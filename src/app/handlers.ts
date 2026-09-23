// What the bot does when somebody talks to it (design.md §7): the six member
// commands, the admin group, every button and select, and a post in a pairing
// thread.
//
// A handler reads rows, calls the pure unit that owns the decision, writes the
// rows back and returns what to reply. The Discord adapter turns `Incoming`
// into these calls and the returned `Reply` into an interaction response, so
// nothing platform specific lives here.

import {
  EMPTY_MASK,
  PRESETS,
  assertMask,
  feasible,
  isAvailableAt,
  orBlock,
} from '../core/availability'
import { alternatives } from '../core/calendar'
import {
  answerCheckin,
  joinMember,
  pauseMember,
  recordEvidence,
  resumeMember,
} from '../core/enrollment'
import { discordTime, renderCopy } from '../config/copy'
import {
  AVAILABILITY_DAYS_ID,
  AVAILABILITY_HOURS_ID,
  availabilityMenu,
  customId,
  daysSelect,
  hoursSelect,
  parseCustomId,
} from '../adapters/discord/components'
import {
  allPairings,
  applyEvent,
  enrollmentConfig,
  introduce,
  lastPairingAt,
  lockedProposal,
  openProposal,
  readSchedulingState,
  slotsFor,
  syncWake,
  type Runtime,
} from './jobs'
import type {
  AvailabilityPreset,
  CopyKey,
  GuildConfig,
  GuildId,
  Incoming,
  MemberId,
  MemberRow,
  PairingRecord,
  Reply,
  SelectOption,
} from '../types'

/** Every reply the bot makes to an interaction is private to the invoker (§7). */
function ephemeral(content: string, extra: Partial<Reply> = {}): Reply {
  return { content, ephemeral: true, ...extra }
}

function said(cfg: GuildConfig, key: CopyKey, vars?: Readonly<Record<string, string | number>>): Reply {
  return ephemeral(renderCopy(cfg, key, vars))
}

/** The one sentence that is not configurable: it names the option to fill in. */
const TIMEZONE_NEEDED =
  'I need your timezone before I can introduce you to anyone, because every hour I offer you is read in it. ' +
  'Run /join again with the timezone option set, for example Europe/Belgrade.'

const NOT_ENROLLED = 'You are not in the rotation on this server yet. Run /join first.'
const NOTHING_TO_ANSWER = 'That is not on the table any more, so there is nothing to answer.'
const NOTED = 'Noted.'

