# 🔥 Matchbook

A Discord bot that introduces two people and then schedules the call.

**Status: build 1 is in the tree.** It joins people, pairs them by rotation,
proposes a time, opens the room and follows up. The scorers of build 2 are not
written yet, so the default weighting is `round-robin` alone. The design is
still the thing to argue with, and it is ahead of the code: read the spec,
**[`docs/design.md`](docs/design.md)**, then the [Quickstart](#quickstart) if
you want to run it. If you have opinions, open an issue. Decisions already
folded into it are filed as issues labelled
[`decision`](https://github.com/Publicly-Traded-Person/matchbook/issues?q=label%3Adecision),
one each, so you can argue with one without diffing the whole document. How
changes land: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Where this came from

Dialup was an app by Max Hawkins and Danielle Baskin. It phoned you out of the
blue and connected you at random to someone else in your group. We had nothing to
do with building it. We were customers.

What we did was vote. In June 2019 KmikeyM shareholders passed
[a vote to start a weekly KmikeyM line on it](https://kmikeym.com/questions/146),
62% yes, which is a narrow margin around here. Then it worked. Shareholders who
had only ever seen each other's usernames on a trade ended up on the phone
together.

It ran until Dialup shut down as a service. Nobody did anything wrong. The thing
simply stopped existing, and a piece of how this market's shareholders knew each
other went with it.

At the September 2026 shareholder poker game, somebody brought up Dialup again,
and somebody else mentioned that Slack has a "donut" feature that pairs coworkers
for coffee. That is the whole origin. We want the 2019 thing back, on Discord,
where the shareholders actually are now.

There are existing bots that do a version of this. We looked at the closest one
and it is competently built. We are building our own anyway, for two reasons. The
first is that we want to tune the matching on things only we know: who voted
against each other, who has held for a decade, who bought their first share last
week. No general-purpose bot can do that, because no general-purpose bot knows
what a shareholder is. The second is the 2019 lesson. If this becomes part of how
shareholders know each other, it should not be something a stranger can switch
off.

But that is an argument for owning it, not for hoarding it. So it is AGPL and it
is public from the design document forward. If your community wants a version of
this, take it. If you want to watch a thing get built and tell us where it is
wrong, that is what the issues tab is for.

## The idea

Tools in this category match people on a single bit of information: have these
two met before. That is not an engineering limitation, it is a data limitation. A
general bot knows nothing about a community's members beyond a username and some
roles, so meeting history is the only signal available to it.

Matchbook replaces the bit with a score. A matching strategy answers one question,
"how good would a pairing of A and B be," as a number between 0 and 1, and
strategies compose as a weighted sum you configure per server. Meeting history
ships as the boring default. A community with its own structured data writes its
own scorer against a documented interface, keeps it private if it wants to, and
never touches the matcher. Ours will read the market. Yours will read whatever
you have.

The second idea is smaller and probably matters more day to day. Matchbook
schedules the call. An introduction arrives with a proposed time already in it,
either person can change it, and once both confirm they get a calendar file and a
private voice channel that opens itself ten minutes early. "Sort out a time
between you" looks like politeness and functions as an obstacle. Dialup understood
this. It just called you.

The two ideas meet in one place. You tell Matchbook when not to bother you, as a
weekly pattern in your own local time. Two people who share no hours are never
paired, because a pairing that cannot become a call is not a pairing. Among
people who can meet, availability is a scorer: someone who is only free on
weekend mornings does not get excluded, they get paired with whoever else is
free on weekend mornings. The first build pairs by rotation; the scorers switch
on once there are outcomes to compare against.

And there is no pairing day. You join, and within about a day you have someone
to talk to, as long as someone is free to meet you. After that, at most one introduction every two weeks, measured from your
last one, not from a calendar. When the only people left are ones you have
already met, Matchbook waits for a stranger if one exists, and reconnects you
with an old partner if none does. It tells you which.

## How it differs from what exists

|  | Typical coffee-chat bot | Matchbook |
|---|---|---|
| Model | Scheduled group voice event, or a DM and good luck | One introduction, one scheduled 1:1 call |
| Matching input | Meeting history, a boolean | Composable numeric scorers |
| Scheduling | Fixed hour, attend or miss it | Proposed time per pair, negotiable, .ics issued |
| Delivery | A voice lobby (event bots) or a DM (Donut-style) | Private thread, because DMs between strangers can be blocked |
| Source | Usually closed | AGPL-3.0 |

One caveat on that table: the left column blends the one bot we studied closely
with what we know of the Donut model secondhand. We have not surveyed the
category. If your favorite already solves something in the right-hand column,
tell us and we will fix the table.

## What feedback would actually help

Vague approval is not useful. These are the decisions most likely to be wrong:

1. **Is the scoring interface the right shape?** `score(a, b, ctx) => 0..1`,
   symmetric, composed as a weighted sum. Is there a matching rule you would want
   that cannot be expressed this way? Hard constraints ("never pair these two")
   and group-level rules are the suspected gaps. Shared availability already
   turned out to be one: it is a precondition outside the score (#16).
2. **Greedy matching instead of Blossom.** The pool at any moment is whoever is
   eligible right now, usually a handful, so greedy and optimal agree. The test
   suite measures the gap against brute force anyway. Is there a pool size or
   shape where that stops being true?
3. **The negotiation limit is one counter-proposal per side**, then the pairing
   releases and the two people are left to their own devices. Too strict?
4. **Availability is a standing weekly pattern plus a declared timezone, not a
   per-pairing poll.** The alternative, a grid of candidate slots each person
   marks for every introduction, is more accurate and never goes stale, but
   costs five extra taps every time. Wrong trade?
5. **Rolling pairing instead of a weekly batch.** A newcomer is paired within
   about a day when someone feasible is eligible, rather than waiting for a
   pairing day, at the cost of the matcher
   only ever seeing the handful of people eligible right now instead of the
   whole pool. Fine at twelve members and at two hundred; is it fine at fifty?
6. **One silent pairing and you are asked before the next one, with a
   partner's confirmation counting as evidence you attended.** Standing
   enrollment fills with ghosts because ignoring a bot is easier than telling it
   no. But someone who does every call and never taps a button is not a ghost,
   and their partner's "yes we met" proves it. Is that the right evidence test,
   and is one tap after a silent pairing the right price?
7. **Two weeks between introductions by default, and wait-for-a-stranger over
   repeat.** With `n` members you have met everyone after `n-1` introductions,
   so a twelve-person server on a weekly gap runs out of strangers in under
   three months. When it does, Matchbook reconnects you with your least-recent
   partner and says so. Right gap, right rule?
8. **Availability is hourly, as a 168-bit weekly mask.** No half-hours, no
   one-off exceptions, no real calendar. Is hourly granularity enough, and is a
   recurring weekly pattern the right model for how people are actually busy?
9. **Self-hosting story.** Clone, edit one TOML file, `docker compose up`. If you
   would not run this, say what stops you.

## Quickstart

Four commands and one file to edit. Budget ten minutes, most of it spent in the
Discord developer portal making a bot account.

```sh
git clone https://github.com/Publicly-Traded-Person/matchbook
cd matchbook
cp config.example.toml config.toml
$EDITOR config.toml
export DISCORD_TOKEN=...
docker compose up
```

`config.toml` is the only file you edit. It wants your guild id, the text
channel pairing threads are created under, and the category the private voice
channels go in. Everything else has a default.

`DISCORD_TOKEN` is the bot token from the Discord developer portal. It stays in
your environment, never in the config file, and the container reads it from
there.

To get the bot into your server, run:

```sh
bun run src/main.ts --check-config config.toml
```

It validates the config and prints the invite URL with exactly the permissions
listed below, so you can read the scopes before you click. Then `docker compose
up` again, or `docker compose up -d` once you are happy.

The database is written to `./data/matchbook.db`, bind mounted into the
container at `/app/data`, so it survives a rebuild. Set `MATCHBOOK_DB` if you
want it somewhere else.

## Permissions

Seven, and this is what each one is for:

- **View Channels**: read the channel pairing threads are created under, and see the voice category.
- **Send Messages**: post the introduction and the follow up in that channel.
- **Create Private Threads**: each pairing gets its own thread, visible only to the two people in it.
- **Send Messages in Threads**: everything after the introduction happens in the thread.
- **Manage Threads**: archive a thread when the pairing is done or expired.
- **Manage Channels**: create the private voice channel ten minutes before the call and delete it after. Its member overwrites are set in the create call itself, which is a Manage Channels operation.
- **Connect**: a bot can only grant a permission it holds itself, so it needs Connect in order to give the pair Connect on their own room.

Not requested: Move Members, Mute Members, Manage Events and Manage Roles. Matchbook never drags anyone into a channel, never touches anyone's microphone, creates no server events, and assigns no roles. If you see it ask for one of those, something is wrong.

## Writing a scorer

A matching strategy answers one question, "how good would a pairing of A and B
be," as a number between 0 and 1. The interface is in
[`src/types.ts`](src/types.ts):

```ts
export interface Participant {
  readonly id: MemberId
  readonly timezone: string // IANA zone id
  readonly mask: Mask // 168 chars of '0' | '1', index 0 is Monday 00:00 local
  readonly tags: readonly string[]
  readonly avoid: readonly MemberId[]
  readonly joinedAt: number
  readonly eligibleAt: number
}

export interface Strategy<R extends Signal = Signal> {
  readonly name: string
  /** Every signal this strategy reads. Enforced by the Context it is handed. */
  readonly reads: readonly R[]
  /** 0..1, higher is a better pairing. Must be symmetric. */
  score(a: Participant, b: Participant, ctx: Context<R>): number
}
```

`reads` is a declaration, not documentation. A strategy lists the signals it
wants, and the `Context` it is handed at call time is a `Pick` of exactly those,
so reading a signal you did not declare is a type error rather than a surprise
in production. The available signals are `pairing-history`, `follow-up`, `tags`,
`availability` and `timezone`.

Build 1 ships one strategy, `round-robin`, which scores by how long ago the two
last met and is the default weighting. Build 2 adds the rest of the scorers,
availability overlap and tag affinity among them, composed as a weighted sum you
configure per server. Your own scorer is a file that exports one `Strategy` and
a weight in `config.toml`. It can stay private, and the matcher does not change.

## License

AGPL-3.0. Self-host it freely. If you run a modified version as a service to
other people, publish your changes.

Built by [KmikeyM](https://kmikeym.com).
