# Matchbook: Design Spec

**Date:** 2026-09-12
**Author:** Charlie (The Investor Relations)
**Status:** 🟡 PENDING Mike's review
**Repo:** `Publicly-Traded-Person/matchbook`, public, AGPL-3.0

---

## 1. The claim

Every Donut-style tool matches people on a single bit of information: have these
two met before. That is not an engineering limitation, it is a data limitation.
A generic bot knows nothing about a community's members except their username
and their roles, so meeting history is the only signal available to it.

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
and it is competent. It was reviewed on 2026-09-12. Differences that matter:

| | CoffeeChat Bot | Matchbook |
|---|---|---|
| Model | Synchronous mass voice event, rounds | Asynchronous pairing, one scheduled 1:1 call |
| Matching input | Meeting history (boolean) | Composable scorers (numeric) |
| Scheduling | Fixed event time, attend or miss it | Proposed time per pair, negotiable, .ics issued |
| Source | Closed | AGPL-3.0 |
| Permissions | Manage Channels, Move Members, Manage Events | Manage Channels, Manage Threads, Manage Events. Never moves anyone |
| Pricing | Not published | Free to self-host |

The synchronous model needs a quorum to not feel sad and excludes anyone who
cannot be present at one fixed hour. The KmikeyM Discord is asynchronous, spread
across timezones, and has exactly one working synchronous ritual already (poker).

## 3. Scope

### In, v1

- Standing opt-in, pause, resume, forget via slash commands
- Auto-pause after two silent pairings, with one check-in first
- Recurring pairing rounds on a configured cadence
- Scored matching with three bundled strategies and weighted composition
- Private thread per pairing
- Per-member weekly availability (presets plus a custom editor)
- Proposed meeting time drawn from real mutual availability, negotiation, lock-in
- .ics generation, Discord scheduled event, temporary private voice channel
- Single follow-up ("did you two connect?") feeding outcome data back into scoring
- SQLite storage behind an interface, every row scoped by `guild_id`
- Docker Compose deployment, config file, no build step required of an adopter

### Out, v1 (deliberate)

- Voice *rounds* / speed-networking (rejected model, not deferred)
- Web dashboard
- Billing or any hosted-service surface
- Identity link to kmikeym.com, and therefore any market-data matching
- Any LLM in the matching path
- Free-text time parsing (selection from offered slots only)
- Group sizes beyond 2, except one group of 3 when the count is odd
- Calendar integration (reading real free/busy from Google Calendar or an .ics
  subscription). The weekly availability mask is in; live calendar access is not,
  because it costs OAuth, per-provider integrations, a genuine privacy surface,
  and it makes a self-hoster obtain API credentials to run a coffee bot.

### Explicitly deferred, with a known home

- `guild_id` on every row and config behind an interface make multi-tenancy a
  configuration change rather than a migration. See §10.
- The KmikeyM market-data strategy lives in a separate private module that
  registers against the strategy interface. It never enters this repo. See §9.

## 4. Architecture

Six units. The first three import nothing platform-specific and are where the
tests concentrate.

**`core/matching`**: pure. `match(participants, history, strategy, opts) => Round`.
No IO, no clock, no Discord.

**`core/strategies`** is the extension point:

```ts
interface Strategy {
  readonly name: string
  /** 0..1, higher is a better pairing. Must be symmetric: score(a,b) === score(b,a). */
  score(a: Participant, b: Participant, ctx: Context): number
}
```

Bundled: `never-met` (1 if never paired, decaying toward 0 with recency of last
pairing), `interest-overlap` (Jaccard similarity over self-declared tags),
`schedulable` (share of the week both members are actually available, see §5),
`round-robin` (deterministic rotation, ignores everything else).

`schedulable` is the clearest argument for scoring over a boolean. Availability
could have been a filter applied after matching, which would exclude constrained
members from rounds. As a scorer it does the opposite: it steers someone with
narrow availability toward a partner they can genuinely meet, while the matcher's
guarantee that everyone appears exactly once per round means narrow availability
never benches anybody.

Composition is a weighted sum from config, normalized to 0..1:
`never-met * 0.7 + interest-overlap * 0.3`.

**`core/rounds`**: cadence and lifecycle. Who is eligible, when the next round
is due, which pairings have expired. Takes an injected clock.

**`adapters/discord`**: the only unit importing a Discord library. Slash
commands, thread creation, voice channel lifecycle, scheduled events, message
delivery. Thin by design.

**`storage`**: interface plus a SQLite implementation. Generic SQL only, no
SQLite-specific features, so a Postgres adapter is a swap rather than a rewrite.

