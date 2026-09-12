# Matchbook

A Discord bot that introduces two people a week and then schedules the call.

**Status: design spec only. There is no code yet.** This repository exists so the
design can be argued with before anything is built. If you have opinions, open an
issue.

Read the spec: **[`docs/design.md`](docs/design.md)**

## The idea in a paragraph

Tools in this category match people on a single bit of information: have these
two met before. That is not an engineering limitation, it is a data limitation.
A generic bot knows nothing about a community's members beyond a username and
some roles, so meeting history is the only signal available to it.

Matchbook replaces the bit with a score. A matching strategy answers one
question, "how good would a pairing of A and B be," as a number between 0 and 1,
and strategies compose as a weighted sum configured per server. Meeting history
ships as the boring default. A community with its own structured data writes its
own scorer against a documented interface, keeps it private if it wants to, and
never touches the matcher.

The second idea is smaller and probably matters more in practice. Matchbook
schedules the call. An introduction arrives with a proposed time already in it,
either person can change it, and once both confirm they get a calendar file and a
private voice channel that opens itself ten minutes early. "Sort out a time
between you" looks like politeness and functions as an obstacle.

## How it differs from what exists

|  | Typical coffee-chat bot | Matchbook |
|---|---|---|
| Model | Scheduled group voice event, or a DM and good luck | One introduction, one scheduled 1:1 call |
| Matching input | Meeting history, a boolean | Composable numeric scorers |
| Scheduling | Fixed hour, attend or miss it | Proposed time per pair, negotiable, .ics issued |
| Delivery | Direct message | Private thread, because DMs between strangers can be blocked |
| Source | Usually closed | AGPL-3.0 |

## What feedback would actually help

Vague approval is not useful. These are the decisions most likely to be wrong:

1. **Is the scoring interface the right shape?** `score(a, b, ctx) => 0..1`,
   symmetric, composed as a weighted sum. Is there a matching rule you would want
   that cannot be expressed this way? Constraints ("never pair these two") and
   group-level rules are the suspected gaps.
2. **Greedy matching with randomized restarts instead of Blossom.** Defensible
   under about 50 participants per round. Where does that break?
3. **The negotiation limit is one counter-proposal per side**, then the pairing
   releases and the two people are left to their own devices. Too strict?
4. **Timezone is stored at join rather than derived from availability.** The
   alternative, a grid of slots each person marks, is more accurate and never
   goes stale, but costs five extra taps. Wrong trade?
5. **The follow-up fires only for locked calls**, so a pairing that released and
   then met anyway is invisible in the numbers. Worth measuring?
6. **Self-hosting story.** Clone, edit one TOML file, `docker compose up`. If you
   would not run this, say what stops you.

## License

AGPL-3.0. Self-host it freely. If you run a modified version as a service to
other people, publish your changes.

Built by [Quarterly Systems](https://quarterly.systems).