/** `/join avoid:` is a free text list of ids, separated however the member typed it. */
function parseAvoid(raw: string | undefined): readonly MemberId[] | undefined {
  if (raw === undefined) return undefined
  return raw
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

function keyOf(guildId: GuildId, memberId: MemberId): string {
  return `${guildId}/${memberId}`
}

// ------------------------------------------------------------- the commands --

async function handleJoin(
  rt: Runtime,
  cfg: GuildConfig,
  incoming: Extract<Incoming, { kind: 'join' }>,
  now: number,
): Promise<Reply> {
  const existing = rt.storage.getMember(cfg.guildId, incoming.userId)
  // A first join without a zone stores nothing: a row with no timezone is a row
  // no hour can be offered to.
  if (existing === null && incoming.timezone === undefined) return ephemeral(TIMEZONE_NEEDED)

  const avoid = parseAvoid(incoming.avoid)
  const row = joinMember(
    existing,
    {
      ...(incoming.timezone === undefined ? {} : { timezone: incoming.timezone }),
      ...(avoid === undefined ? {} : { avoid }),
    },
    now,
    enrollmentConfig(cfg),
    lastPairingAt(rt, cfg.guildId, incoming.userId),
    { guildId: cfg.guildId, id: incoming.userId },
  )
  rt.storage.upsertMember(row)
  syncWake(rt, row, now)

  if (existing === null) return said(cfg, 'join-confirmation')
  return said(cfg, existing.state === 'paused' ? 'resumed' : 'join-updated')
}

/**
 * `/timezone`. The mask is local intent, so changing the zone moves every hour
 * it projects to. A call already locked in may no longer be inside the member's
 * week, and that is the one case worth interrupting the thread over (§5).
 */
async function handleTimezone(
  rt: Runtime,
  cfg: GuildConfig,
  incoming: Extract<Incoming, { kind: 'timezone' }>,
  now: number,
): Promise<Reply> {
  const row = rt.storage.getMember(cfg.guildId, incoming.userId)
  if (row === null) return ephemeral(NOT_ENROLLED)

  const moved: MemberRow = { ...row, timezone: incoming.timezone }
  rt.storage.upsertMember(moved)

  for (const pairing of rt.storage.openPairings(cfg.guildId)) {
    if (!pairing.members.includes(moved.id) || pairing.state !== 'locked') continue
    const locked = lockedProposal(rt, pairing)
    if (locked === null) continue
    if (isAvailableAt(moved.mask, moved.timezone, locked.startUtc)) continue
    if (pairing.threadId === null) continue
    await rt.discord.post(cfg.guildId, pairing.threadId, {
      content: renderCopy(cfg, 'tz-changed-locked-call', {
        start: discordTime(locked.startUtc),
        time: discordTime(locked.startUtc),
      }),
      buttons: [
        { id: customId('keepit', pairing.id), label: 'Keep it', style: 'primary' },
        { id: customId('newtime', pairing.id), label: 'Suggest a new time', style: 'secondary' },
      ],
    })
  }

  return said(cfg, 'join-updated')
}

function handleAvailability(
  rt: Runtime,
  cfg: GuildConfig,
  userId: MemberId,
): Reply {
  const row = rt.storage.getMember(cfg.guildId, userId)
  if (row === null) return ephemeral(NOT_ENROLLED)
  const menu = availabilityMenu(row.preset)
  return ephemeral(renderCopy(cfg, 'availability-menu'), { buttons: menu.buttons })
}

function handlePause(rt: Runtime, cfg: GuildConfig, userId: MemberId, now: number): Reply {
  const row = rt.storage.getMember(cfg.guildId, userId)
  if (row === null) return ephemeral(NOT_ENROLLED)
  const paused = pauseMember(row)
  rt.storage.upsertMember(paused)
  syncWake(rt, paused, now)
  return said(cfg, 'paused')
}

function handleResume(rt: Runtime, cfg: GuildConfig, userId: MemberId, now: number): Reply {
  const row = rt.storage.getMember(cfg.guildId, userId)
  if (row === null) return ephemeral(NOT_ENROLLED)
  const back = resumeMember(row, now, enrollmentConfig(cfg), lastPairingAt(rt, cfg.guildId, userId))
  rt.storage.upsertMember(back)
  syncWake(rt, back, now)
  return said(cfg, 'resumed')
}

function handleForget(rt: Runtime, cfg: GuildConfig, userId: MemberId): Reply {
  rt.storage.forgetMember(cfg.guildId, userId)
  return said(cfg, 'forgotten')
}

// ----------------------------------------------------------------- admin --

/**
 * `/matchbook status`. Three lines an admin can read at a glance: how many
 * people are in the rotation, how many introductions are still running, and
 * what share of all pairings have been reconnections rather than strangers.
 */
function handleAdminStatus(rt: Runtime, cfg: GuildConfig): Reply {
  const active = rt.storage
    .listMembers(cfg.guildId)
    .filter((row) => row.state === 'active').length
  const open = rt.storage.openPairings(cfg.guildId).length
  const pairings = allPairings(rt, cfg.guildId)
  const reconnects = pairings.filter((p) => p.novelty === 'reconnect').length
  const share = pairings.length === 0 ? 0 : Math.round((reconnects / pairings.length) * 100)

  return ephemeral(
    [`pool: ${active}`, `open pairings: ${open}`, `reconnection share: ${share}%`].join('\n'),
  )
}

function handleAdminConfig(cfg: GuildConfig): Reply {
  const days = (ms: number): string => `${Math.round((ms / 86_400_000) * 10) / 10} days`
  return ephemeral(
    [
      `cadence: ${days(cfg.cadenceMs)}`,
      `holding window: ${Math.round(cfg.holdingWindowMs / 3_600_000)} hours`,
      `pull forward: ${days(cfg.pullForwardMaxMs)}`,
      `negotiation timeout: ${Math.round(cfg.negotiationTimeoutMs / 3_600_000)} hours`,
      `call length: ${cfg.callMinutes} minutes`,
      `weights: ${Object.entries(cfg.weights)
        .map(([name, weight]) => `${name} ${weight}`)
        .join(', ')}`,
    ].join('\n'),
  )
}

/** `/matchbook pair`: an introduction outside the cadence, still inside the hours. */
async function handleAdminPair(
  rt: Runtime,
  cfg: GuildConfig,
  incoming: Extract<Incoming, { kind: 'admin-pair' }>,
  now: number,
): Promise<Reply> {
  const a = rt.storage.getMember(cfg.guildId, incoming.a)
  const b = rt.storage.getMember(cfg.guildId, incoming.b)
  if (a === null || b === null) return ephemeral(NOT_ENROLLED)
  if (!feasible(a, b, now)) {
    return said(cfg, 'admin-pair-infeasible', { a: a.id, b: b.id })
  }
  await introduce(rt, cfg, [a.id, b.id], 'forced', now)
  return ephemeral(`Introduced ${a.id} and ${b.id}.`)
}

// --------------------------------------------------------------- buttons --

/** The pairing a button was pressed in, found by the thread it was pressed in. */
function pairingOfChannel(
  rt: Runtime,
  guildId: GuildId,
  channelId: string,
): PairingRecord | null {
  return rt.storage.pairingByThread(guildId, channelId)
}

async function handleConfirm(
  rt: Runtime,
  cfg: GuildConfig,
  userId: MemberId,
  channelId: string,
  proposalId: string,
  now: number,
): Promise<Reply> {
  const pairing = pairingOfChannel(rt, cfg.guildId, channelId)
  if (pairing === null || !pairing.members.includes(userId)) return ephemeral(NOTHING_TO_ANSWER)
  const open = openProposal(rt, pairing)
  if (open === null || open.id !== proposalId) return ephemeral(NOTHING_TO_ANSWER)

  const already = rt.storage
    .confirmationsOf(cfg.guildId, open.id)
    .some((c) => c.memberId === userId)
  if (already) return ephemeral(NOTED)

  await applyEvent(rt, cfg, pairing.id, { kind: 'confirm', by: userId }, now)
  return ephemeral(NOTED)
}

/**
 * "Pick another time". Each side gets one counter (§5), so a member who has
 * spent theirs is told so and nothing moves; otherwise they get the other
 * shared hours as a select whose values are the instants themselves.
 */
function handleCounter(
  rt: Runtime,
  cfg: GuildConfig,
  userId: MemberId,
  channelId: string,
  proposalId: string,
  now: number,
): Reply {
  const pairing = pairingOfChannel(rt, cfg.guildId, channelId)
  if (pairing === null || !pairing.members.includes(userId)) return ephemeral(NOTHING_TO_ANSWER)
  const open = openProposal(rt, pairing)
  if (open === null || open.id !== proposalId) return ephemeral(NOTHING_TO_ANSWER)

  const state = readSchedulingState(rt, pairing)
  if ((state.countersUsed[userId] ?? 0) >= 1) {
    return ephemeral('You have already suggested a time once, so this one stands or nothing does.')
  }

  const a = rt.storage.getMember(cfg.guildId, pairing.members[0])
  const b = rt.storage.getMember(cfg.guildId, pairing.members[1])
  if (a === null || b === null) return ephemeral(NOTHING_TO_ANSWER)

  const others = alternatives(slotsFor(a, b, now), now, open.startUtc, {
    minDays: 3,
    maxDays: 10,
    zoneA: a.timezone,
    zoneB: b.timezone,
  })
  if (others.length === 0) {
    return ephemeral('There is no other hour you both have free in the next ten days.')
  }

  const options: SelectOption[] = others.map((slot) => ({
    value: String(slot),
    label: new Date(slot).toISOString().replace('.000Z', 'Z'),
  }))
  return ephemeral(renderCopy(cfg, 'pick-another-time'), {
    select: {
      id: customId('slot', pairing.id),
      placeholder: 'A time you could both take',
      options,
      min: 1,
      max: 1,
    },
  })
}

/**
 * The follow-up answer (§4a, §9). One answer per member per pairing: the second
 * is acknowledged and dropped, so an answer cannot be edited into its opposite.
 * A Yes is evidence both of them were there, which lowers the gate for both.
 */
function handleFollowUpAnswer(
  rt: Runtime,
  cfg: GuildConfig,
  userId: MemberId,
  pairingId: string,
  connected: boolean,
  now: number,
): Reply {
  const pairing = rt.storage.getPairing(cfg.guildId, pairingId)
  if (pairing === null || !pairing.members.includes(userId)) return ephemeral(NOTHING_TO_ANSWER)

  const answered = rt.storage
    .outcomesOf(cfg.guildId, pairingId)
    .some((outcome) => outcome.memberId === userId)
  if (answered) return ephemeral(NOTED)

  rt.storage.insertOutcome({
    guildId: cfg.guildId,
    pairingId,
    memberId: userId,
    connected,
    answeredAt: now,
  })

  if (connected) {
    for (const memberId of pairing.members) {
      const row = rt.storage.getMember(cfg.guildId, memberId)
      if (row === null || !row.needsAck) continue
      const cleared = recordEvidence(row)
      rt.storage.upsertMember(cleared)
      syncWake(rt, cleared, now)
    }
  }

  return said(cfg, 'follow-up-thanks')
}

function handleCheckinAnswer(
  rt: Runtime,
  cfg: GuildConfig,
  userId: MemberId,
  memberId: MemberId,
  answer: 'keep' | 'pause',
  now: number,
): Reply {
  if (userId !== memberId) return ephemeral(NOTHING_TO_ANSWER)
  const row = rt.storage.getMember(cfg.guildId, userId)
  if (row === null) return ephemeral(NOT_ENROLLED)

  const answered = answerCheckin(row, answer)
  rt.storage.upsertMember(answered)
  syncWake(rt, answered, now)
  return said(cfg, answer === 'keep' ? 'check-in-kept' : 'paused')
}

/** "Suggest a new time" after a timezone move: a fresh pick, or nothing left. */
async function handleNewTime(
  rt: Runtime,
  cfg: GuildConfig,
  userId: MemberId,
  pairingId: string,
  now: number,
): Promise<Reply> {
  const pairing = rt.storage.getPairing(cfg.guildId, pairingId)
  if (pairing === null || !pairing.members.includes(userId) || pairing.state !== 'locked') {
    return ephemeral(NOTHING_TO_ANSWER)
  }
  const a = rt.storage.getMember(cfg.guildId, pairing.members[0])
  const b = rt.storage.getMember(cfg.guildId, pairing.members[1])
  if (a === null || b === null) return ephemeral(NOTHING_TO_ANSWER)

  const startUtc = slotsFor(a, b, now)[0] ?? null
  await applyEvent(rt, cfg, pairingId, { kind: 'tz-repropose', startUtc }, now)
  return ephemeral(NOTED)
}

/** A preset button, or Clear. Both rewrite the whole mask, which is the point. */
function handleAvailabilityPreset(
  rt: Runtime,
  cfg: GuildConfig,
  userId: MemberId,
  choice: string,
): Reply {
  const row = rt.storage.getMember(cfg.guildId, userId)
  if (row === null) return ephemeral(NOT_ENROLLED)

  if (choice === 'clear') {
    rt.storage.upsertMember({ ...row, mask: EMPTY_MASK, preset: 'custom' })
    return said(cfg, 'availability-saved')
  }
  if (choice === 'custom') {
    return ephemeral(renderCopy(cfg, 'availability-menu'), { select: daysSelect() })
  }
  const preset = choice as Exclude<AvailabilityPreset, 'custom'>
  rt.storage.upsertMember({ ...row, mask: PRESETS[preset], preset })
  return said(cfg, 'availability-saved')
}

async function handleButton(
  rt: Runtime,
  cfg: GuildConfig,
  incoming: Extract<Incoming, { kind: 'button' }>,
  now: number,
): Promise<Reply> {
  const { action, ref } = parseCustomId(incoming.customId)
  const { userId, channelId } = incoming

  switch (action) {
    case 'confirm':
      return handleConfirm(rt, cfg, userId, channelId, ref, now)
    case 'counter':
      return handleCounter(rt, cfg, userId, channelId, ref, now)
    case 'yes':
      return handleFollowUpAnswer(rt, cfg, userId, ref, true, now)
    case 'notyet':
      return handleFollowUpAnswer(rt, cfg, userId, ref, false, now)
    case 'keep':
      return handleCheckinAnswer(rt, cfg, userId, ref, 'keep', now)
    case 'pausme':
      return handleCheckinAnswer(rt, cfg, userId, ref, 'pause', now)
    case 'keepit':
      return ephemeral(NOTED)
    case 'newtime':
      return handleNewTime(rt, cfg, userId, ref, now)
    case 'avail':
      return handleAvailabilityPreset(rt, cfg, userId, ref)
    default:
      return ephemeral(NOTHING_TO_ANSWER)
  }
}

// ---------------------------------------------------------------- selects --

function readIndexes(values: readonly string[]): number[] {
  return values
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value))
}

