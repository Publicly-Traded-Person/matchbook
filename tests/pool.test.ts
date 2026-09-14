// The exam for Task 5, "The pool decision: holding, pull-forward, novelty".
//
// One block per Proof leg (a)-(h); each test name carries its leg letter and the
// Machine clause it encodes, so a reader can map any failure back to the
// contract. Nothing here reads the wall clock: every time is derived from the
// fixed NOW below and handed to decidePool as `now`.

import { describe, expect, test } from "bun:test"
import type { GuildId, MemberId, MemberRow, Novelty, PairingRecord } from "../src/types"
import { decidePool } from "../src/core/pool"
import type { PoolConfig, PoolDecision, PoolInput, PoolNotice } from "../src/core/pool"

// ------------------------------------------------------------------ fixtures --

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** A fixed instant. Every fixture time is NOW plus or minus a constant. */
const NOW = 1_767_225_600_000 // 2026-01-01T00:00:00Z

const GUILD: GuildId = "g1"

/** The shipped defaults of §4a, restated so the arithmetic below is readable. */
const CFG: PoolConfig = {
  cadenceMs: 14 * DAY,
  holdingWindowMs: 24 * HOUR,
  pullForwardMaxMs: 3 * DAY,
}

const FULL_MASK = "1".repeat(168)

function member(id: MemberId, over: Partial<MemberRow> = {}): MemberRow {
  return {
    guildId: GUILD,
    id,
    state: "active",
    timezone: "UTC",
    tags: [],
    avoid: [],
    mask: FULL_MASK,
    preset: "any-reasonable-hour",
    eligibleAt: NOW,
    welcome: false,
    lastWelcomeAt: null,
    needsAck: false,
    checkinsIgnored: 0,
    checkinSentAt: null,
    overlapNoticeAt: null,
    joinedAt: NOW - 30 * DAY,
    ...over,
  }
}

function pairingRecord(
  id: string,
  a: MemberId,
  b: MemberId,
  createdAt: number,
  novelty: Novelty = "fresh",
): PairingRecord {
  return {
    id,
    guildId: GUILD,
    members: [a, b],
    state: "completed",
    novelty,
    createdAt,
    threadId: null,
    voiceChannelId: null,
  }
}

/**
 * A stub matcher that proposes the configured pairs in a fixed order, keeping
 * only those whose two ids are both in the pool it was handed (a real matcher
 * over a one-member pool proposes nothing).
 */
function stubPick(...pairs: readonly (readonly [MemberId, MemberId])[]) {
  return (pool: readonly MemberRow[]): readonly { a: MemberId; b: MemberId }[] => {
    const ids = new Set(pool.map((m) => m.id))
    return pairs.filter(([a, b]) => ids.has(a) && ids.has(b)).map(([a, b]) => ({ a, b }))
  }
}

/** Proposes every pair in the pool, in a fixed order. */
function pickEveryPair(pool: readonly MemberRow[]): readonly { a: MemberId; b: MemberId }[] {
  const out: { a: MemberId; b: MemberId }[] = []
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      out.push({ a: pool[i]!.id, b: pool[j]!.id })
    }
  }
  return out
}

type InputOver = Partial<PoolInput> & { members: readonly MemberRow[] }

function poolInput(over: InputOver): PoolInput {
  return {
    members: over.members,
    history: over.history ?? [],
    openPairingMembers: over.openPairingMembers ?? new Set<MemberId>(),
    now: over.now ?? NOW,
    cfg: over.cfg ?? CFG,
    feasible: over.feasible ?? (() => true),
    pick: over.pick ?? (() => []),
  }
}

/** Pairing member order is not pinned by the task; compare sorted tuples. */
function pairIds(p: { members: readonly [MemberId, MemberId] }): MemberId[] {
  return [p.members[0], p.members[1]].sort()
}

function noticesFor(d: PoolDecision, id: MemberId): readonly PoolNotice[] {
  return d.notices.filter((n) => n.memberId === id)
}

// ------------------------------------------------------------------- leg (a) --

