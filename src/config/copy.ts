// Every user-facing sentence the bot says, as a template. A server overrides any
// of them in its `[guilds.copy]` table (§4), so nobody forks the repo to change
// the bot's voice. Placeholders are `{name}` with `name` matching [a-zA-Z_]+.
//
// House rules for anything added here, from §11: no em dashes, and nothing about
// the market, the ticker or the person behind it. Commas, periods, colons and
// parentheses carry the rhythm instead.

import type { CopyKey, GuildConfig } from "../types"

/** `{name}`, where `name` is a placeholder the caller supplies in `vars`. */
const PLACEHOLDER = /\{([a-zA-Z_]+)\}/g

export const DEFAULT_COPY: Readonly<Record<CopyKey, string>> = Object.freeze({
  // ------------------------------------------------------- enrollment (§4a) --

  // §7: says roughly when to expect the first introduction, states the default
  // availability, names /availability, and states what the follow-up answer is
  // used for. That last sentence is quoted from §9 and is the consent line: it
  // changes only when what the answer is used for changes.
  "join-confirmation":
    "You're in. I'll introduce you to someone as soon as another member is free, usually within about a day. " +
    "Unless you say otherwise, I assume you're available 09:00 to 21:00 in your timezone, every day; run /availability to change that. " +
    "When I ask whether you connected, your answer counts toward your stats, tells me you're still active, and helps me avoid re-pairing people who already met.",
  "join-updated": "Updated. The rest of your enrollment stays as it was, so there is nothing else to answer.",
  resumed:
    "Welcome back, you're active again. I kept your history, so I won't introduce you to someone you have already met.",
  paused: "Paused. No more introductions until you run /resume. Your history stays where it is.",
  forgotten: "Deleted. Your row, your pairings, your confirmations and your answers are gone, not deactivated.",

  // ---------------------------------------------------------- matching (§4) --

  "no-overlap":
    "Nobody active right now has hours in common with yours, so I cannot set up an introduction yet. " +
    "You stay in the pool either way, and /availability will widen the odds.",
  "holding-for-stranger": "Holding a while for someone new rather than repeating.",
  "met-everyone": "You've met everyone in Matchbook. Reconnecting you with {partner}, it's been {since}.",
  introduction:
    "Introducing the two of you. This thread is private to you both, and I'll suggest a time in a moment.",

  // -------------------------------------------------------- scheduling (§5) --

  proposal: "How about {time}? Tap Works for me, or pick another time.",
  counter: "New time on the table: {time}. Does that work for both of you?",
  "one-confirmed": "One of you is in for {time}. Waiting on the other.",
  locked:
    "Locked in for {time}. The calendar file is attached, and I'll open a voice room ten minutes before.",
  "released-timeout": "No time locked in, so I'm stepping back. The thread is yours, pick a time that suits you both.",
  "released-overlap":
    "No time works for both of you any more. The thread is yours, and I'm stepping back rather than guessing.",
  "released-limit":
    "You have each suggested a time and neither stuck, so I'm stepping back. The thread is yours to sort out.",
  "room-open": "Starts in ten minutes. Your room: {link}",
  // The calendar file (#27). {a} and {b} are the two display names, read at lock.
  // The attachment is named after ics-summary, slugged.
  "ics-summary": "Matchbook: {a} and {b}",
  "ics-description":
    "A Matchbook call between {a} and {b}. The room link is posted in your thread ten minutes before the start.",

  // --------------------------------------------- follow-up and hygiene (§4a) --

  "follow-up": "Did you two connect?",
  "follow-up-thanks": "Thanks, noted.",
  "check-in": "Still up for these? You weren't around for your last introduction, and I'd rather ask than guess.",
  "check-in-kept": "Good to hear. You are back in the pool as of now.",

  // --------------------------------------------------------- timezones (§5) --

  "tz-changed-locked-call":
    "Your timezone changed, and this call at {time} now falls outside the hours you said you were free. Keep it, or suggest a new time?",
  "pick-another-time": "Pick one of these instead:",

  // ------------------------------------------------------ availability (§5) --

  "availability-menu":
    "Pick the days, then the hours. Each pass adds one block to your week, and Clear empties it.",
  "availability-saved": "Saved. That is your weekly availability from now on.",

  // ------------------------------------------------------------- admin (§7) --

  "admin-status":
    "Pool: {pool}. Holding: {holds}. Upcoming calls: {upcoming}. Reconnections: {reconnect} of recent pairings.",
  "admin-pair-infeasible":
    "{a} and {b} have no available hours in common, so I will not pair them. One of them can widen their hours with /availability.",
})

/**
 * An instant for a sentence: Discord's `<t:epoch:F>` markup, which every client
 * renders in the viewer's own local timezone (spec, Timezones). Every `{start}`
 * and `{time}` the bot fills goes through here; a raw millisecond never reaches
 * a member.
 */
export function discordTime(utcMs: number): string {
  return `<t:${Math.floor(utcMs / 1000)}:F>`
}

/**
 * The template for `key`, with `{name}` placeholders substituted from `vars`.
 * A server override in `cfg.copy` wins over `DEFAULT_COPY`.
 *
 * @throws if a placeholder in the template has no value in `vars`.
 */
export function renderCopy(
  cfg: Pick<GuildConfig, "copy">,
  key: CopyKey,
  vars: Readonly<Record<string, string | number>> = {},
): string {
  const template = cfg.copy[key] ?? DEFAULT_COPY[key]
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new Error(`copy ${key}: no value for placeholder {${name}}`)
    }
    return String(value)
  })
}
