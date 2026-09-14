// Weekly availability masks (design.md §5).
//
// A mask is 168 characters of '0' or '1'. The index is `day * 24 + hour` with
// Monday 0, and the hour is the member's own local hour: the mask is stored as
// local intent and projected to UTC only at match time, so a timezone change
// moves the projected hours and leaves the stored pattern alone.
//
// This module reads no clock, no file and nothing platform specific. Every
// time-dependent function takes the instant it should use.

import { HOURS_PER_WEEK, type AvailabilityPreset, type Mask } from '../types'

const HOUR_MS = 3_600_000
const HOURS_PER_DAY = 24
const DAYS_PER_WEEK = 7

/** What `sharedHours` and `feasible` need of a member: a pattern and a zone. */
type HasAvailability = { mask: Mask; timezone: string }

type PresetName = Exclude<AvailabilityPreset, 'custom'>

function hourRange(fromHour: number, untilHour: number): number[] {
  const hours: number[] = []
  for (let hour = fromHour; hour < untilHour; hour++) hours.push(hour)
  return hours
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
const MONDAY_TO_FRIDAY = [0, 1, 2, 3, 4]
const SATURDAY_AND_SUNDAY = [5, 6]

/** 09:00 to 21:00 local, the hours a reasonable person answers a ping. */
const REASONABLE_HOURS = hourRange(9, 21)
/** 17:00 to 21:00 local. */
const EVENING_HOURS = hourRange(17, 21)

/** 168 zeros: available never, until the member says otherwise. */
export const EMPTY_MASK: Mask = '0'.repeat(HOURS_PER_WEEK)

/**
 * The four presets `/availability` offers. `custom` has no fixed mask: it is
 * whatever blocks the member has ORed in, so it is excluded by the key type.
 */
export const PRESETS: Readonly<Record<PresetName, Mask>> = Object.freeze({
  'any-reasonable-hour': orBlock(EMPTY_MASK, EVERY_DAY, REASONABLE_HOURS),
  'evenings-only': orBlock(EMPTY_MASK, EVERY_DAY, EVENING_HOURS),
  'weekends-only': orBlock(EMPTY_MASK, SATURDAY_AND_SUNDAY, REASONABLE_HOURS),
  'weekdays-9-5-off': orBlock(
    orBlock(EMPTY_MASK, MONDAY_TO_FRIDAY, EVENING_HOURS),
    SATURDAY_AND_SUNDAY,
    REASONABLE_HOURS,
  ),
})

/** A member who joins and never runs `/availability` gets this one (#4). */
export const DEFAULT_PRESET = 'any-reasonable-hour' satisfies AvailabilityPreset

export const DEFAULT_MASK: Mask = PRESETS[DEFAULT_PRESET]

/**
 * Narrow a string to a `Mask`. The message names the required length, so a
 * caller that passed the wrong thing learns what the right thing is.
 */
export function assertMask(mask: string): asserts mask is Mask {
  if (typeof mask !== 'string' || mask.length !== HOURS_PER_WEEK) {
    const got = typeof mask === 'string' ? `${mask.length}` : typeof mask
    throw new Error(
      `A mask must be exactly ${HOURS_PER_WEEK} characters of "0" or "1" (got ${got})`,
    )
  }
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i]
    if (c !== '0' && c !== '1') {
      throw new Error(
        `A mask must be exactly ${HOURS_PER_WEEK} characters of "0" or "1" (index ${i} is "${c}")`,
      )
    }
  }
}

/**
 * OR one available block into a mask: every `(day, hour)` in the cross product
 * is set, everything already set stays set. This is the one write path the
 * custom availability menu uses, one pass per block.
 */
export function orBlock(mask: Mask, days: readonly number[], hours: readonly number[]): Mask {
  assertMask(mask)
  const slots = mask.split('')
  for (const day of days) {
    if (!Number.isInteger(day) || day < 0 || day >= DAYS_PER_WEEK) {
      throw new Error(`A day must be 0 (Monday) through 6 (Sunday), got ${day}`)
    }
    for (const hour of hours) {
      if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS_PER_DAY) {
        throw new Error(`An hour must be 0 through 23, got ${hour}`)
      }
      slots[day * HOURS_PER_DAY + hour] = '1'
    }
  }
  return slots.join('')
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone)
  if (cached !== undefined) return cached
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  })
  formatters.set(zone, made)
  return made
}

/**
 * The mask index an instant falls on in a zone. The formatter does the work,
 * so DST transitions are handled by the zone database rather than by
 * arithmetic that would have to know about them.
 */
function maskIndexAt(zone: string, utcMs: number): number {
  let day = -1
  let hour = -1
  for (const part of formatterFor(zone).formatToParts(new Date(utcMs))) {
    if (part.type === 'weekday') {
      const named = WEEKDAY_INDEX[part.value]
      if (named !== undefined) day = named
    } else if (part.type === 'hour') {
      const parsed = Number.parseInt(part.value, 10)
      if (Number.isInteger(parsed)) hour = parsed % HOURS_PER_DAY
    }
  }
  if (day < 0 || hour < 0) {
    throw new Error(`Could not read the local weekday and hour in zone "${zone}"`)
  }
  return day * HOURS_PER_DAY + hour
}

/** True when the member's local weekday and hour at `utcMs` are marked available. */
export function isAvailableAt(mask: Mask, zone: string, utcMs: number): boolean {
  assertMask(mask)
  return mask[maskIndexAt(zone, utcMs)] === '1'
}

/**
 * The available UTC hour starts in `[fromUtc, fromUtc + hours * 3600000)`,
 * ascending. Walks hour by hour from `fromUtc` rounded down to the hour, so a
 * week that contains a DST transition yields the hours the member would
 * recognise rather than a fixed offset applied to all of them.
 */
export function projectToUtc(
  mask: Mask,
  zone: string,
  fromUtc: number,
  hours: number = HOURS_PER_WEEK,
): number[] {
  assertMask(mask)
  const until = fromUtc + hours * HOUR_MS
  const found: number[] = []
  for (let at = Math.floor(fromUtc / HOUR_MS) * HOUR_MS; at < until; at += HOUR_MS) {
    if (at < fromUtc) continue
    if (mask[maskIndexAt(zone, at)] === '1') found.push(at)
  }
  return found
}

/**
 * The UTC hour starts both members are available for, ascending. Commutative:
 * it is the intersection of two sets of instants, so the argument order only
 * decides which projection is walked.
 */
export function sharedHours(
  a: HasAvailability,
  b: HasAvailability,
  fromUtc: number,
  hours: number = HOURS_PER_WEEK,
): number[] {
  assertMask(a.mask)
  assertMask(b.mask)
  const theirs = new Set(projectToUtc(b.mask, b.timezone, fromUtc, hours))
  return projectToUtc(a.mask, a.timezone, fromUtc, hours).filter((at) => theirs.has(at))
}

/**
 * Can these two meet at all in the week after `now`? The matcher only forms
 * pairs this is true of, which is what keeps empty overlap out of creation.
 */
export function feasible(a: HasAvailability, b: HasAvailability, now: number): boolean {
  return sharedHours(a, b, now, HOURS_PER_WEEK).length > 0
}
