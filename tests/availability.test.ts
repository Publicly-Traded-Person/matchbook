// Exam for Task 1, "Weekly availability masks".
//
// One describe block per Proof leg (a) through (g); every assertion names the
// leg and the Machine clause it comes from. Nothing here reads the wall clock
// or sleeps: every instant is a literal Date.UTC.

import { describe, expect, test } from "bun:test"
import type { AvailabilityPreset, Mask } from "../src/types"
import {
  assertMask,
  DEFAULT_MASK,
  DEFAULT_PRESET,
  EMPTY_MASK,
  feasible,
  isAvailableAt,
  orBlock,
  PRESETS,
  projectToUtc,
  sharedHours,
} from "../src/core/availability"

// ------------------------------------------------------------- fixtures --

/** Hours 9 through 20 set, 12 ones. The `any-reasonable-hour` day slice. */
const DAY_9_TO_21 = "000000000111111111111000"
/** Hours 17 through 20 set, 4 ones. The `evenings-only` day slice. */
const DAY_17_TO_21 = "000000000000000001111000"
const DAY_OFF = "0".repeat(24)

const ALL_ONES = "1".repeat(168) as Mask

/** A 167-character mask: wrong length (M7). */
const SHORT_MASK = "0".repeat(167)
/** 168 characters but one of them is `2`: wrong alphabet (M7). */
const BAD_CHAR_MASK = "2" + "0".repeat(167)

/** The start instant leg (e) pins: Sunday 2026-09-13 20:00 UTC. */
const FROM_UTC = Date.UTC(2026, 8, 13, 20)
const WEEK = 168

const countOnes = (mask: string): number => mask.split("").filter((c) => c === "1").length

const onesIndices = (mask: string): number[] => {
  const out: number[] = []
  for (let i = 0; i < mask.length; i++) if (mask[i] === "1") out.push(i)
  return out
}

const daySlice = (mask: string, day: number): string => mask.slice(day * 24, day * 24 + 24)

/** A mask with a single `1` at `index`, built without touching the module. */
const singleHourMask = (index: number): Mask =>
  ("0".repeat(index) + "1" + "0".repeat(167 - index)) as Mask

const member = (mask: Mask, timezone: string): { mask: Mask; timezone: string } => ({ mask, timezone })

/** The ascending intersection of two sorted number lists (M6's own definition). */
const intersect = (a: readonly number[], b: readonly number[]): number[] => {
  const inB = new Set(b)
  return a.filter((x) => inB.has(x)).sort((x, y) => x - y)
}

const isAscending = (xs: readonly number[]): boolean =>
  xs.every((x, i) => i === 0 || (xs[i - 1] as number) < x)

// ------------------------------------------------------------- leg (a) --
// [M1] The default preset is 9am to 9pm every day, and is what a new member gets.

describe("leg (a): the default preset [M1]", () => {
  test("leg (a) [M1]: DEFAULT_PRESET is 'any-reasonable-hour'", () => {
    const expected: AvailabilityPreset = "any-reasonable-hour"
    expect(DEFAULT_PRESET).toBe(expected)
  })

  test("leg (a) [M1]: DEFAULT_MASK equals PRESETS['any-reasonable-hour']", () => {
    expect(DEFAULT_MASK).toBe(PRESETS["any-reasonable-hour"])
  })

  test("leg (a) [M1]: the default preset is 168 characters with exactly 84 ones", () => {
    expect(PRESETS["any-reasonable-hour"].length).toBe(168)
    expect(countOnes(PRESETS["any-reasonable-hour"])).toBe(84)
  })

  test("leg (a) [M1]: every day slice of the default preset is exactly hours 9 through 20", () => {
    for (let day = 0; day < 7; day++) {
      expect(daySlice(PRESETS["any-reasonable-hour"], day)).toBe(DAY_9_TO_21)
    }
  })

  test("leg (a) [M1]: PRESETS is keyed by the four non-custom presets and no others", () => {
    expect(Object.keys(PRESETS).sort()).toEqual(
      ["any-reasonable-hour", "evenings-only", "weekdays-9-5-off", "weekends-only"].sort(),
    )
  })
})

// ------------------------------------------------------------- leg (b) --
// [M2] The other three presets, slice for slice.

