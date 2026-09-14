// The exam for Task 4, "Enrollment and the ack gate".
//
// One block per Proof leg (a)-(h); each test name carries its leg letter and
// the Machine clause it encodes, so a reader can map any failure back to the
// contract. Nothing here reads the wall clock or sleeps: every instant is
// derived from the fixed NOW below and handed in as `now`.
//
// Two call sites are deliberately kept behind `// @ts-expect-error`, because
// two legs are type-level claims that `bunx tsc --noEmit` is what proves:
// leg (a)'s "a five-argument call is a type error" and leg (d)'s "a partner's
// Not yet has no way in". Leg (a)'s lives in a function that is never called
// (the claim is about the signature, not about what a missing `ids` does at
// run time); leg (d)'s is called, because that leg also says the call "at
// runtime still returns `true`".

import { describe, expect, test } from "bun:test"
import type { GuildId, Mask, MemberId, MemberRow } from "../src/types"
import {
  DEFAULT_MASK_LITERAL,
  answerCheckin,
  closePairing,
  expireCheckin,
  inPool,
  isSilent,
  joinMember,
  pauseMember,
  recordEvidence,
  resumeMember,
  sendCheckin,
} from "../src/core/enrollment"
import type { EnrollmentConfig } from "../src/core/enrollment"

// ------------------------------------------------------------------ fixtures --

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** A fixed instant. Every fixture time is NOW plus or minus a constant. */
const NOW = 1_767_225_600_000 // 2026-01-01T00:00:00Z

const GUILD: GuildId = "g"
const IDS: { guildId: GuildId; id: MemberId } = { guildId: "g", id: "m1" }

/** The shipped cadence of §4a: fourteen days. */
const CFG: EnrollmentConfig = { cadenceMs: 14 * DAY }

/** A mask that is not the default, so "unchanged" is visible when it holds. */
const CUSTOM_MASK: Mask = "1".repeat(24) + "0".repeat(144)

/**
 * The default of #4 as Context spells it out: for each of the seven days,
 * hours 9 through 20 (indices `d*24+9 … d*24+20`) are '1' and all else '0'.
 * Built here rather than imported, so this exam does not consume Task 1.
 */
function expectedDefaultMask(): Mask {
  let mask = ""
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) mask += hour >= 9 && hour <= 20 ? "1" : "0"
  }
  return mask
}

function countOnes(mask: string): number {
  let ones = 0
  for (const cell of mask) if (cell === "1") ones++
  return ones
}

function member(over: Partial<MemberRow> = {}): MemberRow {
  return {
    guildId: GUILD,
    id: "m1",
    state: "active",
    timezone: "Europe/Belgrade",
    tags: [],
    avoid: [],
    mask: CUSTOM_MASK,
    preset: "custom",
    eligibleAt: NOW,
    welcome: false,
    lastWelcomeAt: null,
    needsAck: false,
    checkinsIgnored: 0,
    checkinSentAt: null,
    overlapNoticeAt: null,
    joinedAt: NOW - 90 * DAY,
    ...over,
  }
}

/** A structural copy, for the "the input was not mutated" assertions. */
function snapshot(row: MemberRow): MemberRow {
  return { ...row, tags: [...row.tags], avoid: [...row.avoid] }
}

/**
 * Never called. Its body exists so `bunx tsc --noEmit` reads it: `ids` is the
 * sixth parameter of `joinMember`, required, with no default and no `?`, so a
 * five-argument call must not compile [M1, leg (a)]. If the sixth parameter
 * ever gains a default, the directive below becomes unused and tsc fails.
 */
function fiveArgumentJoinIsATypeError(): MemberRow {
  // @ts-expect-error `ids` is required: a five-argument call is a type error [M1, leg (a)]
  return joinMember(null, { timezone: "Europe/Belgrade" }, NOW, CFG, null)
}

// ------------------------------------------------------------------- leg (a) --