describe("(a) [M1] a fresh pair, and who is never in one", () => {
  test("(a) [M1] two eligible feasible strangers proposed by pick yield exactly one 'fresh' pairing and an empty pullForward", () => {
    const a = member("m1", { eligibleAt: NOW })
    const b = member("m2", { eligibleAt: NOW })

    const d = decidePool(
      poolInput({ members: [a, b], pick: stubPick(["m1", "m2"]) }),
    )

    expect(d.pairings.length).toBe(1)
    expect(pairIds(d.pairings[0]!)).toEqual(["m1", "m2"])
    expect(d.pairings[0]!.novelty).toBe("fresh")
    expect(d.pullForward).toEqual([])
  })

  // The lone pool member has waited past the holding window, and the one other
  // member is feasible and never paired: only the ineligibility of that other
  // member keeps the decision empty. [M1]
  const lone = member("lone", { eligibleAt: NOW - CFG.holdingWindowMs - 1 })

  const ineligible: readonly { label: string; other: MemberRow; open?: MemberId }[] = [
    { label: "a paused member", other: member("other", { state: "paused", eligibleAt: NOW }) },
    { label: "a needsAck member", other: member("other", { needsAck: true, eligibleAt: NOW }) },
    {
      label: "a member whose eligibleAt is more than pullForwardMaxMs after now",
      other: member("other", { eligibleAt: NOW + CFG.pullForwardMaxMs + 1 }),
    },
    {
      label: "a member in openPairingMembers",
      other: member("other", { eligibleAt: NOW }),
      open: "other",
    },
  ]

  for (const c of ineligible) {
    test(`(a) [M1] ${c.label} is never paired and never pulled forward, even past the holding window`, () => {
      const d = decidePool(
        poolInput({
          members: [lone, c.other],
          openPairingMembers: new Set<MemberId>(c.open ? [c.open] : []),
          pick: stubPick(["lone", "other"]),
        }),
      )

      expect(d.pairings).toEqual([])
      expect(d.pullForward).toEqual([])
    })
  }
})

// ------------------------------------------------------------------- leg (b) --

describe("(b) [M2] the holding window and the soonest stranger in reach", () => {
  const far = member("sFar", { eligibleAt: NOW + 2 * DAY })
  const near = member("sNear", { eligibleAt: NOW + 1 * DAY })

  test("(b) [M2] alone for less than holdingWindowMs: no pairing and no pullForward", () => {
    const lone = member("lone", { eligibleAt: NOW - CFG.holdingWindowMs + 1 })

    const d = decidePool(poolInput({ members: [lone, far, near] }))

    expect(d.pairings).toEqual([])
    expect(d.pullForward).toEqual([])
  })

  test("(b) [M2] alone for exactly holdingWindowMs: paired 'held' with the soonest in-reach stranger, who is the sole pullForward entry", () => {
    const lone = member("lone", { eligibleAt: NOW - CFG.holdingWindowMs })

    const d = decidePool(poolInput({ members: [lone, far, near] }))

    expect(d.pairings.length).toBe(1)
    expect(pairIds(d.pairings[0]!)).toEqual(["lone", "sNear"])
    expect(d.pairings[0]!.novelty).toBe("held")
    expect(d.pullForward).toEqual(["sNear"])

    // Being paired sets eligibleAt to now + cadence for every paired member
    // (§4a, algorithm step 4). [M2]
    const updated = new Map(d.updates.map((u) => [u.id, u.eligibleAt]))
    expect(updated.get("lone")).toBe(NOW + CFG.cadenceMs)
    expect(updated.get("sNear")).toBe(NOW + CFG.cadenceMs)
  })
})

// ------------------------------------------------------------------- leg (c) --

