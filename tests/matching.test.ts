// Exam for Task 3, "The matcher". Every test below names the Proof leg it
// encodes and the Machine clause that leg comes from. The strategies are stubs
// carrying explicit score tables, so nothing here depends on Task 2.
import { expect, test } from "bun:test"
import { bruteForceOptimal, match, type MatchOptions, type ProposedPair } from "../src/core/matching"
import type { PairingRecord, Participant, Strategy } from "../src/types"
import { HOURS_PER_WEEK } from "../src/types"

const FULL_MASK = "1".repeat(HOURS_PER_WEEK)
const NOW = 1_700_000_000_000
const NO_HISTORY: readonly PairingRecord[] = []

function member(id: string, avoid: readonly string[] = []): Participant {
  return {
    id,
    timezone: "UTC",
    mask: FULL_MASK,
    tags: [],
    avoid,
    joinedAt: 0,
    eligibleAt: 0,
  }
}

/** Unordered key for a score table: always [min(id), max(id)]. */
function key(x: string, y: string): string {
  return x < y ? `${x}|${y}` : `${y}|${x}`
}

/** A stub strategy with an explicit score table and a fallback for the rest. */
function tableStrategy(table: Readonly<Record<string, number>>, fallback: number): Strategy<"pairing-history"> {
  return {
    name: "stub",
    reads: ["pairing-history"],
    score(a: Participant, b: Participant): number {
      return table[key(a.id, b.id)] ?? fallback
    },
  }
}

const ALWAYS_FEASIBLE = (): boolean => true

function options(feasible: (a: Participant, b: Participant) => boolean = ALWAYS_FEASIBLE): MatchOptions {
  return { now: NOW, feasible }
}

function isPair(p: ProposedPair, x: string, y: string): boolean {
  return (p.a === x && p.b === y) || (p.a === y && p.b === x)
}

function isPairOfIds(x: string, y: string, u: string, v: string): boolean {
  return (x === u && y === v) || (x === v && y === u)
}

function ids(pairs: readonly ProposedPair[]): string[] {
  return pairs.flatMap((p) => [p.a, p.b])
}

function total(pairs: readonly ProposedPair[]): number {
  return pairs.reduce((sum, p) => sum + p.score, 0)
}

function pool(n: number): Participant[] {
  return Array.from({ length: n }, (_, i) => member(`m${i + 1}`))
}

// ---------------------------------------------------------------- leg (a) --
// M1: no returned pair has two equal ids, and no id appears in more than one
// returned pair. Driven over a ten-member pool with a constant-score stub.

test("(a) [M1] over ten members with a constant score, no pair is a self-pair and no id repeats", () => {
  const p = pool(10)
  const pairs = match(p, NO_HISTORY, tableStrategy({}, 0.5), options())

  for (const pair of pairs) {
    expect(pair.a).not.toBe(pair.b)
  }

  const seen = ids(pairs)
  expect(new Set(seen).size).toBe(seen.length)

  // Greedy over ten mutually feasible members leaves nobody unmatched, so the
  // two checks above are not being satisfied by an empty result. [M1, M3]
  expect(pairs.length).toBe(5)
})

// ---------------------------------------------------------------- leg (b) --
// M2: an infeasible pair is never returned, and neither is a pair where one
// member's `avoid` names the other, however high the pair scores.

test("(b) [M2] the one infeasible pair is never returned even when it scores 1", () => {
  const p = pool(4)
  const infeasible = (a: Participant, b: Participant): boolean => !(isPairOfIds(a.id, b.id, "m1", "m2"))
  const strategy = tableStrategy({ [key("m1", "m2")]: 1 }, 0.1)

  const pairs = match(p, NO_HISTORY, strategy, options(infeasible))

  for (const pair of pairs) {
    expect(isPair(pair, "m1", "m2")).toBe(false)
  }
  // The rest of the pool is still matched, so the check above is not vacuous.
  expect(pairs.length).toBeGreaterThan(0)
})

test("(b) [M2] an avoided pair is never returned even when it scores 1", () => {
  const p = [member("m1"), member("m2"), member("m3", ["m4"]), member("m4")]
  const strategy = tableStrategy({ [key("m3", "m4")]: 1 }, 0.1)

  const pairs = match(p, NO_HISTORY, strategy, options())

  for (const pair of pairs) {
    expect(isPair(pair, "m3", "m4")).toBe(false)
  }
  // Somebody is still paired, so the check above is not vacuous. The exact
  // count is left to leg (c), which is where the tie-break of M3 is pinned.
  expect(pairs.length).toBeGreaterThan(0)
})

// ---------------------------------------------------------------- leg (c) --
// M3: greedy by descending score, ties broken by the lexicographically smaller
// [min(id), max(id)].