describe("leg (a) [M1]: a fresh join", () => {
  test("leg (a) [M1]: a six-argument join on a null row carries the ids and the eight literal fields", () => {
    const row = joinMember(null, { timezone: "Europe/Belgrade" }, NOW, CFG, null, IDS)

    expect(row.guildId).toBe("g")
    expect(row.id).toBe("m1")
    expect(row.state).toBe("active")
    expect(row.eligibleAt).toBe(NOW)
    expect(row.joinedAt).toBe(NOW)
    expect(row.mask).toBe(DEFAULT_MASK_LITERAL)
    expect(row.preset).toBe("any-reasonable-hour")
    expect(row.needsAck).toBe(false)
    expect(row.checkinsIgnored).toBe(0)
    expect(row.welcome).toBe(false)
    // The option M1 makes mandatory is the one the row is built from.
    expect(row.timezone).toBe("Europe/Belgrade")
  })

  test("leg (a) [M1]: the joined mask strictly equals DEFAULT_MASK_LITERAL", () => {
    const row = joinMember(null, { timezone: "Europe/Belgrade" }, NOW, CFG, null, IDS)

    expect(row.mask).toBe(DEFAULT_MASK_LITERAL)
  })

  test("leg (a) [M1]: DEFAULT_MASK_LITERAL is 168 characters, 84 ones, '1' at index 9 and '0' at index 8", () => {
    expect(DEFAULT_MASK_LITERAL.length).toBe(168)
    expect(countOnes(DEFAULT_MASK_LITERAL)).toBe(84)
    expect(DEFAULT_MASK_LITERAL.charAt(9)).toBe("1")
    expect(DEFAULT_MASK_LITERAL.charAt(8)).toBe("0")
    // Context spells the whole string out: hours 9 through 20 of each day.
    expect(DEFAULT_MASK_LITERAL).toBe(expectedDefaultMask())
  })

  test("leg (a) [M1]: a join with no timezone throws an Error whose message contains 'timezone'", () => {
    let thrown: unknown = null
    try {
      joinMember(null, {}, NOW, CFG, null, IDS)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("timezone")
  })

  test("leg (a) [M1]: the five-argument call site is kept for bunx tsc --noEmit and never run", () => {
    expect(typeof fiveArgumentJoinIsATypeError).toBe("function")
  })
})

// ------------------------------------------------------------------- leg (b) --

describe("leg (b) [M2]: coming back", () => {
  const paused = () =>
    member({
      state: "paused",
      needsAck: true,
      checkinsIgnored: 2,
      checkinSentAt: NOW - 3 * DAY,
      mask: CUSTOM_MASK,
      preset: "custom",
      timezone: "Europe/Belgrade",
      avoid: ["m9"],
      joinedAt: NOW - 90 * DAY,
      eligibleAt: NOW - 30 * DAY,
    })

  const LAST_PAIRING_AT = NOW - 7 * DAY // + cadence lands a week after NOW

  test("leg (b) [M2]: joinMember and resumeMember on a paused row deep-equal each other", () => {
    const rejoined = joinMember(paused(), {}, NOW, CFG, LAST_PAIRING_AT, IDS)
    const resumed = resumeMember(paused(), NOW, CFG, LAST_PAIRING_AT)

    expect(rejoined).toEqual(resumed)
  })

  test("leg (b) [M2]: both return state 'active', needsAck false and checkinsIgnored 0", () => {
    for (const row of [
      joinMember(paused(), {}, NOW, CFG, LAST_PAIRING_AT, IDS),
      resumeMember(paused(), NOW, CFG, LAST_PAIRING_AT),
    ]) {
      expect(row.state).toBe("active")
      expect(row.needsAck).toBe(false)
      expect(row.checkinsIgnored).toBe(0)
    }
  })

  test("leg (b) [M2]: eligibleAt is lastPairingAt + cadence when that is later than now", () => {
    const expected = LAST_PAIRING_AT + CFG.cadenceMs
    expect(expected).toBeGreaterThan(NOW)

    expect(joinMember(paused(), {}, NOW, CFG, LAST_PAIRING_AT, IDS).eligibleAt).toBe(expected)
    expect(resumeMember(paused(), NOW, CFG, LAST_PAIRING_AT).eligibleAt).toBe(expected)
  })

  test("leg (b) [M2]: eligibleAt is now when lastPairingAt + cadence is one millisecond before now", () => {
    const lastPairingAt = NOW - CFG.cadenceMs - 1
    expect(lastPairingAt + CFG.cadenceMs).toBe(NOW - 1)

    expect(joinMember(paused(), {}, NOW, CFG, lastPairingAt, IDS).eligibleAt).toBe(NOW)
    expect(resumeMember(paused(), NOW, CFG, lastPairingAt).eligibleAt).toBe(NOW)
  })

  test("leg (b) [M2]: eligibleAt is now when lastPairingAt is null", () => {
    expect(joinMember(paused(), {}, NOW, CFG, null, IDS).eligibleAt).toBe(NOW)
    expect(resumeMember(paused(), NOW, CFG, null).eligibleAt).toBe(NOW)
  })

  test("leg (b) [M2]: mask, preset, timezone, avoid and joinedAt come through unchanged", () => {
    const input = paused()

    for (const row of [
      joinMember(paused(), {}, NOW, CFG, LAST_PAIRING_AT, IDS),
      resumeMember(paused(), NOW, CFG, LAST_PAIRING_AT),
    ]) {
      expect(row.mask).toEqual(input.mask)
      expect(row.preset).toEqual(input.preset)
      expect(row.timezone).toEqual(input.timezone)
      expect(row.avoid).toEqual(input.avoid)
      expect(row.joinedAt).toEqual(input.joinedAt)
    }
  })
})

// ------------------------------------------------------------------- leg (c) --

describe("leg (c) [M3]: re-running join updates just that option, and pausing", () => {
  const active = () =>
    member({ state: "active", timezone: "Europe/Belgrade", avoid: [], eligibleAt: NOW + 3 * DAY })

  const LAST_PAIRING_AT = NOW - DAY

  test("leg (c) [M3]: a timezone-only rejoin changes timezone and nothing else", () => {
    const input = active()
    const before = snapshot(input)

    const row = joinMember(input, { timezone: "Asia/Tokyo" }, NOW, CFG, LAST_PAIRING_AT, IDS)

    expect(row.timezone).toBe("Asia/Tokyo")
    expect(row).toEqual({ ...before, timezone: "Asia/Tokyo" })
    // Pure function (Context): the input row is not mutated.
    expect(input).toEqual(before)
  })

  test("leg (c) [M3]: an avoid-only rejoin changes avoid and nothing else", () => {
    const input = active()
    const before = snapshot(input)

    const row = joinMember(input, { avoid: ["x"] }, NOW, CFG, LAST_PAIRING_AT, IDS)

    expect(row.avoid).toEqual(["x"])
    expect(row).toEqual({ ...before, avoid: ["x"] })
    expect(input).toEqual(before)
  })

  test("leg (c) [M3]: pauseMember sets state 'paused' and nothing else", () => {
    const input = active()
    const before = snapshot(input)

    const row = pauseMember(input)

    expect(row.state).toBe("paused")
    expect(row).toEqual({ ...before, state: "paused" })
    expect(input).toEqual(before)
  })
})

// ------------------------------------------------------------------- leg (d) --

describe("leg (d) [M4]: silence is the absence of all three signs", () => {
  const BOOLEANS = [false, true] as const

  test("leg (d) [M4]: isSilent is true for exactly the all-false row of the eight combinations", () => {
    const seen: { evidence: string; silent: boolean }[] = []

    for (const posted of BOOLEANS) {
      for (const tapped of BOOLEANS) {
        for (const partnerYes of BOOLEANS) {
          const silent = isSilent({ posted, tapped, partnerYes })
          seen.push({ evidence: `${posted}/${tapped}/${partnerYes}`, silent })
          expect(silent).toBe(!posted && !tapped && !partnerYes)
        }
      }
    }

    expect(seen.length).toBe(8)
    expect(seen.filter((row) => row.silent).length).toBe(1)
    expect(seen.filter((row) => row.silent)[0]?.evidence).toBe("false/false/false")
  })

  test("leg (d) [M4]: a partner's Not yet has no way in, and the call still returns true", () => {
    expect(
      isSilent({
        posted: false,
        tapped: false,
        partnerYes: false,
        // @ts-expect-error the evidence type has exactly three fields [M4, leg (d)]
        partnerNotYet: true,
      }),
    ).toBe(true)
  })
})

// ------------------------------------------------------------------- leg (e) --

describe("leg (e) [M5]: the gate opens on silence and closes on evidence", () => {
  const closed = () => member({ needsAck: false, eligibleAt: NOW + 5 * DAY })

  test("leg (e) [M5]: closePairing with silent true sets needsAck and leaves eligibleAt alone", () => {
    const input = closed()
    const before = snapshot(input)

    const row = closePairing(input, true, NOW, CFG)

    expect(row.needsAck).toBe(true)
    expect(row.eligibleAt).toBe(before.eligibleAt)
    expect(row).toEqual({ ...before, needsAck: true })
    expect(input).toEqual(before)
  })

  test("leg (e) [M5]: closePairing with silent false leaves needsAck false and eligibleAt alone", () => {
    const input = closed()
    const before = snapshot(input)

    const row = closePairing(input, false, NOW, CFG)

    expect(row.needsAck).toBe(false)
    expect(row.eligibleAt).toBe(before.eligibleAt)
    expect(row).toEqual(before)
  })

  test("leg (e) [M5]: recordEvidence differs from a needsAck row in needsAck alone", () => {
    const input = member({ needsAck: true, eligibleAt: NOW + 5 * DAY })
    const before = snapshot(input)

    const row = recordEvidence(input)

    expect(row.needsAck).toBe(false)
    expect(row).toEqual({ ...before, needsAck: false })
    expect(input).toEqual(before)
  })
})

// ------------------------------------------------------------------- leg (f) --

describe("leg (f) [M6]: the check-in and its two answers", () => {
  test("leg (f) [M6]: sendCheckin sets checkinSentAt to now", () => {
    const input = member({ needsAck: true, checkinSentAt: null })
    const before = snapshot(input)

    const row = sendCheckin(input, NOW)

    expect(row.checkinSentAt).toBe(NOW)
    expect(row).toEqual({ ...before, checkinSentAt: NOW })
  })

  test("leg (f) [M6]: answerCheckin 'keep' clears needsAck and checkinSentAt", () => {
    const input = member({ needsAck: true, checkinSentAt: NOW - HOUR })
    const before = snapshot(input)

    const row = answerCheckin(input, "keep")

    expect(row.needsAck).toBe(false)
    expect(row.checkinSentAt).toBe(null)
    expect(row).toEqual({ ...before, needsAck: false, checkinSentAt: null })
  })

  test("leg (f) [M6]: answerCheckin 'pause' sets state 'paused'", () => {
    const input = member({ state: "active", needsAck: true, checkinSentAt: NOW - HOUR })
    const before = snapshot(input)

    const row = answerCheckin(input, "pause")

    expect(row.state).toBe("paused")
    // The member's own settings and history are not an answer to a check-in.
    expect(row.mask).toEqual(before.mask)
    expect(row.preset).toEqual(before.preset)
    expect(row.timezone).toEqual(before.timezone)
    expect(row.avoid).toEqual(before.avoid)
    expect(row.joinedAt).toEqual(before.joinedAt)
    expect(row.eligibleAt).toEqual(before.eligibleAt)
    expect(input).toEqual(before)
  })
})

// ------------------------------------------------------------------- leg (g) --

describe("leg (g) [M7]: one ignored check-in re-sends, two auto-pause", () => {
  test("leg (g) [M7]: one millisecond short of the cadence returns 'none' with the row unchanged", () => {
    const input = member({ needsAck: true, checkinSentAt: NOW - CFG.cadenceMs + 1, checkinsIgnored: 0 })
    const before = snapshot(input)
    expect(NOW - (input.checkinSentAt ?? 0)).toBe(CFG.cadenceMs - 1)

    const { row, action } = expireCheckin(input, NOW, CFG)

    expect(action).toBe("none")
    expect(row).toEqual(before)
  })

  test("leg (g) [M7]: a needsAck false row returns 'none' with the row unchanged", () => {
    const input = member({ needsAck: false, checkinSentAt: NOW - 2 * CFG.cadenceMs, checkinsIgnored: 0 })
    const before = snapshot(input)

    const { row, action } = expireCheckin(input, NOW, CFG)

    expect(action).toBe("none")
    expect(row).toEqual(before)
  })

  test("leg (g) [M7]: at the cadence with checkinsIgnored 0 it re-sends", () => {
    const input = member({ needsAck: true, checkinSentAt: NOW - CFG.cadenceMs, checkinsIgnored: 0 })
    const before = snapshot(input)

    const { row, action } = expireCheckin(input, NOW, CFG)

    expect(action).toBe("resend")
    expect(row.checkinsIgnored).toBe(1)
    expect(row.checkinSentAt).toBe(NOW)
    expect(row.state).toBe("active")
    expect(row.needsAck).toBe(true)
    expect(input).toEqual(before)
  })

  test("leg (g) [M7]: at the cadence with checkinsIgnored 1 it auto-pauses", () => {
    const input = member({ needsAck: true, checkinSentAt: NOW - CFG.cadenceMs, checkinsIgnored: 1 })
    const before = snapshot(input)

    const { row, action } = expireCheckin(input, NOW, CFG)

    expect(action).toBe("auto-paused")
    expect(row.state).toBe("paused")
    expect(row.checkinsIgnored).toBe(2)
    expect(input).toEqual(before)
  })
})

// ------------------------------------------------------------------- leg (h) --

describe("leg (h) [M8]: who is in the pool", () => {
  const eligible = () =>
    member({ id: "m1", state: "active", needsAck: false, eligibleAt: NOW })

  const NOBODY_PAIRED: ReadonlySet<MemberId> = new Set<MemberId>()

  test("leg (h) [M8]: an active, acked, eligible, unpaired row is in the pool", () => {
    expect(inPool(eligible(), NOW, NOBODY_PAIRED)).toBe(true)
  })

  test("leg (h) [M8]: a paused row is not in the pool", () => {
    expect(inPool(member({ ...eligible(), state: "paused" }), NOW, NOBODY_PAIRED)).toBe(false)
  })

  test("leg (h) [M8]: a needsAck row is not in the pool", () => {
    expect(inPool(member({ ...eligible(), needsAck: true }), NOW, NOBODY_PAIRED)).toBe(false)
  })

  test("leg (h) [M8]: a row whose eligibleAt is now + 1 is not in the pool", () => {
    expect(inPool(member({ ...eligible(), eligibleAt: NOW + 1 }), NOW, NOBODY_PAIRED)).toBe(false)
  })

  test("leg (h) [M8]: a row whose id is in openPairingMembers is not in the pool", () => {
    const paired: ReadonlySet<MemberId> = new Set<MemberId>(["m1"])

    expect(inPool(eligible(), NOW, paired)).toBe(false)
  })
})