**`config`**: `ConfigStore` interface with `FileConfigStore` (TOML on disk,
what self-hosters use) and, later, `DbConfigStore` (per-guild rows, what a
hosted service needs). All user-facing copy lives here as templates so nobody
forks the repo to change the bot's voice.

### The matcher

Optimal maximum-weight matching is the Blossom algorithm, which is genuinely
fiddly. At the scale this tool targets (under ~50 participants per round), a
greedy pass with randomized restarts (200 iterations, keep the highest total
score) lands within a few percent of optimal in ~40 lines. Ship greedy, document
the tradeoff in the README, keep the matcher behind an interface so anyone who
outgrows it can substitute Blossom without touching strategies.

Odd participant count: match on n-1, then attach the unmatched participant to
whichever existing pair yields the highest mean score, forming one group of
three. Nobody is ever benched, and the triad is not told it is the remainder.

## 4a. Enrollment and hygiene

**Enrollment is standing.** `/join` once and you are in every round until you
`/pause`. No weekly opt-in, no renewal step, no recurring ask. This matches how
the 2019 Dialup line worked and it is the entire ergonomic premise: the tool
should cost nothing after the first thirty seconds.

**Standing enrollment has one failure mode and it is fatal if ignored.** People
opt in at peak enthusiasm. Weeks later, someone who no longer wants introductions
will not type `/pause`, because ignoring a bot is easier than telling it no. They
go quiet instead. A listed-but-absent member is worse than a departed one: every
round they are matched, they burn a real participant's entire turn. A pool of
nominally-active ghosts looks healthy in the numbers right up until nobody is
meeting anybody.

**So the bot declines to assume consent it has not seen evidence for.** After two
consecutive pairings with no message in the thread and no follow-up answer, it
sends one DM:

> You've been matched twice without a reply. Want to stay in?
> `[ Keep me in ]`  `[ Pause me ]`

No answer within seven days auto-pauses them. `/resume` restores standing
enrollment with history intact. The check-in fires at most once per silent
streak, never on a schedule, and a single reply resets the streak to zero.

This is hygiene, not enforcement. It costs one counter on the member row and
reuses the outcome data already collected in §5.

**Cadence and pool size.** With `n` participants a round consumes `n/2` pairings
and `n(n-1)/2` distinct pairs exist, so novel pairings exhaust in `n-1` rounds.
Twelve members running weekly exhaust in eleven weeks, after which `never-met`
has nothing left to distinguish and the bot reads to members as getting worse.

**The shipped default is therefore biweekly, not weekly.** It doubles the runway
at half the ask, and it compounds: the scoring model needs accumulated outcomes
to beat random, and biweekly rounds with high completion teach it faster than
weekly rounds where half the pairings ghost. Cadence is per-server config and the
README documents the `n-1` arithmetic so an adopter with 200 members knows to
turn it up.

## 5. Scheduling model

Pairing state machine:

```
created
  -> time_proposed        (bot proposes a slot, posts thread)
  -> one_confirmed        (first "Works for me")
  -> locked               (both confirmed; .ics + event + channel scheduled)
  -> completed            (follow-up answered, or 7 days after the call)

  -> released             (48h with no lock: thread stays, bot steps back)
  -> expired              (no activity at all, archive quietly)
```

**Availability.** A week is 168 hours, so each member's availability is a 168-bit
weekly mask at hourly granularity, index 0 being Monday 00:00 in their own local
time. Finding when two people can meet is a bitwise AND. It is instant, it is a
few dozen bytes on the member row, and it replaces the hardcoded civil-hours
window rather than supplementing it.

**The mask is stored as local intent and projected to UTC at match time.** Storing
UTC directly would leave a member's "weekdays 9 to 5" sitting on the wrong hours
the moment they change timezone. Storing the local weekly pattern alongside the
timezone means the blackout travels with them automatically, which is the only
behavior anyone would expect from a declaration like "not during my workday."

**Entering it must not involve parsing English**, for the same reason free-text
time entry was rejected. `/availability` offers four presets covering most
people, `Weekdays 9 to 5` / `Evenings only` / `Weekends only` / `Anytime is fine`,
plus a custom path that is two Discord select menus, days and then hours. The
chosen preset is remembered so reopening the menu shows current state.

**Slot proposal.** AND the two masks, project to UTC, and take candidate
30-minute slots in the next 3 to 10 days that fall inside the shared hours,
preferring evenings local to both. Propose one. On "Pick another time", offer up
to five alternatives from the same shared set as a select menu. Calls are 30
minutes and the mask is hourly, so proposals land on the hour.

