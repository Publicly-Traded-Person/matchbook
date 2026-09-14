// The matcher (§4). Pure: no IO, no clock, no Discord. The pool is whoever is
// eligible right now, typically two to a handful of people, so scoring every
// pair and taking the best non-overlapping set is cheap. Greedy is what ships;
// `bruteForceOptimal` exists so the suite can measure the gap on every fixture
// of ten or fewer rather than guess at it (§8).

import type {
  AllSignals,
  Context,
  MemberId,
  PairingRecord,
  Participant,
  Signal,
  Strategy,
} from '../types'

export type MatchOptions = {
  now: number
  /** Can these two actually meet? A precondition, applied before any scoring. */
  feasible(a: Participant, b: Participant): boolean
  /** Signals beyond the history, for strategies that read them. */
  signals?: Partial<AllSignals>
}

export type ProposedPair = {
  /** The lexicographically smaller of the two ids. */
  a: MemberId
  b: MemberId
  score: number
  /** True when no record in the history names both ids. */
  fresh: boolean
}

/** A scored pair, carrying the pool indices the brute force search works over. */
interface Candidate {
  readonly i: number
  readonly j: number
  readonly pair: ProposedPair
}

/**
 * The best non-overlapping set of pairs the greedy pass finds: candidates in
 * descending score order, ties broken by the smaller `[a, b]` id tuple, each
 * taken unless one of its members is already spoken for.
 */
export function match(
  pool: readonly Participant[],
  history: readonly PairingRecord[],
  strategy: Strategy<any>,
  opts: MatchOptions,
): ProposedPair[] {
  return greedy(scoreAll(pool, history, strategy, opts))
}

/**
 * The maximum total score over every set of disjoint compatible pairs, by
 * recursion on the first unmatched member: either leave it out, or pair it with
 * each later member it is compatible with.
 */
export function bruteForceOptimal(
  pool: readonly Participant[],
  history: readonly PairingRecord[],
  strategy: Strategy<any>,
  opts: MatchOptions,
): number {
  const candidates = scoreAll(pool, history, strategy, opts)
  if (candidates.length === 0) return 0

  const n = pool.length
  // scores[i][j] for i < j, undefined where the two are not compatible.
  const scores: (number | undefined)[][] = Array.from({ length: n }, () =>
    new Array<number | undefined>(n).fill(undefined),
  )
  for (const c of candidates) scores[c.i]![c.j] = c.pair.score

  const taken = new Array<boolean>(n).fill(false)
  const search = (from: number): number => {
    let i = from
    while (i < n && taken[i]) i++
    if (i >= n) return 0

    taken[i] = true
    let best = search(i + 1) // leave i unmatched
    for (let j = i + 1; j < n; j++) {
      if (taken[j]) continue
      const s = scores[i]![j]
      if (s === undefined) continue
      taken[j] = true
      const total = s + search(i + 1)
      taken[j] = false
      if (total > best) best = total
    }
    taken[i] = false
    return best
  }

  // The greedy set is itself a set of disjoint compatible pairs, so its total is
  // a lower bound on the optimum. Taking it as the floor keeps the reported gap
  // from dipping below zero when the two sums add the same doubles in a
  // different order.
  const greedySum = greedy(candidates).reduce((sum, p) => sum + p.score, 0)
  return Math.max(search(0), greedySum)
}

function greedy(candidates: readonly Candidate[]): ProposedPair[] {
  const ordered = [...candidates].sort((x, y) => byScoreThenId(x.pair, y.pair))
  const used = new Set<MemberId>()
  const chosen: ProposedPair[] = []
  for (const { pair } of ordered) {
    if (used.has(pair.a) || used.has(pair.b)) continue
    used.add(pair.a)
    used.add(pair.b)
    chosen.push(pair)
  }
  return chosen
}

/** Descending score, then the lexicographically smaller `[a, b]` id tuple. */
function byScoreThenId(x: ProposedPair, y: ProposedPair): number {
  if (x.score !== y.score) return y.score - x.score
  if (x.a !== y.a) return x.a < y.a ? -1 : 1
  if (x.b !== y.b) return x.b < y.b ? -1 : 1
  return 0
}

/** Every compatible pair in the pool, scored once, in canonical id order. */
function scoreAll(
  pool: readonly Participant[],
  history: readonly PairingRecord[],
  strategy: Strategy<any>,
  opts: MatchOptions,
): Candidate[] {
  if (pool.length < 2) return []
  const ctx = contextFor(strategy, history, opts)
  const candidates: Candidate[] = []
  for (let i = 0; i < pool.length; i++) {
    const first = pool[i]!
    for (let j = i + 1; j < pool.length; j++) {
      const second = pool[j]!
      const a = first.id <= second.id ? first : second
      const b = first.id <= second.id ? second : first
      if (!compatible(a, b, opts)) continue
      candidates.push({
        i,
        j,
        pair: {
          a: a.id,
          b: b.id,
          score: strategy.score(a, b, ctx),
          fresh: isFresh(history, a.id, b.id),
        },
      })
    }
  }
  return candidates
}

/**
 * The preconditions, both applied before scoring: nobody pairs with themselves,
 * an avoid note on either side is honored and is never a signal (§4), and the
 * caller's feasibility test has the last word.
 */
function compatible(a: Participant, b: Participant, opts: MatchOptions): boolean {
  if (a.id === b.id) return false
  if (a.avoid.includes(b.id) || b.avoid.includes(a.id)) return false
  return opts.feasible(a, b)
}

function isFresh(history: readonly PairingRecord[], a: MemberId, b: MemberId): boolean {
  return !history.some(
    (r) =>
      (r.members[0] === a && r.members[1] === b) ||
      (r.members[0] === b && r.members[1] === a),
  )
}

/**
 * What the strategy declared it reads, and nothing else. The history argument is
 * always `'pairing-history'`; the rest come from `opts.signals` over empty
 * defaults.
 */
function contextFor<R extends Signal>(
  strategy: Strategy<R>,
  history: readonly PairingRecord[],
  opts: MatchOptions,
): Context<R> {
  const available: AllSignals = {
    'pairing-history': history,
    'follow-up': opts.signals?.['follow-up'] ?? [],
    tags: opts.signals?.tags ?? new Map<MemberId, readonly string[]>(),
    availability: opts.signals?.availability ?? new Map<MemberId, string>(),
    timezone: opts.signals?.timezone ?? new Map<MemberId, string>(),
  }
  const picked: Record<string, unknown> = { now: opts.now }
  for (const signal of strategy.reads) picked[signal] = available[signal]
  return picked as Context<R>
}
