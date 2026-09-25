// Exam for Task 6, "The scheduling state machine".
//
// Every assertion below names the Proof leg it comes from and the Machine
// clause behind it. The module under test is pure: no wall clock is read and
// nothing sleeps, so `NOW` and `START` are constants and every deadline is
// written as the literal arithmetic its clause pins.

import { describe, expect, test } from "bun:test"
import type { CopyKey, JobKind, MemberId, PairingState } from "../src/types"
import {
  IllegalTransition,
  dueTimes,
  initialState,
  transition,
  type Effect,
  type SchedulingConfig,
  type SchedulingEvent,
  type SchedulingState,
} from "../src/core/scheduling"

// ------------------------------------------------------------- fixtures --

const A: MemberId = "member-a"
const B: MemberId = "member-b"
const MEMBERS: readonly [MemberId, MemberId] = [A, B]

const NOW = 1_699_000_000_000
const START = 1_700_000_000_000
const COUNTER_START = 1_700_003_600_000
const TZ_START = 1_700_007_200_000

/** §8 defaults: 48h negotiation timeout, `callMinutes` 30 so `callMs` is 1800000. */
const CFG: SchedulingConfig = { negotiationTimeoutMs: 172_800_000, callMs: 1_800_000 }

/** The literal offsets of M4/M5/M7, written out once. */
const ROOM_OPEN_LEAD = 600_000
const ROOM_CLOSE_TAIL = 3_600_000
const FOLLOW_UP_TAIL = 86_400_000
const SEVEN_DAYS = 604_800_000

const ALL_STATES: readonly PairingState[] = [
  "created",
  "time_proposed",
  "one_confirmed",
  "locked",
  "released",
  "completed",
  "expired",
]

const ALL_KINDS: readonly SchedulingEvent["kind"][] = [
  "propose",
  "confirm",
  "counter",
  "negotiation-timeout",
  "overlap-lost",
  "tz-repropose",
  "follow-up-due",
  "release-review",
  "archive",
  "decline",
]

function stateOf(over: Partial<SchedulingState> & { state: PairingState }): SchedulingState {
  return {
    members: MEMBERS,
    proposedStartUtc: null,
    proposedBy: null,
    countersUsed: {},
    confirmedBy: [],
    lockedStartUtc: null,
    declinedBy: [],
    ...over,
  }
}

/**
 * One representative state per `PairingState`, written as a literal rather than
 * chained through `transition`, so a wrong early transition cannot hide a later
 * row of M1's table.
 */
const REPS: Readonly<Record<PairingState, SchedulingState>> = {
  created: stateOf({ state: "created" }),
  time_proposed: stateOf({ state: "time_proposed", proposedStartUtc: START }),
  one_confirmed: stateOf({ state: "one_confirmed", proposedStartUtc: START, confirmedBy: [A] }),
  locked: stateOf({
    state: "locked",
    proposedStartUtc: START,
    confirmedBy: [A, B],
    lockedStartUtc: START,
  }),
  released: stateOf({ state: "released", proposedStartUtc: START }),
  completed: stateOf({
    state: "completed",
    proposedStartUtc: START,
    confirmedBy: [A, B],
    lockedStartUtc: START,
  }),
  expired: stateOf({ state: "expired" }),
}

/** A member who has not confirmed yet, so `confirm` is never illegal by M3 alone. */
function freeConfirmer(s: SchedulingState): MemberId {
  return s.members.find((m) => !s.confirmedBy.includes(m)) ?? s.members[0]
}

/** A member with no counter spent, preferring "the other side" (§5), so M2 never bites. */
function freeCounterer(s: SchedulingState): MemberId {
  const unspent = s.members.filter((m) => (s.countersUsed[m] ?? 0) === 0)
  return unspent.find((m) => !s.confirmedBy.includes(m)) ?? unspent[0] ?? s.members[0]
}

