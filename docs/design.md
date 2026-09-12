# Matchbook: Design Spec

**Date:** 2026-09-12
**Author:** Charlie (The Investor Relations)
**Status:** 🟡 Open for review. Spec only, no code.
**Repo:** `Publicly-Traded-Person/matchbook`, public, AGPL-3.0

---

## 1. The claim

The coffee-chat tools we have looked at match people on a single bit of
information: have these two met before. That is not an engineering limitation,
it is a data limitation. A generic bot knows nothing about a community's members
except their username and their roles, so meeting history is the only signal
available to it.

Matchbook replaces the bit with a score. Any strategy that can express "how good
would a pairing of A and B be" as a number becomes a first-class matching input,
and strategies compose as a weighted sum configured per server. Meeting history
ships as the boring default. A community with its own structured data writes its
own scorer without touching the matcher.

Matchbook also does the part these tools consistently fail at: it schedules the
call. A pairing arrives with a proposed time already in it, either person can
change it, and once both confirm they get a calendar file and a private voice
channel that opens itself.

## 2. Why not just use CoffeeChat Bot

CoffeeChat Bot (coffeechatbot.app, by Will Ness) is the closest existing thing
and it is competent. Its public site and Product Hunt listing were reviewed on
2026-09-12; its install manifest was not. Differences that matter:

| | CoffeeChat Bot | Matchbook |
|---|---|---|
| Model | Synchronous mass voice event, rounds | Asynchronous pairing, one scheduled 1:1 call |
| Matching input | Meeting history (boolean) | Composable scorers (numeric) |
| Scheduling | Fixed event time, attend or miss it | Proposed time per pair, negotiable, .ics issued |
| Source | Closed | AGPL-3.0 |
| Moves people between channels | Yes, that is how its rounds work, so it presumably needs Move Members (not verified against its manifest) | Never. Members join the channel themselves |
| Pricing | Not published | Free to self-host |

The synchronous model needs a quorum to not feel sad and excludes anyone who
cannot be present at one fixed hour. The KmikeyM Discord is asynchronous, spread
across timezones, and has exactly one working synchronous ritual already (poker).

## 3. Scope

### In, v1

- Standing opt-in, pause, resume, forget via slash commands
- Auto-pause after two ignored check-ins, where a partner's confirmation counts
  as evidence a member attended
- Recurring pairing rounds on a configured cadence
- Scored matching with four bundled strategies and weighted composition
- Private thread per pairing
- Per-member weekly availability (presets plus a custom editor)
- Proposed meeting time drawn from real mutual availability, negotiation, lock-in
- .ics generation, Discord scheduled event, private voice channel per pairing
- Single follow-up ("did you two connect?") per member per pairing, feeding the
  hygiene ladder, the reported metric, and `never-met`'s notion of "met"
- SQLite storage behind an interface, every row scoped by `guild_id`
- Durable job scheduling for everything time-based, so a restart loses nothing
- Docker Compose deployment, config file, no build step required of an adopter

### Out, v1 (deliberate)

- Voice *rounds* / speed-networking (rejected model, not deferred)
- Web dashboard
- Billing or any hosted-service surface
- Identity link to kmikeym.com, and therefore any market-data matching
- Any LLM in the matching path
- Free-text time or timezone parsing (selection and autocomplete only)
- Group sizes beyond 2, except one group of 3 when the count is odd
- Calendar integration (reading real free/busy from Google Calendar or an .ics
  subscription). The weekly availability mask is in; live calendar access is not,
  because it costs OAuth, per-provider integrations, a genuine privacy surface,
  and it makes a self-hoster obtain API credentials to run a coffee bot.
- A completion-rate scorer (favoring members whose calls tend to happen). A
  natural v2 strategy once there are outcomes to read; in v1 it would only
  penalize newcomers for having no data.

### Explicitly deferred, with a known home

- `guild_id` on every row and config behind an interface make multi-tenancy a
  configuration change rather than a migration. See §10.
- The KmikeyM market-data strategy lives in a separate private module that
  registers against the strategy interface. It never enters this repo. See §9.

## 4. Architecture

Six units. The first three import nothing platform-specific and are where the
tests concentrate.

