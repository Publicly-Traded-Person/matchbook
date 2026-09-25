# Matchbook: Design Spec

**Date:** 2026-09-12
**Author:** Charlie (The Investor Relations)
**Status:** 🟡 Open for review. Spec only, no code.
**Repo:** `Publicly-Traded-Person/matchbook`, public, AGPL-3.0
**Decisions, questions and build assumptions live in the issue tracker (§13).**

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

And introductions arrive on the member's own clock. There is no pairing day. You
join, and within about a day you have someone to talk to, as long as someone is
free to meet you.

## 2. Why not just use CoffeeChat Bot

CoffeeChat Bot (coffeechatbot.app, by Will Ness) is the closest existing thing
and it is competent. Its public site and Product Hunt listing were reviewed on
2026-09-12; its install manifest was not. Differences that matter:

| | CoffeeChat Bot | Matchbook |
|---|---|---|
| Model | Synchronous mass voice event, rounds | Asynchronous pairing, one scheduled 1:1 call |
| Matching input | Meeting history (boolean) | Composable scorers (numeric) |
| When you get paired | At the event | Within about a day of becoming eligible, when a feasible stranger or welcomer exists |
| Scheduling | Fixed event time, attend or miss it | Proposed time per pair, negotiable, .ics issued |
| Source | Closed | AGPL-3.0 |
| Moves people between channels | Yes, that is how its rounds work, so it presumably needs Move Members (not verified against its manifest) | Never. Members join the channel themselves. Move Members, Mute Members and Manage Events are not requested |
| Pricing | Not published | Free to self-host |

The synchronous model needs a quorum to not feel sad and excludes anyone who
cannot be present at one fixed hour. The KmikeyM Discord is asynchronous, spread
across timezones, and has exactly one working synchronous ritual already (poker).

## 3. Scope

### In, v1

