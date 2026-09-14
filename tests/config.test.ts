// Exam for Task 10 (config file and copy templates). Every test names the
// Proof leg it encodes and the Machine clause that leg comes from.

import { describe, expect, test } from 'bun:test'
import type { ConfigStore, CopyKey, GuildConfig } from '../src/types'
import { loadConfig, parseConfig } from '../src/config/file-store'
import { DEFAULT_COPY, renderCopy } from '../src/config/copy'

/** The example config lives at the repo root, one level above tests/. */
const EXAMPLE_PATH = `${import.meta.dir}/../config.example.toml`

const REQUIRED_ONLY = `
[[guilds]]
guild_id = "111111111111111111"
thread_parent_channel_id = "222222222222222222"
voice_category_id = "333333333333333333"
`

/** REQUIRED_ONLY with one of the three required fields dropped. */
function withoutField(field: string): string {
  return REQUIRED_ONLY.split('\n')
    .filter((line) => !line.trimStart().startsWith(`${field} =`))
    .join('\n')
}

function onlyGuild(store: ConfigStore): GuildConfig {
  const ids = store.guildIds()
  expect(ids).toHaveLength(1)
  const cfg = store.get(ids[0]!)
  expect(cfg).not.toBeNull()
  return cfg as GuildConfig
}

/** Asserts `fn` throws an Error whose message contains `needle`. */
function throwsNaming(fn: () => unknown, needle: string): void {
  let caught: unknown = undefined
  let threw = false
  try {
    fn()
  } catch (err) {
    threw = true
    caught = err
  }
  expect(threw).toBe(true)
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toContain(needle)
}

// Every member of the CopyKey union, written out because a type union is not
// enumerable at runtime. Typed as CopyKey[] so a wrong or stale key fails tsc.
const ALL_COPY_KEYS: readonly CopyKey[] = [
  'join-confirmation',
  'join-updated',
  'resumed',
  'paused',
  'forgotten',
  'no-overlap',
  'holding-for-stranger',
  'met-everyone',
  'introduction',
  'proposal',
  'counter',
  'one-confirmed',
  'locked',
  'released-timeout',
  'released-overlap',
  'released-limit',
  'room-open',
  'follow-up',
  'follow-up-thanks',
  'check-in',
  'check-in-kept',
  'tz-changed-locked-call',
  'pick-another-time',
  'availability-menu',
  'availability-saved',
  'admin-status',
  'admin-pair-infeasible',
]

// --------------------------------------------------------------- leg (a) --

describe('leg (a) [M1]: loadConfig on the shipped config.example.toml', () => {
  test('yields exactly one guild id', () => {
    const store = loadConfig(EXAMPLE_PATH)
    expect(store.guildIds()).toHaveLength(1)
  })

  test('its config carries the six literal values of M1', () => {
    const cfg = onlyGuild(loadConfig(EXAMPLE_PATH))
    expect(cfg.cadenceMs).toBe(1209600000)
    expect(cfg.holdingWindowMs).toBe(86400000)
    expect(cfg.pullForwardMaxMs).toBe(259200000)
    expect(cfg.negotiationTimeoutMs).toBe(172800000)
    expect(cfg.callMinutes).toBe(30)
    expect(cfg.weights).toEqual({ 'round-robin': 1 })
  })

  test('its guild id and the two required channel ids are the ones it was keyed by', () => {
    const store = loadConfig(EXAMPLE_PATH)
    const cfg = onlyGuild(store)
    expect(cfg.guildId).toBe(store.guildIds()[0]!)
    expect(typeof cfg.threadParentChannelId).toBe('string')
    expect(cfg.threadParentChannelId.length).toBeGreaterThan(0)
    expect(typeof cfg.voiceCategoryId).toBe('string')
    expect(cfg.voiceCategoryId.length).toBeGreaterThan(0)
  })

  test("copy['join-confirmation'] is a non-empty string read from the file's [guilds.copy] table", async () => {
    const text = await Bun.file(EXAMPLE_PATH).text()
    // M2 pins cfg.copy to {} when the table is absent, so an own key here can
    // only have come from the file itself.
    expect(text).toContain('[guilds.copy]')
    const cfg = onlyGuild(loadConfig(EXAMPLE_PATH))
    expect(Object.keys(cfg.copy)).toContain('join-confirmation')
    const value = cfg.copy['join-confirmation']
    expect(typeof value).toBe('string')
    expect((value as string).length).toBeGreaterThan(0)
  })
})

