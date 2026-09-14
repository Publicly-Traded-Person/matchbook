// The message components behind /availability (§5). Availability is a handful
// of presets and two select menus, never a text box, so nothing has to read
// English to work out when somebody is free.
//
// Shapes come from src/types.ts: these are plain data, and the gateway adapter
// is the only place that turns them into discord.js builders.

import type { AvailabilityPreset, Button, OutgoingMessage, SelectMenu, SelectOption } from '../../types'

/** Custom ids are `<action>:<ref>`; the ref may itself contain colons. */
const SEPARATOR = ':'

/** Build the custom id a button or select carries back to us. */
export function customId(action: string, ref: string): string {
  return `${action}${SEPARATOR}${ref}`
}

/** Split a custom id on its first colon. Everything after it is the ref. */
export function parseCustomId(id: string): { action: string; ref: string } {
  const at = id.indexOf(SEPARATOR)
  if (at === -1) return { action: id, ref: '' }
  return { action: id.slice(0, at), ref: id.slice(at + 1) }
}

/** The action prefix on every availability preset button. */
export const AVAILABILITY_ACTION = 'avail'

/** Custom id of the button that wipes a member's availability back to nothing. */
export const AVAILABILITY_CLEAR_ID = customId(AVAILABILITY_ACTION, 'clear')

/** Select menu id for the day picker behind the custom preset. */
export const AVAILABILITY_DAYS_ID = 'avail-days'

/** Select menu id for the hour picker behind the custom preset. */
export const AVAILABILITY_HOURS_ID = 'avail-hours'

const PRESET_LABELS: ReadonlyArray<readonly [AvailabilityPreset, string]> = [
  ['weekdays-9-5-off', 'Weekdays (9 to 5 off)'],
  ['evenings-only', 'Evenings only'],
  ['weekends-only', 'Weekends only'],
  ['any-reasonable-hour', 'Any reasonable hour'],
  ['custom', 'Pick my own days and hours'],
]

/** The presets offered on the menu, in the order the buttons appear. */
export const AVAILABILITY_PRESETS: readonly AvailabilityPreset[] = PRESET_LABELS.map(([preset]) => preset)

const DAY_LABELS: readonly string[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]

/**
 * The /availability prompt: five presets, plus a way to clear. The button for
 * the member's current preset is highlighted so they can see what is saved.
 * Task 13 wraps the configured copy around this; the content here is the
 * fallback prompt.
 */
export function availabilityMenu(preset: AvailabilityPreset): OutgoingMessage {
  const buttons: Button[] = PRESET_LABELS.map(([value, label]) => ({
    id: customId(AVAILABILITY_ACTION, value),
    label,
    style: value === preset ? 'primary' : 'secondary',
  }))
  buttons.push({ id: AVAILABILITY_CLEAR_ID, label: 'Clear', style: 'secondary' })
  return {
    content: 'When could you take a 30 minute call? Pick the option closest to your week.',
    buttons,
  }
}

/** Day picker for the custom preset: Monday first, matching index 0 of a Mask. */
export function daysSelect(): SelectMenu {
  const options: SelectOption[] = DAY_LABELS.map((label, index) => ({
    value: String(index),
    label,
  }))
  return {
    id: AVAILABILITY_DAYS_ID,
    placeholder: 'Days you could take a call',
    options,
    min: 1,
    max: options.length,
  }
}

/** Hour picker for the custom preset: local hour starts, 00:00 through 23:00. */
export function hoursSelect(): SelectMenu {
  const options: SelectOption[] = Array.from({ length: 24 }, (_unused, hour) => ({
    value: String(hour),
    label: `${String(hour).padStart(2, '0')}:00`,
  }))
  return {
    id: AVAILABILITY_HOURS_ID,
    placeholder: 'Hours you could take a call (your local time)',
    options,
    min: 1,
    max: options.length,
  }
}
