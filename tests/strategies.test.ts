// Exam for Task 2: the strategy interface, round-robin, and composition.
//
// Every test below names the Proof leg (a)-(f) and the Machine clause (M1-M6)
// it encodes, so a reader can map the exam back to the task's own words.
// No clock is read and nothing sleeps: `NOW` is a fixed constant and every
// time-based value is derived from it.

import { describe, expect, test } from "bun:test"
import { buildContext, compose, roundRobin, STRATEGIES } from "../src/core/strategies"
import type {
  AllSignals,
  Context,
  MemberId,
  PairingRecord,
  Participant,
  Signal,
  Strategy,
} from "../src/types"

const DAY = 86_400_000
const NOW = 1_700_000_000_000

const ALL_SIGNAL_NAMES = [
  "pairing-history",
  "follow-up",
  "tags",
  "availability",
  "timezone",
] as const satisfies readonly Signal[]

function signals(over: Partial<AllSignals> = {}): AllSignals {
  return {
    "pairing-history": [],
    "follow-up": [],
    tags: new Map<MemberId, readonly string[]>(),
    availability: new Map<MemberId, string>(),
    timezone: new Map<MemberId, string>(),
    ...over,
  }
}

function participant(id: MemberId): Participant {
  return {
    id,
    timezone: "UTC",
    mask: "1".repeat(168),
    tags: [],
    avoid: [],
    joinedAt: NOW - 365 * DAY,
    eligibleAt: NOW,
  }
}

/** A pairing record naming `a` and `b`, in that order, created at `createdAt`. */
function record(a: MemberId, b: MemberId, createdAt: number): PairingRecord {
  return {
    id: `p:${a}:${b}:${createdAt}`,
    guildId: "g1",
    members: [a, b],
    state: "completed",
    novelty: "fresh",
    createdAt,
    threadId: null,
    voiceChannelId: null,
  }
}

/** A full context over every signal, so any strategy can be handed it. */
function ctxOf(history: readonly PairingRecord[], now: number = NOW): Context {
  return buildContext(signals({ "pairing-history": history }), ALL_SIGNAL_NAMES, now)
}

function stub(name: string, value: number, reads: readonly Signal[] = []): Strategy {
  return { name, reads, score: () => value }
}

const A = participant("a")
const B = participant("b")

// ---------------------------------------------------------------------------
// Leg (a) / M1: buildContext exposes `now` plus exactly the declared reads.
// ---------------------------------------------------------------------------

describe("leg (a) / M1: buildContext exposes now plus exactly the declared reads", () => {
  test("own enumerable keys are exactly now plus the names in reads", () => {
    const all = signals()
    const ctx = buildContext(all, ["pairing-history", "timezone"], 0)

    expect(Object.keys(ctx).sort()).toEqual(["now", "pairing-history", "timezone"])
  })

  test("an undeclared signal is a runtime absence, not just a type error", () => {
    const all = signals()
    const ctx = buildContext(all, ["pairing-history", "timezone"], 0)

    expect("tags" in ctx).toBe(false)
    // M1: "no other signal is present" covers every undeclared signal.
    expect("follow-up" in ctx).toBe(false)
    expect("availability" in ctx).toBe(false)
  })

  test("now is the now it was given, and the declared signals are the given values", () => {
    const history = [record("a", "b", NOW - DAY)]
    const all = signals({ "pairing-history": history })
    const ctx = buildContext(all, ["pairing-history", "timezone"], NOW)

    expect(ctx.now).toBe(NOW)
    expect(ctx["pairing-history"]).toEqual(history)
    expect(ctx.timezone).toEqual(all.timezone)
  })

  test("reads of a single signal yield exactly that signal plus now", () => {
    const ctx = buildContext(signals(), ["tags"], 7)

    expect(Object.keys(ctx).sort()).toEqual(["now", "tags"])
    expect(ctx.now).toBe(7)
  })

  test("an empty reads list yields now alone", () => {
    const ctx = buildContext(signals(), [], NOW)

    expect(Object.keys(ctx)).toEqual(["now"])
  })

  test("Context: buildContext copies references, never the arrays", () => {
    const all = signals({ "pairing-history": [record("a", "b", NOW - DAY)] })
    const ctx = buildContext(all, ["pairing-history", "tags"], NOW)

    expect(ctx["pairing-history"]).toBe(all["pairing-history"])
    expect(ctx.tags).toBe(all.tags)
  })
})