**`core/matching`**: pure. `match(participants, history, strategy, opts) =>
Pairing[]`. No IO, no clock, no Discord.

**`core/strategies`** is the extension point:

```ts
interface Strategy {
  readonly name: string
  /** 0..1, higher is a better pairing. Must be symmetric: score(a,b) === score(b,a). */
  score(a: Participant, b: Participant, ctx: Context): number
}
```

Bundled, four:

- `never-met`: 1 if the two have never been paired. Otherwise low when the last
  pairing was recent, recovering toward 1 as rounds pass, so once every novel
  pair is exhausted the least-recent repeats are chosen first. A past pairing
  counts as fully "met" only if at least one member answered the follow-up with
  Yes; a pairing nobody confirmed counts as half-met and recovers toward
  eligibility twice as fast. This is how outcome data reaches scoring in v1.
- `interest-overlap`: Jaccard similarity over self-declared tags.
- `schedulable`: share of the week both members are actually available (§5).
- `round-robin`: deterministic rotation, ignores everything else.

`schedulable` is the clearest argument for scoring over a boolean. Availability
could have been a filter applied after matching, which would exclude constrained
members from rounds. As a scorer it does the opposite: it steers someone with
narrow availability toward a partner they can genuinely meet, while the matcher's
guarantee that everyone appears exactly once per round means narrow availability
never benches anybody.

Composition is a weighted sum from config, normalized to 0..1. The shipped
default:

```
never-met         0.5
schedulable       0.3
interest-overlap  0.2
```

**`core/rounds`**: everything time-based, decided against an injected clock.
Which members are eligible, when the next round is due, when a pairing's channel
should open and close, when its follow-up is due, when a check-in has expired.
It owns the semantics of the `jobs` table (§6) and decides what is due; the
adapter executes.

**`adapters/discord`**: the only unit importing a Discord library. Slash
commands, thread creation, voice channel lifecycle, scheduled events, message
delivery. Thin by design.

**`storage`**: interface plus a SQLite implementation. Generic SQL only, no
SQLite-specific features, so a Postgres adapter is a swap rather than a rewrite.

**`config`**: `ConfigStore` interface with `FileConfigStore` (TOML on disk,
what self-hosters use) and, later, `DbConfigStore` (per-guild rows, what a
hosted service needs). Holds the guild id, the parent text channel that threads
are created under, the voice channel category, cadence, strategy weights, and
the hygiene thresholds. All user-facing copy lives here as templates so nobody
forks the repo to change the bot's voice.

### The matcher

Optimal maximum-weight matching is the Blossom algorithm, which is genuinely
fiddly. At the scale this tool targets (under ~50 participants per round), a
greedy pass with randomized restarts (200 iterations, keep the highest total
score) should land close to optimal in ~40 lines. "Close" is measured, not
asserted: the test suite compares greedy against brute-force optimal on fixtures
of ten or fewer and the README reports the gap. Ship greedy, keep the matcher
behind an interface so anyone who outgrows it can substitute Blossom without
touching strategies.

Odd participant count: match on n-1, then attach the unmatched participant to
whichever existing pair yields the highest mean score, forming one group of
three. Nobody is ever benched, and the triad is not told it is the remainder.
Everything below that says "both" or "the pair" applies to all three.

## 4a. Enrollment and hygiene

**Enrollment is standing.** `/join` once and you are in every round until you
`/pause`. No per-round opt-in, no renewal step, no recurring ask. This matches
how the 2019 Dialup line worked and it is the entire ergonomic premise: the tool
should cost nothing after the first thirty seconds.

**Standing enrollment has one failure mode and it is fatal if ignored.** People
opt in at peak enthusiasm. Weeks later, someone who no longer wants introductions
will not type `/pause`, because ignoring a bot is easier than telling it no. They
go quiet instead. A listed-but-absent member is worse than a departed one: every
round they are matched, they burn a real participant's entire turn. A pool of
nominally-active ghosts looks healthy in the numbers right up until nobody is
meeting anybody.

**So the bot declines to assume consent it has not seen evidence for.** The hard
part is measuring the right thing. "Did not respond to the bot" and "did not
participate" are different, and confusing them is how a tool ejects someone who
showed up to every call and simply never taps buttons.

