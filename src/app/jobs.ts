// The engine behind the app: the runtime every handler is given, the pairing
// lifecycle, and the durable job dispatch (design.md §5, §6, §8).
//
// Nothing here knows about Discord beyond the `DiscordPort` it is handed, and
// nothing reads a clock: `now` arrives with every call, which is what lets the
// suite drive a simulated month an hour at a time.
//
// The scheduling state of a pairing is never held in memory between events. It
// is rebuilt from the proposal and confirmation rows on each event, handed to
// the pure state machine, and the machine's effects are carried out here.

import { feasible, sharedHours } from '../core/availability'
import { ics, proposeSlots } from '../core/calendar'
import {
  closePairing,
  expireCheckin,
  inPool,
  isSilent,
  sendCheckin,
  type EnrollmentConfig,
} from '../core/enrollment'
import { match } from '../core/matching'
import { decidePool, type PoolConfig, type PoolNotice } from '../core/pool'
import {
  transition,
  type Effect,
  type SchedulingConfig,
  type SchedulingEvent,
  type SchedulingState,
} from '../core/scheduling'
import { compose, STRATEGIES } from '../core/strategies'
import { discordTime, renderCopy } from '../config/copy'
import { customId } from '../adapters/discord/components'
import type { Scheduler } from '../jobs/scheduler'
import type {
  Button,
  ConfigStore,
  CopyKey,
  DiscordPort,
  GuildConfig,
  GuildId,
  Job,
  Mask,
  MemberId,
  MemberRow,
  Novelty,
  OutgoingMessage,
  PairingRecord,
  Participant,
  Proposal,
  Storage,
} from '../types'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
/** A released pairing is reviewed, and a completed one archived, a week later. */
const WEEK_MS = 604_800_000

/** How far ahead the bot looks for hours two members share: ten days (§5). */
export const PROPOSAL_WINDOW_HOURS = 240

/** The window a first proposal has to land in, in days from now (§5). */
export const PROPOSAL_MIN_DAYS = 3
export const PROPOSAL_MAX_DAYS = 10

/**
 * Everything a handler or a job needs. One of these is built per app, and it is
 * the only thing passed around: no module-level state, so two apps in one test
 * process cannot see each other.
 */
export type Runtime = {
  readonly storage: Storage
  readonly config: ConfigStore
  readonly discord: DiscordPort
  readonly scheduler: Scheduler
  readonly ids: () => string
  /**
   * Half-finished custom availability picks, keyed by `guildId/memberId`. The
   * day select has to be remembered until the hour select arrives, and it is
   * not worth a column: an abandoned pick costs one map entry.
   */
  readonly pendingDays: Map<string, readonly number[]>
}

// ------------------------------------------------------------- config views --

export function schedulingConfig(cfg: GuildConfig): SchedulingConfig {
  return {
    negotiationTimeoutMs: cfg.negotiationTimeoutMs,
    callMs: cfg.callMinutes * MINUTE_MS,
  }
}

export function enrollmentConfig(cfg: GuildConfig): EnrollmentConfig {
  return { cadenceMs: cfg.cadenceMs }
}

export function poolConfig(cfg: GuildConfig): PoolConfig {
  return {
    cadenceMs: cfg.cadenceMs,
    holdingWindowMs: cfg.holdingWindowMs,
    pullForwardMaxMs: cfg.pullForwardMaxMs,
  }
}

// --------------------------------------------------------------- utilities --