// ---------------------------------------------------------------------------
// Leg (b) / M2: the round-robin declaration, and strangers score 1.
// ---------------------------------------------------------------------------

describe("leg (b) / M2: round-robin declares itself and scores strangers 1", () => {
  test("name and reads equal their literals", () => {
    expect(roundRobin.name).toBe("round-robin")
    expect(roundRobin.reads).toEqual(["pairing-history"])
  })

  test("a pair absent from a three-record history scores exactly 1", () => {
    const history = [
      record("c", "d", NOW - 2 * DAY),
      record("e", "f", NOW - 9 * DAY),
      record("d", "e", NOW - 40 * DAY),
    ]
    expect(history.length).toBe(3)

    expect(roundRobin.score(A, B, ctxOf(history))).toBe(1)
  })

  test("a record naming only one of the two does not count as a pairing of both", () => {
    // M2: the score is 1 unless a record contains BOTH ids.
    const history = [
      record("a", "c", NOW - DAY),
      record("d", "b", NOW - 3 * DAY),
      record("b", "e", NOW - 5 * DAY),
    ]

    expect(roundRobin.score(A, B, ctxOf(history))).toBe(1)
  })

  test("an empty history scores 1", () => {
    expect(roundRobin.score(A, B, ctxOf([]))).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Leg (c) / M3: the recovery curve d / (d + 14).
// ---------------------------------------------------------------------------

describe("leg (c) / M3: a repeat recovers along d / (d + 14)", () => {
  test("one record 14 days before now scores exactly 0.5", () => {
    const history = [record("a", "b", NOW - 14 * DAY)]

    expect(roundRobin.score(A, B, ctxOf(history))).toBe(0.5)
  })

  test("one record 28 days before now scores 2/3 within 1e-9", () => {
    const history = [record("a", "b", NOW - 28 * DAY)]

    const score = roundRobin.score(A, B, ctxOf(history))
    expect(Math.abs(score - 2 / 3)).toBeLessThan(1e-9)
  })

  test("with two records the newer one is used: 28 days plus 14 days scores 0.5", () => {
    const history = [
      record("a", "b", NOW - 28 * DAY),
      record("a", "b", NOW - 14 * DAY),
    ]

    expect(roundRobin.score(A, B, ctxOf(history))).toBe(0.5)
  })

  test("the newer record wins whichever order the history is in", () => {
    const newerFirst = [
      record("b", "a", NOW - 14 * DAY),
      record("a", "b", NOW - 28 * DAY),
    ]

    expect(roundRobin.score(A, B, ctxOf(newerFirst))).toBe(0.5)
  })

  test("a history of pairings between other members only scores 1", () => {
    const history = [
      record("c", "d", NOW - DAY),
      record("e", "f", NOW - 14 * DAY),
      record("c", "f", NOW - 200 * DAY),
    ]

    expect(roundRobin.score(A, B, ctxOf(history))).toBe(1)
  })

  test("a pairing between other members does not lower this pair's score", () => {
    const own = [record("a", "b", NOW - 14 * DAY)]
    const withOthers = [
      record("c", "d", NOW - DAY),
      ...own,
      record("a", "c", NOW - 2 * DAY),
      record("b", "d", NOW - 3 * DAY),
    ]

    expect(roundRobin.score(A, B, ctxOf(withOthers))).toBe(0.5)
    expect(roundRobin.score(A, B, ctxOf(withOthers))).toBe(
      roundRobin.score(A, B, ctxOf(own)),
    )
  })

  test("Context: d is fractional days, so a 3.5 day old record scores 0.2", () => {
    // d = (now - createdAt) / 86400000 = 3.5; 3.5 / (3.5 + 14) = 0.2.
    const history = [record("a", "b", NOW - 3.5 * DAY)]

    const score = roundRobin.score(A, B, ctxOf(history))
    expect(Math.abs(score - 0.2)).toBeLessThan(1e-9)
  })

  test("Context: now comes from ctx.now, so an older now gives a smaller d", () => {
    const history = [record("a", "b", NOW - 28 * DAY)]

    // Read at NOW - 14 days, the same record is 14 days old.
    expect(roundRobin.score(A, B, ctxOf(history, NOW - 14 * DAY))).toBe(0.5)
  })

  test("Context: a repeat never reaches 1, so a stranger always outranks it", () => {
    const veryOld = [record("a", "b", NOW - 10_000 * DAY)]

    const repeat = roundRobin.score(A, B, ctxOf(veryOld))
    expect(repeat).toBeLessThan(1)
    expect(repeat).toBeGreaterThan(0.5)
    expect(roundRobin.score(A, B, ctxOf([]))).toBeGreaterThan(repeat)
  })
})

// ---------------------------------------------------------------------------
// Leg (d) / M4: symmetry over all 45 pairs of a ten-member fixture.
// ---------------------------------------------------------------------------

describe("leg (d) / M4: round-robin is symmetric over a ten-member fixture", () => {
  const TEN: readonly Participant[] = Array.from({ length: 10 }, (_, i) =>
    participant(`m${i}`),
  )

  // History pairs members 0 to 5 at assorted ages. Some records are stored as
  // [a, b] and some as [b, a], so an implementation keying on an ordered tuple
  // is caught here rather than passing by accident.
  const MIXED_HISTORY: readonly PairingRecord[] = [
    record("m0", "m1", NOW - 3 * DAY),
    record("m1", "m0", NOW - 31 * DAY),
    record("m2", "m0", NOW - 9 * DAY),
    record("m3", "m1", NOW - 21 * DAY),
    record("m2", "m3", NOW - 0.5 * DAY),
    record("m4", "m0", NOW - 47 * DAY),
    record("m5", "m4", NOW - 14 * DAY),
    record("m5", "m1", NOW - 2.25 * DAY),
    record("m3", "m5", NOW - 63 * DAY),
    record("m4", "m2", NOW - 5 * DAY),
  ]

  test("score(a, b) strictly equals score(b, a) for every one of the 45 pairs", () => {
    const ctx = ctxOf(MIXED_HISTORY)
    const scores: number[] = []

    for (let i = 0; i < TEN.length; i++) {
      for (let j = i + 1; j < TEN.length; j++) {
        const a = TEN[i]!
        const b = TEN[j]!
        const ab = roundRobin.score(a, b, ctx)
        const ba = roundRobin.score(b, a, ctx)
        expect(ab).toBe(ba)
        scores.push(ab)
      }
    }

    expect(scores.length).toBe(45)
    // The fixture has to exercise both branches, or symmetry proves nothing.
    expect(scores.some((s) => s < 1)).toBe(true)
    expect(scores.some((s) => s === 1)).toBe(true)
    expect(scores.every((s) => s >= 0 && s <= 1)).toBe(true)
  })

  test("the reversed-order record is still read as a pairing of that pair", () => {
    // m5 and m4 are stored as ["m5", "m4"], 14 days old: d / (d + 14) = 0.5.
    const ctx = ctxOf(MIXED_HISTORY)

    expect(roundRobin.score(TEN[4]!, TEN[5]!, ctx)).toBe(0.5)
    expect(roundRobin.score(TEN[5]!, TEN[4]!, ctx)).toBe(0.5)
  })

  test("members 6 to 9 appear in no record, so every pair among them scores 1", () => {
    const ctx = ctxOf(MIXED_HISTORY)

    expect(roundRobin.score(TEN[6]!, TEN[7]!, ctx)).toBe(1)
    expect(roundRobin.score(TEN[8]!, TEN[9]!, ctx)).toBe(1)
    expect(roundRobin.score(TEN[0]!, TEN[9]!, ctx)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Leg (e) / M5: weight-normalized sum of per-part clamped scores.
// ---------------------------------------------------------------------------

describe("leg (e) / M5: compose is the weight-normalized sum of clamped parts", () => {
  const ctx = ctxOf([])

  test("stubs scoring 1 and 0 with weights 0.5 and 0.5 give 0.5", () => {
    const one = stub("one", 1)
    const zero = stub("zero", 0)
    const composed = compose({ one: 0.5, zero: 0.5 }, [one, zero])

    expect(composed.score(A, B, ctx)).toBe(0.5)
  })

  test("the same stubs with weights 1 and 3 give 0.25", () => {
    const one = stub("one", 1)
    const zero = stub("zero", 0)
    const composed = compose({ one: 1, zero: 3 }, [one, zero])

    expect(composed.score(A, B, ctx)).toBe(0.25)
  })

  test("a stub returning 7 composed alone gives 1", () => {
    const composed = compose({ big: 1 }, [stub("big", 7)])

    expect(composed.score(A, B, ctx)).toBe(1)
  })

  test("a stub returning -2 composed alone gives 0", () => {
    const composed = compose({ negative: 1 }, [stub("negative", -2)])

    expect(composed.score(A, B, ctx)).toBe(0)
  })

  test("clamping is per part and happens before the sum", () => {
    // 7 clamps to 1 and -2 clamps to 0, so equal weights give 0.5, not 2.5.
    const composed = compose({ big: 1, negative: 1 }, [
      stub("big", 7),
      stub("negative", -2),
    ])

    expect(composed.score(A, B, ctx)).toBe(0.5)
  })

  test("weights that are all 0 give 0", () => {
    const composed = compose({ one: 0, zero: 0 }, [stub("one", 1), stub("zero", 0)])

    const score = composed.score(A, B, ctx)
    expect(Number.isNaN(score)).toBe(false)
    expect(score).toBe(0)
  })

  test("composed reads are the deduplicated union of its parts' reads", () => {
    const tagsOnly = stub("tags-only", 1, ["tags"])
    const tagsAndZone = stub("tags-and-zone", 1, ["tags", "timezone"])
    const composed = compose({ "tags-only": 1, "tags-and-zone": 1 }, [
      tagsOnly,
      tagsAndZone,
    ])

    expect([...composed.reads].sort()).toEqual(["tags", "timezone"])
  })

  test("Context: compose normalizes by the sum of the weights it was given", () => {
    // 2 * 1 + 6 * 0.5 = 5, over a weight sum of 8, is 0.625.
    const composed = compose({ one: 2, half: 6 }, [stub("one", 1), stub("half", 0.5)])

    expect(composed.score(A, B, ctx)).toBe(0.625)
  })

  test("Context: compose ignores a strategy the weights do not name", () => {
    const named = stub("named", 1)
    const unnamed = stub("unnamed", 0)
    const composed = compose({ named: 1 }, [named, unnamed])

    expect(composed.score(A, B, ctx)).toBe(1)
  })

  test("composing round-robin alone reproduces its own score", () => {
    const history = [record("a", "b", NOW - 14 * DAY)]
    const full = ctxOf(history)
    const composed = compose({ "round-robin": 1 }, [roundRobin])

    expect(composed.score(A, B, full)).toBe(0.5)
    expect(composed.score(A, B, full)).toBe(roundRobin.score(A, B, full))
  })
})

// ---------------------------------------------------------------------------
// Leg (f) / M6: a weight naming a strategy that was not supplied is an error.
// ---------------------------------------------------------------------------

describe("leg (f) / M6: compose rejects a weight naming a missing strategy", () => {
  test("compose({ 'never-met': 1 }, [roundRobin]) throws naming never-met", () => {
    let thrown: unknown = null
    try {
      compose({ "never-met": 1 }, [roundRobin])
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("never-met")
  })

  test("the error names the missing strategy, not a generic failure", () => {
    let thrown: unknown = null
    try {
      compose({ "round-robin": 1, "interest-overlap": 0.2 }, [roundRobin])
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain("interest-overlap")
  })
})

// ---------------------------------------------------------------------------
// Produces / Context: the registry build 1 ships.
// ---------------------------------------------------------------------------

describe("Produces: STRATEGIES holds only round-robin in build 1", () => {
  test("its keys are exactly ['round-robin'] and the entry is roundRobin", () => {
    expect(Object.keys(STRATEGIES)).toEqual(["round-robin"])
    expect(STRATEGIES["round-robin"]).toBe(roundRobin)
  })
})