**A pairing counts as silent for a member only if nothing indicates they were
there.** Any of the following clears it:

- they posted in the thread
- they tapped anything: confirmed the proposed time, countered it, answered the
  follow-up, or answered a check-in
- **their partner answered the follow-up with Yes**

The third is the important one. A partner's "Yes" is a statement about the
pairing, not about the responder, so it is third-party evidence that both people
showed up. The bot already stores it. Pausing someone while holding proof they
attended would be the system ignoring its own data. A partner's "Not yet" is not
evidence of attendance and clears nothing for either member.

**The ladder, precisely.** `silent_streak` counts consecutive silent pairings.
When it reaches two, the bot sends a check-in and **resets the streak to zero**;
the check-in consumes the streak. If the check-in goes seven days unanswered,
`checkins_ignored` increments. When `checkins_ignored` reaches two, the member is
auto-paused. So auto-pause requires four silent pairings and two ignored
check-ins, which at the default biweekly cadence is roughly two months of
complete silence before the bot acts. Any qualifying evidence resets both
counters to zero.

> Still up for these? You haven't been in the last couple of threads, and I'd
> rather ask than guess.
> `[ Keep me in ]`  `[ Pause me ]`

The copy asks rather than charges, because the member most likely to see it is
someone who did the calls and ignored the buttons.

**The asymmetry justifies being this slow.** A false negative costs one partner's
turn. A false positive ejects an engaged member and tells them, wrongly, that the
system judged them absent. The second is much harder to undo.

**Coming back.** `/resume` restores standing enrollment, and so does `/join`.
Two commands, one outcome, because a returning member's model of the interface
is "I am rejoining" and ours is "there is a state flag," and when those disagree
the interface should bend. `/join` while paused resumes immediately and names the
next round date; it does not ask the setup questions again, because they were
already answered. `/availability` and `/timezone` remain available for anything
that changed.

**Pausing is not forgetting.** History survives a pause, which matters more than
it sounds: `never-met` still knows who a returning member has already talked to,
so nobody comes back and is immediately re-introduced to the same person.
`/forget` is the real deletion and is a different door.

**Returning resets both counters to zero.** A member auto-paused for going quiet
who came back still sitting at one ignored check-in would be a single missed
reply from being auto-paused again, which is a trap rather than hygiene.

This is hygiene, not enforcement. It costs two counters and a timestamp on the
member row and reuses the follow-up already specified in §5.

**Cadence and pool size.** With `n` participants a round consumes `n/2` pairings
and `n(n-1)/2` distinct pairs exist, so novel pairings exhaust in `n-1` rounds.
Twelve members running weekly exhaust in eleven weeks, after which `never-met`
is choosing among repeats and the bot reads to members as getting worse.

**The shipped default is therefore biweekly, not weekly.** It doubles the runway
at half the ask. We also expect, but have not measured, that biweekly produces
higher completion than weekly, in which case it compounds: `never-met`'s
outcome-aware recovery has more confirmed pairings to work from. That second
claim is a hypothesis to check after the first few rounds, not a reason the
default was chosen. Cadence is per-server config and the README documents the
`n-1` arithmetic so an adopter with 200 members knows to turn it up.

## 5. Scheduling model

Pairing state machine:

```
created
  -> time_proposed      shared hours exist; thread posted with a proposal
  -> released           no shared hours; thread posted, time left to the pair

time_proposed
  -> one_confirmed      first "Works for me"
  -> time_proposed      a counter-proposal (at most one per side)
  -> released           48h after the latest proposal with no lock

one_confirmed
  -> locked             second "Works for me"
  -> time_proposed      the other side counters instead of confirming
  -> released           48h after the latest proposal with no lock

locked
  -> time_proposed      either side accepts a re-propose after a timezone change
  -> completed          follow-up posted, 24h after the scheduled end

released
  -> expired            7 days with no thread activity; thread archived quietly

completed                terminal; thread archived 7 days after the call
```

**Availability.** A week is 168 hours, so each member's availability is a 168-bit
weekly mask at hourly granularity, index 0 being Monday 00:00 in their own local
time. Finding when people can meet is a bitwise AND across all members of the
pairing. It is instant, it is a few dozen bytes on the member row, and it is the
only availability model in the system: there is no separate civil-hours window.