/** Representative event(s) of a kind; `tz-repropose` and `release-review` each branch. */
function eventsFor(kind: SchedulingEvent["kind"], s: SchedulingState): readonly SchedulingEvent[] {
  switch (kind) {
    case "propose":
      return [{ kind: "propose", startUtc: START }]
    case "confirm":
      return [{ kind: "confirm", by: freeConfirmer(s) }]
    case "counter":
      return [{ kind: "counter", by: freeCounterer(s), startUtc: COUNTER_START }]
    case "negotiation-timeout":
      return [{ kind: "negotiation-timeout" }]
    case "overlap-lost":
      return [{ kind: "overlap-lost" }]
    case "tz-repropose":
      return [
        { kind: "tz-repropose", startUtc: TZ_START },
        { kind: "tz-repropose", startUtc: null },
      ]
    case "follow-up-due":
      return [{ kind: "follow-up-due" }]
    case "release-review":
      return [
        { kind: "release-review", hadActivity: true },
        { kind: "release-review", hadActivity: false },
      ]
    case "archive":
      return [{ kind: "archive" }]
    case "decline":
      // A member who has not declined yet, with a time and with none left (#29).
      return [
        { kind: "decline", by: s.members.find((m) => !s.declinedBy.includes(m)) ?? A, startUtc: TZ_START },
        { kind: "decline", by: s.members.find((m) => !s.declinedBy.includes(m)) ?? A, startUtc: null },
      ]
  }
}

/** M1's table, keyed `<state>:<event.kind>`. Everything absent is an IllegalTransition. */
const M1: Readonly<Record<string, (ev: SchedulingEvent) => PairingState>> = {
  "created:propose": () => "time_proposed",
  "time_proposed:confirm": () => "one_confirmed",
  "time_proposed:counter": () => "time_proposed",
  "time_proposed:negotiation-timeout": () => "released",
  "time_proposed:overlap-lost": () => "released",
  "one_confirmed:confirm": () => "locked",
  "one_confirmed:counter": () => "time_proposed",
  "one_confirmed:negotiation-timeout": () => "released",
  "one_confirmed:overlap-lost": () => "released",
  "locked:tz-repropose": (ev) =>
    ev.kind === "tz-repropose" && ev.startUtc !== null ? "time_proposed" : "released",
  "locked:follow-up-due": () => "completed",
  "locked:decline": (ev) => (ev.kind === "decline" && ev.startUtc !== null ? "time_proposed" : "released"),
  "released:release-review": (ev) =>
    ev.kind === "release-review" && ev.hadActivity ? "completed" : "expired",
  "completed:archive": () => "completed",
}

/** The resulting state's name, or how the call refused. */
function outcomeLabel(s: SchedulingState, ev: SchedulingEvent): string {
  try {
    return transition(s, ev, NOW, CFG).next.state
  } catch (e) {
    if (e instanceof IllegalTransition) return "IllegalTransition"
    const name = e instanceof Error ? e.constructor.name : typeof e
    return `threw ${name}`
  }
}

function rowLabel(kind: SchedulingEvent["kind"], ev: SchedulingEvent): string {
  if (ev.kind === "tz-repropose") return `${kind}(startUtc=${ev.startUtc === null ? "null" : "set"})`
  if (ev.kind === "release-review") return `${kind}(hadActivity=${ev.hadActivity})`
  if (ev.kind === "decline") return `${kind}(startUtc=${ev.startUtc === null ? "null" : "set"})`
  return kind
}

// -------------------------------------------------------- effect helpers --

type Say = Extract<Effect, { type: "say" }>

const isCancel = (kind: JobKind) => (e: Effect) => e.type === "cancel" && e.kind === kind
const isSchedule = (kind: JobKind) => (e: Effect) => e.type === "schedule" && e.kind === kind

/** Index of the cancel of `kind`, asserted present. */
function cancelIndex(fx: readonly Effect[], kind: JobKind): number {
  const i = fx.findIndex(isCancel(kind))
  expect(`cancel ${kind} present: ${i >= 0}`).toBe(`cancel ${kind} present: true`)
  expect(fx[i]).toEqual({ type: "cancel", kind })
  return i
}