**Empty overlap** is a real outcome, not an error. A pairing with no shared hours
falls through to the `released` path below, and the message says why rather than
merely stepping back: no time works for both of you, the thread is yours.

**Negotiation limit.** Each side gets one counter-proposal. After two rounds the
pairing releases rather than continuing to negotiate. Two rounds is generous;
three is a tool being annoying.

**Timezones are mandatory**, captured at `/join`. Without them the bot will
confidently propose 3am to someone. Display uses Discord's `<t:epoch:F>` markdown,
which every client renders in the viewer's own local timezone at no cost to us.

**Changing timezone.** `/timezone <zone>` updates it immediately, and re-running
`/join` opens the same modal pre-filled and acts as an edit rather than erroring
or duplicating the member. Two paths to the same place, because people will guess
either one. This is not an edge case. Members travel, and a stale timezone is
worse than no timezone: it makes the bot confidently wrong rather than merely
uninformed.

**A timezone change never rewrites a locked call.** All times are stored in UTC
and rendered with local-timezone markdown, so a call locked for Thursday 19:00
Pacific stays at the same absolute moment and simply displays as Friday 04:00
once that member has crossed nine timezones. The .ics is UTC and their calendar app does the
same thing unaided. What two people agreed to was a moment, not a clock reading.

**But the bot notices when the moment became a bad one.** If a member's timezone
changes and they have a locked call that now falls outside civil hours (the same
09:00-21:00 window used for proposal), the bot posts once in that thread offering
`[ Keep it ]` or `[ Suggest a new time ]`, actionable by either person. This
reuses the negotiation machinery above and adds no new states.

**Rejected alternative: no stored timezone.** Offer both members a grid of
candidate slots rendered in their own local time and take the overlap. More
accurate than any stored timezone and it never goes stale, but it replaces one
tap with six, which reintroduces exactly the coordination burden this feature
exists to remove.

**On lock:** create a Discord scheduled event (gives native reminders for free),
generate and post an .ics (DTSTART, DTEND, SUMMARY, DESCRIPTION, LOCATION, UID,
ORGANIZER, ATTENDEE; LOCATION is the voice channel URL), and schedule the channel
to open 10 minutes before start and delete 60 minutes after end.

**Graceful degradation is a feature, not an error path.** A released pairing
falls back to exactly the behavior of a scheduling-free tool: the thread exists,
both people are in it, the bot says the time is theirs to arrange and steps back.

## 6. Data model

Every table carries `guild_id` from the first migration. Retrofitting a tenant
column into live data is a painful migration; adding it now costs one word.

```
guilds(guild_id PK, created_at)
members(guild_id, discord_user_id, state, timezone, tags, avoid_notes,
        availability_mask, availability_preset,
        silent_streak, checkin_sent_at, joined_at,
        PRIMARY KEY(guild_id, discord_user_id))
rounds(id PK, guild_id, scheduled_for, state, created_at)
pairings(id PK, guild_id, round_id, thread_id, state, created_at)
pairing_members(pairing_id, discord_user_id)
proposals(id PK, pairing_id, start_utc, duration_min, state, proposed_by, created_at)
confirmations(proposal_id, discord_user_id, confirmed_at)
outcomes(pairing_id, discord_user_id, connected, answered_at)
```

`members.state` is one of `active | paused`. A member who leaves is deleted, not
flagged, so `/forget` is a real deletion. `silent_streak` counts consecutive
pairings with no thread message and no follow-up answer; any reply resets it to
zero, and reaching two triggers the check-in described in §4a.

`availability_mask` is 168 characters of `0` or `1`, index 0 being Monday 00:00
in the member's local time. A packed representation would be 21 bytes instead of
168, which is not a saving worth making: the readable form can be inspected in a
database client without tooling, and debugging a scheduling complaint is much
likelier than running out of disk.

**Durable scheduling.** Rounds are rows with a `next_run_at` and a ticker polls
for what is due. Not an in-process timer. This survives a restart, and it scales
from one guild to a thousand unchanged. Correctness first, scale as a side effect.

## 7. Discord surface

**Member commands:** `/join` (modal: timezone, optional interests, optional
avoid-notes; re-running it edits rather than duplicates), `/timezone`,
`/availability`, `/pause`, `/resume`, `/forget`.

**Admin commands:** `/matchbook config`, `/matchbook run` (trigger a round now),
`/matchbook status`.

**Permissions requested:** View Channels, Send Messages, Create Private Threads,
Send Messages in Threads, Manage Threads, Manage Channels, Manage Events. The
README explains each in one line. Notably absent: Move Members. Matchbook never
relocates a person, which is a lighter ask than the synchronous alternatives.

