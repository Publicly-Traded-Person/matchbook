// The exam for Task 13, "The app: handlers, jobs, and the simulated month".
//
// One describe block per Proof leg (a) through (h) and (j); leg (i) is the
// simulated month and lives in tests/e2e-month.test.ts. Every test name carries
// its leg letter and the Machine clause it encodes, so a failure maps back to
// the contract.
//
// Nothing here reads the wall clock or sleeps: every instant is derived from the
// fixed NOW below and handed to `handle` or `tick` as `now`. Every world opens
// its own `:memory:` database, so no two tests share state.

import { describe, expect, test } from 'bun:test'

import type {
  App,
  DiscordPort,
  GuildConfig,
  GuildId,
  Mask,
  MemberId,
  MemberRow,
  OutgoingMessage,
  PairingRecord,
  Reply,
  Storage,
} from '../src/types'
import { createApp } from '../src/app/index'
import { openStorage } from '../src/storage/sqlite'
import { parseConfig } from '../src/config/file-store'
import { renderCopy } from '../src/config/copy'
import { DEFAULT_MASK, sharedHours } from '../src/core/availability'
import { DEFAULT_MASK_LITERAL } from '../src/core/enrollment'
import { FakeDiscord } from './helpers/fake-discord'

// ------------------------------------------------------------------ fixtures --

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A fixed instant: 2026-01-01T00:00:00Z, a Thursday. */
const NOW = 1_767_225_600_000

const GUILD: GuildId = '600000000000000001'
const PARENT = '600000000000000002'
const CATEGORY = '600000000000000003'

/**
 * The config every world runs on. The copy overrides exist so the templates
 * take the variables the scheduling effects actually carry (`{start}`, `{by}`,
 * `{link}`); the assertions below render through this same config, so they stay
 * strict equalities. `admin-status` is deliberately left at its default: M8
 * asks for three literal lines no template produces, so the app builds them.
 */
const TOML = `
[[guilds]]
guild_id = "${GUILD}"
thread_parent_channel_id = "${PARENT}"
voice_category_id = "${CATEGORY}"
cadence_days = 14
holding_window_hours = 24
pull_forward_days = 3
negotiation_timeout_hours = 48
call_minutes = 30

[guilds.weights]
round-robin = 1.0

[guilds.copy]
proposal = "Proposal: {start}. Tap Works for me, or pick another time."
counter = "Counter: {start}."
one-confirmed = "One of you is in ({by}). Waiting on the other."
locked = "Locked in: {start}. The calendar file is attached."
room-open = "Starts in ten minutes. Your room: {link}"
tz-changed-locked-call = "Your timezone changed and this call now falls outside your hours. Keep it, or suggest a new time?"
met-everyone = "You have met everyone here, so I am reconnecting the two of you."
admin-pair-infeasible = "Those two have no available hours in common, so I will not pair them."
`

const EMPTY_MASK: Mask = '0'.repeat(168)
const CALL_MS = 30 * MINUTE
const ROOM_OPEN_LEAD_MS = 600_000
const ROOM_CLOSE_AFTER_MS = 3_600_000
const FOLLOW_UP_AFTER_MS = 86_400_000

// -------------------------------------------------------------- the recorder --

type CallName =
  | 'createPrivateThread'
  | 'post'
  | 'archiveThread'
  | 'createVoiceChannel'
  | 'deleteChannel'

type Call = { method: CallName; args: readonly unknown[]; result: unknown }

/**
 * A `DiscordPort` that delegates to the task's `FakeDiscord` and writes down
 * every call it forwards. The task does not pin the shape of the fake's own
 * `calls` entries, so the counting the Proof asks for happens here instead; the
 * fake is still the thing the app talks to.
 */
class Recorder implements DiscordPort {
  readonly calls: Call[] = []
  readonly posts: { channelId: string; message: OutgoingMessage }[] = []

  constructor(private readonly inner: DiscordPort) {}