/**
 * The M3 four-member table. `ad` and `bc` are not named by the clause; they are
 * pinned low here so greedy never reaches them and the best matching stays
 * {ab, cd} = 1.7 as M4 states.
 */
const FOUR = [member("a"), member("b"), member("c"), member("d")]
const FOUR_TABLE: Readonly<Record<string, number>> = {
  [key("a", "b")]: 0.9,
  [key("c", "d")]: 0.8,
  [key("a", "c")]: 0.95,
  [key("b", "d")]: 0.1,
  [key("a", "d")]: 0.05,
  [key("b", "c")]: 0.02,
}
const FOUR_STRATEGY = tableStrategy(FOUR_TABLE, 0)

test("(c) [M3] the four-member table yields exactly [ac, bd]", () => {
  const pairs = match(FOUR, NO_HISTORY, FOUR_STRATEGY, options())

  expect(pairs.map((p) => [p.a, p.b])).toEqual([
    ["a", "c"],
    ["b", "d"],
  ])
})

test("(c) [M3] a tie between ab and ac picks the smaller id", () => {
  const three = [member("a"), member("b"), member("c")]
  // `bc` is not named by the clause; it sits below the tie so the assertion is
  // about the tie-break between ab and ac and nothing else.
  const strategy = tableStrategy(
    {
      [key("a", "b")]: 0.5,
      [key("a", "c")]: 0.5,
      [key("b", "c")]: 0.1,
    },
    0,
  )

  const pairs = match(three, NO_HISTORY, strategy, options())

  expect(pairs.map((p) => [p.a, p.b])).toEqual([["a", "b"]])
})

// ---------------------------------------------------------------- leg (d) --
// M4: bruteForceOptimal is the maximum total score over every set of disjoint
// feasible pairs, greedy is never above it, and the gap is reported.

test("(d) [M4] on the four-member table optimal is 1.7 and the greedy pairs sum to 1.05", () => {
  const optimal = bruteForceOptimal(FOUR, NO_HISTORY, FOUR_STRATEGY, options())
  const greedy = total(match(FOUR, NO_HISTORY, FOUR_STRATEGY, options()))

  expect(Math.abs(optimal - 1.7)).toBeLessThanOrEqual(1e-9)
  expect(Math.abs(greedy - 1.05)).toBeLessThanOrEqual(1e-9)
})

test("(d) [M4] on a two-member pool optimal is that pair's score", () => {
  const two = [member("a"), member("b")]
  const strategy = tableStrategy({ [key("a", "b")]: 0.4 }, 0)

  const optimal = bruteForceOptimal(two, NO_HISTORY, strategy, options())

  expect(Math.abs(optimal - 0.4)).toBeLessThanOrEqual(1e-9)
})

/** mulberry32, so the fixture score tables are the same on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Scores are k/1024 with k an integer in 1..1023: every score, and every sum of
 * at most five of them, is exact in IEEE754. The gap can then be compared
 * against zero with no tolerance at all.
 */
function seededTable(members: readonly Participant[], seed: number): Record<string, number> {
  const next = rng(seed)
  const table: Record<string, number> = {}
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i]!
      const b = members[j]!
      table[key(a.id, b.id)] = (1 + Math.floor(next() * 1023)) / 1024
    }
  }
  return table
}

for (const [index, size] of [2, 4, 6, 8, 9, 10].entries()) {
  test(`(d) [M4] fixture of ${size} members: optimal minus greedy is reported and is never negative`, () => {
    const p = pool(size)
    const strategy = tableStrategy(seededTable(p, 20260914 + index), 0)

    const greedy = total(match(p, NO_HISTORY, strategy, options()))
    const optimal = bruteForceOptimal(p, NO_HISTORY, strategy, options())
    const gap = optimal - greedy

    console.log(`matching gap: size=${size} greedy=${greedy} optimal=${optimal} gap=${gap}`)

    expect(gap).toBeGreaterThanOrEqual(0)
    if (size === 2) {
      expect(gap).toBeLessThanOrEqual(1e-9)
    }
  })
}

// ---------------------------------------------------------------- leg (e) --
// M5: a pool of fewer than two members returns [], and so does a pool where
// nothing is feasible.

test("(e) [M5] pools of one or zero, and a wholly infeasible pool of ten, return []", () => {
  const strategy = tableStrategy({}, 0.5)

  expect(match([member("m1")], NO_HISTORY, strategy, options())).toEqual([])
  expect(match([], NO_HISTORY, strategy, options())).toEqual([])
  expect(match(pool(10), NO_HISTORY, strategy, options(() => false))).toEqual([])
})
