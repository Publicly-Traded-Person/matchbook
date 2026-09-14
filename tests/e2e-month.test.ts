// The exam for Task 13's Proof leg (i), Machine clause M9: the simulated month.
//
// Twenty members from tests/fixtures/members-20.json join on day 0 (two of them
// later, on day 3 and day 10), the app is ticked every simulated hour for thirty
// days, and a seeded generator decides who taps Works for me and who speaks up
// in a thread. Nothing here sleeps or reads the wall clock: every instant is
// derived from the fixed START below and handed to `handle` or `tick`.
//
// The assertions are structural, not sequence-dependent: the exam cannot predict
// which pairs the matcher forms, so it checks the invariants M9 names over
// whatever month the app produced.

import { describe, expect, test } from 'bun:test'

import type {
  App,
  AvailabilityPreset,
  DiscordPort,
  GuildId,
  MemberId,
  OutgoingMessage,
  PairingRecord,
  Storage,
} from '../src/types'
import { createApp } from '../src/app/index'
import { openStorage } from '../src/storage/sqlite'
import { parseConfig } from '../src/config/file-store'
import { renderCopy } from '../src/config/copy'
import { FakeDiscord } from './helpers/fake-discord'
import fixtureJson from './fixtures/members-20.json'

// ------------------------------------------------------------------ fixtures --

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 2026-01-01T00:00:00Z. Day 0 of the simulated month. */
const START = 1_767_225_600_000
const FINAL = START + 30 * DAY

const GUILD: GuildId = '600000000000000001'
const PARENT = '600000000000000002'
const CATEGORY = '600000000000000003'

const ROOM_OPEN_LEAD_MS = 600_000
const ROOM_CLOSE_AFTER_MS = 3_600_000

/** The same inline config the handler exam runs on, with the placeholder ids. */
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

type FixtureMember = { id: MemberId; timezone: string; preset: AvailabilityPreset }

const FIXTURE: FixtureMember[] = (() => {
  const raw = fixtureJson as unknown
  if (Array.isArray(raw)) return raw as FixtureMember[]
  const wrapped = (raw as { members?: unknown }).members
  if (Array.isArray(wrapped)) return wrapped as FixtureMember[]
  throw new Error('tests/fixtures/members-20.json must hold an array of members')
})()

// --------------------------------------------------------- seeded generator --

/** mulberry32, defined here so the month is reproducible without a clock. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** How often a member taps Works for me on a proposal they are shown. */
const CONFIRM_CHANCE = 0.7
/** How often one member speaks up in the thread after an introduction. */
const THREAD_MESSAGE_CHANCE = 0.5
/** How often a member answers the follow-up, and how often the answer is Yes. */
const ANSWER_CHANCE = 0.7
const CONNECTED_CHANCE = 0.6

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
 * every call it forwards, so the counting M9 asks for does not depend on the
 * shape of the fake's own entries.
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

function buttonIds(message: OutgoingMessage): string[] {
  return (message.buttons ?? []).map((b) => b.id)
}

/** An unordered member pair, as a key. */
function pairKey(members: readonly MemberId[]): string {
  return [...members].sort().join('|')
}

// ------------------------------------------------------------------ the month --