  async createPrivateThread(
    guildId: GuildId,
    parentChannelId: string,
    name: string,
    members: readonly MemberId[],
  ): Promise<{ id: string; url: string }> {
    const result = await this.inner.createPrivateThread(guildId, parentChannelId, name, members)
    this.calls.push({
      method: 'createPrivateThread',
      args: [guildId, parentChannelId, name, members],
      result,
    })
    return result
  }

  async post(
    guildId: GuildId,
    channelId: string,
    message: OutgoingMessage,
  ): Promise<{ id: string }> {
    const result = await this.inner.post(guildId, channelId, message)
    this.calls.push({ method: 'post', args: [guildId, channelId, message], result })
    this.posts.push({ channelId, message })
    return result
  }

  async archiveThread(guildId: GuildId, threadId: string): Promise<void> {
    await this.inner.archiveThread(guildId, threadId)
    this.calls.push({ method: 'archiveThread', args: [guildId, threadId], result: undefined })
  }

  async createVoiceChannel(
    guildId: GuildId,
    categoryId: string,
    name: string,
    members: readonly MemberId[],
  ): Promise<{ id: string; url: string }> {
    const result = await this.inner.createVoiceChannel(guildId, categoryId, name, members)
    this.calls.push({
      method: 'createVoiceChannel',
      args: [guildId, categoryId, name, members],
      result,
    })
    return result
  }

  async deleteChannel(guildId: GuildId, channelId: string): Promise<void> {
    await this.inner.deleteChannel(guildId, channelId)
    this.calls.push({ method: 'deleteChannel', args: [guildId, channelId], result: undefined })
  }

  of(method: CallName): Call[] {
    return this.calls.filter((c) => c.method === method)
  }

  postsIn(channelId: string): OutgoingMessage[] {
    return this.posts.filter((p) => p.channelId === channelId).map((p) => p.message)
  }
}

// ----------------------------------------------------------------- the world --

type World = {
  storage: Storage
  cfg: GuildConfig
  fake: { postsTo(channelId: string): unknown[]; calls: unknown[] }
  discord: Recorder
  app: App
}

function makeWorld(): World {
  const storage = openStorage(':memory:')
  const config = parseConfig(TOML)
  const cfg = config.get(GUILD)
  if (cfg === null) throw new Error('the exam config is missing its guild')
  const fake = new FakeDiscord() as unknown as World['fake'] & DiscordPort
  const discord = new Recorder(fake)
  let n = 0
  const app = createApp({ storage, config, discord, ids: () => `x${++n}` })
  storage.ensureGuild(GUILD, NOW)
  return { storage, cfg, fake, discord, app }
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`the exam expected ${what}`)
  return value
}

function buttonIds(message: OutgoingMessage): string[] {
  return (message.buttons ?? []).map((b) => b.id)
}

function memberRow(id: MemberId, over: Partial<MemberRow> = {}): MemberRow {
  return {
    guildId: GUILD,
    id,
    state: 'active',
    timezone: 'UTC',
    tags: [],
    avoid: [],
    mask: DEFAULT_MASK,
    preset: 'any-reasonable-hour',
    eligibleAt: NOW,
    welcome: false,
    lastWelcomeAt: null,
    needsAck: false,
    checkinsIgnored: 0,
    checkinSentAt: null,
    overlapNoticeAt: null,
    joinedAt: NOW,
    ...over,
  }
}

/** Joins two members in UTC at `at` and ticks once, which pairs them. */
async function pairedWorld(at: number = NOW): Promise<
  World & { pairing: PairingRecord; threadId: string; proposalId: string; start: number }
> {
  const w = makeWorld()
  await w.app.handle({ kind: 'join', guildId: GUILD, userId: 'u1', timezone: 'UTC' }, at)
  await w.app.handle({ kind: 'join', guildId: GUILD, userId: 'u2', timezone: 'UTC' }, at)
  await w.app.tick(at)

  const pairing = must(w.storage.openPairings(GUILD)[0], 'a pairing after the first tick')
  const threadId = must(pairing.threadId, 'the pairing to carry a thread id')
  const proposal = must(
    w.storage.proposalsOf(GUILD, pairing.id).find((p) => p.state === 'open'),
    'an open proposal after the first tick',
  )
  return { ...w, pairing, threadId, proposalId: proposal.id, start: proposal.startUtc }
}