v1 ships in two builds (#19). **Build 1 is the shortest loop that produces a
completed call and a measured answer**: introduction, agreed time, call, "did
you two connect?" It runs the `round-robin` strategy behind the feasibility
precondition and nothing that exists only to rank pairs better. **Build 2** turns
on the scorers. Items below marked *(build 2)* are specified now, built second,
and off by default until build 1 has produced pairings. `round-robin` plus
feasibility already gives a stranger every time until the pool is exhausted, so
the pilot cohort loses nothing by the deferral. What it buys is that the first
real data measures the loop, not the loop plus weights nobody has evidence for.

- Standing opt-in, pause, resume, forget via slash commands
- An acknowledgment gate after one silent pairing (#18), where a partner's
  confirmation counts as evidence a member attended; auto-pause only as
  housekeeping
- Rolling pairing: per-member eligibility, no batch rounds, a holding window, and
  a novelty rule that prefers waiting for a stranger over repeating, until there
  are no strangers left
- Scored matching with four bundled strategies and weighted composition; every
  strategy declares the signals it reads *(build 2: `never-met`,
  `interest-overlap`, `schedulable`; the interface, `round-robin` and the
  feasibility precondition are build 1)*
- Self-declared interests on `/join` *(build 2, with `interest-overlap`)*
- The volunteer welcome pool (#17) *(build 2, pulled into build 1 only if the
  first week shows a newcomer waiting)*
- Private thread per pairing
- Per-member weekly availability (presets plus a custom editor)
- Proposed meeting time drawn from real mutual availability, negotiation, lock-in
- .ics generation; a private voice channel created ten minutes before the call
- Follow-up ("did you two connect?") per member, for locked pairings and for
  released pairings that had thread activity
- SQLite storage behind an interface, every row scoped by `guild_id`
- Durable job scheduling for everything time-based, so a restart loses nothing
- Docker Compose deployment, config file, no build step required of an adopter

### Out, v1 (deliberate)

- Voice *rounds* / speed-networking (rejected model, not deferred)
- Batch pairing rounds of any kind (#15)
- Discord scheduled events (#14): voice-type events require Move Members and
  Mute Members; external-type events have no channel to inherit privacy from
- Web dashboard
- Billing or any hosted-service surface
- Identity link to kmikeym.com, and therefore any market-data matching
- Any LLM in the matching path
- Free-text time or timezone parsing (selection and autocomplete only)
- Group sizes other than two. With no batch there is no odd count to absorb
- Calendar integration (reading real free/busy from Google Calendar or an .ics
  subscription). The weekly availability mask is in; live calendar access is not,
  because it costs OAuth, per-provider integrations, a genuine privacy surface,
  and it makes a self-hoster obtain API credentials to run a coffee bot.
- A completion-rate scorer (#2). A natural v2 strategy once there are outcomes
  to read; in v1 it would only penalize newcomers for having no data.
- Per-member cadence. Falls out of the eligibility model for free someday; not
  now.

### Explicitly deferred, with a known home

- `guild_id` on every row and config behind an interface make multi-tenancy a
  configuration change rather than a migration. See §10.
- The KmikeyM market-data strategy lives in a separate private module that
  registers against the strategy interface. It never enters this repo. See §9.

## 4. Architecture

Six units. The first three import nothing platform-specific and are where the
tests concentrate.

**`core/matching`**: pure. `match(pool, history, strategy, opts) => Pairing[]`.
No IO, no clock, no Discord. The pool is whoever is eligible right now (§4a),
not the whole membership.

**`core/strategies`** is the extension point:

```ts
type Signal =
  | 'pairing-history'   // who has been paired with whom, and when
  | 'follow-up'         // the per-member "did you two connect" answers
  | 'tags'              // self-declared interests
  | 'availability'      // the weekly mask
  | 'timezone'

interface Strategy {
  readonly name: string
  /** Every signal this strategy reads. Enforced by the Context it is handed. */
  readonly reads: readonly Signal[]
  /** 0..1, higher is a better pairing. Must be symmetric: score(a,b) === score(b,a). */
  score(a: Participant, b: Participant, ctx: Context): number
}
```

`reads` is the rule from #6 made structural: a strategy gets a `Context`
containing only the signals it declared, so reading something undeclared is a
type error rather than a policy violation. §9 says what the declaration is for.

Bundled, four:

- `never-met` (reads `pairing-history`, `follow-up`): 1 if the two have never
  been paired. Otherwise low when the last pairing was recent, recovering toward
  1 as time passes, so once every stranger is exhausted the least-recent repeats
  are chosen first. A past pairing counts as fully "met" only if at least one
  member answered the follow-up with Yes; a pairing nobody confirmed counts as
  half-met and recovers twice as fast (#1).
- `interest-overlap` (reads `tags`): Jaccard similarity over self-declared tags.
- `schedulable` (reads `availability`, `timezone`): share of the week both
  members are actually available (§5). It ranks feasible pairs; it does not
  decide feasibility, which is a precondition (below, #16).
- `round-robin` (reads `pairing-history`): deterministic rotation, ignores
  everything else. A pair never paired scores 1; a repeat scores d / (d + 14),
  with d the days since their most recent pairing. Strangers always outrank
  repeats, and among repeats the least recent wins (#22).

**Shared availability is a precondition for a pair, not a term in its score
(#16).** A pair is *feasible* only if the AND of their projected masks (§5) is
non-empty. Only feasible pairs are scored at all. The first draft made
`schedulable` a scorer alone, on the argument that a filter would exclude
constrained members. That confused two filters. Filtering *members* by
availability would exclude someone; filtering *pairs* by whether they can meet
excludes nobody, because a constrained member is still paired with anyone they
overlap with. And with the weights below, a scorer alone ranked a never-met pair
with zero shared hours (0.5) above a recent repeat with every hour shared
(about 0.4), then sent the winner straight to a released thread. Scheduling is
the product; a pairing that cannot become a call is not a pairing.

Among feasible pairs, `schedulable` still does the steering: someone free only
on weekend mornings is ranked toward whoever else is free then.

Avoid notes are the other precondition. `/join`'s `avoid` option names members
the matcher must never pair you with; it is honored before scoring, is never
exposed as a `Signal`, and its only purpose is that exclusion (§9).

A member whose mask overlaps no active member's is not paired. The bot tells
them once, names `/availability`, and leaves them in the pool; the holding
window (§4a) does not apply to them, because no amount of waiting produces a
feasible partner.

Composition, over feasible pairs, is a weighted sum from config, normalized to
0..1. The build 1 default is `round-robin 1.0` and nothing else (#19). The
build 2 default:

```
never-met         0.5
schedulable       0.3
interest-overlap  0.2
```

**`core/eligibility`**: everything time-based, decided against an injected
clock. Who is in the pool, who is being held and why, when a pull-forward is
allowed, when a pairing's channel should open and close, when its follow-up is
due, when a check-in has expired. It owns the semantics of the `jobs` table (§6)
and decides what is due; the adapter executes.

**`adapters/discord`**: the only unit importing a Discord library. Slash
commands, thread creation, voice channel lifecycle, message delivery. Thin by
design.

**`storage`**: interface plus a SQLite implementation. Generic SQL only, no
SQLite-specific features, so a Postgres adapter is a swap rather than a rewrite.

**`config`**: `ConfigStore` interface with `FileConfigStore` (TOML on disk,
what self-hosters use) and, later, `DbConfigStore` (per-guild rows, what a
hosted service needs). Holds the guild id, the parent text channel that threads
are created under, the voice channel category, the cadence, the holding window,
the pull-forward limit, strategy weights, and the hygiene thresholds. All
user-facing copy lives here as templates so nobody forks the repo to change the
bot's voice.

### The matcher

The pool at any moment is small: whoever is eligible right now, typically two to
a handful of people. The matcher scores every pair in it and takes the best
non-overlapping set. At this size the difference between greedy and optimal
matching is usually nothing, but the matcher stays behind an interface and the
test suite measures greedy against brute-force optimal on every fixture of ten
or fewer, so if a large community ever has a large pool the gap is a known
number rather than a guess.

## 4a. Enrollment, eligibility and hygiene

**Enrollment is standing.** `/join` once and you are in until you `/pause`. No
per-round opt-in, no renewal step, no recurring ask. This matches how the 2019
Dialup line worked and it is the entire ergonomic premise: the tool should cost
nothing after the first thirty seconds.

**There is no pairing day (#15).** Each member has one date, `eligible_at`.
Joining sets it to now. Being paired sets it to now plus the cadence. Members
whose date has passed are the pool; whenever the pool has two or more, the
matcher runs. A newcomer is eligible the moment they join, so the first thing
that happens after `/join` is the thing they joined for.

**Cadence is the minimum gap between one member's introductions**, measured from
their last pairing, not from a calendar. The shipped default is two weeks.
Nobody gets two introductions six days apart because they happened to join at
the right moment (a welcomer's extra pairing, #17, is the one consented
exception), and two weeks is long enough that the thing does not become a
chore.

**Holding and pull-forward.** A member alone in the pool waits up to 24 hours
(the holding window) for company. If nobody arrives, the bot pairs them with the
soonest-eligible feasible stranger, or with the soonest-eligible member when the
novelty rule's branch 3 applies, pulling that member's `eligible_at` forward by
at most three days. The novelty rule takes precedence over the holding window:
at hour 24, a repeat is not pulled forward while a stranger exists. Nobody minds their next introduction coming a few days early, and
every pull-forward nudges a launch-day cohort out of lockstep, so a pool that
started synchronized spreads itself across the period within a couple of cycles.

**Pull-forward cannot keep the newcomer promise at launch, so volunteers do
(#17).** If the whole pool was paired yesterday, the soonest-eligible member is
thirteen days out and a three-day pull-forward reaches nobody; the person who
joins the day after launch waits ten days, and the one who joins a week after
launch waits four, for a bot that said it would introduce them. So a member may volunteer to welcome newcomers with `/welcome
on` (also a button in the `/join` confirmation; default off). When a newcomer's
first pairing would otherwise wait past the holding window, the matcher may pair
them with any welcomer, ignoring the welcomer's `eligible_at`. Feasibility
(§4) still applies. A welcome pairing does not move the welcomer's own
`eligible_at`: welcoming is extra, not instead. A welcomer with an open pairing
is not eligible to welcome, so nobody is in two pairings at once. A welcomer
takes at most one welcome pairing per seven days, so a handful of volunteers is not consumed by a
launch-week wave. The newcomer's `eligible_at` is set as for any pairing. The
alternative, lifting the pull-forward cap for first pairings, keeps the promise
by taking a turn nobody agreed to; volunteering is consent.

**The novelty rule.** Waiting only helps if a stranger exists somewhere.
"Partner" in every branch means a feasible partner (#16): someone whose
availability overlaps the member's. Holding for a stranger means holding for a
stranger you can meet.

1. If the best available pairing is with someone the member has never met, pair.
2. If the only eligible partners are repeats, but someone the member has never
   met exists among active members, hold for them. Pull-forward applies. The
   hold lasts at most one cadence period. The member is told: "Holding a while
   for someone new rather than repeating."
3. If the member has met everyone, do not wait. Pair with the least-recent
   repeat and say so: "You've met everyone in Matchbook. Reconnecting you with
   X, it's been four months." `never-met`'s recovery curve already ranks old
   repeats above recent ones, so no extra machinery chooses X.

Branch 3 is reconnection, not fallback. A second call with someone you clicked
with months ago is a good call, and "you've met everyone" is a milestone with an
obvious next line attached: the pool needs to grow. It is the most useful number
the system produces and it is reported as such.

**The arithmetic behind it.** With `n` active members, a member meets everyone
after `n-1` introductions. Twelve members on a two-week cadence means about five
months before anyone reaches branch 3; twenty members, about nine. That runway
is the argument for two weeks over one and for recruitment over cleverness.

**Standing enrollment has one failure mode and it is fatal if ignored.** People
opt in at peak enthusiasm. Weeks later, someone who no longer wants introductions
will not type `/pause`, because ignoring a bot is easier than telling it no. They
go quiet instead. A listed-but-absent member is worse than a departed one: every
time they are paired, they burn a real participant's turn. A pool of
nominally-active ghosts looks healthy right up until nobody is meeting anybody.

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

**The gate, precisely (#18).** A pairing that ends silent for a member sets
`needs_ack` on their row. A member with `needs_ack` is not in the pool. When
their `eligible_at` arrives, the bot sends a check-in:

> Still up for these? You weren't around for your last introduction, and I'd
> rather ask than guess.
> `[ Keep me in ]`  `[ Pause me ]`

`Keep me in` clears the flag and they enter the pool that moment. `Pause me`
pauses. Nothing else happens on a timer that costs anyone a turn: nobody is
paired while a check-in is unanswered. Any qualifying evidence, arriving at any
point, clears the flag too. The copy asks rather than charges, because the
member most likely to see it is someone who did the call and ignored the
buttons.

One housekeeping counter remains. A check-in unanswered for one full cadence period
counts as ignored (`checkins_ignored` increments) and the check-in is re-sent once;
two ignored check-ins auto-pause the row so the member list stays honest. This never costs a partner anything, because the
member was already out of the pool.

**The first draft was slower, and wrong about why.** It required four silent
pairings and two ignored check-ins, about two months, before acting, on the
argument that a false negative costs one partner's turn while a false positive
ejects an engaged member. Both halves were right. The mistake was treating
"ask before spending another partner's turn" and "eject" as the same act. They
are not, and once they are separated the check-in can come after one silent pairing
at no cost to anyone real: the member who did the call and never tapped is
still never asked, because their partner's Yes already vouched for them. The
cost to a real member is one tap, once, after a pairing where nothing they did
left a trace. The cost to their next partner drops from up to four burned turns
to zero.

**Coming back.** `/resume` restores standing enrollment, and so does `/join`.
Two commands, one outcome, because a returning member's model of the interface
is "I am rejoining" and ours is "there is a state flag," and when those disagree
the interface should bend. `/join` while paused resumes immediately, sets
`eligible_at` to the later of now and their last pairing plus the cadence, and
does not ask the setup questions again, because they
were already answered. `/availability` and `/timezone` remain available for
anything that changed.

**Pausing is not forgetting.** History survives a pause, which matters more than
it sounds: `never-met` still knows who a returning member has already talked to,
so nobody comes back and is immediately re-introduced to the same person.
`/forget` is the real deletion and is a different door.

**Returning clears `needs_ack` and zeroes `checkins_ignored`.** A member
auto-paused for going quiet who came back still sitting at two ignored check-ins
would be auto-paused again on the next expiry, which is a trap rather than
hygiene.

This is hygiene, not enforcement. It costs a flag, a counter and a timestamp on
the member row and reuses the follow-up specified in §5.

## 5. Scheduling model

Pairing state machine:

```
created
  -> time_proposed      thread posted with a proposal (feasibility is
                        guaranteed at creation, #16)

time_proposed
  -> one_confirmed      first "Works for me"
  -> time_proposed      a counter-proposal (at most one per side)
  -> released           48h after the latest proposal with no lock
  -> released           no shared hours remain after a timezone change

one_confirmed
  -> locked             second "Works for me"
  -> time_proposed      the other side counters instead of confirming
  -> released           48h after the latest proposal with no lock
  -> released           no shared hours remain after a timezone change

locked
  -> time_proposed      either side accepts a re-propose after a timezone change
  -> completed          follow-up posted, 24h after the scheduled end

released
  -> completed          7 days after release, if anyone posted in the thread:
                        follow-up posted (#9)
  -> expired            7 days after release with no thread activity; archived

completed                terminal; thread archived 7 days later
```

**Availability.** A week is 168 hours, so each member's availability is a 168-bit
weekly mask at hourly granularity, index 0 being Monday 00:00 in their own local
time. Finding when two people can meet is a bitwise AND. It is instant, it is a
few dozen bytes on the member row, and it is the only availability model in the
system: there is no separate civil-hours window.

**The default mask is the `Any reasonable hour` preset: 09:00 to 21:00 local,
every day (#4).** A member who joins and never runs `/availability` gets exactly
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

The presets are (#22): `Any reasonable hour`, 09:00 to 21:00 every day (the
default); `Evenings only`, 17:00 to 21:00 every day; `Weekends only`, 09:00 to
21:00 on Saturday and Sunday; `Weekdays 9 to 5 off`, the default minus Monday to
Friday 09:00 to 17:00. Every preset stays inside the 09:00 to 21:00 envelope, so
no preset proposes 03:00.

**Slot proposal.** AND the two masks, project to UTC, and take candidate
30-minute slots in the next 3 to 10 days that fall inside the shared hours,
preferring evenings local to both. Propose one. On "Pick another time", offer up
to five alternatives from the same shared set as a select menu. Calls are 30
minutes and the mask is hourly, so proposals land on the hour.

**Empty overlap** cannot occur at creation: the matcher only forms feasible
pairs (#16). It can still occur later, when a timezone change removes every
shared hour from a pairing not yet locked. That pairing goes to `released`,
and the message says why rather than merely stepping back: no time works for
both of you any more, the thread is yours. A locked call is not released by a
timezone change; it gets the `[ Keep it ]` / `[ Suggest a new time ]` offer
below, and only a fresh proposal that finds no shared hours releases it.

**Negotiation limit.** Each side gets one counter-proposal. Once both are spent
with no lock, the pairing releases rather than continuing to negotiate. A
"Works for me" from one side is voided if the other side counters; the new
proposal needs both confirmations.

**Follow-up.** Twenty-four hours after a locked call's scheduled end, or seven
days after a release in which at least one member posted in the thread (#9), the
bot posts once:

> Did you two connect?  `[ Yes ]`  `[ Not yet ]`

Each member may answer once; answers are independent and recorded per member. It
never asks again. Released pairings with no thread activity get no follow-up;
asking two people who never spoke whether they met is noise. "Not yet" rather
than "No" because the honest answer in week one is usually scheduling rather than
refusal, and a question that implies failure gets ignored. A Yes from either
member is attendance evidence for both (§4a), and marks the pairing as fully met
for `never-met` (§4).

**Timezones are mandatory**, captured at `/join` through a slash-command option
with autocomplete over the IANA zone database (#5). Typing `kos` offers
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

**Can't make it (#29).** The one other thing that rewrites a locked call is a
member saying they cannot make it. The locked post carries a `Can't make it`
button, and either member may use it once per pairing: the bot cancels the room
and the follow-up, proposes the next hour that fits both masks at least three
days out, and the negotiation clock restarts, exactly as after a timezone
change. A third tap, after both have used theirs, releases the pairing to the
thread. The button is dead once the room is open or the call has passed; a
missed call is the follow-up's to record. The post that announces it mentions
both members (#32) and names who tapped, with the old time and the new one. A
cancellation calendar file waits on #33.

**On lock (#14):** generate and post an .ics: a single `VEVENT` with `UID`,
`DTSTAMP`, `DTSTART`, `DTEND` (all UTC), `SUMMARY`, `DESCRIPTION`, and
`LOCATION` set to the pairing's thread URL, which is where the room link will
appear. No `ORGANIZER` or `ATTENDEE`: those require `mailto:` addresses the bot
does not have and must not collect. No Discord scheduled event is created (§3).
`SUMMARY` and `DESCRIPTION` are the copy keys `ics-summary` and
`ics-description` (#27), whose `{a}` and `{b}` are the two members' display
names, read from the guild at the moment of the lock and kept nowhere. The
attachment is named after the summary, lowercased and hyphenated, so a member
sees who the file is for before opening it.

**Ten minutes before the call**, one job creates the private voice channel under
the configured category, with View Channel and Connect granted to the two
members in the create call itself, and posts in the thread: "Starts in ten
minutes. Your room: <link>." That post is the reminder. Sixty minutes after the
scheduled end, another job deletes the channel.

A locked call that is later re-proposed (timezone change) posts a fresh .ics on
the new lock, carrying the same `UID`, so a calendar that imports both keeps one
entry. If the T-10 job has not yet run, it is cancelled and nothing else needs
undoing.

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
        availability_mask, availability_preset, eligible_at,
        welcome, last_welcome_at,
        needs_ack, checkins_ignored, checkin_sent_at, overlap_notice_at,
        joined_at,
        PRIMARY KEY(guild_id, discord_user_id))
pairings(id PK, guild_id, thread_id, voice_channel_id, state, novelty,
         created_at)   -- novelty: fresh | held | reconnect | welcome | forced
pairing_members(guild_id, pairing_id, discord_user_id, last_activity_at)
proposals(id PK, guild_id, pairing_id, start_utc, duration_min, state,
          proposed_by, created_at)
confirmations(guild_id, proposal_id, discord_user_id, confirmed_at)
outcomes(guild_id, pairing_id, discord_user_id, connected, answered_at)
jobs(id PK, guild_id, kind, ref_id, run_at, state, created_at)
```

There is no `rounds` table (#15). `members.eligible_at` is the entire cadence
model. `pairings.novelty` records how the pairing was produced
(`fresh | held | reconnect | welcome | forced`), because the share of
reconnections over time is the number that says the pool needs to grow, and the
share of welcomes says whether launch-week demand outran the pool. `welcome` and
`last_welcome_at` are the volunteer flag and its seven-day throttle (#17).
`overlap_notice_at` is when a member whose mask overlaps nobody's was last told
so; "told once" needs a record (#21). `pairing_members.last_activity_at` is when
that member last posted in the pairing thread, never what they posted: a thread
post counts as evidence in §4a, and §5 sends a released pairing to follow-up
only if someone posted (#21).

`members.state` is one of `active | paused`. A member who leaves is deleted, not
flagged, so `/forget` is a real deletion. `needs_ack` and `checkins_ignored`
are the hygiene fields from §4a; `checkin_sent_at` is the most recent check-in, used
to detect the one-cadence expiry.

`availability_mask` is 168 characters of `0` or `1`, index 0 being Monday 00:00
in the member's local time. A packed representation would be 21 bytes instead of
168, which is not a saving worth making: the readable form can be inspected in a
database client without tooling, and debugging a scheduling complaint is much
likelier than running out of disk.

`outcomes.connected` is true for Yes and false for Not yet. The distinction from
"No" lives in the copy, not the column; nothing in v1 treats a Not yet as a
refusal.

**Durable scheduling.** Every time-based action is a row in `jobs` with a
`run_at`, and a single ticker polls for what is due. Holding-window expiry,
novelty-hold expiry, negotiation release at 48h, channel creation at T-10,
channel deletion at T+60, follow-up at T+24h or release+7d, check-in send at
`eligible_at`, check-in expiry at one cadence, thread archival. Not
in-process timers. This survives a restart, it scales from one guild to a
thousand unchanged, and it makes every deferred action inspectable in one table.
Correctness first, scale as a side effect.

## 7. Discord surface

**Member commands.**

- `/join` with options `timezone` (required, autocomplete), `interests`
  (optional text, build 2), `avoid` (optional text). Re-running it with any option
  updates just that option; a paused member running it is resumed. The
  confirmation says roughly when to expect the first introduction, states the
  default availability, names `/availability`, and states what the follow-up
  answer is used for (§9).
- `/timezone`, `/availability`, `/welcome on|off` (build 2, #19), `/pause`,
  `/resume`, `/forget`.

**Admin commands:** `/matchbook config`, `/matchbook status` (pool, holds,
upcoming calls, reconnection share), `/matchbook pair <a> <b>` (force one; refused if the pair is infeasible).

**Permissions requested:** View Channels, Send Messages, Create Private Threads,
Send Messages in Threads, Manage Threads, Manage Channels, Connect. The README
explains each in one line.

- Connect is requested because the bot can only grant the pair permissions it
  holds itself, and it grants Connect on the private voice channel.
- Permission overwrites are set in the channel create call, which Manage
  Channels permits ("only permissions your bot has in the guild can be
  allowed/denied"). The bot never edits overwrites on an existing channel,
  which would require Manage Roles.
- Not requested: Move Members, Mute Members, Manage Events, Manage Roles.
  Matchbook never relocates a person and never creates a Discord event (#14).

**Why private threads rather than DMs.** Discord members can block DMs from
people they have not friended, which is precisely the case a first introduction
hits. A private thread is deliverable, gives both people a shared space so
neither has to enter the other's inbox, carries the bot's framing above the
conversation, and gives the follow-up somewhere natural to land. Threads are
created under the parent text channel named in config.

## 8. Testing

Test-driven, concentrated on the pure core.

**Matching properties** (not example tests): nobody is ever paired with
themselves; nobody appears in two open pairings at once; no pairing is ever
formed between two members with empty projected overlap; given a stranger with
no shared hours and a recent repeat with full overlap, the repeat is chosen
(#16); while any never-paired feasible combination is available in the pool, no
fresh-eligible member is given a repeat;
`score(a,b) === score(b,a)` for every bundled strategy; composed weights always
produce a value in 0..1; a strategy's `Context` contains exactly its declared
signals and nothing else; the greedy matcher's total score is measured against
brute-force optimal on every fixture of ten or fewer members and the gap is
reported.

**Eligibility**, against an injected clock: a newcomer is paired within the
holding window whenever anyone else feasible is eligible; the novelty rule takes
precedence over the holding window; a member alone past the window
pulls the soonest-eligible member forward by no more than the limit; a newcomer
alone past the window with no member within the pull-forward limit is paired
with a welcomer, whose `eligible_at` does not move and who is not welcomed
again within seven days; a newcomer with no welcomer and nobody in reach waits; no member is
paired sooner than cadence minus the pull-forward limit after their last
pairing, except as a welcomer; a welcomer with an open pairing is never chosen; a member with an unmet active member somewhere is held rather than
repeated, for no longer than one cadence; a member who has met everyone is paired
with their least-recent partner without holding; a synchronized twelve-member
cohort is spread across the period within three cycles of simulated newcomers,
**provided newcomers arrive slowly enough that a lone newcomer's holding window
lands within the pull-forward limit of a cohort date** (#20). Measured
2026-09-14: one newcomer every 5 days leaves the twelve on 4 distinct eligible
dates; one every day leaves them on 1, because newcomers pair with each other
before any cohort member is in reach. Build 1 pins the 5-day case (at least 3
distinct dates).

**Jobs**: every job kind fires at most once, at or after its `run_at`, never
after cancellation, and survives a simulated restart between scheduling and firing. No test sleeps.

**Scheduling** state machine is exhaustively tested over its transition table,
including every release entry (48h from either negotiating state; overlap lost
after a timezone change from either negotiating state), the voided confirmation
on a counter, the negotiation limit, the locked-to-proposed re-propose path, and both
follow-up triggers.

**Availability**: mask intersection is commutative; a member on `Any reasonable
hour` never constrains a pair beyond 09:00-21:00; a member whose mask overlaps nobody's,
empty or not, is never paired and is told once; changing timezone moves the projected
UTC hours by exactly the offset delta and leaves the stored local mask untouched;
the `schedulable` score equals shared hours over 168 and stays in 0..1; a new
member's mask equals the default preset.

**Enrollment hygiene**: any of the evidence types clears `needs_ack`; a
partner's Yes clears it for both members while a partner's Not yet clears it for
neither; a member with `needs_ack` is never in the pool and is asked exactly
once when eligible; `Keep me in` puts them in the pool immediately; one ignored
check-in never auto-pauses; two does; a paused member is never in the pool;
`/resume` and `/join` are equivalent for a paused member and both restore
history intact; returning clears `needs_ack`, zeroes `checkins_ignored` and sets `eligible_at`
to the later of now and last pairing plus cadence; a
forgotten member who rejoins starts with no history at all.

**End to end** runs a simulated month against a fake Discord adapter and a
synthetic 20-member fixture guild, with no network.

**Build 1 scope (#19):** the matching properties that concern feasibility and
`round-robin`, all of eligibility except the welcome pool, jobs, the whole
scheduling machine, availability, hygiene, and end to end. The scorer
properties (symmetry, weight normalization, `Context` contents, greedy vs
optimal) and the welcome-pool cases are build 2 and are written against the
interface before build 1 ships, so that build 2 is adding implementations, not
tests.

The real Discord adapter stays thin enough to verify by using it.

## 9. Privacy and consent

Stored: Discord user ID, opt-in state, timezone, self-declared tags and
avoid-notes, a weekly availability pattern, an eligibility date, pairing
history, proposed and confirmed times, one answer per member per pairing to "did
you two connect," a hygiene flag, counter and timestamp, a welcome-volunteer
flag and its last-use date, the chosen availability preset, a join date, the
date a member was told nobody shares their hours, and the time of a member's
last post in a pairing thread (not its content). That is the entire schema.

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

**What data is allowed to decide (#6).** Each strategy declares the signals it
reads (§4, `reads`). A signal collected for one stated purpose is not read for
another without a sentence in `/join` saying so. The follow-up answer is the
live example: it is a metric, it is evidence in the hygiene ladder, and it is an
input to `never-met`, and `/join` says all three in one line: "When I ask
whether you connected, your answer counts toward your stats, tells me you're
still active, and helps me avoid re-pairing people who already met." A future
strategy that wants to read it for a fourth purpose changes that sentence first.

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

Public repo at `Publicly-Traded-Person/matchbook`, credited to KmikeyM (#7). An
earlier draft argued for Quarterly Systems branding on the grounds that a
general tool reads strangely wearing one person's ticker; Mike reversed that.
The README tells the story as KmikeyM's because it is, and the tool being general
does not make its builder anonymous.

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

Not announced as a program. One message in `#chatter` and a permanent line in
the channel topic. The first members to join are paired with each other within
the holding window, so the first introductions happen the first day. The
welcome pool (#17) is build 2, so in build 1 a late joiner may wait on a cohort
that all paired at once; if that happens in the first week, it is the trigger
named in §3 for pulling the pool into build 1. Once it ships, ask two or three
people who said yes early to run `/welcome on`.

Standing evidence as of 2026-09-12: within minutes of the idea being raised in
chat, one member said they would participate outright and a second said they
would be interested in a shareholder activity that is not poker. Two data points,
same day. The second is the more interesting one: demand for a live thing from
someone the existing ritual does not reach.

**The reported metrics are completion rate and reconnection share, not
signups.** Match count is vanity. If eight people opt in and two calls actually
happen, that is the finding. When reconnections start appearing, the pool needs
new members, and that is a recruitment brief handed over by the data.

**The first pairings are round-robin (#19).** Build 1 runs no ranking scorer, only `round-robin`, so early
pairings are the next feasible stranger in rotation. That is not the model
working, and it is not meant to be: it is the loop being measured. Build 2's
scorers get turned on once there are follow-up answers to learn from and a
completion rate to compare against. Say this out loud rather than let an early
pairing look like a bug.

## 13. Where the open items live

None blocking. They are in the issue tracker, not here, so this document does
not hold a second copy that drifts:

- Decisions already folded in and still arguable: label
  [`decision`](https://github.com/Publicly-Traded-Person/matchbook/issues?q=label%3Adecision).
  #3 is closed, superseded by #14. #12 and #13 are closed, resolved from
  Discord's documentation.
- Undecided, revisit after the first pairings: label
  [`question`](https://github.com/Publicly-Traded-Person/matchbook/issues?q=label%3Aquestion)
  (#8 call length, #10 updating a "Not yet", #11 the two-week-completion
  hypothesis).
- Assumptions the first build must confirm: label
  [`verify`](https://github.com/Publicly-Traded-Person/matchbook/issues?q=label%3Averify).
  None open at the time of writing.