async function handleSelect(
  rt: Runtime,
  cfg: GuildConfig,
  incoming: Extract<Incoming, { kind: 'select' }>,
  now: number,
): Promise<Reply> {
  const { action, ref } = parseCustomId(incoming.customId)
  const { userId } = incoming

  if (incoming.customId === AVAILABILITY_DAYS_ID) {
    rt.pendingDays.set(keyOf(cfg.guildId, userId), readIndexes(incoming.values))
    return ephemeral(renderCopy(cfg, 'availability-menu'), { select: hoursSelect() })
  }

  if (incoming.customId === AVAILABILITY_HOURS_ID) {
    const row = rt.storage.getMember(cfg.guildId, userId)
    if (row === null) return ephemeral(NOT_ENROLLED)
    const key = keyOf(cfg.guildId, userId)
    const days = rt.pendingDays.get(key)
    if (days === undefined) return ephemeral('Pick the days first, then the hours.')
    rt.pendingDays.delete(key)
    const mask = orBlock(row.mask, days, readIndexes(incoming.values))
    assertMask(mask)
    rt.storage.upsertMember({ ...row, mask, preset: 'custom' })
    return said(cfg, 'availability-saved')
  }

  if (action === 'slot') {
    const startUtc = Number.parseInt(incoming.values[0] ?? '', 10)
    if (!Number.isInteger(startUtc)) return ephemeral(NOTHING_TO_ANSWER)
    const pairing = rt.storage.getPairing(cfg.guildId, ref)
    if (pairing === null || !pairing.members.includes(userId)) return ephemeral(NOTHING_TO_ANSWER)
    if (pairing.state !== 'time_proposed' && pairing.state !== 'one_confirmed') {
      return ephemeral(NOTHING_TO_ANSWER)
    }
    const state = readSchedulingState(rt, pairing)
    if ((state.countersUsed[userId] ?? 0) >= 1) return ephemeral(NOTHING_TO_ANSWER)
    await applyEvent(rt, cfg, pairing.id, { kind: 'counter', by: userId, startUtc }, now)
    return ephemeral(NOTED)
  }

  return ephemeral(NOTHING_TO_ANSWER)
}