/** Index of the schedule of `kind`, asserted present and at exactly `runAt`. */
function scheduleIndex(fx: readonly Effect[], kind: JobKind, runAt: number): number {
  const i = fx.findIndex(isSchedule(kind))
  expect(`schedule ${kind} present: ${i >= 0}`).toBe(`schedule ${kind} present: true`)
  expect(fx[i]).toEqual({ type: "schedule", kind, runAt })
  return i
}

/** The single `say` of an effect list. */
function onlySay(fx: readonly Effect[]): Say {
  const says = fx.filter((e): e is Say => e.type === "say")
  expect(says.length).toBe(1)
  return says[0]!
}

function expectSay(fx: readonly Effect[], copy: CopyKey, vars: Record<string, string | number>): void {
  const say = onlySay(fx)
  expect(say.copy).toBe(copy)
  expect({ ...(say.vars ?? {}) }).toEqual(vars)
}

// ------------------------------------------------------------ the legs --

describe("leg (a): the whole transition table [M1]", () => {
  test("all 70 (state, event.kind) combinations land on M1's target or throw IllegalTransition", () => {
    expect(ALL_STATES.length).toBe(7)
    expect(ALL_KINDS.length).toBe(10)

    const observedLegal: string[] = []
    let combinations = 0

    for (const state of ALL_STATES) {
      for (const kind of ALL_KINDS) {
        combinations += 1
        const key = `${state}:${kind}`
        const rule = M1[key]
        const rep = REPS[state]
        let sawLegal = false

        // `tz-repropose` and `release-review` each branch, so a combination can
        // carry two target rows; both are exercised under the one combination.
        for (const ev of eventsFor(kind, rep)) {
          const expected = rule ? rule(ev) : "IllegalTransition"
          const label = `${state} + ${rowLabel(kind, ev)}`
          expect(`${label} -> ${outcomeLabel(rep, ev)}`).toBe(`${label} -> ${expected}`)
          if (rule) sawLegal = true
        }

        if (sawLegal) observedLegal.push(key)
      }
    }

    expect(combinations).toBe(70)
    // The count of legal combinations found is exactly 14 (13 at build 1, plus locked:decline).
    expect(observedLegal.length).toBe(14)
    expect(observedLegal.slice().sort()).toEqual(Object.keys(M1).slice().sort())
  })

  test("IllegalTransition is an Error subclass", () => {
    const err = new IllegalTransition("nope")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(IllegalTransition)
  })

  test("initialState is `created` with no proposal, empty counters and no confirmations", () => {
    expect(initialState(MEMBERS)).toEqual({
      state: "created",
      members: [A, B],
      proposedStartUtc: null,
      proposedBy: null,
      countersUsed: {},
      confirmedBy: [],
      lockedStartUtc: null,
      declinedBy: [],
    })
  })
})

describe("leg (b): the one counter per side [M2]", () => {
  test("a member's second counter throws IllegalTransition", () => {
    const first = transition(
      REPS.time_proposed,
      { kind: "counter", by: A, startUtc: COUNTER_START },
      NOW,
      CFG,
    )
    expect(first.next.state).toBe("time_proposed")
    expect(first.next.countersUsed[A] ?? 0).toBe(1)

    expect(
      outcomeLabel(first.next, { kind: "counter", by: A, startUtc: TZ_START }),
    ).toBe("IllegalTransition")
  })

  test("a counter by the other member from one_confirmed empties confirmedBy", () => {
    // REPS.one_confirmed has A confirmed; B counters instead of confirming.
    const { next } = transition(
      REPS.one_confirmed,
      { kind: "counter", by: B, startUtc: COUNTER_START },
      NOW,
      CFG,
    )
    expect(next.state).toBe("time_proposed")
    expect(next.confirmedBy).toEqual([])
    expect(next.countersUsed[B] ?? 0).toBe(1)
    // The new proposal is the one that now needs both confirmations again.
    expect(next.proposedStartUtc).toBe(COUNTER_START)
    expect(next.proposedBy).toBe(B)
  })
})