/** Both members tap Works for me, which locks the call. */
async function lockedWorld(at: number = NOW) {
  const w = await pairedWorld(at)
  for (const userId of ['u1', 'u2'] as const) {
    await w.app.handle(
      {
        kind: 'button',
        guildId: GUILD,
        userId,
        customId: `confirm:${w.proposalId}`,
        channelId: w.threadId,
      },
      at,
    )
  }
  return w
}

/**
 * Fixed-offset zones, so a local hour can be chosen without a DST surprise.
 * Offset zero is left out: the members below live in UTC, and a timezone change
 * to the same wall clock is not the change leg (g) is about.
 */
const FIXED_ZONES: readonly string[] = [
  ...Array.from({ length: 12 }, (_u, i) => `Etc/GMT+${i + 1}`),
  ...Array.from({ length: 14 }, (_u, i) => `Etc/GMT-${i + 1}`),
]

function localHourIn(ms: number, zone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
  return Number.parseInt(formatter.format(new Date(ms)), 10)
}

/** A zone whose local hour at `ms` is inside (or outside) the default 09-20 mask. */
function zoneWhereCallIs(ms: number, inside: boolean): string {
  for (const zone of FIXED_ZONES) {
    const hour = localHourIn(ms, zone)
    const fits = hour >= 9 && hour <= 20
    if (fits === inside) return zone
  }
  throw new Error(`no fixed-offset zone puts ${ms} ${inside ? 'inside' : 'outside'} 09-20`)
}

// ------------------------------------------------------------------- leg (a) --

describe('leg (a) [M1]: /join enrols, replies ephemerally and schedules eligible', () => {
  test('a join with a timezone stores the row, replies, and queues one eligible job', async () => {
    const w = makeWorld()

    const reply = must(
      await w.app.handle({ kind: 'join', guildId: GUILD, userId: 'u1', timezone: 'UTC' }, NOW),
      'a reply to /join',
    )

    // M1: stores a row with eligibleAt: now.
    const row = must(w.storage.getMember(GUILD, 'u1'), 'the joined member row')
    expect(row.eligibleAt).toBe(NOW)
    expect(row.state).toBe('active')
    expect(row.timezone).toBe('UTC')

    // M1: replies ephemerally with the rendered join-confirmation.
    expect(reply.ephemeral).toBe(true)
    expect(reply.content).toBe(renderCopy(w.cfg, 'join-confirmation'))

    // M1: schedules an eligible job at now, keyed by the member id.
    const eligible = w.storage.pendingJobs(GUILD).filter((j) => j.kind === 'eligible')
    expect(eligible.length).toBe(1)
    expect(eligible[0]!.runAt).toBe(NOW)
    expect(eligible[0]!.refId).toBe('u1')
  })

  test('a join with no timezone replies about the timezone and stores nothing', async () => {
    const w = makeWorld()

    const reply = must(
      await w.app.handle({ kind: 'join', guildId: GUILD, userId: 'u9' }, NOW),
      'a reply to a /join with no timezone',
    )

    expect(reply.ephemeral).toBe(true)
    expect(reply.content.toLowerCase()).toContain('timezone')
    expect(w.storage.getMember(GUILD, 'u9')).toBeNull()
  })
})

// ------------------------------------------------------------------- leg (b) --