describe("(c) [M3] novelty outranks the window, until no stranger exists anywhere", () => {
  const lone = member("lone", { eligibleAt: NOW - CFG.holdingWindowMs - 1 })
  const repeatFar = member("rFar", { eligibleAt: NOW + 2 * DAY })
  const repeatNear = member("rNear", { eligibleAt: NOW + 1 * DAY })
  const strangerOutOfReach = member("sOut", { eligibleAt: NOW + 10 * DAY })

  const met: readonly PairingRecord[] = [
    pairingRecord("p1", "lone", "rFar", NOW - 40 * DAY),
    pairingRecord("p2", "lone", "rNear", NOW - 30 * DAY),
  ]

  test("(c) [M3] only in-reach members are repeats while a stranger exists out of reach: no pairing, no pullForward", () => {
    const d = decidePool(
      poolInput({
        members: [lone, repeatFar, repeatNear, strangerOutOfReach],
        history: met,
      }),
    )

    expect(d.pairings).toEqual([])
    expect(d.pullForward).toEqual([])
  })

  test("(c) [M3] no stranger anywhere: the soonest-eligible in-reach repeat is pulled forward as 'reconnect'", () => {
    const d = decidePool(
      poolInput({
        // History now covers every active member, so `lone` has no stranger.
        members: [lone, repeatFar, repeatNear],
        history: met,
      }),
    )

    expect(d.pairings.length).toBe(1)
    expect(pairIds(d.pairings[0]!)).toEqual(["lone", "rNear"])
    expect(d.pairings[0]!.novelty).toBe("reconnect")
    expect(d.pullForward).toEqual(["rNear"])
  })
})

// ------------------------------------------------------------------- leg (d) --

describe("(d) [M4] holding for a stranger, for at most one cadence", () => {
  const history = [pairingRecord("p1", "p1m", "p2m", NOW - 60 * DAY)]
  const stranger = member("s", { eligibleAt: NOW + 10 * DAY })

  test("(d) [M4] the best pairing is a repeat and a stranger exists among active members: no pairing, a 'holding-for-stranger' notice per pool member", () => {
    const a = member("p1m", { eligibleAt: NOW })
    const b = member("p2m", { eligibleAt: NOW })

    const d = decidePool(
      poolInput({
        members: [a, b, stranger],
        history,
        pick: stubPick(["p1m", "p2m"]),
      }),
    )

    expect(d.pairings).toEqual([])
    expect(d.pullForward).toEqual([])

    const held = d.notices.filter((n) => n.kind === "holding-for-stranger")
    expect(held.map((n) => n.memberId).sort()).toEqual(["p1m", "p2m"])
  })

  test("(d) [M4] the same input with a full cadence waited since eligibleAt: the repeat is paired with novelty 'held'", () => {
    const a = member("p1m", { eligibleAt: NOW - CFG.cadenceMs })
    const b = member("p2m", { eligibleAt: NOW - CFG.cadenceMs })

    const d = decidePool(
      poolInput({
        members: [a, b, stranger],
        history,
        pick: stubPick(["p1m", "p2m"]),
      }),
    )

    expect(d.pairings.length).toBe(1)
    expect(pairIds(d.pairings[0]!)).toEqual(["p1m", "p2m"])
    expect(d.pairings[0]!.novelty).toBe("held")
  })
})

// ------------------------------------------------------------------- leg (e) --

describe("(e) [M5] met everyone: reconnect, and say so", () => {
  test("(e) [M5] a repeat pair with no stranger on either side is 'reconnect' and names each side in a 'met-everyone' notice", () => {
    const a = member("ma", { eligibleAt: NOW })
    const b = member("mb", { eligibleAt: NOW })
    const c = member("mc", { eligibleAt: NOW + 10 * DAY })

    const firstAB = NOW - 100 * DAY
    const newestAB = NOW - 20 * DAY
    const history = [
      pairingRecord("p1", "ma", "mb", firstAB),
      pairingRecord("p2", "ma", "mc", NOW - 80 * DAY),
      pairingRecord("p3", "mb", "mc", NOW - 60 * DAY),
      pairingRecord("p4", "mb", "ma", newestAB), // newest createdAt naming both
    ]

    const d = decidePool(
      poolInput({ members: [a, b, c], history, pick: stubPick(["ma", "mb"]) }),
    )

    expect(d.pairings.length).toBe(1)
    expect(pairIds(d.pairings[0]!)).toEqual(["ma", "mb"])
    expect(d.pairings[0]!.novelty).toBe("reconnect")

    expect(d.notices.length).toBe(2)
    const byMember = new Map(d.notices.map((n) => [n.memberId, n]))

    const forA = byMember.get("ma")
    expect(forA?.kind).toBe("met-everyone")
    expect(forA?.partnerId).toBe("mb")
    expect(forA?.lastPairedAt).toBe(newestAB)

    const forB = byMember.get("mb")
    expect(forB?.kind).toBe("met-everyone")
    expect(forB?.partnerId).toBe("ma")
    expect(forB?.lastPairedAt).toBe(newestAB)
  })
})

