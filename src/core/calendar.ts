// Slot proposal and the calendar file (design doc section 5, "Slot proposal"
// and "On lock"). Pure: no Discord, no storage, no wall clock. Every time is
// epoch milliseconds in UTC; `now` is always injected by the caller.
//
// `shared` is the list of UTC hour starts the availability unit produces. This
// module takes the numbers and never imports that unit.

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

/** Local hours counted as evening at both ends of the pairing. */
const EVENING_FIRST_HOUR = 17
const EVENING_LAST_HOUR = 20

/** How many alternatives "Pick another time" offers (design doc section 5). */
const MAX_ALTERNATIVES = 5

export type SlotOptions = {
  minDays: number
  maxDays: number
  zoneA: string
  zoneB: string
}

export type IcsEvent = {
  uid: string
  dtstamp: number
  startUtc: number
  durationMin: number
  summary: string
  description: string
  threadUrl: string
}

// ------------------------------------------------------------ slot picking --

const hourFormatters = new Map<string, Intl.DateTimeFormat>()

function hourFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = hourFormatters.get(timeZone)
  if (cached) return cached
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  })
  hourFormatters.set(timeZone, made)
  return made
}

const labelFormatters = new Map<string, Intl.DateTimeFormat>()

/**
 * A slot for a select menu option, in the picker's own zone (#30): a menu label
 * is plain text where Discord's <t:> markup does not render, and the menu is
 * ephemeral, so the bot knows exactly whose eyes it is for. `Sat, Sep 26, 5:00 PM`.
 */
export function slotLabel(utcMs: number, timeZone: string): string {
  let made = labelFormatters.get(timeZone)
  if (made === undefined) {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    labelFormatters.set(timeZone, made)
  }
  // Assembled from parts, so the label does not drift with ICU's joiners
  // (one version says `Sep 26, 5:00 PM`, another `Sep 26 at 5:00 PM`).
  const part = new Map(made.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]))
  const at = (type: Intl.DateTimeFormatPartTypes): string => part.get(type) ?? ''
  return `${at('weekday')}, ${at('month')} ${at('day')}, ${at('hour')}:${at('minute')} ${at('dayPeriod')}`
}

/** The local hour (0..23) of a UTC instant in an IANA zone. */
function localHour(ms: number, timeZone: string): number {
  return Number.parseInt(hourFormatter(timeZone).format(new Date(ms)), 10)
}

function isEveningIn(ms: number, timeZone: string): boolean {
  const hour = localHour(ms, timeZone)
  return hour >= EVENING_FIRST_HOUR && hour <= EVENING_LAST_HOUR
}

/** Evening for both people, which is what the proposal leans toward. */
function isEveningForBoth(ms: number, opts: SlotOptions): boolean {
  return isEveningIn(ms, opts.zoneA) && isEveningIn(ms, opts.zoneB)
}

/**
 * The shared hours that are far enough out to plan around and near enough to
 * still feel like a date, evening-for-both first and ascending inside each
 * group. Duplicates and off-the-hour values are dropped: calls are 30 minutes
 * and the mask is hourly, so proposals land on the hour.
 */
export function proposeSlots(
  shared: readonly number[],
  now: number,
  opts: SlotOptions,
): number[] {
  const earliest = now + opts.minDays * DAY_MS
  const latest = now + opts.maxDays * DAY_MS

  const kept = new Set<number>()
  for (const slot of shared) {
    if (slot < earliest || slot > latest) continue
    if (slot % HOUR_MS !== 0) continue
    kept.add(slot)
  }

  const evening = new Map<number, boolean>()
  for (const slot of kept) evening.set(slot, isEveningForBoth(slot, opts))

  return [...kept].sort((a, b) => {
    const rank = Number(evening.get(b)) - Number(evening.get(a))
    return rank !== 0 ? rank : a - b
  })
}

/**
 * Up to five other times from the same shared set, in proposal order, for the
 * "Pick another time" menu.
 */
export function alternatives(
  shared: readonly number[],
  now: number,
  chosen: number,
  opts: SlotOptions,
): number[] {
  return proposeSlots(shared, now, opts)
    .filter((slot) => slot !== chosen)
    .slice(0, MAX_ALTERNATIVES)
}

// --------------------------------------------------------- the .ics file --

const CRLF = '\r\n'

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** A UTC instant as an iCalendar UTC date-time, `YYYYMMDDTHHMMSSZ`. */
export function formatIcsTime(ms: number): string {
  const at = new Date(ms)
  return (
    pad(at.getUTCFullYear(), 4) +
    pad(at.getUTCMonth() + 1, 2) +
    pad(at.getUTCDate(), 2) +
    'T' +
    pad(at.getUTCHours(), 2) +
    pad(at.getUTCMinutes(), 2) +
    pad(at.getUTCSeconds(), 2) +
    'Z'
  )
}

/**
 * The attachment name for a calendar file: the summary lowercased, every run of
 * anything but ASCII letters and digits folded to one hyphen, ends trimmed.
 * `matchbook.ics` when nothing survives, so the file always has a name.
 */
export function icsFileName(summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug === '' ? 'matchbook' : slug}.ics`
}

/** RFC 5545 text escaping for SUMMARY, DESCRIPTION and LOCATION values. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * One VEVENT for a locked call, pointing at the pairing thread. No ORGANIZER or
 * ATTENDEE: those need mailto: addresses the bot does not have and must not
 * collect. A re-lock after a timezone change passes the same `uid`, so a
 * calendar importing both files keeps one entry.
 */
export function ics(event: IcsEvent): string {
  const start = formatIcsTime(event.startUtc)
  const end = formatIcsTime(event.startUtc + event.durationMin * MINUTE_MS)

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Matchbook//EN',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${formatIcsTime(event.dtstamp)}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeText(event.summary)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    `LOCATION:${escapeText(event.threadUrl)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]

  return lines.join(CRLF) + CRLF
}