describe('leg (b) [M2]: a tick introduces two strangers with a time on the table', () => {
  test('one pairing, one private thread, introduction then proposal, dates pushed out', async () => {
    const w = await pairedWorld()

    // M2: one pairing in storage, holding both members.
    const open = w.storage.openPairings(GUILD)
    expect(open.length).toBe(1)
    expect([...open[0]!.members].sort()).toEqual(['u1', 'u2'])

    // M2: one private thread naming both ids, under the configured parent.
    const threads = w.discord.of('createPrivateThread')
    expect(threads.length).toBe(1)
    expect(threads[0]!.args[1]).toBe(PARENT)
    expect([...(threads[0]!.args[3] as MemberId[])].sort()).toEqual(['u1', 'u2'])

    // M2: the introduction, then the proposal carrying its two buttons.
    const posts = w.discord.postsIn(w.threadId)
    expect(posts.length).toBeGreaterThanOrEqual(2)
    expect(posts[0]!.content).toBe(renderCopy(w.cfg, 'introduction'))
    expect(posts[1]!.content).toBe(renderCopy(w.cfg, 'proposal', { start: w.start }))
    expect(buttonIds(posts[1]!).sort()).toEqual(
      [`confirm:${w.proposalId}`, `counter:${w.proposalId}`].sort(),
    )

    // `postsTo` is the fake's own view of the same thread.
    expect(w.fake.postsTo(w.threadId).length).toBe(posts.length)

    // M2: the proposed start is one of Task 1's shared hours, 3 to 10 days out.
    const a = must(w.storage.getMember(GUILD, 'u1'), 'the first member row')
    const b = must(w.storage.getMember(GUILD, 'u2'), 'the second member row')
    expect(sharedHours(a, b, NOW, 240)).toContain(w.start)
    expect(w.start).toBeGreaterThanOrEqual(NOW + 3 * DAY)
    expect(w.start).toBeLessThanOrEqual(NOW + 10 * DAY)
    expect(w.storage.proposalsOf(GUILD, w.pairing.id).length).toBe(1)

    // M2: both rows are eligible again one cadence from now.
    expect(a.eligibleAt).toBe(NOW + w.cfg.cadenceMs)
    expect(b.eligibleAt).toBe(NOW + w.cfg.cadenceMs)

    // M2: a negotiation-release job is pending against the pairing.
    const release = w.storage
      .pendingJobs(GUILD)
      .filter((j) => j.kind === 'negotiation-release' && j.refId === w.pairing.id)
    expect(release.length).toBe(1)
  })
})

// ------------------------------------------------------------------- leg (c) --

describe('leg (c) [M3]: two confirmations lock the call', () => {
  test('state locked, an .ics post carrying the locked copy, and the three call jobs', async () => {
    const w = await lockedWorld()

    // M3: storage shows locked.
    expect(must(w.storage.getPairing(GUILD, w.pairing.id), 'the pairing').state).toBe('locked')

    // M3: the thread receives the locked copy with a calendar file attached.
    const locked = w.discord
      .postsIn(w.threadId)
      .filter((m) => m.file !== undefined && m.file.name.endsWith('.ics'))
    expect(locked.length).toBe(1)
    expect(locked[0]!.content).toBe(renderCopy(w.cfg, 'locked', { start: w.start }))

    // M3: room-open, room-close and follow-up at Task 6's due times.
    const pending = w.storage.pendingJobs(GUILD).filter((j) => j.refId === w.pairing.id)
    const at = (kind: string): number[] =>
      pending.filter((j) => j.kind === kind).map((j) => j.runAt)
    expect(at('room-open')).toEqual([w.start - ROOM_OPEN_LEAD_MS])
    expect(at('room-close')).toEqual([w.start + CALL_MS + ROOM_CLOSE_AFTER_MS])
    expect(at('follow-up')).toEqual([w.start + CALL_MS + FOLLOW_UP_AFTER_MS])
  })
})

// ------------------------------------------------------------------- leg (d) --

describe('leg (d) [M4]: the voice room opens ten minutes early and closes after', () => {
  test('one createVoiceChannel with the configured category, the link post, one deleteChannel', async () => {
    const w = await lockedWorld()

    await w.app.tick(w.start - ROOM_OPEN_LEAD_MS)

    // M4: created once, in the configured category, for exactly the two members.
    const rooms = w.discord.of('createVoiceChannel')
    expect(rooms.length).toBe(1)
    expect(rooms[0]!.args[1]).toBe(CATEGORY)
    expect([...(rooms[0]!.args[3] as MemberId[])].sort()).toEqual(['u1', 'u2'])

    // M4: the thread gets the room-open copy with the returned url in it.
    const room = rooms[0]!.result as { id: string; url: string }
    const posts = w.discord.postsIn(w.threadId)
    expect(posts[posts.length - 1]!.content).toBe(
      renderCopy(w.cfg, 'room-open', { link: room.url }),
    )

    // M4: room-close deletes that channel, once.
    await w.app.tick(w.start + CALL_MS + ROOM_CLOSE_AFTER_MS)
    const deletes = w.discord.of('deleteChannel')
    expect(deletes.length).toBe(1)
    expect(deletes[0]!.args[1]).toBe(room.id)
  })
})

