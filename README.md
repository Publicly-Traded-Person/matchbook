# Matchbook

A Discord bot that introduces two people and then schedules the call.

**Status: design spec only. There is no code yet.** This repository exists so the
design can be argued with before anything gets built. If you have opinions, open
an issue. Read the spec: **[`docs/design.md`](docs/design.md)**

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
weekly pattern in your own local time, and that availability is not a filter
applied after matching. It is a scorer applied during it. Someone who is only
free on weekend mornings does not get excluded from rounds, they get paired with
whoever else is free on weekend mornings.

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
   and group-level rules are the suspected gaps.
2. **Greedy matching with randomized restarts instead of Blossom.** Defensible
   under about 50 participants per round. Where does that break?
3. **The negotiation limit is one counter-proposal per side**, then the pairing
   releases and the two people are left to their own devices. Too strict?
4. **Availability is a standing weekly pattern plus a declared timezone, not a
   per-pairing poll.** The alternative, a grid of candidate slots each person
   marks for every introduction, is more accurate and never goes stale, but
   costs five extra taps every time. Wrong trade?
5. **The follow-up fires only for locked calls**, so a pairing that released and
   then met anyway is invisible in the numbers. Worth measuring?
6. **Auto-pause after two ignored check-ins, with a partner's confirmation
   counting as evidence you attended.** Standing enrollment fills with ghosts
   because ignoring a bot is easier than telling it no. But someone who does
   every call and never taps a button is not a ghost, and their partner's "yes
   we met" proves it. Is that the right evidence test, and is roughly two months
   of silence the right rope?
7. **Biweekly by default rather than weekly.** With `n` members you exhaust every
   novel pairing in `n-1` rounds, so a twelve-person server running weekly is out
   of new introductions in eleven weeks. Is biweekly the right shipped default?
8. **Availability is hourly, as a 168-bit weekly mask.** No half-hours, no
   one-off exceptions, no real calendar. Is hourly granularity enough, and is a
   recurring weekly pattern the right model for how people are actually busy?
9. **Self-hosting story.** Clone, edit one TOML file, `docker compose up`. If you
   would not run this, say what stops you.

## License

AGPL-3.0. Self-host it freely. If you run a modified version as a service to
other people, publish your changes.

Built by [Quarterly Systems](https://quarterly.systems).
