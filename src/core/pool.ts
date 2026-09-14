// The pool decision (§4a): who gets introduced right now, who waits a while for
// someone new, and whose date is pulled forward to keep a lone member company.
//
// There is no pairing day. Every member carries one `eligibleAt`, the pool is
// whoever's date has passed, and this function is the whole of the decision:
// pure, platform free, and driven entirely by the `now` it is handed.

import type { MemberId, MemberRow, Novelty, PairingRecord } from '../types'

export type PoolConfig = {
  cadenceMs: number
  holdingWindowMs: number
  pullForwardMaxMs: number
}

/** Something the bot owes a member an explanation for, one per member per kind. */
export type PoolNotice = {
  memberId: MemberId
  kind: 'holding-for-stranger' | 'met-everyone' | 'no-overlap'
  partnerId?: MemberId
  lastPairedAt?: number
}

export type PoolPairing = {
  members: readonly [MemberId, MemberId]
  novelty: Novelty
}

export type PoolInput = {
  members: readonly MemberRow[]
  history: readonly PairingRecord[]
  openPairingMembers: ReadonlySet<MemberId>
  now: number
  cfg: PoolConfig
  /** Availability overlap (§4). Asked of rows, never of ids. */
  feasible(a: MemberRow, b: MemberRow): boolean
  /** The matcher already composed with the strategy: proposals, best first. */
  pick(pool: readonly MemberRow[]): readonly { a: MemberId; b: MemberId }[]
}

export type PoolDecision = {
  pairings: readonly { members: readonly [MemberId, MemberId]; novelty: Novelty }[]
  pullForward: readonly MemberId[]
  updates: readonly MemberRow[]
  notices: readonly PoolNotice[]
}

/** Unordered pair key. Ids are Discord snowflakes, so a separator is enough. */
function pairKey(a: MemberId, b: MemberId): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

function byId(a: MemberId, b: MemberId): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Soonest eligible first, smaller id breaking the tie. */
function bySoonest(a: MemberRow, b: MemberRow): number {
  return a.eligibleAt - b.eligibleAt || byId(a.id, b.id)
}

export function decidePool(input: PoolInput): PoolDecision {
  const { members, history, openPairingMembers, now, cfg, feasible, pick } = input

  // Newest shared pairing per unordered pair. Absent means never met.
  const lastPaired = new Map<string, number>()
  for (const record of history) {
    const [x, y] = record.members
    const key = pairKey(x, y)
    const seen = lastPaired.get(key)
    if (seen === undefined || record.createdAt > seen) lastPaired.set(key, record.createdAt)
  }
  const metAt = (a: MemberId, b: MemberId): number | undefined => lastPaired.get(pairKey(a, b))

  // "Active members" includes those not yet eligible and those in open
  // pairings: they exist, so waiting for one of them can help.
  const active = members.filter((m) => m.state === 'active')
  const inPool = (m: MemberRow): boolean =>
    m.state === 'active' && !m.needsAck && m.eligibleAt <= now && !openPairingMembers.has(m.id)

  const avoided = (a: MemberRow, b: MemberRow): boolean =>
    a.avoid.includes(b.id) || b.avoid.includes(a.id)
  // Feasibility is asked in both directions, so an asymmetric table cannot slip
  // a pair past the check.
  const compatible = (a: MemberRow, b: MemberRow): boolean =>
    a.id !== b.id && !avoided(a, b) && feasible(a, b) && feasible(b, a)

  const notices: PoolNotice[] = []
  const pairings: PoolPairing[] = []
  const pullForward: MemberId[] = []
  const updates: MemberRow[] = []
  const paired = new Set<MemberId>()

  function accept(a: MemberRow, b: MemberRow, novelty: Novelty): void {
    pairings.push({ members: [a.id, b.id], novelty })
    paired.add(a.id)
    paired.add(b.id)
    // Being paired sets the date (§4a).
    updates.push({ ...a, eligibleAt: now + cfg.cadenceMs }, { ...b, eligibleAt: now + cfg.cadenceMs })
  }

  // (1) The pool, and for each of its members their strangers among the active.
  const pool: MemberRow[] = []
  const strangers = new Map<MemberId, number>()
  for (const m of members) {
    if (!inPool(m)) continue
    let reachable = 0
    let unmet = 0
    for (const other of active) {
      if (!compatible(m, other)) continue
      reachable++
      if (metAt(m.id, other.id) === undefined) unmet++
    }
    if (reachable === 0) {
      // Nobody at all shares their hours: say so, and leave them out of every
      // other branch so no further notice names them.
      notices.push({ memberId: m.id, kind: 'no-overlap' })
      continue
    }
    strangers.set(m.id, unmet)
    pool.push(m)
  }
  const hasStranger = (id: MemberId): boolean => (strangers.get(id) ?? 0) > 0

  // (2) Walk the matcher's proposals in order.
  const inPoolById = new Map(pool.map((m) => [m.id, m]))
  const holdingFor = new Set<MemberId>()
  const waitedACadence = (m: MemberRow): boolean => now - m.eligibleAt >= cfg.cadenceMs

  for (const proposal of pick(pool)) {
    const a = inPoolById.get(proposal.a)
    const b = inPoolById.get(proposal.b)
    if (!a || !b) continue
    if (paired.has(a.id) || paired.has(b.id)) continue
    if (!compatible(a, b)) continue

    const met = metAt(a.id, b.id)
    if (met === undefined) {
      accept(a, b, 'fresh')
      continue
    }
    if (!hasStranger(a.id) && !hasStranger(b.id)) {
      // Branch 3: reconnection, not fallback.
      accept(a, b, 'reconnect')
      notices.push({ memberId: a.id, kind: 'met-everyone', partnerId: b.id, lastPairedAt: met })
      notices.push({ memberId: b.id, kind: 'met-everyone', partnerId: a.id, lastPairedAt: met })
      continue
    }
    if (waitedACadence(a) || waitedACadence(b)) {
      // The hold lasts at most one cadence period.
      accept(a, b, 'held')
      continue
    }
    if (hasStranger(a.id)) holdingFor.add(a.id)
    if (hasStranger(b.id)) holdingFor.add(b.id)
  }

  // (3) Pull-forward for whoever has now waited out the holding window.
  const waiting = pool
    .filter((m) => !paired.has(m.id) && now - m.eligibleAt >= cfg.holdingWindowMs)
    .sort(bySoonest)

  for (const m of waiting) {
    if (paired.has(m.id)) continue
    const reach = active.filter(
      (other) =>
        !paired.has(other.id) &&
        !inPool(other) &&
        !openPairingMembers.has(other.id) &&
        !other.needsAck &&
        other.eligibleAt > now &&
        other.eligibleAt <= now + cfg.pullForwardMaxMs &&
        compatible(m, other),
    )
    const unmetInReach = reach.filter((other) => metAt(m.id, other.id) === undefined).sort(bySoonest)

    let partner = unmetInReach[0]
    let novelty: Novelty = 'held'
    if (!partner) {
      // Novelty outranks the window: a repeat is not pulled forward while a
      // stranger exists anywhere among active members.
      if (hasStranger(m.id)) continue
      partner = reach.slice().sort(bySoonest)[0]
      novelty = 'reconnect'
    }
    if (!partner) continue

    accept(m, partner, novelty)
    pullForward.push(partner.id)
  }

  // A hold is only worth saying out loud to someone still unpaired.
  for (const id of holdingFor) {
    if (!paired.has(id)) notices.push({ memberId: id, kind: 'holding-for-stranger' })
  }

  return { pairings, pullForward, updates, notices }
}