// ------------------------------------------------------------------- leg (e) --

describe('leg (e) [M5]: the follow-up asks, and each member answers once', () => {
  test('follow-up post, completed, yes and notyet recorded, a second answer records nothing', async () => {
    const w = await lockedWorld()
    const followUpAt = w.start + CALL_MS + FOLLOW_UP_AFTER_MS
    await w.app.tick(w.start - ROOM_OPEN_LEAD_MS)
    await w.app.tick(w.start + CALL_MS + ROOM_CLOSE_AFTER_MS)
    await w.app.tick(followUpAt)

    // M5: the follow-up copy, with one button per answer.
    const asked = w.discord
      .postsIn(w.threadId)
      .filter((m) => m.content === renderCopy(w.cfg, 'follow-up'))
    expect(asked.length).toBe(1)
    expect(buttonIds(asked[0]!).sort()).toEqual(
      [`yes:${w.pairing.id}`, `notyet:${w.pairing.id}`].sort(),
    )

    // M5: the pairing is completed.
    expect(must(w.storage.getPairing(GUILD, w.pairing.id), 'the pairing').state).toBe('completed')

    // M5: yes records connected true, notyet records connected false.
    await w.app.handle(
      {
        kind: 'button',
        guildId: GUILD,
        userId: 'u1',
        customId: `yes:${w.pairing.id}`,
        channelId: w.threadId,
      },
      followUpAt + MINUTE,
    )
    await w.app.handle(
      {
        kind: 'button',
        guildId: GUILD,
        userId: 'u2',
        customId: `notyet:${w.pairing.id}`,
        channelId: w.threadId,
      },
      followUpAt + 2 * MINUTE,
    )

    const answered = w.storage.outcomesOf(GUILD, w.pairing.id)
    expect(answered.length).toBe(2)
    expect(must(answered.find((o) => o.memberId === 'u1'), "u1's outcome").connected).toBe(true)
    expect(must(answered.find((o) => o.memberId === 'u2'), "u2's outcome").connected).toBe(false)

    // M5: a second answer from the same member replies ephemerally and stores nothing.
    const again = must(
      await w.app.handle(
        {
          kind: 'button',
          guildId: GUILD,
          userId: 'u1',
          customId: `yes:${w.pairing.id}`,
          channelId: w.threadId,
        },
        followUpAt + 3 * MINUTE,
      ),
      'a reply to a second answer',
    )
    expect(again.ephemeral).toBe(true)
    expect(w.storage.outcomesOf(GUILD, w.pairing.id).length).toBe(2)
  })
})

// ------------------------------------------------------------------- leg (f) --

/**
 * Drives a pairing to a silent end: nobody confirms, so negotiation-release
 * fires, and nobody posts, so the release review expires it. Leg (f) says
 * "completed"; a pairing cannot reach state `completed` with no tap and no
 * message, so this reads it as the Context's "a pairing ends at completed or
 * expired" and asserts a terminal state.
 */
async function silentlyEndedWorld() {
  const w = await pairedWorld()
  await w.app.tick(NOW + w.cfg.negotiationTimeoutMs) // negotiation-release
  await w.app.tick(NOW + w.cfg.negotiationTimeoutMs + 7 * DAY) // release review, no activity
  return w
}