describe("leg (c): confirmations [M3]", () => {
  test("a confirm by a member already in confirmedBy throws IllegalTransition", () => {
    expect(outcomeLabel(REPS.one_confirmed, { kind: "confirm", by: A })).toBe("IllegalTransition")
  })

  test("confirm by each member in turn locks at the proposal's startUtc", () => {
    const proposed = transition(REPS.created, { kind: "propose", startUtc: START }, NOW, CFG)
    expect(proposed.next.state).toBe("time_proposed")
    expect(proposed.next.proposedStartUtc).toBe(START)
    expect(proposed.next.proposedBy).toBe(null)

    const one = transition(proposed.next, { kind: "confirm", by: A }, NOW, CFG)
    expect(one.next.state).toBe("one_confirmed")
    expect(one.next.confirmedBy).toEqual([A])
    expect(one.next.lockedStartUtc).toBe(null)

    const two = transition(one.next, { kind: "confirm", by: B }, NOW, CFG)
    expect(two.next.state).toBe("locked")
    expect(two.next.lockedStartUtc).toBe(START)
    expect(two.next.confirmedBy.slice().sort()).toEqual([A, B])
  })
})

describe("leg (d): negotiation and lock deadlines [M4]", () => {
  test("propose cancels then schedules negotiation-release at now + negotiationTimeoutMs", () => {
    const { effects } = transition(REPS.created, { kind: "propose", startUtc: START }, NOW, CFG)
    const cancel = cancelIndex(effects, "negotiation-release")
    const schedule = scheduleIndex(effects, "negotiation-release", NOW + CFG.negotiationTimeoutMs)
    expect(schedule).toBeGreaterThan(cancel)
  })

  test("counter cancels then schedules negotiation-release at now + negotiationTimeoutMs", () => {
    const { effects } = transition(
      REPS.time_proposed,
      { kind: "counter", by: A, startUtc: COUNTER_START },
      NOW,
      CFG,
    )
    const cancel = cancelIndex(effects, "negotiation-release")
    const schedule = scheduleIndex(effects, "negotiation-release", NOW + CFG.negotiationTimeoutMs)
    expect(schedule).toBeGreaterThan(cancel)
  })

  test("the locking confirm cancels negotiation-release and schedules the three call jobs", () => {
    const { next, effects } = transition(REPS.one_confirmed, { kind: "confirm", by: B }, NOW, CFG)
    expect(next.state).toBe("locked")

    const cancel = cancelIndex(effects, "negotiation-release")
    const roomOpen = scheduleIndex(effects, "room-open", START - ROOM_OPEN_LEAD)
    const roomClose = scheduleIndex(effects, "room-close", START + CFG.callMs + ROOM_CLOSE_TAIL)
    const followUp = scheduleIndex(effects, "follow-up", START + CFG.callMs + FOLLOW_UP_TAIL)

    expect(roomOpen).toBeGreaterThan(cancel)
    expect(roomClose).toBeGreaterThan(cancel)
    expect(followUp).toBeGreaterThan(cancel)
  })
})

