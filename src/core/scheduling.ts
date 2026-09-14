/**
 * The pairing scheduling state machine (design.md §5, §8).
 *
 * An introduction arrives with a proposed time, either side may change it once,
 * and when both say "Works for me" the time is locked. If the two never agree,
 * the pairing is released: the thread stays theirs and the bot steps back.
 *
 * This module is pure. `transition` returns the next state plus the effects the
 * app (Task 13) carries out against storage, the job queue and Discord. Nothing
 * here touches the clock: every time-based decision takes `now` in epoch
 * milliseconds.
 */

import type { CopyKey, JobKind, MemberId, PairingState } from '../types'

// ------------------------------------------------------------- shapes --

export type SchedulingState = {
  state: PairingState
  members: readonly [MemberId, MemberId]
  proposedStartUtc: number | null
  /** Who made the standing proposal; null when the bot proposed it. */
  proposedBy: MemberId | null
  /** Counters spent per member. Each side gets at most one (§5). */
  countersUsed: Readonly<Record<MemberId, number>>
  confirmedBy: readonly MemberId[]
  lockedStartUtc: number | null
}

export type SchedulingEvent =
  | { kind: 'propose'; startUtc: number }
  | { kind: 'confirm'; by: MemberId }
  | { kind: 'counter'; by: MemberId; startUtc: number }
  | { kind: 'negotiation-timeout' }
  | { kind: 'overlap-lost' }
  /** A timezone change on a locked call: a new time, or null when none is left. */
  | { kind: 'tz-repropose'; startUtc: number | null }
  | { kind: 'follow-up-due' }
  | { kind: 'release-review'; hadActivity: boolean }
  | { kind: 'archive' }

export type SchedulingConfig = {
  negotiationTimeoutMs: number
  /** Call length in milliseconds (callMinutes * 60000, 1800000 by default). */
  callMs: number
}

export type Effect =
  | { type: 'schedule'; kind: JobKind; runAt: number }
  | { type: 'cancel'; kind: JobKind }
  | { type: 'say'; copy: CopyKey; vars?: Readonly<Record<string, string | number>> }
  | { type: 'archive' }

/** Thrown for every (state, event) pair outside the table of §5. */
export class IllegalTransition extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IllegalTransition'
  }
}

// ---------------------------------------------------------- constants --

/** The voice channel opens ten minutes before the call. */
const ROOM_OPEN_LEAD_MS = 600_000
/** It is deleted an hour after the call ends. */
const ROOM_CLOSE_AFTER_MS = 3_600_000
/** The follow-up lands a day after the call ends. */
const FOLLOW_UP_AFTER_MS = 86_400_000
/** A released pairing is reviewed, and a completed one archived, a week later. */
const WEEK_MS = 604_800_000

// ------------------------------------------------------- constructors --

export function initialState(members: readonly [MemberId, MemberId]): SchedulingState {
  return {
    state: 'created',
    members,
    proposedStartUtc: null,
    proposedBy: null,
    countersUsed: {},
    confirmedBy: [],
    lockedStartUtc: null,
  }
}

export function dueTimes(
  lockedStartUtc: number,
  cfg: SchedulingConfig,
): { roomOpen: number; roomClose: number; followUp: number } {
  const end = lockedStartUtc + cfg.callMs
  return {
    roomOpen: lockedStartUtc - ROOM_OPEN_LEAD_MS,
    roomClose: end + ROOM_CLOSE_AFTER_MS,
    followUp: end + FOLLOW_UP_AFTER_MS,
  }
}

// ---------------------------------------------------------- transition --

type Outcome = { next: SchedulingState; effects: readonly Effect[] }

export function transition(
  s: SchedulingState,
  ev: SchedulingEvent,
  now: number,
  cfg: SchedulingConfig,
): Outcome {
  switch (s.state) {
    case 'created':
      if (ev.kind === 'propose') return enterProposed(s, ev.startUtc, null, 'proposal', now, cfg)
      break

    case 'time_proposed':
      switch (ev.kind) {
        case 'confirm':
          return confirm(s, ev.by, 'one_confirmed', cfg)
        case 'counter':
          return counter(s, ev.by, ev.startUtc, now, cfg)
        case 'negotiation-timeout':
          return enterReleased(s, 'released-timeout', now)
        case 'overlap-lost':
          return enterReleased(s, 'released-overlap', now)
      }
      break

    case 'one_confirmed':
      switch (ev.kind) {
        case 'confirm':
          return confirm(s, ev.by, 'locked', cfg)
        case 'counter':
          return counter(s, ev.by, ev.startUtc, now, cfg)
        case 'negotiation-timeout':
          return enterReleased(s, 'released-timeout', now)
        case 'overlap-lost':
          return enterReleased(s, 'released-overlap', now)
      }
      break

    case 'locked':
      switch (ev.kind) {
        case 'tz-repropose':
          return ev.startUtc === null
            ? enterReleased(s, 'released-overlap', now)
            : repropose(s, ev.startUtc, now, cfg)
        case 'follow-up-due':
          return enterCompleted(s, now)
      }
      break

    case 'released':
      if (ev.kind === 'release-review') {
        return ev.hadActivity ? enterCompleted(s, now) : enterExpired(s)
      }
      break

    case 'completed':
      if (ev.kind === 'archive') return { next: s, effects: [{ type: 'archive' }] }
      break

    case 'expired':
      break
  }
  throw new IllegalTransition(`no transition from ${s.state} on ${ev.kind}`)
}