describe('leg (f) [M6]: silence raises the gate, and the check-in lowers it', () => {
  test('both rows need an acknowledgement after a silent pairing ends', async () => {
    const w = await silentlyEndedWorld()

    const ended = must(w.storage.getPairing(GUILD, w.pairing.id), 'the ended pairing')
    expect(['completed', 'expired']).toContain(ended.state)
    expect(must(w.storage.getMember(GUILD, 'u1'), 'u1').needsAck).toBe(true)
    expect(must(w.storage.getMember(GUILD, 'u2'), 'u2').needsAck).toBe(true)
  })

  test('the check-in goes to a thread of one, and no pairing includes them until keep', async () => {
    const w = await silentlyEndedWorld()
    const eligibleAt = must(w.storage.getMember(GUILD, 'u1'), 'u1').eligibleAt
    expect(eligibleAt).toBe(NOW + w.cfg.cadenceMs)

    // A fresh stranger, eligible before the check-in lands.
    await w.app.handle({ kind: 'join', guildId: GUILD, userId: 'u3', timezone: 'UTC' }, NOW + 13 * DAY)
    await w.app.tick(NOW + 13 * DAY)

    const threadsBefore = w.discord.of('createPrivateThread').length
    await w.app.tick(eligibleAt)

    // M6: a private thread with only that member, carrying the check-in copy.
    const alone = w.discord
      .of('createPrivateThread')
      .slice(threadsBefore)
      .filter((c) => (c.args[3] as MemberId[]).length === 1 && (c.args[3] as MemberId[])[0] === 'u1')
    expect(alone.length).toBe(1)
    const checkinThread = (alone[0]!.result as { id: string }).id
    const checkinPosts = w.discord.postsIn(checkinThread)
    expect(checkinPosts.length).toBe(1)
    expect(checkinPosts[0]!.content).toBe(renderCopy(w.cfg, 'check-in'))
    expect(buttonIds(checkinPosts[0]!).sort()).toEqual(['keep:u1', 'pausme:u1'].sort())

    // M6: no pairing includes them while the gate is up.
    const holds = (id: MemberId): boolean =>
      w.storage.openPairings(GUILD).some((p) => p.members.includes(id))
    expect(holds('u1')).toBe(false)

    // Keep, then a tick with the stranger still waiting, pairs them. The fourth
    // member joins only to guarantee a due `eligible` job (M1); an all-zero mask
    // keeps them out of the pool, so the pairing that forms is u1 with u3.
    await w.app.handle(
      {
        kind: 'button',
        guildId: GUILD,
        userId: 'u1',
        customId: 'keep:u1',
        channelId: checkinThread,
      },
      eligibleAt + HOUR,
    )
    expect(must(w.storage.getMember(GUILD, 'u1'), 'u1').needsAck).toBe(false)

    await w.app.handle({ kind: 'join', guildId: GUILD, userId: 'u4', timezone: 'UTC' }, eligibleAt + 2 * HOUR)
    w.storage.upsertMember(
      memberRow('u4', {
        mask: EMPTY_MASK,
        preset: 'custom',
        eligibleAt: eligibleAt + 2 * HOUR,
        joinedAt: eligibleAt + 2 * HOUR,
      }),
    )
    for (let t = eligibleAt + 2 * HOUR; t <= eligibleAt + 3 * DAY; t += HOUR) await w.app.tick(t)

    expect(holds('u1')).toBe(true)
    const fresh = must(
      w.storage.openPairings(GUILD).find((p) => p.members.includes('u1')),
      "u1's new pairing",
    )
    expect([...fresh.members].sort()).toEqual(['u1', 'u3'])
  })

  test("a partner's yes clears the gate for both, a partner's notyet for neither", async () => {
    const yes = await silentlyEndedWorld()
    await yes.app.handle(
      {
        kind: 'button',
        guildId: GUILD,
        userId: 'u1',
        customId: `yes:${yes.pairing.id}`,
        channelId: yes.threadId,
      },
      NOW + 10 * DAY,
    )
    expect(must(yes.storage.getMember(GUILD, 'u1'), 'u1').needsAck).toBe(false)
    expect(must(yes.storage.getMember(GUILD, 'u2'), 'u2').needsAck).toBe(false)

    const no = await silentlyEndedWorld()
    await no.app.handle(
      {
        kind: 'button',
        guildId: GUILD,
        userId: 'u1',
        customId: `notyet:${no.pairing.id}`,
        channelId: no.threadId,
      },
      NOW + 10 * DAY,
    )
    expect(must(no.storage.getMember(GUILD, 'u1'), 'u1').needsAck).toBe(true)
    expect(must(no.storage.getMember(GUILD, 'u2'), 'u2').needsAck).toBe(true)
  })
})