/** The thread url Discord serves, rebuilt from the ids we stored. */
export function threadUrl(guildId: GuildId, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`
}

/** A thread of one, named for its member: check-ins and pool notices go here. */
function soloThreadName(memberId: MemberId): string {
  return `Matchbook: ${memberId}`
}

function pairThreadName(a: MemberId, b: MemberId): string {
  return `Matchbook: ${a} and ${b}`
}

export function participantOf(row: MemberRow): Participant {
  return {
    id: row.id,
    timezone: row.timezone,
    mask: row.mask,
    tags: row.tags,
    avoid: row.avoid,
    joinedAt: row.joinedAt,
    eligibleAt: row.eligibleAt,
  }
}

/** When this member was last introduced to anyone, or null if never. */
export function lastPairingAt(rt: Runtime, guildId: GuildId, id: MemberId): number | null {
  const newest = rt.storage.pairingsOf(guildId, id)[0]
  return newest === undefined ? null : newest.createdAt
}

/**
 * Every pairing the guild has, newest first. There is no "all pairings" query
 * on `Storage`, so this is the union over the members, which is the same set:
 * a pairing always has two member rows pointing at it.
 */
export function allPairings(rt: Runtime, guildId: GuildId): PairingRecord[] {
  const seen = new Map<string, PairingRecord>()
  for (const member of rt.storage.listMembers(guildId)) {
    for (const pairing of rt.storage.pairingsOf(guildId, member.id)) seen.set(pairing.id, pairing)
  }
  for (const pairing of rt.storage.openPairings(guildId)) seen.set(pairing.id, pairing)
  return [...seen.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/** The ids of everyone currently in a pairing that has not ended. */
export function openPairingMembers(rt: Runtime, guildId: GuildId): Set<MemberId> {
  const ids = new Set<MemberId>()
  for (const pairing of rt.storage.openPairings(guildId)) {
    for (const id of pairing.members) ids.add(id)
  }
  return ids
}

/** Schedule a job unless one of the same kind is already pending for this ref. */
function scheduleIfAbsent(
  rt: Runtime,
  guildId: GuildId,
  kind: Job['kind'],
  refId: string,
  runAt: number,
  now: number,
): boolean {
  const pending = rt.storage
    .pendingJobs(guildId)
    .some((job) => job.kind === kind && job.refId === refId)
  if (pending) return false
  rt.scheduler.schedule(guildId, kind, refId, runAt, now)
  return true
}

/**
 * Point a member's next wake-up at their date: a check-in when the gate is up,
 * the matcher when it is not, and nothing at all while they are paused. Called
 * every time a row's state, gate or date changes, so at most one of the two is
 * ever pending.
 */
export function syncWake(rt: Runtime, row: MemberRow, now: number): void {
  const { guildId, id } = row
  for (const kind of ['eligible', 'check-in', 'hold-expiry', 'novelty-hold-expiry'] as const) {
    rt.scheduler.cancel(guildId, kind, id)
  }
  if (row.state !== 'active') {
    rt.scheduler.cancel(guildId, 'check-in-expiry', id)
    return
  }
  if (!row.needsAck) rt.scheduler.cancel(guildId, 'check-in-expiry', id)
  rt.scheduler.schedule(
    guildId,
    row.needsAck ? 'check-in' : 'eligible',
    id,
    Math.max(now, row.eligibleAt),
    now,
  )
}

// ------------------------------------------------------- scheduling state --

/** The newest proposal in one state, or null. */
function newestProposal(proposals: readonly Proposal[], state: Proposal['state']): Proposal | null {
  for (let i = proposals.length - 1; i >= 0; i--) {
    const proposal = proposals[i]!
    if (proposal.state === state) return proposal
  }
  return null
}

export function openProposal(rt: Runtime, pairing: PairingRecord): Proposal | null {
  return newestProposal(rt.storage.proposalsOf(pairing.guildId, pairing.id), 'open')
}

export function lockedProposal(rt: Runtime, pairing: PairingRecord): Proposal | null {
  return newestProposal(rt.storage.proposalsOf(pairing.guildId, pairing.id), 'locked')
}

/**
 * Rebuild the machine's state from the rows. The standing proposal is the
 * newest open one, the counters spent are the proposals each member authored,
 * and the confirmations are the ones on the standing proposal, so a counter
 * voiding the other side's "Works for me" needs no cleanup: the confirmation
 * stays on the proposal it was about.
 */
export function readSchedulingState(rt: Runtime, pairing: PairingRecord): SchedulingState {
  const proposals = rt.storage.proposalsOf(pairing.guildId, pairing.id)
  const open = newestProposal(proposals, 'open')
  const locked = newestProposal(proposals, 'locked')

  const countersUsed: Record<MemberId, number> = {}
  for (const proposal of proposals) {
    if (proposal.proposedBy === null) continue
    countersUsed[proposal.proposedBy] = (countersUsed[proposal.proposedBy] ?? 0) + 1
  }

  const confirmedBy =
    open === null
      ? []
      : rt.storage.confirmationsOf(pairing.guildId, open.id).map((c) => c.memberId)

  return {
    state: pairing.state,
    members: pairing.members,
    proposedStartUtc: open?.startUtc ?? null,
    proposedBy: open?.proposedBy ?? null,
    countersUsed,
    confirmedBy,
    lockedStartUtc: locked?.startUtc ?? null,
  }
}

/** Retire every proposal still on the table, so the rebuilt state is honest. */
function supersedeProposals(rt: Runtime, pairing: PairingRecord): void {
  for (const proposal of rt.storage.proposalsOf(pairing.guildId, pairing.id)) {
    if (proposal.state === 'open' || proposal.state === 'locked') {
      rt.storage.updateProposal({ ...proposal, state: 'superseded' })
    }
  }
}

// -------------------------------------------------------------- the effects --

/** Which copy carries which buttons. The machine names the sentence; this names the taps. */
function buttonsFor(copy: CopyKey, pairingId: string, proposal: Proposal | null): Button[] | undefined {
  switch (copy) {
    case 'proposal':
    case 'counter':
    case 'one-confirmed':
      if (proposal === null) return undefined
      return [
        { id: customId('confirm', proposal.id), label: 'Works for me', style: 'success' },
        { id: customId('counter', proposal.id), label: 'Pick another time', style: 'secondary' },
      ]
    case 'follow-up':
      return [
        { id: customId('yes', pairingId), label: 'Yes', style: 'success' },
        { id: customId('notyet', pairingId), label: 'Not yet', style: 'secondary' },
      ]
    case 'tz-changed-locked-call':
      return [
        { id: customId('keepit', pairingId), label: 'Keep it', style: 'primary' },
        { id: customId('newtime', pairingId), label: 'Suggest a new time', style: 'secondary' },
      ]
    default:
      return undefined
  }
}

/**
 * The calendar file that rides along with the lock. The same `uid` every time,
 * so a re-lock after a timezone change updates the entry rather than adding a
 * second one, and no attendee addresses, which the bot does not have (§9).
 */
export function icsAttachment(
  pairing: PairingRecord,
  startUtc: number,
  cfg: GuildConfig,
  now: number,
): { name: string; bytes: Uint8Array } {
  const text = ics({
    uid: `${pairing.id}@matchbook`,
    dtstamp: now,
    startUtc,
    durationMin: cfg.callMinutes,
    summary: 'Matchbook call',
    description: 'Your Matchbook call',
    threadUrl: pairing.threadId === null ? '' : threadUrl(pairing.guildId, pairing.threadId),
  })
  return { name: `${pairing.id}.ics`, bytes: new TextEncoder().encode(text) }
}

/** Post one sentence of configured copy into a pairing's thread. */
async function sayInThread(
  rt: Runtime,
  cfg: GuildConfig,
  pairing: PairingRecord,
  copy: CopyKey,
  vars: Readonly<Record<string, string | number>>,
  extra?: Partial<OutgoingMessage>,
): Promise<void> {
  if (pairing.threadId === null) return
  const message: OutgoingMessage = { content: renderCopy(cfg, copy, vars), ...extra }
  await rt.discord.post(cfg.guildId, pairing.threadId, message)
}

/**
 * `{start}` and `{time}` are the same instant under two names, so a server that
 * renamed the placeholder in its copy still gets the value. Both are rendered as
 * Discord timestamp markup, never as the raw millisecond.
 */
function copyVars(
  state: SchedulingState,
  effect: Extract<Effect, { type: 'say' }>,
): Record<string, string | number> {
  const vars: Record<string, string | number> = {}
  const standing = state.lockedStartUtc ?? state.proposedStartUtc
  if (standing !== null) vars.start = standing
  Object.assign(vars, effect.vars ?? {})
  if (typeof vars.start === 'number') {
    const shown = discordTime(vars.start)
    vars.start = shown
    vars.time = shown
  }
  return vars
}

async function runEffects(
  rt: Runtime,
  cfg: GuildConfig,
  pairingId: string,
  next: SchedulingState,
  proposal: Proposal | null,
  effects: readonly Effect[],
  now: number,
): Promise<void> {
  for (const effect of effects) {
    const pairing = rt.storage.getPairing(cfg.guildId, pairingId)
    if (pairing === null) return
    switch (effect.type) {
      case 'schedule':
        rt.scheduler.cancel(cfg.guildId, effect.kind, pairingId)
        rt.scheduler.schedule(cfg.guildId, effect.kind, pairingId, effect.runAt, now)
        break
      case 'cancel':
        rt.scheduler.cancel(cfg.guildId, effect.kind, pairingId)
        break
      case 'archive':
        if (pairing.threadId !== null) await rt.discord.archiveThread(cfg.guildId, pairing.threadId)
        break
      case 'say': {
        const vars = copyVars(next, effect)
        const buttons = buttonsFor(effect.copy, pairingId, proposal)
        const file =
          effect.copy === 'locked' && next.lockedStartUtc !== null
            ? icsAttachment(pairing, next.lockedStartUtc, cfg, now)
            : undefined
        await sayInThread(rt, cfg, pairing, effect.copy, vars, {
          ...(buttons === undefined ? {} : { buttons }),
          ...(file === undefined ? {} : { file }),
        })
        break
      }
    }
  }
}

// ------------------------------------------------------------ pairing events --

/** Does this event put a fresh time on the table? */
function isProposing(event: SchedulingEvent): boolean {
  return (
    event.kind === 'propose' ||
    event.kind === 'counter' ||
    (event.kind === 'tz-repropose' && event.startUtc !== null)
  )
}

/**
 * One event against one pairing: rebuild the state, run the machine, write the
 * rows it implies, then carry out its effects. A transition the table has no
 * entry for throws out of `transition`; callers guard on the pairing's state
 * rather than catching, so an illegal sequence is a bug rather than a silence.
 */
export async function applyEvent(
  rt: Runtime,
  cfg: GuildConfig,
  pairingId: string,
  event: SchedulingEvent,
  now: number,
): Promise<void> {
  const pairing = rt.storage.getPairing(cfg.guildId, pairingId)
  if (pairing === null) return

  const before = readSchedulingState(rt, pairing)
  const { next, effects } = transition(before, event, now, schedulingConfig(cfg))

  const open = openProposal(rt, pairing)
  let current: Proposal | null = open

  if (isProposing(event) && next.proposedStartUtc !== null) {
    supersedeProposals(rt, pairing)
    const proposal: Proposal = {
      id: rt.ids(),
      guildId: cfg.guildId,
      pairingId,
      startUtc: next.proposedStartUtc,
      durationMin: cfg.callMinutes,
      state: 'open',
      proposedBy: event.kind === 'counter' ? event.by : null,
      createdAt: now,
    }
    rt.storage.insertProposal(proposal)
    current = proposal
  } else if (event.kind === 'confirm' && open !== null) {
    rt.storage.insertConfirmation({
      guildId: cfg.guildId,
      proposalId: open.id,
      memberId: event.by,
      confirmedAt: now,
    })
    if (next.state === 'locked') {
      const locked: Proposal = { ...open, state: 'locked' }
      rt.storage.updateProposal(locked)
      current = locked
    }
  } else if (next.state === 'released') {
    supersedeProposals(rt, pairing)
    current = null
  }

  if (next.state !== pairing.state) {
    rt.storage.updatePairing({ ...pairing, state: next.state })
  }

  await runEffects(rt, cfg, pairingId, next, current, effects, now)

  const ended = next.state === 'completed' || next.state === 'expired'
  if (ended && pairing.state !== next.state) await endPairing(rt, cfg, pairingId, now)
}

/**
 * The introduction (§5): a private thread for the two of them, the opening
 * sentence, and a time drawn from the hours they share. If no hour in the
 * proposal window works, the thread still opens and the release clock starts,
 * so the bot steps back rather than proposing a time nobody can take.
 */
export async function introduce(
  rt: Runtime,
  cfg: GuildConfig,
  members: readonly [MemberId, MemberId],
  novelty: Novelty,
  now: number,
): Promise<PairingRecord | null> {
  const a = rt.storage.getMember(cfg.guildId, members[0])
  const b = rt.storage.getMember(cfg.guildId, members[1])
  if (a === null || b === null) return null

  const id = rt.ids()
  const thread = await rt.discord.createPrivateThread(
    cfg.guildId,
    cfg.threadParentChannelId,
    pairThreadName(a.id, b.id),
    [a.id, b.id],
  )
  const pairing: PairingRecord = {
    id,
    guildId: cfg.guildId,
    members: [a.id, b.id],
    state: 'created',
    novelty,
    createdAt: now,
    threadId: thread.id,
    voiceChannelId: null,
  }
  rt.storage.insertPairing(pairing, [
    { guildId: cfg.guildId, pairingId: id, memberId: a.id, lastActivityAt: null },
    { guildId: cfg.guildId, pairingId: id, memberId: b.id, lastActivityAt: null },
  ])

  await sayInThread(rt, cfg, pairing, 'introduction', {})

  const start = firstSlot(a, b, now)
  if (start === undefined) {
    rt.scheduler.schedule(
      cfg.guildId,
      'negotiation-release',
      id,
      now + cfg.negotiationTimeoutMs,
      now,
    )
    return rt.storage.getPairing(cfg.guildId, id)
  }

  await applyEvent(rt, cfg, id, { kind: 'propose', startUtc: start }, now)
  return rt.storage.getPairing(cfg.guildId, id)
}

/** The time the bot offers first: the best shared hour three to ten days out. */
export function firstSlot(a: MemberRow, b: MemberRow, now: number): number | undefined {
  return slotsFor(a, b, now)[0]
}

export function slotsFor(a: MemberRow, b: MemberRow, now: number): number[] {
  return proposeSlots(sharedHours(a, b, now, PROPOSAL_WINDOW_HOURS), now, {
    minDays: PROPOSAL_MIN_DAYS,
    maxDays: PROPOSAL_MAX_DAYS,
    zoneA: a.timezone,
    zoneB: b.timezone,
  })
}

/**
 * A pairing ended. Each member's silence is read off the thread, their
 * confirmations and the partner's Yes; a silent one has the gate raised and is
 * asked about it when their next turn comes round (§4a).
 */
export async function endPairing(
  rt: Runtime,
  cfg: GuildConfig,
  pairingId: string,
  now: number,
): Promise<void> {
  const pairing = rt.storage.getPairing(cfg.guildId, pairingId)
  if (pairing === null) return

  const memberRows = rt.storage.pairingMembers(cfg.guildId, pairingId)
  const outcomes = rt.storage.outcomesOf(cfg.guildId, pairingId)
  const tapped = new Set<MemberId>()
  for (const proposal of rt.storage.proposalsOf(cfg.guildId, pairingId)) {
    for (const confirmation of rt.storage.confirmationsOf(cfg.guildId, proposal.id)) {
      tapped.add(confirmation.memberId)
    }
  }

  for (const memberId of pairing.members) {
    const row = rt.storage.getMember(cfg.guildId, memberId)
    if (row === null) continue
    const partner = pairing.members.find((other) => other !== memberId)
    const silent = isSilent({
      posted: memberRows.some((m) => m.memberId === memberId && m.lastActivityAt !== null),
      tapped: tapped.has(memberId),
      partnerYes: outcomes.some((o) => o.memberId === partner && o.connected),
    })
    const closed = closePairing(row, silent, now, enrollmentConfig(cfg))
    rt.storage.upsertMember(closed)
    syncWake(rt, closed, now)
  }
}

// --------------------------------------------------------------- the pool --

/** A thread of one, for a sentence the bot owes a single member. */
export async function notifyMember(
  rt: Runtime,
  cfg: GuildConfig,
  memberId: MemberId,
  message: OutgoingMessage,
): Promise<void> {
  const thread = await rt.discord.createPrivateThread(
    cfg.guildId,
    cfg.threadParentChannelId,
    soloThreadName(memberId),
    [memberId],
  )
  await rt.discord.post(cfg.guildId, thread.id, message)
}

/**
 * Run the pool decision for a guild and carry it out: the dates it sets, the
 * introductions it asks for, the explanations it owes, and the two holding jobs
 * that wake whoever was left waiting.
 */
export async function runPool(rt: Runtime, cfg: GuildConfig, now: number): Promise<void> {
  const guildId = cfg.guildId
  const members = rt.storage.listMembers(guildId)
  const history = allPairings(rt, guildId)
  const strategy = compose(cfg.weights, Object.values(STRATEGIES))
  // The pool and the matcher must agree on what a possible pair is, so both are
  // handed the same predicate rather than each deciding for itself.
  type Available = { mask: Mask; timezone: string }
  const canMeet = (a: Available, b: Available): boolean => feasible(a, b, now)

  const decision = decidePool({
    members,
    history,
    openPairingMembers: openPairingMembers(rt, guildId),
    now,
    cfg: poolConfig(cfg),
    feasible: canMeet,
    pick: (pool) =>
      match(pool.map(participantOf), history, strategy, {
        now,
        feasible: canMeet,
      }).map((proposal) => ({ a: proposal.a, b: proposal.b })),
  })

  // Being paired sets the date, so the rows move before the threads open.
  for (const row of decision.updates) rt.storage.upsertMember(row)

  for (const pairing of decision.pairings) {
    await introduce(rt, cfg, pairing.members, pairing.novelty, now)
  }

  for (const row of decision.updates) {
    const current = rt.storage.getMember(guildId, row.id)
    if (current !== null) syncWake(rt, current, now)
  }

  const kinds = (kind: PoolNotice['kind']): Set<MemberId> =>
    new Set(decision.notices.filter((n) => n.kind === kind).map((n) => n.memberId))

  await deliverNotices(rt, cfg, decision.notices, now)
  await holdWhoeverWaited(rt, cfg, kinds('no-overlap'), kinds('holding-for-stranger'), now)
}

async function deliverNotices(
  rt: Runtime,
  cfg: GuildConfig,
  notices: readonly PoolNotice[],
  now: number,
): Promise<void> {
  for (const notice of notices) {
    const row = rt.storage.getMember(cfg.guildId, notice.memberId)
    if (row === null) continue
    if (notice.kind === 'no-overlap') {
      // One explanation per member, ever: repeating it every pass would be nagging.
      if (row.overlapNoticeAt !== null) continue
      rt.storage.upsertMember({ ...row, overlapNoticeAt: now })
      await notifyMember(rt, cfg, row.id, { content: renderCopy(cfg, 'no-overlap') })
    } else if (notice.kind === 'met-everyone') {
      const since = notice.lastPairedAt ?? now
      await notifyMember(rt, cfg, row.id, {
        content: renderCopy(cfg, 'met-everyone', {
          partner: notice.partnerId ?? '',
          since: `${Math.max(0, Math.round((now - since) / DAY_MS))} days`,
        }),
      })
    }
    // `holding-for-stranger` is said where the hold is booked, so it is said
    // once per hold rather than once per pass.
  }
}

/**
 * Whoever is still in the pool after the decision waits: for the holding window
 * to run out, and at the outside for one cadence of holding out for someone new.
 * The sentence about that hold goes with the job, so it is said once.
 */
async function holdWhoeverWaited(
  rt: Runtime,
  cfg: GuildConfig,
  noOverlap: ReadonlySet<MemberId>,
  holdingForStranger: ReadonlySet<MemberId>,
  now: number,
): Promise<void> {
  const open = openPairingMembers(rt, cfg.guildId)
  for (const row of rt.storage.listMembers(cfg.guildId)) {
    // Someone nobody shares hours with is not waiting for company, so waking
    // them on a timer would only reach the same answer.
    if (!inPool(row, now, open) || noOverlap.has(row.id)) continue

    const holdAt = row.eligibleAt + cfg.holdingWindowMs
    if (holdAt > now) scheduleIfAbsent(rt, cfg.guildId, 'hold-expiry', row.id, holdAt, now)

    const noveltyAt = row.eligibleAt + cfg.cadenceMs
    if (noveltyAt <= now) continue
    const booked = scheduleIfAbsent(rt, cfg.guildId, 'novelty-hold-expiry', row.id, noveltyAt, now)
    // The sentence goes with the hold, so it is said once per hold rather than
    // once per pass over the pool.
    if (booked && holdingForStranger.has(row.id)) {
      await notifyMember(rt, cfg, row.id, { content: renderCopy(cfg, 'holding-for-stranger') })
    }
  }
}

// ------------------------------------------------------------ the check-in --

/** Send the check-in of §4a into a thread of one and start its expiry clock. */
export async function sendCheckIn(
  rt: Runtime,
  cfg: GuildConfig,
  row: MemberRow,
  now: number,
): Promise<void> {
  await notifyMember(rt, cfg, row.id, {
    content: renderCopy(cfg, 'check-in'),
    buttons: [
      { id: customId('keep', row.id), label: 'Keep me in', style: 'primary' },
      { id: customId('pausme', row.id), label: 'Pause me', style: 'secondary' },
    ],
  })
  rt.storage.upsertMember(sendCheckin(row, now))
  rt.scheduler.cancel(cfg.guildId, 'check-in-expiry', row.id)
  rt.scheduler.schedule(cfg.guildId, 'check-in-expiry', row.id, now + cfg.cadenceMs, now)
}

// ---------------------------------------------------------- the voice room --

async function openRoom(rt: Runtime, cfg: GuildConfig, pairingId: string): Promise<void> {
  const pairing = rt.storage.getPairing(cfg.guildId, pairingId)
  if (pairing === null || pairing.state !== 'locked') return
  if (pairing.threadId === null || pairing.voiceChannelId !== null) return

  const channel = await rt.discord.createVoiceChannel(
    cfg.guildId,
    cfg.voiceCategoryId,
    pairThreadName(pairing.members[0], pairing.members[1]),
    pairing.members,
  )
  rt.storage.updatePairing({ ...pairing, voiceChannelId: channel.id })
  await rt.discord.post(cfg.guildId, pairing.threadId, {
    content: renderCopy(cfg, 'room-open', { link: channel.url }),
  })
}

async function closeRoom(rt: Runtime, cfg: GuildConfig, pairingId: string): Promise<void> {
  const pairing = rt.storage.getPairing(cfg.guildId, pairingId)
  if (pairing === null || pairing.voiceChannelId === null) return
  await rt.discord.deleteChannel(cfg.guildId, pairing.voiceChannelId)
  rt.storage.updatePairing({ ...pairing, voiceChannelId: null })
}

// ----------------------------------------------------------- job dispatch --

/**
 * One due job. Every branch reads the row it is about first and does nothing if
 * the world moved on, so a job that outlived its pairing is a no-op rather than
 * an error.
 */
export async function runJob(rt: Runtime, job: Job, now: number): Promise<void> {
  const cfg = rt.config.get(job.guildId)
  if (cfg === null) return

  switch (job.kind) {
    case 'eligible':
    case 'hold-expiry':
    case 'novelty-hold-expiry':
      await runPool(rt, cfg, now)
      return

    case 'negotiation-release':
      await releaseNegotiation(rt, cfg, job.refId, now)
      return

    case 'room-open':
      await openRoom(rt, cfg, job.refId)
      return

    case 'room-close':
      await closeRoom(rt, cfg, job.refId)
      return

    case 'follow-up': {
      const pairing = rt.storage.getPairing(cfg.guildId, job.refId)
      if (pairing?.state === 'locked') {
        await applyEvent(rt, cfg, pairing.id, { kind: 'follow-up-due' }, now)
      }
      return
    }

    case 'expire': {
      const pairing = rt.storage.getPairing(cfg.guildId, job.refId)
      if (pairing?.state !== 'released') return
      const hadActivity = rt.storage
        .pairingMembers(cfg.guildId, pairing.id)
        .some((member) => member.lastActivityAt !== null)
      await applyEvent(rt, cfg, pairing.id, { kind: 'release-review', hadActivity }, now)
      return
    }

    case 'check-in': {
      const row = rt.storage.getMember(cfg.guildId, job.refId)
      if (row === null || row.state !== 'active' || !row.needsAck) return
      await sendCheckIn(rt, cfg, row, now)
      return
    }

    case 'check-in-expiry': {
      const row = rt.storage.getMember(cfg.guildId, job.refId)
      if (row === null) return
      const { row: next, action } = expireCheckin(row, now, enrollmentConfig(cfg))
      if (action === 'none') return
      rt.storage.upsertMember(next)
      if (action === 'resend') await sendCheckIn(rt, cfg, next, now)
      else syncWake(rt, next, now)
      return
    }

    case 'archive': {
      const pairing = rt.storage.getPairing(cfg.guildId, job.refId)
      if (pairing?.threadId != null) await rt.discord.archiveThread(cfg.guildId, pairing.threadId)
      return
    }
  }
}

/**
 * The release clock ran out. A pairing that never got a time proposed at all
 * has no transition to take, so it is released here: the same sentence, the
 * same week-long review, without asking the table for an entry it has no reason
 * to hold.
 */
async function releaseNegotiation(
  rt: Runtime,
  cfg: GuildConfig,
  pairingId: string,
  now: number,
): Promise<void> {
  const pairing = rt.storage.getPairing(cfg.guildId, pairingId)
  if (pairing === null) return

  if (pairing.state === 'created') {
    rt.storage.updatePairing({ ...pairing, state: 'released' })
    await sayInThread(rt, cfg, pairing, 'released-overlap', {})
    rt.scheduler.schedule(cfg.guildId, 'expire', pairing.id, now + WEEK_MS, now)
    return
  }
  if (pairing.state === 'time_proposed' || pairing.state === 'one_confirmed') {
    await applyEvent(rt, cfg, pairing.id, { kind: 'negotiation-timeout' }, now)
  }
}