// ------------------------------------------------------------------- leg (f) --

describe("(f) [M6] nobody shares their hours", () => {
  test("(f) [M6] a pool member feasible with nobody gets exactly one notice, of kind 'no-overlap', and is never paired or pulled forward", () => {
    const lonely = member("solo", { eligibleAt: NOW - 30 * DAY })
    const y = member("my", { eligibleAt: NOW })
    const z = member("mz", { eligibleAt: NOW })

    const d = decidePool(
      poolInput({
        members: [lonely, y, z],
        feasible: (a, b) => a.id !== "solo" && b.id !== "solo",
        pick: stubPick(["solo", "my"], ["my", "mz"]),
      }),
    )

    const mine = noticesFor(d, "solo")
    expect(mine.length).toBe(1)
    expect(mine[0]!.kind).toBe("no-overlap")

    expect(d.pairings.some((p) => pairIds(p).includes("solo"))).toBe(false)
    expect(d.pullForward).not.toContain("solo")

    // The rest of the pool is unaffected: the feasible pair still forms. [M1]
    expect(d.pairings.length).toBe(1)
    expect(pairIds(d.pairings[0]!)).toEqual(["my", "mz"])
  })
})

// ------------------------------------------------------------------- leg (g) --

describe("(g) [M7] the shape of any returned decision", () => {
  test("(g) [M7] over 20 randomized members every pairing is distinct, disjoint, feasible and not avoided, and no update moves eligibleAt before now", () => {
    const rnd = (() => {
      let s = 20260101 >>> 0
      return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0
        return s / 4294967296
      }
    })()

    const id = (i: number) => `m${String(i).padStart(2, "0")}`

    // m01 is infeasible with m02..m06 (the seeded feasible table); m07 avoids
    // m01 through its row's avoid list, so M7's "feasible" and "not avoided"
    // are exercised separately.
    const infeasibleWithM01 = new Set(["m02", "m03", "m04", "m05", "m06"])
    const feasible = (a: MemberRow, b: MemberRow): boolean => {
      if (a.id === "m01" && infeasibleWithM01.has(b.id)) return false
      if (b.id === "m01" && infeasibleWithM01.has(a.id)) return false
      return true
    }

    const members: MemberRow[] = []
    for (let i = 1; i <= 20; i++) {
      const mid = id(i)
      const past = rnd() < 0.7
      members.push(
        member(mid, {
          eligibleAt: past
            ? NOW - Math.floor(rnd() * 5 * DAY)
            : NOW + Math.floor(1 + rnd() * 4 * DAY),
          avoid: mid === "m07" ? ["m01"] : [],
          joinedAt: NOW - Math.floor(10 + rnd() * 100) * DAY,
        }),
      )
    }

    const history: PairingRecord[] = []
    for (let i = 0; i < 25; i++) {
      const a = 1 + Math.floor(rnd() * 20)
      let b = 1 + Math.floor(rnd() * 20)
      if (b === a) b = a === 20 ? 1 : a + 1
      history.push(pairingRecord(`h${i}`, id(a), id(b), NOW - Math.floor(1 + rnd() * 90) * DAY))
    }

    const d = decidePool(
      poolInput({ members, history, feasible, pick: pickEveryPair }),
    )

    // A pick proposing every pair over this pool must yield some pairing; an
    // empty decision would make the rest of this leg vacuous.
    expect(d.pairings.length).toBeGreaterThan(0)

    const rows = new Map(members.map((m) => [m.id, m]))
    const seen = new Set<MemberId>()
    const banned = new Set(["m02", "m03", "m04", "m05", "m06", "m07"])

    for (const p of d.pairings) {
      const [a, b] = [p.members[0], p.members[1]]
      expect(a).not.toBe(b)
      expect(seen.has(a)).toBe(false)
      expect(seen.has(b)).toBe(false)
      seen.add(a)
      seen.add(b)
      expect(feasible(rows.get(a)!, rows.get(b)!)).toBe(true)
      if (a === "m01") expect(banned.has(b)).toBe(false)
      if (b === "m01") expect(banned.has(a)).toBe(false)
    }

    for (const u of d.updates) {
      expect(u.eligibleAt).toBeGreaterThanOrEqual(NOW)
    }
  })
})