describe("leg (e): release, follow-up and expiry [M5]", () => {
  const releases: readonly {
    label: string
    from: SchedulingState
    ev: SchedulingEvent
    say: CopyKey
  }[] = [
    {
      label: "negotiation-timeout from time_proposed",
      from: REPS.time_proposed,
      ev: { kind: "negotiation-timeout" },
      say: "released-timeout",
    },
    {
      label: "negotiation-timeout from one_confirmed",
      from: REPS.one_confirmed,
      ev: { kind: "negotiation-timeout" },
      say: "released-timeout",
    },
    {
      label: "overlap-lost from time_proposed",
      from: REPS.time_proposed,
      ev: { kind: "overlap-lost" },
      say: "released-overlap",
    },
    {
      label: "overlap-lost from one_confirmed",
      from: REPS.one_confirmed,
      ev: { kind: "overlap-lost" },
      say: "released-overlap",
    },
    {
      label: "tz-repropose with null from locked",
      from: REPS.locked,
      ev: { kind: "tz-repropose", startUtc: null },
      say: "released-overlap",
    },
  ]

  for (const entry of releases) {
    test(`entering released by ${entry.label} schedules expire, cancels four jobs and says ${entry.say}`, () => {
      const { next, effects } = transition(entry.from, entry.ev, NOW, CFG)
      expect(next.state).toBe("released")

      scheduleIndex(effects, "expire", NOW + SEVEN_DAYS)
      cancelIndex(effects, "negotiation-release")
      cancelIndex(effects, "room-open")
      cancelIndex(effects, "room-close")
      cancelIndex(effects, "follow-up")
      expectSay(effects, entry.say, {})
    })
  }

  test("follow-up-due on locked completes, says follow-up and schedules archive at now + 7d", () => {
    const { next, effects } = transition(REPS.locked, { kind: "follow-up-due" }, NOW, CFG)
    expect(next.state).toBe("completed")
    scheduleIndex(effects, "archive", NOW + SEVEN_DAYS)
    expectSay(effects, "follow-up", {})
  })

  test("release-review with activity completes with the same two effects", () => {
    const { next, effects } = transition(
      REPS.released,
      { kind: "release-review", hadActivity: true },
      NOW,
      CFG,
    )
    expect(next.state).toBe("completed")
    scheduleIndex(effects, "archive", NOW + SEVEN_DAYS)
    expectSay(effects, "follow-up", {})
  })

  test("release-review without activity expires and yields an archive effect", () => {
    const { next, effects } = transition(
      REPS.released,
      { kind: "release-review", hadActivity: false },
      NOW,
      CFG,
    )
    expect(next.state).toBe("expired")
    expect(effects).toContainEqual({ type: "archive" })
  })
})

describe("leg (f): a timezone re-proposal reopens the negotiation [M6]", () => {
  test("tz-repropose with a startUtc from locked resets counters, confirmations and jobs", () => {
    const locked = stateOf({
      state: "locked",
      proposedStartUtc: START,
      proposedBy: A,
      countersUsed: { [A]: 1, [B]: 1 },
      confirmedBy: [A, B],
      lockedStartUtc: START,
    })

    const { next, effects } = transition(locked, { kind: "tz-repropose", startUtc: TZ_START }, NOW, CFG)

    expect(next.state).toBe("time_proposed")
    expect({ ...next.countersUsed }).toEqual({})
    expect(next.confirmedBy).toEqual([])

    cancelIndex(effects, "room-open")
    cancelIndex(effects, "room-close")
    cancelIndex(effects, "follow-up")
    scheduleIndex(effects, "negotiation-release", NOW + CFG.negotiationTimeoutMs)
  })
})

describe("leg (g): the three due times [M7]", () => {
  test("dueTimes returns the three literal offsets", () => {
    expect(dueTimes(1_000_000_000_000, { negotiationTimeoutMs: 0, callMs: 1_800_000 })).toEqual({
      roomOpen: 999_999_400_000,
      roomClose: 1_000_005_400_000,
      followUp: 1_000_088_200_000,
    })
  })
})

describe("effect ordering: cancels first, then schedules, then says", () => {
  test("every legal transition emits its effects in that order", () => {
    for (const key of Object.keys(M1)) {
      const [state, kind] = key.split(":") as [PairingState, SchedulingEvent["kind"]]
      const rep = REPS[state]

      for (const ev of eventsFor(kind, rep)) {
        const { effects } = transition(rep, ev, NOW, CFG)
        const at = (type: Effect["type"]) =>
          effects.flatMap((e, i) => (e.type === type ? [i] : []))
        const cancels = at("cancel")
        const schedules = at("schedule")
        const says = at("say")

        const lastCancel = cancels.length ? Math.max(...cancels) : -1
        const firstSchedule = schedules.length ? Math.min(...schedules) : Infinity
        const lastSchedule = schedules.length ? Math.max(...schedules) : -1
        const firstSay = says.length ? Math.min(...says) : Infinity

        const label = `${state} + ${rowLabel(kind, ev)}`
        expect(`${label}: cancels before schedules: ${lastCancel < firstSchedule}`).toBe(
          `${label}: cancels before schedules: true`,
        )
        expect(`${label}: schedules before says: ${lastSchedule < firstSay}`).toBe(
          `${label}: schedules before says: true`,
        )
      }
    }
  })
})