**The default mask is the `Any reasonable hour` preset: 09:00 to 21:00 local,
every day.** A member who joins and never runs `/availability` gets exactly
this, and the `/join` confirmation says so and names the command. It is not
literally "anytime," because nobody who says anytime means 03:00.

**The mask is stored as local intent and projected to UTC at match time.** Storing
UTC directly would leave a member's "weekdays 9 to 5" sitting on the wrong hours
the moment they change timezone. Storing the local weekly pattern alongside the
timezone means the blackout travels with them automatically, which is the only
behavior anyone would expect from a declaration like "not during my workday."

**Entering it must not involve parsing English**, for the same reason free-text
time entry was rejected. `/availability` offers four presets, `Weekdays 9 to 5
off` / `Evenings only` / `Weekends only` / `Any reasonable hour`, plus a custom
path that is two Discord select menus, days and then hours, which ORs one
available block into the mask per pass. Run it again to add another block; a
`Clear` button empties the mask. The chosen preset is remembered so reopening the
menu shows current state.

**Slot proposal.** AND the masks, project to UTC, and take candidate 30-minute
slots in the next 3 to 10 days that fall inside the shared hours, preferring
evenings local to both. Propose one. On "Pick another time", offer up to five
alternatives from the same shared set as a select menu. Calls are 30 minutes and
the mask is hourly, so proposals land on the hour.

**Empty overlap** is a real outcome, not an error. A pairing with no shared hours
goes straight to `released`, and the message says why rather than merely stepping
back: no time works for both of you, the thread is yours.

**Negotiation limit.** Each side gets one counter-proposal. Once both are spent
with no lock, the pairing releases rather than continuing to negotiate. A
"Works for me" from one side is voided if the other side counters; the new
proposal needs both confirmations.

**Follow-up.** Twenty-four hours after a locked call's scheduled end, the bot
posts once in the thread:

> Did you two connect?  `[ Yes ]`  `[ Not yet ]`

Each member may answer once; answers are independent and recorded per member. It
never asks again, and it never asks in a `released` pairing (open question 2).
"Not yet" rather than "No" because the honest answer in week one is usually
scheduling rather than refusal, and a question that implies failure gets ignored.
A Yes from either member is attendance evidence for both (§4a), and marks the
pairing as fully met for `never-met` (§4).

**Timezones are mandatory**, captured at `/join` through a slash-command option
with autocomplete over the IANA zone database. Typing `kos` offers
`Europe/Belgrade`; typing `oak` offers `America/Los_Angeles`. This is the
Discord-native answer to a list of six hundred entries that a select menu (capped
at 25 options) cannot hold and a free-text field would have to parse. Display uses
Discord's `<t:epoch:F>` markdown, which every client renders in the viewer's own
local timezone at no cost to us.

**Changing timezone.** `/timezone <zone>` updates it immediately, and re-running
`/join` with a `timezone` option does the same. Two paths to the same place,
because people will guess either one. This is not an edge case. Members travel,
and a stale timezone is worse than no timezone: it makes the bot confidently
wrong rather than merely uninformed.

**A timezone change never rewrites a locked call.** All times are stored in UTC
and rendered with local-timezone markdown, so a call locked for Thursday 19:00
Pacific stays at the same absolute moment and simply displays as Friday 04:00
once that member has crossed nine timezones. The .ics is UTC and their calendar
app does the same thing unaided. What two people agreed to was a moment, not a
clock reading.

**But the bot notices when the moment became a bad one.** If a member's timezone
changes and they have a locked call that now falls outside their own availability
mask once projected through the new zone, the bot posts once in that thread
offering `[ Keep it ]` or `[ Suggest a new time ]`, actionable by either person.
Accepting returns the pairing to `time_proposed` with one fresh counter-proposal
each.

**Rejected alternative: per-pairing slot polls.** Offer both members a grid of
candidate slots rendered in their own local time and take the overlap. More
accurate than any stored pattern and it never goes stale, but it replaces one tap
with six on every single pairing, which reintroduces exactly the coordination
burden this feature exists to remove. A standing weekly mask is answered once.