// ------------------------------------------------------------------- leg (h) --

describe("(h) [M8] a synchronized cohort spreads out", () => {
  test("(h) [M8] after 42 simulated days the twelve originals hold at least 3 distinct eligibleAt values", () => {
    const originals = Array.from({ length: 12 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`)
    const rows = new Map<MemberId, MemberRow>()
    for (const mid of originals) {
      rows.set(mid, member(mid, { eligibleAt: NOW, joinedAt: NOW }))
    }

    const history: PairingRecord[] = []
    const open: { a: MemberId; b: MemberId; until: number }[] = []
    const lastPaired = new Map<string, number>()
    const key = (a: MemberId, b: MemberId) => [a, b].sort().join("|")

    // The stub matcher: greedily prefer never-paired pairs, then oldest repeats.
    const greedyPick = (pool: readonly MemberRow[]): readonly { a: MemberId; b: MemberId }[] => {
      const cands: { a: MemberId; b: MemberId; last: number }[] = []
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          const a = pool[i]!.id
          const b = pool[j]!.id
          cands.push({ a, b, last: lastPaired.get(key(a, b)) ?? -1 })
        }
      }
      cands.sort((x, y) => {
        const fresh = (x.last === -1 ? 0 : 1) - (y.last === -1 ? 0 : 1)
        if (fresh !== 0) return fresh
        if (x.last !== y.last) return x.last - y.last
        if (x.a !== y.a) return x.a < y.a ? -1 : 1
        return x.b < y.b ? -1 : x.b > y.b ? 1 : 0
      })
      const used = new Set<MemberId>()
      const out: { a: MemberId; b: MemberId }[] = []
      for (const c of cands) {
        if (used.has(c.a) || used.has(c.b)) continue
        used.add(c.a)
        used.add(c.b)
        out.push({ a: c.a, b: c.b })
      }
      return out
    }

    let newcomers = 0
    let seq = 0

    for (let hour = 0; hour <= 42 * 24; hour++) {
      const now = NOW + hour * HOUR

      // A newcomer every 5 days, eligible the moment they join (§4a).
      if (hour > 0 && hour % (5 * 24) === 0) {
        newcomers += 1
        const nid = `n${String(newcomers).padStart(2, "0")}`
        rows.set(nid, member(nid, { eligibleAt: now, joinedAt: now }))
      }

      // Each pairing is held open for two days.
      const openMembers = new Set<MemberId>()
      for (const o of open) {
        if (o.until > now) {
          openMembers.add(o.a)
          openMembers.add(o.b)
        }
      }

      const d = decidePool({
        members: [...rows.values()],
        history,
        openPairingMembers: openMembers,
        now,
        cfg: CFG,
        feasible: () => true,
        pick: greedyPick,
      })

      for (const u of d.updates) rows.set(u.id, u)

      for (const p of d.pairings) {
        const a = p.members[0]
        const b = p.members[1]
        seq += 1
        history.push(pairingRecord(`sim${seq}`, a, b, now, p.novelty))
        lastPaired.set(key(a, b), now)
        open.push({ a, b, until: now + 2 * DAY })
      }
    }

    const spread = new Set(originals.map((mid) => rows.get(mid)!.eligibleAt))
    expect(spread.size).toBeGreaterThanOrEqual(3)
  })
})