describe("leg (b): the other three presets [M2]", () => {
  test("leg (b) [M2]: evenings-only is hours 17 through 20 every day, 28 ones", () => {
    for (let day = 0; day < 7; day++) {
      expect(daySlice(PRESETS["evenings-only"], day)).toBe(DAY_17_TO_21)
    }
    expect(PRESETS["evenings-only"].length).toBe(168)
    expect(countOnes(PRESETS["evenings-only"])).toBe(28)
  })

  test("leg (b) [M2]: weekends-only is 24 zeros Monday through Friday and hours 9 through 20 at the weekend, 24 ones", () => {
    for (let day = 0; day <= 4; day++) {
      expect(daySlice(PRESETS["weekends-only"], day)).toBe(DAY_OFF)
    }
    expect(daySlice(PRESETS["weekends-only"], 5)).toBe(DAY_9_TO_21)
    expect(daySlice(PRESETS["weekends-only"], 6)).toBe(DAY_9_TO_21)
    expect(PRESETS["weekends-only"].length).toBe(168)
    expect(countOnes(PRESETS["weekends-only"])).toBe(24)
  })

  test("leg (b) [M2]: weekdays-9-5-off is evenings on weekdays and hours 9 through 20 at the weekend, 44 ones", () => {
    for (let day = 0; day <= 4; day++) {
      expect(daySlice(PRESETS["weekdays-9-5-off"], day)).toBe(DAY_17_TO_21)
    }
    expect(daySlice(PRESETS["weekdays-9-5-off"], 5)).toBe(DAY_9_TO_21)
    expect(daySlice(PRESETS["weekdays-9-5-off"], 6)).toBe(DAY_9_TO_21)
    expect(PRESETS["weekdays-9-5-off"].length).toBe(168)
    expect(countOnes(PRESETS["weekdays-9-5-off"])).toBe(44)
  })
})

// ------------------------------------------------------------- leg (c) --
// [M3] orBlock unions a (days x hours) block into a mask; EMPTY_MASK is 168 zeros.

describe("leg (c): orBlock and EMPTY_MASK [M3]", () => {
  test("leg (c) [M3]: EMPTY_MASK is 168 characters and contains no '1'", () => {
    expect(EMPTY_MASK.length).toBe(168)
    expect(EMPTY_MASK).toBe("0".repeat(168))
    expect(countOnes(EMPTY_MASK)).toBe(0)
  })

  test("leg (c) [M3]: orBlock(EMPTY_MASK, [0, 6], [9, 10]) sets exactly indices 9, 10, 153 and 154", () => {
    const result = orBlock(EMPTY_MASK, [0, 6], [9, 10])
    expect(result.length).toBe(168)
    expect(countOnes(result)).toBe(4)
    expect(onesIndices(result)).toEqual([9, 10, 153, 154])
  })

  test("leg (c) [M3]: orBlock over already-set indices leaves the mask and the count unchanged", () => {
    const before = countOnes(DEFAULT_MASK)
    const result = orBlock(DEFAULT_MASK, [0, 1, 2, 3, 4, 5, 6], [9, 10, 11])
    expect(countOnes(result)).toBe(before)
    expect(result).toBe(DEFAULT_MASK)
  })

  test("leg (c) [M3]: orBlock returns the union of the input's ones and the block", () => {
    const base = PRESETS["evenings-only"]
    const result = orBlock(base, [5, 6], [9, 10])
    const expected = new Set(onesIndices(base))
    for (const day of [5, 6]) for (const hour of [9, 10]) expected.add(day * 24 + hour)
    expect(onesIndices(result)).toEqual([...expected].sort((x, y) => x - y))
    expect(result.length).toBe(168)
  })
})

// ------------------------------------------------------------- leg (d) --
// [M4] isAvailableAt reads the local weekday and hour, Monday indexed 0.

describe("leg (d): isAvailableAt [M4]", () => {
  const mondayOneAm = singleHourMask(1) // day 0, hour 1
  const sundayEightPm = singleHourMask(164) // day 6, hour 20

  test("leg (d) [M4]: index 1 is Monday 01:00 local, true for Etc/GMT-1 at 2026-09-14T00:00:00Z", () => {
    expect(isAvailableAt(mondayOneAm, "Etc/GMT-1", Date.UTC(2026, 8, 14, 0))).toBe(true)
  })

  test("leg (d) [M4]: the same mask is false for Etc/GMT-1 an hour later, at 2026-09-14T01:00:00Z", () => {
    expect(isAvailableAt(mondayOneAm, "Etc/GMT-1", Date.UTC(2026, 8, 14, 1))).toBe(false)
  })

  test("leg (d) [M4]: index 164 is Sunday 20:00 local, true for America/Los_Angeles at 2026-09-14T03:00:00Z", () => {
    expect(isAvailableAt(sundayEightPm, "America/Los_Angeles", Date.UTC(2026, 8, 14, 3))).toBe(true)
  })
})

// ------------------------------------------------------------- leg (e) --
// [M5] projectToUtc turns local intent into UTC hour starts, ascending, and
// does not mutate the mask it was given.