**Why private threads rather than DMs.** Discord members can block DMs from
people they have not friended, which is precisely the case a first introduction
hits. A private thread is deliverable, gives both people a shared space so
neither has to enter the other's inbox, carries the bot's framing above the
conversation, and gives the follow-up somewhere natural to land.

## 8. Testing

Test-driven, concentrated on the pure core.

**Matching properties** (not example tests): nobody is ever paired with
themselves; every participant appears exactly once per round; an odd count yields
exactly one group of three and no other group of three; repeat pairings strictly
decrease as history accumulates; `score(a,b) === score(b,a)` for every bundled
strategy; composed weights always produce a value in 0..1.

**Rounds** run against an injected clock. No test sleeps.

**Scheduling** state machine is exhaustively tested over its transition table,
including both release paths and the negotiation limit.

**Availability**: mask intersection is commutative; a member marked available
everywhere never constrains a pair; a member marked available nowhere always
produces the empty-overlap path; changing timezone moves the projected UTC hours
by exactly the offset delta and leaves the stored local mask untouched; the
`schedulable` score equals shared hours over 168 and stays in 0..1.

**Enrollment hygiene**: a single reply resets the streak; the check-in fires at
most once per streak; seven days of silence after a check-in auto-pauses; a
paused member never appears in a round; `/resume` restores history intact.

**End to end** runs a full round against a fake Discord adapter and a synthetic
20-member fixture guild, with no network.

The real Discord adapter stays thin enough to verify by using it.

## 9. Privacy and consent

Stored: Discord user ID, opt-in state, timezone, self-declared tags and
avoid-notes, pairing history, proposed and confirmed times, and one yes/no per
pairing. That is the entire schema.

Never stored: message content, voice, or anything from an operator's private
knowledge base.

`/forget` deletes the member row, their pairing memberships, their confirmations
and their outcomes. The bot says so plainly rather than claiming it deactivated
them.

**Disclosure boundary.** In v1 a pairing message discloses nothing a member has
not already made public by being in the server. That property is what keeps
Matchbook out of Sensitive Content territory, and it is the thing to protect when
smarter strategies arrive. "You two voted opposite ways on vote 187" is an
appealing match reason and also a disclosure of two people's votes to each other.
That is a consent question, not a feature question. When market data enters
scoring, `/join` gains an explicit sentence about what is used, and that is a
change to the consent, not to the copy.

The future KmikeyM strategy reads through an existing read-only market-data
service. It never touches the contact records, and it never ships in this repo.

## 10. Multi-tenancy and a possible hosted service

Discord bots are natively multi-tenant: one application, one token, many guilds,
one gateway connection. Nothing here fights that. Four decisions taken now keep a
paid hosted service a configuration change rather than a rewrite:

1. `guild_id` on every row from the first migration (§6)
2. Config behind `ConfigStore`, file-backed now, database-backed later (§4)
3. Durable `next_run_at` scheduling rather than in-process timers (§6)
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

Public repo at `Publicly-Traded-Person/matchbook`, branded Quarterly Systems in
the README rather than KmikeyM, since a general-purpose tool reads strangely to a
stranger when it wears one person's ticker.

**AGPL-3.0.** Self-host freely; run a modified version as a network service to
other people and you publish your changes. This keeps the tool genuinely free for
self-hosters while making it unattractive to wrap and resell as closed SaaS. The
license must be set before the first public commit: relicensing later requires
consent from every contributor by then.

The shipped code, the README and the configuration contain no mention of
KmikeyM, shares, or votes. This design document is the exception: it explains
where the idea came from and what the private strategy will need from the
interface, which is context a reviewer needs and an adopter can ignore.

### README first section

A working bot in under ten minutes, and honest about the number:

```
git clone https://github.com/Publicly-Traded-Person/matchbook
cp config.example.toml config.toml   # guild id, cadence, strategy weights
export DISCORD_TOKEN=...
docker compose up
```

Above it: the invite link with exact scopes, one line per permission explaining
why. Below it: the strategy interface documented in about fifteen lines, because
writing a scorer for your own community is the reason to choose this over the
closed alternative.

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

**Round one is honestly random.** With no history, `never-met` scores every pair
identically. The model gets meaningfully better around round three and good once
outcomes accumulate. Say this out loud rather than let the first pairing look
like a bug.

## 13. Open questions

None blocking. Two to revisit after the first three rounds:

1. Whether 30 minutes is the right default call length, or 20.
2. Whether the follow-up should also fire for `released` pairings, which would
   measure how often the fallback still produces a conversation.