// --------------------------------------------------------------- the door --

/**
 * One interaction. The guild has to be configured: an interaction from a server
 * nobody set up has nothing to answer with, and inventing defaults would put a
 * bot in a channel its admin never named.
 */
export async function handle(rt: Runtime, incoming: Incoming, now: number): Promise<Reply | null> {
  const cfg = rt.config.get(incoming.guildId)
  if (cfg === null) return null
  rt.storage.ensureGuild(incoming.guildId, now)

  switch (incoming.kind) {
    case 'join':
      return handleJoin(rt, cfg, incoming, now)
    case 'timezone':
      return handleTimezone(rt, cfg, incoming, now)
    case 'availability':
      return handleAvailability(rt, cfg, incoming.userId)
    case 'pause':
      return handlePause(rt, cfg, incoming.userId, now)
    case 'resume':
      return handleResume(rt, cfg, incoming.userId, now)
    case 'forget':
      return handleForget(rt, cfg, incoming.userId)
    case 'admin-status':
      return handleAdminStatus(rt, cfg)
    case 'admin-config':
      return handleAdminConfig(cfg)
    case 'admin-pair':
      return handleAdminPair(rt, cfg, incoming, now)
    case 'button':
      return handleButton(rt, cfg, incoming, now)
    case 'select':
      return handleSelect(rt, cfg, incoming, now)
    case 'thread-message': {
      const pairing = rt.storage.pairingByThread(cfg.guildId, incoming.threadId)
      if (pairing === null || !pairing.members.includes(incoming.userId)) return null
      rt.storage.touchPairingMember(cfg.guildId, pairing.id, incoming.userId, incoming.at)
      return null
    }
  }
}