describe("leg (e): projectToUtc [M5]", () => {
  const mondayOneAm = singleHourMask(1)

  test("leg (e) [M5]: a one-hour mask at index 1 projects to exactly one instant under Etc/GMT-1", () => {
    expect(projectToUtc(mondayOneAm, "Etc/GMT-1", FROM_UTC, WEEK)).toEqual([Date.UTC(2026, 8, 14, 0)])
  })

  test("leg (e) [M5]: the same mask projects to exactly one instant under Etc/GMT-3", () => {
    expect(projectToUtc(mondayOneAm, "Etc/GMT-3", FROM_UTC, WEEK)).toEqual([Date.UTC(2026, 8, 13, 22)])
  })

  test("leg (e) [M5]: the two zones differ by exactly -7200000 ms", () => {
    const one = projectToUtc(mondayOneAm, "Etc/GMT-1", FROM_UTC, WEEK)
    const three = projectToUtc(mondayOneAm, "Etc/GMT-3", FROM_UTC, WEEK)
    expect(three.length).toBe(1)
    expect(one.length).toBe(1)
    expect((three[0] as number) - (one[0] as number)).toBe(-7200000)
  })

  test("leg (e) [M5]: the default mask projects to exactly 84 ascending instants under Etc/GMT-1, starting at 2026-09-14T08:00:00Z", () => {
    const projected = projectToUtc(DEFAULT_MASK, "Etc/GMT-1", FROM_UTC, WEEK)
    expect(projected.length).toBe(84)
    expect(isAscending(projected)).toBe(true)
    expect(projected[0]).toBe(Date.UTC(2026, 8, 14, 8))
  })

  test("leg (e) [M5]: the default mask projects to exactly 84 ascending instants under Etc/GMT-3, starting at 2026-09-14T06:00:00Z", () => {
    const projected = projectToUtc(DEFAULT_MASK, "Etc/GMT-3", FROM_UTC, WEEK)
    expect(projected.length).toBe(84)
    expect(isAscending(projected)).toBe(true)
    expect(projected[0]).toBe(Date.UTC(2026, 8, 14, 6))
  })

  test("leg (e) [M5]: every projected instant is inside the window and on an hour start", () => {
    const projected = projectToUtc(DEFAULT_MASK, "Etc/GMT-1", FROM_UTC, WEEK)
    for (const at of projected) {
      expect(at).toBeGreaterThanOrEqual(FROM_UTC)
      expect(at).toBeLessThan(FROM_UTC + WEEK * 3600000)
      expect(at % 3600000).toBe(0)
    }
  })

  test("leg (e) [M5]: the mask string compares equal before and after the calls", () => {
    const beforeDefault = `${DEFAULT_MASK}`
    const beforeSingle = `${mondayOneAm}`
    projectToUtc(mondayOneAm, "Etc/GMT-1", FROM_UTC, WEEK)
    projectToUtc(mondayOneAm, "Etc/GMT-3", FROM_UTC, WEEK)
    projectToUtc(DEFAULT_MASK, "Etc/GMT-1", FROM_UTC, WEEK)
    expect(mondayOneAm).toBe(beforeSingle)
    expect(DEFAULT_MASK).toBe(beforeDefault)
  })
})

// ------------------------------------------------------------- leg (f) --
// [M6] sharedHours is the commutative intersection; feasible is "non-empty over
// the week ahead".