describe('leg (i) [M9]: a simulated month over twenty members', () => {
  test('the fixture holds m01 through m20 across a spread of zones and presets', () => {
    expect(FIXTURE.length).toBe(20)
    expect(FIXTURE.map((m) => m.id)).toEqual(
      Array.from({ length: 20 }, (_u, i) => `m${String(i + 1).padStart(2, '0')}`),
    )
    const zones = new Set(FIXTURE.map((m) => m.timezone))
    expect(zones.size).toBeGreaterThanOrEqual(5)
    expect(zones.has('Etc/GMT+8')).toBe(true)
    expect(zones.has('Etc/GMT-9')).toBe(true)
    for (const m of FIXTURE) {
      expect(typeof m.preset).toBe('string')
      expect([
        'weekdays-9-5-off',
        'evenings-only',
        'weekends-only',
        'any-reasonable-hour',
        'custom',
      ]).toContain(m.preset)
    }
  })

  test(
    'thirty days of hourly ticks hold every invariant M9 names',
    async () => {
      const storage: Storage = openStorage(':memory:')
      const config = parseConfig(TOML)
      const cfg = config.get(GUILD)
      if (cfg === null) throw new Error('the exam config is missing its guild')
      const fake = new FakeDiscord() as unknown as DiscordPort & {
        postsTo(channelId: string): unknown[]
      }
      const discord = new Recorder(fake)
      let n = 0
      const app: App = createApp({ storage, config, discord, ids: () => `x${++n}` })
      storage.ensureGuild(GUILD, START)

      const rng = makeRng(20_260_101)
      const callMs = cfg.callMinutes * MINUTE

      const join = async (m: FixtureMember, at: number): Promise<void> => {
        await app.handle(
          { kind: 'join', guildId: GUILD, userId: m.id, timezone: m.timezone },
          at,
        )
      }

      // Eighteen on day 0; the last two arrive on day 3 and day 10.
      const late = new Map<number, FixtureMember>([
        [START + 3 * DAY, FIXTURE[18]!],
        [START + 10 * DAY, FIXTURE[19]!],
      ])
      for (const m of FIXTURE.slice(0, 18)) await join(m, START)

      // Every post the app makes is answered once, in the order it was made.
      let cursor = 0
      const drain = async (now: number): Promise<void> => {
        while (cursor < discord.posts.length) {
          const entry = discord.posts[cursor++]!
          const ids = buttonIds(entry.message)
          const confirm = ids.find((id) => id.startsWith('confirm:'))
          const yes = ids.find((id) => id.startsWith('yes:'))
          const pairing = storage.pairingByThread(GUILD, entry.channelId)
          if (pairing === null) continue

          if (confirm !== undefined) {
            for (const member of pairing.members) {
              if (rng() >= CONFIRM_CHANCE) continue
              await app.handle(
                {
                  kind: 'button',
                  guildId: GUILD,
                  userId: member,
                  customId: confirm,
                  channelId: entry.channelId,
                },
                now,
              )
            }
            if (rng() < THREAD_MESSAGE_CHANCE) {
              await app.handle(
                {
                  kind: 'thread-message',
                  guildId: GUILD,
                  userId: pairing.members[0]!,
                  threadId: entry.channelId,
                  at: now,
                },
                now,
              )
            }
          } else if (yes !== undefined) {
            for (const member of pairing.members) {
              if (rng() >= ANSWER_CHANCE) continue
              const connected = rng() < CONNECTED_CHANCE
              await app.handle(
                {
                  kind: 'button',
                  guildId: GUILD,
                  userId: member,
                  customId: connected ? yes : `notyet:${pairing.id}`,
                  channelId: entry.channelId,
                },
                now,
              )
            }
          }
        }
      }

      for (let t = START; t <= FINAL; t += HOUR) {
        const arriving = late.get(t)
        if (arriving !== undefined) await join(arriving, t)
        await app.tick(t)
        await drain(t)

        // M9: at no tick is any member in two open pairings.
        const busy = storage.openPairings(GUILD).flatMap((p) => [...p.members])
        expect(new Set(busy).size).toBe(busy.length)
      }

      // ------------------------------------------------------ what the month left --

      const byId = new Map<string, PairingRecord>()
      for (const m of FIXTURE) {
        for (const p of storage.pairingsOf(GUILD, m.id)) byId.set(p.id, p)
      }
      const pairings = [...byId.values()]
      expect(pairings.length).toBeGreaterThan(0)

      // M9: every pairing has a thread.
      for (const p of pairings) {
        expect(p.threadId).not.toBeNull()
      }

      /** The locked start of a pairing, or null if it never locked one in. */
      const lockedStart = (p: PairingRecord): number | null => {
        const locked = storage.proposalsOf(GUILD, p.id).find((x) => x.state === 'locked')
        return locked === undefined ? null : locked.startUtc
      }
      const opened = (p: PairingRecord): boolean => {
        const start = lockedStart(p)
        return start !== null && start - ROOM_OPEN_LEAD_MS <= FINAL
      }
      const closed = (p: PairingRecord): boolean => {
        const start = lockedStart(p)
        return start !== null && start + callMs + ROOM_CLOSE_AFTER_MS <= FINAL
      }

      // M9: one createVoiceChannel and one deleteChannel for every pairing whose
      // call has been and gone, none for one whose room has not opened yet.
      // Attribution is by the unordered member pair the room was created for.
      const expectedOpen = pairings.filter(opened).length
      const expectedClose = pairings.filter(closed).length
      expect(expectedOpen).toBeGreaterThan(0)

      const roomCalls = discord.of('createVoiceChannel')
      const deleteIds = discord.of('deleteChannel').map((c) => c.args[1] as string)
      expect(roomCalls.length).toBe(expectedOpen)
      expect(deleteIds.length).toBe(expectedClose)
      // No room is deleted twice.
      expect(new Set(deleteIds).size).toBe(deleteIds.length)

      const roomsByPair = new Map<string, string[]>()
      for (const call of roomCalls) {
        const key = pairKey(call.args[3] as MemberId[])
        const room = (call.result as { id: string }).id
        roomsByPair.set(key, [...(roomsByPair.get(key) ?? []), room])
      }
      const deleted = new Set(deleteIds)
      const pairingsByPair = new Map<string, PairingRecord[]>()
      for (const p of pairings) {
        const key = pairKey(p.members)
        pairingsByPair.set(key, [...(pairingsByPair.get(key) ?? []), p])
      }
      for (const [key, list] of pairingsByPair) {
        const rooms = roomsByPair.get(key) ?? []
        expect(rooms.length).toBe(list.filter(opened).length)
        expect(rooms.filter((id) => deleted.has(id)).length).toBe(list.filter(closed).length)
      }

      // M9: every completed pairing received exactly one follow-up post.
      const followUp = renderCopy(cfg, 'follow-up')
      const completed = pairings.filter((p) => p.state === 'completed')
      for (const p of completed) {
        const asked = discord
          .postsIn(p.threadId ?? '')
          .filter((m) => m.content === followUp)
        expect(asked.length).toBe(1)
      }

      // M9: nobody is paired again sooner than one cadence less the pull-forward.
      const minimumGap = cfg.cadenceMs - cfg.pullForwardMaxMs
      for (const m of FIXTURE) {
        const mine = storage
          .pairingsOf(GUILD, m.id)
          .map((p) => p.createdAt)
          .sort((a, b) => a - b)
        for (let i = 1; i < mine.length; i++) {
          expect(mine[i]! - mine[i - 1]!).toBeGreaterThanOrEqual(minimumGap)
        }
      }

      // M9: the two numbers the month reports.
      const outcomes = storage.allOutcomes(GUILD)
      const connectedPairings = new Set(
        outcomes.filter((o) => o.connected).map((o) => o.pairingId),
      )
      const completionRate =
        completed.length === 0
          ? 0
          : completed.filter((p) => connectedPairings.has(p.id)).length / completed.length
      const reconnectionShare =
        pairings.filter((p) => p.novelty === 'reconnect').length / pairings.length

      console.log(
        `completion rate ${completionRate}, reconnection share ${reconnectionShare} ` +
          `(${pairings.length} pairings, ${completed.length} completed, ${expectedOpen} calls)`,
      )
      for (const value of [completionRate, reconnectionShare]) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    },
    600_000,
  )
})
