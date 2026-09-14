// Matching strategies (§4). A strategy answers one question: how good would a
// pairing of A and B be, as a number between 0 and 1. It declares the signals
// it reads and is handed a Context carrying those and nothing else, so an
// undeclared read is a type error and a runtime absence both. No IO, no clock,
// no Discord: the caller passes `now` in.

import type {
  AllSignals,
  Context,
  Participant,
  PairingRecord,
  Signal,
  Strategy,
  Weights,
} from '../types'

const MS_PER_DAY = 86_400_000

/**
 * Days it takes a repeat pairing to recover halfway back to a stranger's
 * score. At exactly this age a repeat scores 0.5.
 */
export const RECOVERY_HALF_LIFE_DAYS = 14

/**
 * The signals a strategy declared, plus `now`, and no other key. References
 * are copied, never the arrays behind them.
 */
export function buildContext<R extends Signal>(
  all: AllSignals,
  reads: readonly R[],
  now: number,
): Context<R> {
  const ctx: Record<string, unknown> = { now }
  for (const signal of reads) ctx[signal] = all[signal]
  return ctx as Context<R>
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** The newest record naming both members, or null if they are strangers. */
function latestPairing(
  a: Participant,
  b: Participant,
  history: readonly PairingRecord[],
): PairingRecord | null {
  let newest: PairingRecord | null = null
  for (const record of history) {
    const [one, two] = record.members
    const both =
      (one === a.id && two === b.id) || (one === b.id && two === a.id)
    if (!both) continue
    if (newest === null || record.createdAt > newest.createdAt) newest = record
  }
  return newest
}

/**
 * Rotation as a recovery curve: strangers score 1, a repeat recovers toward 1
 * with age but never reaches it. So a stranger always outranks any repeat, and
 * among repeats the least recent wins.
 */
export const roundRobin: Strategy<'pairing-history'> = {
  name: 'round-robin',
  reads: ['pairing-history'],
  score(a, b, ctx) {
    const newest = latestPairing(a, b, ctx['pairing-history'])
    if (newest === null) return 1
    const days = Math.max(0, (ctx.now - newest.createdAt) / MS_PER_DAY)
    return days / (days + RECOVERY_HALF_LIFE_DAYS)
  },
}

/**
 * Weighted composition, configured per server. The composed strategy reads the
 * deduplicated union of its parts' signals and scores the weight-normalized
 * sum of each part's score, clamped to [0, 1] before summing. A strategy the
 * weights do not name contributes nothing; a weight naming a strategy that was
 * not handed in is a configuration error and throws.
 */
export function compose(
  weights: Weights,
  strategies: readonly Strategy<any>[],
): Strategy {
  const byName = new Map<string, Strategy<any>>()
  for (const strategy of strategies) byName.set(strategy.name, strategy)

  const parts: { strategy: Strategy<any>; weight: number }[] = []
  let total = 0
  for (const [name, weight] of Object.entries(weights)) {
    const strategy = byName.get(name)
    if (strategy === undefined) {
      throw new Error(
        `unknown strategy in weights: ${name} (known: ${[...byName.keys()].join(', ') || 'none'})`,
      )
    }
    parts.push({ strategy, weight })
    total += weight
  }

  const reads: Signal[] = []
  for (const strategy of strategies) {
    for (const signal of strategy.reads) {
      if (!reads.includes(signal)) reads.push(signal)
    }
  }

  return {
    name: 'composed',
    reads,
    score(a, b, ctx) {
      if (total === 0) return 0
      let sum = 0
      for (const part of parts) {
        sum += part.weight * clamp01(part.strategy.score(a, b, ctx))
      }
      return clamp01(sum / total)
    },
  }
}

/** Every strategy a server can name in its weights. Build 1 has one. */
export const STRATEGIES: Readonly<Record<string, Strategy<any>>> = Object.freeze({
  'round-robin': roundRobin,
})