describe("leg (f): sharedHours and feasible [M6]", () => {
  test("leg (f) [M6]: sharedHours is commutative across two presets in two zones", () => {
    const a = member(PRESETS["evenings-only"], "Etc/GMT-1")
    const b = member(PRESETS["any-reasonable-hour"], "America/Los_Angeles")
    expect(sharedHours(a, b, FROM_UTC, WEEK)).toEqual(sharedHours(b, a, FROM_UTC, WEEK))
  })

  test("leg (f) [M6]: sharedHours is the ascending intersection of the two projections", () => {
    const a = member(PRESETS["evenings-only"], "Etc/GMT-1")
    const b = member(PRESETS["any-reasonable-hour"], "America/Los_Angeles")
    const shared = sharedHours(a, b, FROM_UTC, WEEK)
    expect(shared).toEqual(
      intersect(
        projectToUtc(a.mask, a.timezone, FROM_UTC, WEEK),
        projectToUtc(b.mask, b.timezone, FROM_UTC, WEEK),
      ),
    )
    expect(isAscending(shared)).toBe(true)
  })

  test("leg (f) [M6]: feasible is false for a weekends-only member and a Monday-to-Friday member, both in UTC", () => {
    const everyHour = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]
    const weekdaysOnly = orBlock(EMPTY_MASK, [0, 1, 2, 3, 4], everyHour)
    const a = member(PRESETS["weekends-only"], "UTC")
    const b = member(weekdaysOnly, "UTC")
    expect(sharedHours(a, b, FROM_UTC, WEEK)).toEqual([])
    expect(feasible(a, b, FROM_UTC)).toBe(false)
    expect(feasible(b, a, FROM_UTC)).toBe(false)
  })

  test("leg (f) [M6]: feasible is true for two default members in UTC", () => {
    const a = member(DEFAULT_MASK, "UTC")
    const b = member(DEFAULT_MASK, "UTC")
    expect(sharedHours(a, b, FROM_UTC, WEEK).length).toBeGreaterThan(0)
    expect(feasible(a, b, FROM_UTC)).toBe(true)
  })

  test("leg (f) [M6]: feasible agrees with sharedHours over the 168 hours after now", () => {
    const a = member(PRESETS["evenings-only"], "Etc/GMT-1")
    const b = member(PRESETS["weekends-only"], "America/Los_Angeles")
    expect(feasible(a, b, FROM_UTC)).toBe(sharedHours(a, b, FROM_UTC, WEEK).length > 0)
  })

  test("leg (f) [M6]: a default member shares with an all-ones member exactly their own projection", () => {
    const a = member(DEFAULT_MASK, "Etc/GMT-1")
    const b = member(ALL_ONES, "America/Los_Angeles")
    expect(sharedHours(a, b, FROM_UTC, WEEK)).toEqual(projectToUtc(a.mask, a.timezone, FROM_UTC, WEEK))
  })
})

// ------------------------------------------------------------- leg (g) --
// [M7] Every entry point rejects a mask that is not 168 characters of 0 or 1,
// with an Error whose message contains `168`.

describe("leg (g): mask validation [M7]", () => {
  const bad: ReadonlyArray<readonly [string, string]> = [
    ["a 167-character mask", SHORT_MASK],
    ["a 168-character mask containing '2'", BAD_CHAR_MASK],
  ]

  for (const [label, mask] of bad) {
    const m = mask as Mask

    test(`leg (g) [M7]: isAvailableAt throws an Error mentioning 168 for ${label}`, () => {
      expect(() => isAvailableAt(m, "UTC", FROM_UTC)).toThrow(Error)
      expect(() => isAvailableAt(m, "UTC", FROM_UTC)).toThrow(/168/)
    })

    test(`leg (g) [M7]: projectToUtc throws an Error mentioning 168 for ${label}`, () => {
      expect(() => projectToUtc(m, "UTC", FROM_UTC, WEEK)).toThrow(Error)
      expect(() => projectToUtc(m, "UTC", FROM_UTC, WEEK)).toThrow(/168/)
    })

    test(`leg (g) [M7]: orBlock throws an Error mentioning 168 for ${label}`, () => {
      expect(() => orBlock(m, [0], [9])).toThrow(Error)
      expect(() => orBlock(m, [0], [9])).toThrow(/168/)
    })

    test(`leg (g) [M7]: sharedHours throws an Error mentioning 168 for ${label}`, () => {
      const good = member(DEFAULT_MASK, "UTC")
      expect(() => sharedHours(member(m, "UTC"), good, FROM_UTC, WEEK)).toThrow(Error)
      expect(() => sharedHours(member(m, "UTC"), good, FROM_UTC, WEEK)).toThrow(/168/)
      expect(() => sharedHours(good, member(m, "UTC"), FROM_UTC, WEEK)).toThrow(/168/)
    })

    test(`leg (g) [M7]: feasible throws an Error mentioning 168 for ${label}`, () => {
      const good = member(DEFAULT_MASK, "UTC")
      expect(() => feasible(member(m, "UTC"), good, FROM_UTC)).toThrow(Error)
      expect(() => feasible(member(m, "UTC"), good, FROM_UTC)).toThrow(/168/)
      expect(() => feasible(good, member(m, "UTC"), FROM_UTC)).toThrow(/168/)
    })

    test(`leg (g) [M7]: assertMask throws an Error mentioning 168 for ${label}`, () => {
      expect(() => assertMask(mask)).toThrow(Error)
      expect(() => assertMask(mask)).toThrow(/168/)
    })
  }

  test("leg (g) [M7]: assertMask accepts a well-formed 168-character mask", () => {
    expect(() => assertMask(DEFAULT_MASK)).not.toThrow()
    expect(() => assertMask(EMPTY_MASK)).not.toThrow()
    expect(() => assertMask(ALL_ONES)).not.toThrow()
  })
})