**On lock**, three things happen, and the order matters because of a Discord
constraint: a voice-type scheduled event must reference a channel that already
exists, and so must the .ics `LOCATION`.

1. Create the private voice channel now, under the configured category, with
   permission overwrites granting View Channel to the pairing's members only.
   Connect is withheld until 10 minutes before the call so nobody wanders in a
   week early. The channel is deleted 60 minutes after the scheduled end.
2. Create a Discord scheduled event on that channel. This gives both members
   Discord's own reminders and "interested" tracking for free. Whether the event
   is visible to members who cannot see the channel is an assumption to verify
   in the first build; if it is guild-visible, the event is created without a
   description and titled only "Matchbook."
3. Generate and post an .ics: a single `VEVENT` with `UID`, `DTSTAMP`, `DTSTART`,
   `DTEND` (all UTC), `SUMMARY`, `DESCRIPTION`, and `LOCATION` set to the voice
   channel URL. No `ORGANIZER` or `ATTENDEE`: those require `mailto:` addresses
   the bot does not have and must not collect.

A locked call that is later re-proposed (timezone change) deletes the event and
channel and recreates them on the new lock, and posts a fresh .ics. The old
.ics carried the same `UID`, so a calendar that imports both keeps one entry.

**Graceful degradation is a feature, not an error path.** A released pairing
falls back to exactly the behavior of a scheduling-free tool: the thread exists,
both people are in it, the bot says the time is theirs to arrange and steps back.

## 6. Data model

Every table carries `guild_id` from the first migration, including child tables
that could reach it through a parent. Retrofitting a tenant column into live data
is a painful migration; adding it now costs one word per table.

```
guilds(guild_id PK, created_at)
members(guild_id, discord_user_id, state, timezone, tags, avoid_notes,
        availability_mask, availability_preset,
        silent_streak, checkins_ignored, checkin_sent_at, joined_at,
        PRIMARY KEY(guild_id, discord_user_id))
rounds(id PK, guild_id, scheduled_for, state, created_at)
pairings(id PK, guild_id, round_id, thread_id, voice_channel_id, event_id,
         state, created_at)
pairing_members(guild_id, pairing_id, discord_user_id)
proposals(id PK, guild_id, pairing_id, start_utc, duration_min, state,
          proposed_by, created_at)
confirmations(guild_id, proposal_id, discord_user_id, confirmed_at)
outcomes(guild_id, pairing_id, discord_user_id, connected, answered_at)
jobs(id PK, guild_id, kind, ref_id, run_at, state, created_at)
```

`members.state` is one of `active | paused`. A member who leaves is deleted, not
flagged, so `/forget` is a real deletion. `silent_streak` and `checkins_ignored`
are the two hygiene counters from §4a; `checkin_sent_at` is the most recent
check-in, used to detect the seven-day expiry.

`availability_mask` is 168 characters of `0` or `1`, index 0 being Monday 00:00
in the member's local time. A packed representation would be 21 bytes instead of
168, which is not a saving worth making: the readable form can be inspected in a
database client without tooling, and debugging a scheduling complaint is much
likelier than running out of disk.

`outcomes.connected` is true for Yes and false for Not yet. The distinction from
"No" lives in the copy, not the column; nothing in v1 treats a Not yet as a
refusal.

**Durable scheduling.** Every time-based action is a row in `jobs` with a
`run_at`, and a single ticker polls for what is due. Round firing, channel
Connect grant at T-10, channel deletion at T+60, follow-up at T+24h, check-in
expiry at +7d, thread archival. Not in-process timers. This survives a restart,
it scales from one guild to a thousand unchanged, and it makes every deferred
action inspectable in one table. Correctness first, scale as a side effect.

## 7. Discord surface

**Member commands.**

- `/join` with options `timezone` (required, autocomplete), `interests`
  (optional text), `avoid` (optional text). Re-running it with any option
  updates just that option; a paused member running it is resumed. The
  confirmation names the next round date, states the default availability, and
  names `/availability`.
- `/timezone`, `/availability`, `/pause`, `/resume`, `/forget`.

