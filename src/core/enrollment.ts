// Enrollment and the acknowledgement gate (design.md §4a).
//
// Enrollment is standing: a member joins once and stays in the rotation until
// they pause. After a pairing nobody showed up to, the bot asks before it
// spends another member's turn, and a partner's Yes counts as proof the member
// was there. Coming back is one command, with the history intact.
//
// Every function here is pure: it takes a row and returns a new row, never
// mutating the input, and every time-dependent decision takes the instant it
// should use. Nothing in this file reads a clock, a file or a platform API.

import type { GuildId, Mask, MemberId, MemberRow } from '../types'

/** The one setting the gate needs: how long a member's turn lasts. */
export type EnrollmentConfig = { cadenceMs: number }

/**
 * The availability a member who never ran `/availability` gets (#4): hours 9
 * through 20 local on every day, which is indices `d * 24 + 9` through
 * `d * 24 + 20`, so 12 hours a day and 84 in the week.
 *
 * It is written out here rather than imported so enrollment depends on nothing
 * but the shared types. `src/core/availability.ts` builds the same string from
 * its preset table, and the two are asserted equal where they meet.
 */
export const DEFAULT_MASK_LITERAL: Mask =
  '000000000111111111111000' +
  '000000000111111111111000' +
  '000000000111111111111000' +
  '000000000111111111111000' +
  '000000000111111111111000' +
  '000000000111111111111000' +
  '000000000111111111111000'

/** The preset `DEFAULT_MASK_LITERAL` is the mask of. */
const DEFAULT_PRESET = 'any-reasonable-hour'

/** What a join or a resume may set. Anything absent is left as it was. */
export type EnrollmentOptions = {
  timezone?: string
  avoid?: readonly MemberId[]
}

/** The evidence a pairing can leave behind, and nothing else (M4). */
export type Evidence = {
  posted: boolean
  tapped: boolean
  partnerYes: boolean
}

/** What `expireCheckin` did, so the caller knows what to send. */
export type CheckinExpiry = {
  row: MemberRow
  action: 'none' | 'resend' | 'auto-paused'
}

/** One ignored check-in re-sends it, two auto-pause the member (§4a). */
const IGNORED_CHECKINS_BEFORE_PAUSE = 2

/**
 * When a returning member's next turn falls: one cadence after their last
 * pairing, or right now if that has already passed. A member who has never
 * been paired has no date to wait out, so theirs is `now`.
 */
function nextEligibleAt(now: number, cfg: EnrollmentConfig, lastPairingAt: number | null): number {
  if (lastPairingAt === null) return now
  return Math.max(now, lastPairingAt + cfg.cadenceMs)
}

/** Apply the options a rejoin named, and only those. */
function withOptions(row: MemberRow, opts: EnrollmentOptions): MemberRow {
  let next = row
  if (opts.timezone !== undefined) next = { ...next, timezone: opts.timezone }
  if (opts.avoid !== undefined) next = { ...next, avoid: [...opts.avoid] }
  return next
}

/**
 * `/join`, in all three of its readings.
 *
 * With no row yet it enrols: the default mask and preset, active, no gate
 * pending, eligible immediately. A timezone is required, because every hour
 * this member is offered is read in it.
 *
 * On an active row it is the "re-run it with any option and just that option
 * changes" path (#5): the row comes back with the named fields set and
 * everything else untouched.
 *
 * On a paused row it is the resume path, identical to `resumeMember`: the gate
 * clears, the ignored count zeroes, and the next turn is one cadence after the
 * last pairing.
 *
 * `ids` is required and has no default: a row that reached storage with an
 * empty guild id would be a row no query could find.
 */