// ------------------------------------------------------------------- leg (g) --

describe('leg (g) [M7]: pause, resume, forget, and a timezone that moves a call', () => {
  test('pause reads back paused; resume and a second join both return the member', async () => {
    const w = await pairedWorld()
    const lastPairingAt = NOW // the pairing above was created at NOW

    await w.app.handle({ kind: 'pause', guildId: GUILD, userId: 'u1' }, NOW + HOUR)
    expect(must(w.storage.getMember(GUILD, 'u1'), 'u1').state).toBe('paused')

    await w.app.handle({ kind: 'resume', guildId: GUILD, userId: 'u1' }, NOW + 2 * HOUR)
    const resumed = must(w.storage.getMember(GUILD, 'u1'), 'u1 after resume')
    expect(resumed.state).toBe('active')
    expect(resumed.eligibleAt).toBe(Math.max(NOW + 2 * HOUR, lastPairingAt + w.cfg.cadenceMs))

    await w.app.handle({ kind: 'pause', guildId: GUILD, userId: 'u1' }, NOW + 3 * HOUR)
    await w.app.handle({ kind: 'join', guildId: GUILD, userId: 'u1', timezone: 'UTC' }, NOW + 4 * HOUR)
    const rejoined = must(w.storage.getMember(GUILD, 'u1'), 'u1 after rejoining')
    expect(rejoined.state).toBe('active')
    expect(rejoined.eligibleAt).toBe(Math.max(NOW + 4 * HOUR, lastPairingAt + w.cfg.cadenceMs))
  })

  test('forget deletes the row and replies with the forgotten copy', async () => {
    const w = await pairedWorld()

    const reply = must(
      await w.app.handle({ kind: 'forget', guildId: GUILD, userId: 'u1' }, NOW + HOUR),
      'a reply to /forget',
    )
    expect(w.storage.getMember(GUILD, 'u1')).toBeNull()
    expect(reply.content).toBe(renderCopy(w.cfg, 'forgotten'))
  })

  test('a timezone that moves a locked call outside the mask asks; one that does not says nothing', async () => {
    const w = await lockedWorld()

    // A zone where the locked start still falls inside 09-20 local: nothing said.
    const before = w.discord.postsIn(w.threadId).length
    const fits = zoneWhereCallIs(w.start, true)
    await w.app.handle({ kind: 'timezone', guildId: GUILD, userId: 'u1', timezone: fits }, NOW + HOUR)
    expect(must(w.storage.getMember(GUILD, 'u1'), 'u1').timezone).toBe(fits)
    expect(w.discord.postsIn(w.threadId).length).toBe(before)

    // A zone where it no longer does: the thread is asked which way to go.
    const moved = zoneWhereCallIs(w.start, false)
    await w.app.handle({ kind: 'timezone', guildId: GUILD, userId: 'u1', timezone: moved }, NOW + 2 * HOUR)
    expect(must(w.storage.getMember(GUILD, 'u1'), 'u1').timezone).toBe(moved)

    const posts = w.discord.postsIn(w.threadId)
    expect(posts.length).toBe(before + 1)
    expect(posts[posts.length - 1]!.content).toBe(renderCopy(w.cfg, 'tz-changed-locked-call'))
    expect(buttonIds(posts[posts.length - 1]!).sort()).toEqual(
      [`keepit:${w.pairing.id}`, `newtime:${w.pairing.id}`].sort(),
    )
  })
})

// ------------------------------------------------------------------- leg (h) --