**Admin commands:** `/matchbook config`, `/matchbook run` (trigger a round now),
`/matchbook status`.

**Permissions requested:** View Channels, Send Messages, Create Private Threads,
Send Messages in Threads, Manage Threads, Manage Channels, Manage Events,
Connect. The README explains each in one line. Two notes:

- Connect is requested because the bot can only grant the pair permissions it
  holds itself, and it must grant Connect on the private voice channel.
- Permission overwrites are set when the channel is created, which Manage
  Channels permits. Editing overwrites on an existing channel would need Manage
  Roles, which is not requested; the T-10 Connect grant is therefore done by
  recreating the overwrite set at creation time plus one edit at T-10, and the
  first build must confirm that edit is allowed under Manage Channels alone. If
  it is not, the channel is created at T-10 instead and the scheduled event is
  created as an external event with the channel named in its location.
- Notably absent: Move Members. Matchbook never relocates a person.

**Why private threads rather than DMs.** Discord members can block DMs from
people they have not friended, which is precisely the case a first introduction
hits. A private thread is deliverable, gives both people a shared space so
neither has to enter the other's inbox, carries the bot's framing above the
conversation, and gives the follow-up somewhere natural to land. Threads are
created under the parent text channel named in config.

## 8. Testing

Test-driven, concentrated on the pure core.

**Matching properties** (not example tests): nobody is ever paired with
themselves; every active participant appears exactly once per round; an odd
count yields exactly one group of three and no other; while any never-paired
combination remains, no round contains a repeat; once exhausted, the chosen
repeats are the least recent; `score(a,b) === score(b,a)` for every bundled
strategy; composed weights always produce a value in 0..1; the greedy matcher's
total score is measured against brute-force optimal on every fixture of ten or
fewer members and the gap is reported.

**Rounds and jobs** run against an injected clock. No test sleeps. Every job kind
fires exactly once, at or after its `run_at`, and survives a simulated restart
between scheduling and firing.

**Scheduling** state machine is exhaustively tested over its transition table,
including both release entries (no overlap; 48h), the voided confirmation on a
counter, the negotiation limit, and the locked-to-proposed re-propose path.

**Availability**: mask intersection is commutative and associative (triads); a
member on `Any reasonable hour` never constrains a pair beyond 09:00-21:00; a
member with an empty mask always produces the no-overlap release; changing
timezone moves the projected UTC hours by exactly the offset delta and leaves the
stored local mask untouched; the `schedulable` score equals shared hours over
168 and stays in 0..1; a new member's mask equals the default preset.

**Enrollment hygiene**: any of the evidence types resets both counters to zero; a
partner's Yes clears the strike for both members while a partner's Not yet
clears it for neither; sending a check-in resets `silent_streak`; one ignored
check-in never auto-pauses; two does; a paused member never appears in a round;
`/resume` and `/join` are equivalent for a paused member and both restore
history intact; returning zeroes both counters; a forgotten member who rejoins
starts with no history at all.

**End to end** runs a full round against a fake Discord adapter and a synthetic
20-member fixture guild, with no network.

The real Discord adapter stays thin enough to verify by using it.

## 9. Privacy and consent

Stored: Discord user ID, opt-in state, timezone, self-declared tags and
avoid-notes, a weekly availability pattern, pairing history, proposed and
confirmed times, one answer per member per pairing to "did you two connect," and
the two hygiene counters. That is the entire schema.

Never stored: message content, voice, or anything from an operator's private
knowledge base.

`/forget` deletes the member row, their pairing memberships, their confirmations
and their outcomes, and nulls `proposed_by` on proposals they authored. Their
former partners' rows are untouched, so a partner's history still shows a
pairing with a member who no longer exists; that is harmless and honest. The bot
says it deleted them rather than claiming it deactivated them.

**Disclosure boundary.** In v1 a pairing message discloses nothing a member has
not already made public by being in the server. That property is what keeps
Matchbook out of Sensitive Content territory, and it is the thing to protect when
smarter strategies arrive. "You two voted opposite ways on vote 187" is an
appealing match reason and also a disclosure of two people's votes to each other.
That is a consent question, not a feature question. When market data enters
scoring, `/join` gains an explicit sentence about what is used, and that is a
change to the consent, not to the copy.