export function joinMember(
  existing: MemberRow | null,
  opts: EnrollmentOptions,
  now: number,
  cfg: EnrollmentConfig,
  lastPairingAt: number | null,
  ids: { guildId: GuildId; id: MemberId },
): MemberRow {
  // The type already refuses a five-argument call. This says the same thing at
  // runtime, so a caller that reached here untyped gets the reason rather than
  // a row scoped to nothing.
  const given = ids as { guildId?: GuildId; id?: MemberId } | undefined
  if (given === undefined || given.guildId === undefined || given.id === undefined) {
    throw new Error('joinMember needs its sixth argument, the required ids { guildId, id }.')
  }

  if (existing === null) {
    if (opts.timezone === undefined) {
      throw new Error(
        'A first join needs a timezone: pass the IANA zone you live in, for example Europe/Belgrade.',
      )
    }
    return {
      guildId: ids.guildId,
      id: ids.id,
      state: 'active',
      timezone: opts.timezone,
      tags: [],
      avoid: opts.avoid === undefined ? [] : [...opts.avoid],
      mask: DEFAULT_MASK_LITERAL,
      preset: DEFAULT_PRESET,
      eligibleAt: nextEligibleAt(now, cfg, lastPairingAt),
      welcome: false,
      lastWelcomeAt: null,
      needsAck: false,
      checkinsIgnored: 0,
      checkinSentAt: null,
      overlapNoticeAt: null,
      joinedAt: now,
    }
  }

  const updated = withOptions(existing, opts)
  if (existing.state === 'paused') return resumeMember(updated, now, cfg, lastPairingAt)
  return updated
}

/**
 * `/resume`. Returning clears the gate and zeroes the ignored count, so a
 * member who went quiet and came back is not asked about the silence again.
 * The mask, preset, timezone, avoid list and join date are their own.
 */
export function resumeMember(
  row: MemberRow,
  now: number,
  cfg: EnrollmentConfig,
  lastPairingAt: number | null,
): MemberRow {
  return {
    ...row,
    state: 'active',
    needsAck: false,
    checkinsIgnored: 0,
    eligibleAt: nextEligibleAt(now, cfg, lastPairingAt),
  }
}

/** `/pause`. Out of the rotation, with everything else kept for the return. */
export function pauseMember(row: MemberRow): MemberRow {
  return { ...row, state: 'paused' }
}

/**
 * Was this pairing silent? Only when none of the three kinds of evidence
 * turned up. The type has exactly these three fields, so a partner's "Not yet"
 * has no way in: it is an answer about the call, not evidence of absence.
 */
export function isSilent(evidence: Evidence): boolean {
  return !evidence.posted && !evidence.tapped && !evidence.partnerYes
}

/**
 * A pairing ended. A silent one raises the gate, so the next turn asks first.
 * The date itself is set by the pool decision (§4a) when a member is paired,
 * which is why closing never touches `eligibleAt`.
 */
export function closePairing(
  row: MemberRow,
  silent: boolean,
  now: number,
  cfg: EnrollmentConfig,
): MemberRow {
  void now
  void cfg
  return { ...row, needsAck: silent }
}

/** Evidence arrived after the fact, so the gate comes back down. */
export function recordEvidence(row: MemberRow): MemberRow {
  return { ...row, needsAck: false }
}

/** The check-in went out: remember when, so housekeeping can time it. */
export function sendCheckin(row: MemberRow, now: number): MemberRow {
  return { ...row, checkinSentAt: now }
}

/** The member answered the check-in. Keeping clears the gate, pausing pauses. */
export function answerCheckin(row: MemberRow, answer: 'keep' | 'pause'): MemberRow {
  if (answer === 'pause') return { ...row, state: 'paused' }
  return { ...row, needsAck: false, checkinSentAt: null }
}

/**
 * A cadence passed with no answer. The first silence re-sends the check-in,
 * the second pauses the member, and nothing at all happens while no check-in
 * is pending or the cadence has not run out.
 */
export function expireCheckin(row: MemberRow, now: number, cfg: EnrollmentConfig): CheckinExpiry {
  if (!row.needsAck) return { row, action: 'none' }
  if (row.checkinSentAt === null) return { row, action: 'none' }
  if (now - row.checkinSentAt < cfg.cadenceMs) return { row, action: 'none' }

  const checkinsIgnored = row.checkinsIgnored + 1
  if (checkinsIgnored >= IGNORED_CHECKINS_BEFORE_PAUSE) {
    return { row: { ...row, checkinsIgnored, state: 'paused' }, action: 'auto-paused' }
  }
  return { row: { ...row, checkinsIgnored, checkinSentAt: now }, action: 'resend' }
}

/**
 * Is this member up for a pairing right now? Active, not waiting behind the
 * gate, their date has arrived, and they are not already in an open pairing.
 */
export function inPool(
  row: MemberRow,
  now: number,
  openPairingMembers: ReadonlySet<MemberId>,
): boolean {
  return (
    row.state === 'active' &&
    !row.needsAck &&
    row.eligibleAt <= now &&
    !openPairingMembers.has(row.id)
  )
}