// --------------------------------------------------------------- leg (b) --

describe('leg (b) [M2]: parseConfig defaults, copy table and required fields', () => {
  test('a TOML with only the three required ids yields the five numeric defaults', () => {
    const cfg = onlyGuild(parseConfig(REQUIRED_ONLY))
    expect(cfg.guildId).toBe('111111111111111111')
    expect(cfg.threadParentChannelId).toBe('222222222222222222')
    expect(cfg.voiceCategoryId).toBe('333333333333333333')
    expect(cfg.cadenceMs).toBe(1209600000)
    expect(cfg.holdingWindowMs).toBe(86400000)
    expect(cfg.pullForwardMaxMs).toBe(259200000)
    expect(cfg.negotiationTimeoutMs).toBe(172800000)
    expect(cfg.callMinutes).toBe(30)
  })

  test("the same TOML yields weights deep-equal to { 'round-robin': 1 } and copy deep-equal to {}", () => {
    const cfg = onlyGuild(parseConfig(REQUIRED_ONLY))
    expect(cfg.weights).toEqual({ 'round-robin': 1 })
    expect(cfg.copy).toEqual({})
  })

  test('a [guilds.copy] table is carried into cfg.copy so renderCopy returns it, leaving other keys on the default', () => {
    const cfg = onlyGuild(
      parseConfig(`${REQUIRED_ONLY}
[guilds.copy]
paused = "Custom pause text"
`),
    )
    expect(cfg.copy).toEqual({ paused: 'Custom pause text' })
    expect(renderCopy(cfg, 'paused')).toBe('Custom pause text')
    expect(renderCopy(cfg, 'resumed')).toBe(DEFAULT_COPY['resumed'])
  })

  test('omitting guild_id throws an Error naming that field', () => {
    throwsNaming(() => parseConfig(withoutField('guild_id')), 'guild_id')
  })

  test('omitting thread_parent_channel_id throws an Error naming that field', () => {
    throwsNaming(() => parseConfig(withoutField('thread_parent_channel_id')), 'thread_parent_channel_id')
  })

  test('omitting voice_category_id throws an Error naming that field', () => {
    throwsNaming(() => parseConfig(withoutField('voice_category_id')), 'voice_category_id')
  })
})

// --------------------------------------------------------------- leg (c) --

describe('leg (c) [M3]: DEFAULT_COPY coverage and renderCopy substitution', () => {
  test('DEFAULT_COPY has at least 27 keys', () => {
    expect(Object.keys(DEFAULT_COPY).length).toBeGreaterThanOrEqual(27)
  })

  test('every CopyKey has a non-empty string in DEFAULT_COPY', () => {
    for (const key of ALL_COPY_KEYS) {
      const value = DEFAULT_COPY[key]
      expect(typeof value).toBe('string')
      expect(value.trim().length).toBeGreaterThan(0)
    }
  })

  test('renderCopy uses cfg.copy[key] when present and DEFAULT_COPY[key] otherwise', () => {
    const overridden: Pick<GuildConfig, 'copy'> = { copy: { paused: 'Override text' } }
    const empty: Pick<GuildConfig, 'copy'> = { copy: {} }
    expect(renderCopy(overridden, 'paused')).toBe('Override text')
    expect(renderCopy(empty, 'paused')).toBe(DEFAULT_COPY['paused'])
    expect(renderCopy(overridden, 'resumed')).toBe(DEFAULT_COPY['resumed'])
  })

  test('renderCopy substitutes every {name} with String(vars[name])', () => {
    const cfg: Pick<GuildConfig, 'copy'> = { copy: { paused: 'A {one} B {two} C' } }
    expect(renderCopy(cfg, 'paused', { one: 'x', two: 7 })).toBe('A x B 7 C')
  })

  test("renderCopy(cfg, 'room-open', { link: 'X' }) contains 'Your room: X'", () => {
    const cfg: Pick<GuildConfig, 'copy'> = { copy: {} }
    expect(renderCopy(cfg, 'room-open', { link: 'X' })).toContain('Your room: X')
  })

  test("renderCopy(cfg, 'room-open', {}) throws an Error naming the missing placeholder", () => {
    const cfg: Pick<GuildConfig, 'copy'> = { copy: {} }
    throwsNaming(() => renderCopy(cfg, 'room-open', {}), 'link')
  })

  test('a placeholder with no value in vars throws an Error naming it, vars omitted entirely too', () => {
    const cfg: Pick<GuildConfig, 'copy'> = { copy: { paused: 'A {one} B {two} C' } }
    throwsNaming(() => renderCopy(cfg, 'paused', { one: 'x' }), 'two')
    throwsNaming(() => renderCopy(cfg, 'paused'), 'one')
  })
})