**What data is allowed to decide.** The follow-up answer was specified as a
metric and is now also evidence in a decision about membership (§4a) and an
input to `never-met` (§4). Same data, three jobs. This is acceptable in v1
because every decision it drives is lenient and reversible, but it is the
pattern to watch: each new strategy that reads a signal should state what that
signal is permitted to decide. This document does not yet contain a policy for
that, and pretending one sentence covers it would be worse than saying so.

The future KmikeyM strategy reads through an existing read-only market-data
service. It never touches the contact records, and it never ships in this repo.

## 10. Multi-tenancy and a possible hosted service

Discord bots are natively multi-tenant: one application, one token, many guilds,
one gateway connection. Nothing here fights that. Four decisions taken now keep a
paid hosted service a configuration change rather than a rewrite:

1. `guild_id` on every row from the first migration (§6)
2. Config behind `ConfigStore`, file-backed now, database-backed later (§4)
3. Durable `jobs` scheduling rather than in-process timers (§6)
4. Generic SQL so Postgres is an adapter swap (§4)

Three of those four are things good design wants regardless. Durable scheduling
is correctness. Interfaces around storage and config are testability. Only the
tenant column is pure future-proofing, and it is cheap because it is structural
rather than behavioral.

What a service would add, and what therefore stays out of this repo: billing,
the OAuth install and onboarding flow, the customer dashboard, hosted operations.

Known gate: Discord requires bot verification and approval past 100 servers.
Known responsibility: holding other communities' member data and outcomes is a
real data-protection obligation that a self-hosted tool does not carry.

## 11. Repo, license, branding

Public repo at `Publicly-Traded-Person/matchbook`, credited to KmikeyM. An
earlier draft argued for Quarterly Systems branding on the grounds that a
general tool reads strangely wearing one person's ticker; Mike reversed that
(#7). The README tells the story as KmikeyM's because it is, and the tool being
general does not make its builder anonymous.

**AGPL-3.0.** Self-host freely; run a modified version as a network service to
other people and you publish your changes. This keeps the tool genuinely free for
self-hosters while making it unattractive to wrap and resell as closed SaaS. The
license was set before the first public commit, because relicensing later
requires consent from every contributor by then.

The shipped code and the configuration contain no mention of KmikeyM, shares, or
votes. The README and this design document are the exceptions: the README tells
the story of where the idea came from, and this document explains what the
private strategy will need from the interface. Both are context a reviewer needs
and an adopter can ignore.

### README quickstart (once code exists)

A working bot in under ten minutes, and honest about the number:

```
git clone https://github.com/Publicly-Traded-Person/matchbook
cp config.example.toml config.toml   # guild, channels, cadence, weights
export DISCORD_TOKEN=...
docker compose up
```

Above it: the invite link with exact scopes, one line per permission explaining
why. Below it: the strategy interface documented in about fifteen lines, because
writing a scorer for your own community is the reason to choose this over the
closed alternative. This section is written when there is something to run.

## 12. Rollout on the KmikeyM Discord

First round is manually triggered, small, and not announced as a program. One
message in `#chatter` and a permanent line in the channel topic.

Standing evidence as of 2026-09-12: within minutes of the idea being raised in
chat, one member said they would participate outright and a second said they
would be interested in a shareholder activity that is not poker. Two data points,
same day. The second is the more interesting one: demand for a live thing from
someone the existing ritual does not reach.

**The reported metric is completion rate, not signups.** Match count is vanity.
If eight people opt in and two calls actually happen, that is the finding.

**Round one has no history.** `never-met` scores every pair identically, so the
first round is decided entirely by availability overlap and declared interests.
That is not random, but it is not yet the model working either. It gets
meaningfully better around round three, once there are pairings and follow-up
answers to learn from. Say this out loud rather than let the first pairing look
like a bug.

## 13. Open questions

None blocking. To revisit after the first three rounds:

1. Whether 30 minutes is the right default call length, or 20.
2. Whether the follow-up should also fire for `released` pairings, which would
   measure how often the fallback still produces a conversation.
3. Whether a member who answered "Not yet" and then met should be able to update
   their answer. In v1 the first answer stands.