// --------------------------------------------------------------- entries --

const cancel = (kind: JobKind): Effect => ({ type: 'cancel', kind })
const schedule = (kind: JobKind, runAt: number): Effect => ({ type: 'schedule', kind, runAt })
const say = (copy: CopyKey, vars?: Readonly<Record<string, string | number>>): Effect =>
  vars === undefined ? { type: 'say', copy } : { type: 'say', copy, vars }

/** Jobs that only make sense while a call is locked in. */
const CALL_JOBS: readonly JobKind[] = ['room-open', 'room-close', 'follow-up']

/** A fresh proposal (the bot's first one, or a counter): restart the release clock. */
function enterProposed(
  s: SchedulingState,
  startUtc: number,
  by: MemberId | null,
  copy: 'proposal' | 'counter',
  now: number,
  cfg: SchedulingConfig,
): Outcome {
  return {
    next: {
      ...s,
      state: 'time_proposed',
      proposedStartUtc: startUtc,
      proposedBy: by,
      lockedStartUtc: null,
    },
    effects: [
      cancel('negotiation-release'),
      schedule('negotiation-release', now + cfg.negotiationTimeoutMs),
      say(copy, { start: startUtc }),
    ],
  }
}

function confirm(
  s: SchedulingState,
  by: MemberId,
  target: 'one_confirmed' | 'locked',
  cfg: SchedulingConfig,
): Outcome {
  if (s.confirmedBy.includes(by)) {
    throw new IllegalTransition(`${by} has already confirmed this proposal`)
  }
  const confirmedBy = [...s.confirmedBy, by]
  if (target === 'one_confirmed') {
    return {
      next: { ...s, state: 'one_confirmed', confirmedBy },
      effects: [say('one-confirmed', { by })],
    }
  }
  return enterLocked({ ...s, confirmedBy }, cfg)
}

/** The second "Works for me": the time is ours, so book the room and the follow-up. */
function enterLocked(s: SchedulingState, cfg: SchedulingConfig): Outcome {
  const start = s.proposedStartUtc
  const next: SchedulingState = { ...s, state: 'locked', lockedStartUtc: start }
  if (start === null) {
    return { next, effects: [cancel('negotiation-release'), say('locked')] }
  }
  const due = dueTimes(start, cfg)
  return {
    next,
    effects: [
      cancel('negotiation-release'),
      schedule('room-open', due.roomOpen),
      schedule('room-close', due.roomClose),
      schedule('follow-up', due.followUp),
      say('locked', { start }),
    ],
  }
}

/** Each side gets one counter, and a counter voids the other side's confirmation. */
function counter(
  s: SchedulingState,
  by: MemberId,
  startUtc: number,
  now: number,
  cfg: SchedulingConfig,
): Outcome {
  const used = s.countersUsed[by] ?? 0
  if (used >= 1) throw new IllegalTransition(`${by} has already countered once`)
  const spent: SchedulingState = {
    ...s,
    countersUsed: { ...s.countersUsed, [by]: used + 1 },
    confirmedBy: [],
  }
  return enterProposed(spent, startUtc, by, 'counter', now, cfg)
}

/** A timezone change moved a locked call: back to negotiation, both sides fresh. */
function repropose(
  s: SchedulingState,
  startUtc: number,
  now: number,
  cfg: SchedulingConfig,
): Outcome {
  return {
    next: {
      ...s,
      state: 'time_proposed',
      proposedStartUtc: startUtc,
      proposedBy: null,
      countersUsed: {},
      confirmedBy: [],
      lockedStartUtc: null,
    },
    effects: [
      ...CALL_JOBS.map(cancel),
      schedule('negotiation-release', now + cfg.negotiationTimeoutMs),
      say('proposal', { start: startUtc }),
    ],
  }
}

/** The bot steps back for a week, then reviews the thread (§5, #9). */
function enterReleased(s: SchedulingState, copy: CopyKey, now: number): Outcome {
  return {
    next: { ...s, state: 'released', lockedStartUtc: null },
    effects: [
      cancel('negotiation-release'),
      ...CALL_JOBS.map(cancel),
      schedule('expire', now + WEEK_MS),
      say(copy),
    ],
  }
}

function enterCompleted(s: SchedulingState, now: number): Outcome {
  return {
    next: { ...s, state: 'completed' },
    effects: [schedule('archive', now + WEEK_MS), say('follow-up')],
  }
}

/** Released, nobody spoke: no follow-up, just archive the thread (§5). */
function enterExpired(s: SchedulingState): Outcome {
  return { next: { ...s, state: 'expired' }, effects: [{ type: 'archive' }] }
}