describe("say copy keys and their vars", () => {
  test("propose says `proposal` with the proposal's start", () => {
    const { effects } = transition(REPS.created, { kind: "propose", startUtc: START }, NOW, CFG)
    expectSay(effects, "proposal", { start: START })
  })

  test("counter says `counter` with the new start", () => {
    const { effects } = transition(
      REPS.time_proposed,
      { kind: "counter", by: A, startUtc: COUNTER_START },
      NOW,
      CFG,
    )
    expectSay(effects, "counter", { start: COUNTER_START })
  })

  test("the first confirm says `one-confirmed` with the confirming member", () => {
    const { effects } = transition(REPS.time_proposed, { kind: "confirm", by: A }, NOW, CFG)
    expectSay(effects, "one-confirmed", { by: A })
  })

  test("the locking confirm says `locked` with the locked start", () => {
    const { effects } = transition(REPS.one_confirmed, { kind: "confirm", by: B }, NOW, CFG)
    expectSay(effects, "locked", { start: START })
  })
})

// ------------------------------------------ leg (h): Can't make it (#29, Task 2) --

describe("leg (h): a decline moves a locked call once per member [M2..M5]", () => {
  const LOCKED = REPS.locked

  test("(b) a fresh member with a time: back to time_proposed, jobs cancelled, declined said [M2]", () => {
    const { next, effects } = transition(LOCKED, { kind: "decline", by: A, startUtc: TZ_START }, NOW, CFG)
    expect(next.state).toBe("time_proposed")
    expect(next.proposedStartUtc).toBe(TZ_START)
    expect(next.proposedBy).toBeNull()
    expect(next.confirmedBy).toEqual([])
    expect(next.countersUsed).toEqual({})
    expect(next.lockedStartUtc).toBeNull()
    expect(next.declinedBy).toEqual([A])
    expect(effects).toEqual([
      { type: "cancel", kind: "room-open" },
      { type: "cancel", kind: "room-close" },
      { type: "cancel", kind: "follow-up" },
      { type: "schedule", kind: "negotiation-release", runAt: NOW + CFG.negotiationTimeoutMs },
      { type: "say", copy: "declined", vars: { who: A, old: START, start: TZ_START } },
    ])
  })

  test("(c) a fresh member with no time left: released, released-overlap said [M3]", () => {
    const { next, effects } = transition(LOCKED, { kind: "decline", by: A, startUtc: null }, NOW, CFG)
    expect(next.state).toBe("released")
    expect(next.lockedStartUtc).toBeNull()
    expect(onlySay(effects).copy).toBe("released-overlap")
    cancelIndex(effects, "room-open")
    cancelIndex(effects, "room-close")
    cancelIndex(effects, "follow-up")
    scheduleIndex(effects, "expire", NOW + SEVEN_DAYS)
  })

  test("(d) a spent member: released when both are spent, IllegalTransition when only they are [M4]", () => {
    const bothSpent = stateOf({ ...LOCKED, declinedBy: [A, B] })
    const { next, effects } = transition(bothSpent, { kind: "decline", by: A, startUtc: TZ_START }, NOW, CFG)
    expect(next.state).toBe("released")
    expect(onlySay(effects).copy).toBe("released-declines")

    const oneSpent = stateOf({ ...LOCKED, declinedBy: [A] })
    expect(() => transition(oneSpent, { kind: "decline", by: A, startUtc: TZ_START }, NOW, CFG)).toThrow(
      IllegalTransition,
    )
  })

  test("(e) declinedBy survives the re-lock [M5]", () => {
    const declined = transition(LOCKED, { kind: "decline", by: A, startUtc: TZ_START }, NOW, CFG).next
    const one = transition(declined, { kind: "confirm", by: A }, NOW, CFG).next
    const relocked = transition(one, { kind: "confirm", by: B }, NOW, CFG).next
    expect(relocked.state).toBe("locked")
    expect(relocked.lockedStartUtc).toBe(TZ_START)
    expect(relocked.declinedBy).toEqual([A])
  })
})