// --------------------------------------------------------------- leg (d) --

describe('leg (d) [M4]: the six pinned substrings live in their named defaults', () => {
  test("DEFAULT_COPY['check-in'] contains the check-in sentence", () => {
    expect(DEFAULT_COPY['check-in']).toContain(
      "Still up for these? You weren't around for your last introduction, and I'd rather ask than guess.",
    )
  })

  test("DEFAULT_COPY['follow-up'] contains 'Did you two connect?'", () => {
    expect(DEFAULT_COPY['follow-up']).toContain('Did you two connect?')
  })

  test("DEFAULT_COPY['holding-for-stranger'] contains the holding sentence", () => {
    expect(DEFAULT_COPY['holding-for-stranger']).toContain(
      'Holding a while for someone new rather than repeating.',
    )
  })

  test("DEFAULT_COPY['join-confirmation'] contains the section 9 sentence and /availability", () => {
    expect(DEFAULT_COPY['join-confirmation']).toContain(
      "When I ask whether you connected, your answer counts toward your stats, tells me you're still active, and helps me avoid re-pairing people who already met.",
    )
    expect(DEFAULT_COPY['join-confirmation']).toContain('/availability')
  })

  test("DEFAULT_COPY['room-open'] contains 'Starts in ten minutes. Your room: {link}'", () => {
    expect(DEFAULT_COPY['room-open']).toContain('Starts in ten minutes. Your room: {link}')
  })
})

// --------------------------------------------------------------- leg (e) --

describe('leg (e) [M5]: no forbidden character, substring or word in the copy or the example file', () => {
  const EM_DASH = '\u2014' // the em dash U+2014, written as an escape
  const FORBIDDEN_SUBSTRINGS = ['experiment', 'kmikeym', 'shareholder']
  const FORBIDDEN_WORDS = [/\bvote\b/, /\bvotes\b/]

  function assertClean(label: string, text: string): void {
    expect(`${label}/U+2014: ${text.includes(EM_DASH)}`).toBe(`${label}/U+2014: false`)
    const lower = text.toLowerCase()
    for (const needle of FORBIDDEN_SUBSTRINGS) {
      expect(`${label}/${needle}: ${lower.includes(needle)}`).toBe(`${label}/${needle}: false`)
    }
    for (const pattern of FORBIDDEN_WORDS) {
      expect(`${label}/${pattern.source}: ${pattern.test(lower)}`).toBe(`${label}/${pattern.source}: false`)
    }
  }

  test('the joined values of DEFAULT_COPY are clean', () => {
    assertClean('DEFAULT_COPY', Object.values(DEFAULT_COPY).join('\n'))
  })

  test('the text of config.example.toml is clean, line by line', async () => {
    const text = await Bun.file(EXAMPLE_PATH).text()
    expect(text.length).toBeGreaterThan(0)
    const lines = text.split('\n')
    for (const [index, line] of lines.entries()) {
      assertClean(`config.example.toml:${index + 1}`, line)
    }
  })
})