describe('leg (h) [M8]: the admin commands', () => {
  test('admin-pair forces a feasible pair and refuses an infeasible one', async () => {
    const w = makeWorld()
    w.storage.upsertMember(memberRow('u1'))
    w.storage.upsertMember(memberRow('u2'))
    // Disjoint masks: Monday 00-05 local against Monday 12-17 local, same zone.
    const early = ('1'.repeat(6) + '0'.repeat(162)) as Mask
    const late = ('0'.repeat(12) + '1'.repeat(6) + '0'.repeat(150)) as Mask
    w.storage.upsertMember(memberRow('u3', { mask: early, preset: 'custom' }))
    w.storage.upsertMember(memberRow('u4', { mask: late, preset: 'custom' }))

    await w.app.handle(
      { kind: 'admin-pair', guildId: GUILD, userId: 'admin', a: 'u1', b: 'u2' },
      NOW,
    )
    const forced = w.storage.pairingsOf(GUILD, 'u1')
    expect(forced.length).toBe(1)
    expect(forced[0]!.novelty).toBe('forced')
    expect([...forced[0]!.members].sort()).toEqual(['u1', 'u2'])

    const refused = must(
      await w.app.handle(
        { kind: 'admin-pair', guildId: GUILD, userId: 'admin', a: 'u3', b: 'u4' },
        NOW,
      ),
      'a reply to an infeasible /admin-pair',
    )
    expect(refused.content).toBe(renderCopy(w.cfg, 'admin-pair-infeasible'))
    expect(w.storage.pairingsOf(GUILD, 'u3').length).toBe(0)
    expect(w.storage.pairingsOf(GUILD, 'u4').length).toBe(0)
  })

  test('admin-status reports the pool, the open pairings and the reconnection share', async () => {
    const w = makeWorld()
    // Two members in the pool. The one open pairing is held by two paused
    // members, so "pool" counts 2 whether it is read as the pool of §4a or as
    // the active membership.
    w.storage.upsertMember(memberRow('p1', { state: 'paused' }))
    w.storage.upsertMember(memberRow('p2', { state: 'paused' }))
    w.storage.upsertMember(memberRow('p3'))
    w.storage.upsertMember(memberRow('p4'))
    w.storage.insertPairing(
      {
        id: 'pair-open',
        guildId: GUILD,
        members: ['p1', 'p2'],
        state: 'time_proposed',
        novelty: 'fresh',
        createdAt: NOW - DAY,
        threadId: 'thread-open',
        voiceChannelId: null,
      },
      [
        { guildId: GUILD, pairingId: 'pair-open', memberId: 'p1', lastActivityAt: null },
        { guildId: GUILD, pairingId: 'pair-open', memberId: 'p2', lastActivityAt: null },
      ],
    )

    const lines = (reply: Reply): string[] => reply.content.split('\n').map((l) => l.trim().toLowerCase())

    const first = must(
      await w.app.handle({ kind: 'admin-status', guildId: GUILD, userId: 'admin' }, NOW),
      'a reply to /admin-status',
    )
    expect(lines(first)).toContain('pool: 2')
    expect(lines(first)).toContain('open pairings: 1')
    expect(lines(first)).toContain('reconnection share: 0%')

    // A second pairing, this one a reconnection: one of two is 50%.
    w.storage.insertPairing(
      {
        id: 'pair-again',
        guildId: GUILD,
        members: ['p3', 'p4'],
        state: 'completed',
        novelty: 'reconnect',
        createdAt: NOW - 2 * DAY,
        threadId: 'thread-again',
        voiceChannelId: null,
      },
      [
        { guildId: GUILD, pairingId: 'pair-again', memberId: 'p3', lastActivityAt: null },
        { guildId: GUILD, pairingId: 'pair-again', memberId: 'p4', lastActivityAt: null },
      ],
    )

    const second = must(
      await w.app.handle({ kind: 'admin-status', guildId: GUILD, userId: 'admin' }, NOW),
      'a second reply to /admin-status',
    )
    expect(lines(second)).toContain('reconnection share: 50%')
  })
})

// ------------------------------------------------------------------- leg (j) --

describe('leg (j) [M10]: the two default masks are the same string', () => {
  test('DEFAULT_MASK equals DEFAULT_MASK_LITERAL', () => {
    expect(DEFAULT_MASK).toBe(DEFAULT_MASK_LITERAL)
  })
})
