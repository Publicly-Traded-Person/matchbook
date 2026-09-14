# Matchbook build 1: the shortest complete loop

**Grammar:** claims-v1

**Claim:** I run /join on the KmikeyM Discord and within about a day a private thread introduces me to a shareholder with a proposed time already in it; we each tap Works for me, get a calendar file, a voice room opens ten minutes early, and the next day the bot asks whether we connected. (elicited)
**Summary:** Matchbook is a Discord bot that introduces two people and then schedules the call, and build 1 is the shortest loop that produces a completed call and a measured answer. It exists because the 2019 Dialup line was how shareholders knew each other, it stopped existing, and every replacement stops at the introduction and leaves the scheduling to politeness. What you get is a bot you can self-host from one config file, pairing by rotation behind a can-they-actually-meet check, with the scorers left off until there are real pairings to learn from.

**Goal:** Build 1 of `docs/design.md` (#19): standing enrollment with the ack gate, rolling pairing by `round-robin` behind the feasibility precondition, the whole scheduling state machine with .ics and a T-10 voice room, the follow-up, SQLite storage behind an interface, durable jobs, a thin discord.js adapter, and a Docker Compose deploy. Scorers, tags and the welcome pool are build 2 and are not built here; their tests against the interface are.
**Closes:** #4 #5 #6 #9 #14 #15 #16 #18 #19

**Tech Stack:** Bun 1.3, TypeScript 5 (strict, `noUncheckedIndexedAccess`), `bun:sqlite`, `Bun.TOML`, `discord.js` 14.27. `bootstrapCmd: bun install`. `testCmd: bunx tsc --noEmit && bun test`. State is SQLite behind the `Storage` interface per spec §4 and §6; this plan deliberately leaves the TinyBase default of the greenfield reference because the spec names SQLite and generic SQL.
**Exam command:** bun test {paths}
**Spec:** `docs/design.md` in this repo, at BASE. Section numbers in every Context refer to it. Every shape the tasks share is already committed in `src/types.ts` at BASE; tasks import from it and never redeclare it.

**Parallelization rationale:** Wave 1 is twelve wide (Tasks 1 to 12): availability, strategies, matching, enrollment, the pool decision, the scheduling machine, calendar, jobs, storage, config, the Discord command definitions and the deploy files share only `src/types.ts`, which exists at BASE, and each takes its collaborators as injected parameters or plain data, so none needs a sibling's runtime behaviour. Wave 2 is Task 13 alone: the app composes the real modules and its exam is a simulated month over their actual behaviour, which no contract can promise. Wave 3 is Task 14 alone: the entry point boots the real app, and its config check runs the real loader. Task 15 is manual and waves nothing.

## Global Constraints

- Check: bunx tsc --noEmit && bun test
- Check: test -z "$(grep -rl 'discord.js' src --include=*.ts | grep -v -e '^src/adapters/discord/' -e '^src/main.ts')"
- Check: test -z "$(grep -rn -e '—' src config.example.toml README.md Dockerfile docker-compose.yml 2>/dev/null)"
- Check: test -z "$(grep -rniE 'kmikeym|shareholder|experiment' src config.example.toml 2>/dev/null)"
- Every shared shape is imported from `src/types.ts`; no module redeclares `Strategy`, `Context`, `MemberRow`, `PairingRecord`, `Job`, `Storage`, `GuildConfig`, `DiscordPort`, `Incoming` or `App`.
- No test sleeps and no test reads the wall clock: every time-based behaviour takes an injected `now` (epoch milliseconds) and tests drive it.
- Tests never share on-disk state: a test needing a database opens `:memory:`; a test writing files uses its own `mkdtemp` directory.
- Only `src/adapters/discord/` and `src/main.ts` import `discord.js`. `src/core/`, `src/jobs/`, `src/storage/` and `src/config/` import nothing platform-specific.
- Every table has a `guild_id` column and every query is scoped by it.
- No user-facing string in `src/` or `config.example.toml` contains an em dash (U+2014), the word "experiment", or any mention of KmikeyM, shares or votes. Copy uses commas, periods, colons or parentheses instead.
- A `Mask` is exactly 168 characters of `0` or `1`, index 0 being Monday 00:00 local; any function given another length throws an `Error` whose message contains `168`.

**Acceptance:** suite, plus per-task review. Task 13's simulated month is the integration-spanning exam: per-task green never establishes the seams. The live install on the KmikeyM Discord is Task 15, a manual step outside the fleet run.

### Task 1: Weekly availability masks

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/core/availability.ts`
- Test: `tests/availability.test.ts`

**Claim:** I tell it when not to bother me, as a weekly pattern in my own local time, and two people who share no hours are never treated as able to meet. (derived)
Machine: M1. `PRESETS['any-reasonable-hour']` is a 168-character mask in which each of the seven day slices `mask.slice(d * 24, d * 24 + 24)` equals `'000000000111111111111000'` (hours 9 through 20 set, 84 ones in total); `DEFAULT_PRESET` is `'any-reasonable-hour'` and `DEFAULT_MASK` equals that preset's mask.
M2. `PRESETS['evenings-only']` has every day slice equal to `'000000000000000001111000'` (28 ones); `PRESETS['weekends-only']` has Monday through Friday slices of 24 zeros and Saturday and Sunday slices equal to `'000000000111111111111000'` (24 ones); `PRESETS['weekdays-9-5-off']` has Monday through Friday slices equal to `'000000000000000001111000'` and Saturday and Sunday slices equal to `'000000000111111111111000'` (44 ones).
M3. `orBlock(mask, days, hours)` returns a mask whose ones are the union of the input's ones and every `(day, hour)` in the block, and `EMPTY_MASK` is 168 zeros.
M4. `isAvailableAt(mask, zone, utcMs)` is `true` exactly when the mask has a `1` at the index of the local weekday and hour of `utcMs` in `zone`, weekday indexed Monday 0 through Sunday 6.
M5. `projectToUtc(mask, zone, fromUtc, hours)` returns the UTC hour starts in `[fromUtc, fromUtc + hours * 3600000)` at which `isAvailableAt` is true, ascending; for a one-hour mask at index 1 projected from `Date.UTC(2026, 8, 13, 20)` for 168 hours, `Etc/GMT-1` gives exactly `[Date.UTC(2026, 8, 14, 0)]` and `Etc/GMT-3` gives exactly `[Date.UTC(2026, 8, 13, 22)]`, a shift of exactly `-7200000`, and the mask string is unchanged after the calls.
M6. `sharedHours(a, b, fromUtc, hours)` returns the ascending intersection of the two projections and is commutative; `feasible(a, b, now)` is `true` exactly when `sharedHours(a, b, now, 168)` is non-empty, and a member on `DEFAULT_MASK` shares with an all-ones member exactly the default member's own projection.
M7. A mask argument of any length other than 168, or containing a character other than `0` or `1`, makes each of `isAvailableAt`, `projectToUtc`, `orBlock`, `sharedHours`, `feasible` and `assertMask` throw an `Error` whose message contains `168`.

**Authorized-by:** #4; #16; spec §5 "Availability", "The default mask", "The mask is stored as local intent"

**Interfaces:**
- Consumes: none
- Produces: `PRESETS: Readonly<Record<Exclude<AvailabilityPreset, 'custom'>, Mask>>`
- Produces: `DEFAULT_PRESET: AvailabilityPreset`
- Produces: `DEFAULT_MASK: Mask`
- Produces: `EMPTY_MASK: Mask`
- Produces: `orBlock(mask: Mask, days: readonly number[], hours: readonly number[]): Mask`
- Produces: `isAvailableAt(mask: Mask, zone: string, utcMs: number): boolean`
- Produces: `projectToUtc(mask: Mask, zone: string, fromUtc: number, hours: number): number[]`
- Produces: `sharedHours(a: { mask: Mask; timezone: string }, b: { mask: Mask; timezone: string }, fromUtc: number, hours: number): number[]`
- Produces: `feasible(a: { mask: Mask; timezone: string }, b: { mask: Mask; timezone: string }, now: number): boolean`
- Produces: `assertMask(mask: string): asserts mask is Mask`

**Context:** Index arithmetic is `day * 24 + hour` with Monday 0. The preset hours are this plan's definition, since the spec names only the default: `any-reasonable-hour` is 09:00 to 21:00 every day (hours 9 through 20, 12 per day, 84 total); `evenings-only` is 17:00 to 21:00 every day (hours 17 through 20, 28 total); `weekends-only` is 09:00 to 21:00 on Saturday and Sunday (24 total); `weekdays-9-5-off` is `any-reasonable-hour` minus Monday through Friday 09:00 to 17:00, which leaves weekdays 17:00 to 21:00 and weekends 09:00 to 21:00 (44 total). Local weekday and hour come from `Intl.DateTimeFormat(‘en-US’, { timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts`, which Bun 1.3 supports for every id in `Intl.supportedValuesOf('timeZone')` (445 ids at BASE); `Etc/GMT-1` is UTC+1 and `Etc/GMT-3` is UTC+3, both without DST, which is why the offset test uses them. `projectToUtc` walks hour by hour from `fromUtc` rounded down to the hour, so DST transitions are handled by the formatter, not by arithmetic. `feasible` looks one week ahead of `now`. `hours` defaults to 168 where omitted. No file, clock or Discord import.

**Proof:**
- Test: `tests/availability.test.ts`
- Guard: `tests/availability.test.ts`
- Legs: (a) the default preset has length 168, a count of `1` characters equal to 84, `DEFAULT_PRESET` is `'any-reasonable-hour'`, `DEFAULT_MASK` equals `PRESETS['any-reasonable-hour']`, and for each day 0 through 6 the 24-character day slice strictly equals `'000000000111111111111000'` [M1]; (b) for `evenings-only` each of the seven day slices strictly equals `'000000000000000001111000'` and the count of ones is 28; for `weekends-only` slices 0 through 4 strictly equal 24 zeros, slices 5 and 6 strictly equal `'000000000111111111111000'`, and the count is 24; for `weekdays-9-5-off` slices 0 through 4 strictly equal `'000000000000000001111000'`, slices 5 and 6 strictly equal `'000000000111111111111000'`, and the count is 44 [M2]; (c) `orBlock(EMPTY_MASK, [0, 6], [9, 10])` has exactly four ones at indices 9, 10, 153 and 154, `orBlock` over an already-set index leaves the count unchanged, and `EMPTY_MASK` has 168 characters and no `1` [M3]; (d) a mask with a single `1` at index 1 (Monday 01:00) reports `true` for `Etc/GMT-1` at `2026-09-14T00:00:00Z` and `false` at `2026-09-14T01:00:00Z`, and a `1` at index 164 (Sunday 20:00) reports `true` for `America/Los_Angeles` at `2026-09-14T03:00:00Z` [M4]; (e) with a one-hour mask at index 1, `projectToUtc` from `Date.UTC(2026, 8, 13, 20)` for 168 hours returns exactly `[Date.UTC(2026, 8, 14, 0)]` under `Etc/GMT-1` and exactly `[Date.UTC(2026, 8, 13, 22)]` under `Etc/GMT-3`; the default mask projected from the same start for 168 hours has exactly 84 elements under each zone, ascending, with first element `Date.UTC(2026, 8, 14, 8)` under `Etc/GMT-1` and `Date.UTC(2026, 8, 14, 6)` under `Etc/GMT-3`; and the mask string compares equal before and after the calls [M5]; (f) `sharedHours(a, b, …)` deep-equals `sharedHours(b, a, …)` for two different presets in two different zones, `feasible` is `false` for one member on `weekends-only` and another whose ones are only Monday through Friday, both in `UTC`, and `true` for two default members in `UTC`, and `sharedHours` of a default member with an all-ones member deep-equals `projectToUtc` of the default member alone [M6]; (g) a 167-character mask and a 168-character mask containing `2` each make `isAvailableAt`, `projectToUtc`, `orBlock`, `sharedHours`, `feasible` and `assertMask` throw an `Error` whose message contains `168` [M7].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 2: The strategy interface, round-robin, and composition

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/core/strategies.ts`
- Test: `tests/strategies.test.ts`

**Claim:** A matching strategy answers one question, how good would a pairing of A and B be, as a number between 0 and 1, and a strategy can only read the signals it declared. (derived)
Machine: M1. `buildContext(all, reads, now)` returns an object whose own enumerable keys are exactly `now` plus the names in `reads`, in any order, and no other signal is present.
M2. `roundRobin.name` is `'round-robin'`, `roundRobin.reads` deep-equals `['pairing-history']`, and `roundRobin.score(a, b, ctx)` is `1` when no record in `ctx['pairing-history']` contains both ids.
M3. When the two have been paired, `roundRobin.score` equals `d / (d + 14)` where `d` is days since their most recent pairing's `createdAt`, so 14 days gives exactly `0.5`, and a pairing between other members does not lower it.
M4. `roundRobin.score(a, b, ctx) === roundRobin.score(b, a, ctx)` for every pair in a ten-member fixture with a mixed history.
M5. `compose(weights, strategies)` returns a `Strategy` whose `reads` is the deduplicated union of its parts' `reads` and whose score is the weight-normalized sum of each part's score clamped to `[0, 1]`, so a part returning `7` counts as `1` and one returning `-2` as `0`, and the score is `0` when every weight is `0`.
M6. `compose` throws an `Error` naming the missing strategy when `weights` names a strategy not in `strategies`.

**Authorized-by:** #6; #19; spec §4 "core/strategies", "Composition"

**Interfaces:**
- Consumes: none
- Produces: `buildContext<R extends Signal>(all: AllSignals, reads: readonly R[], now: number): Context<R>`
- Produces: `roundRobin: Strategy<'pairing-history'>`
- Produces: `compose(weights: Weights, strategies: readonly Strategy<any>[]): Strategy`
- Produces: `STRATEGIES: Readonly<Record<string, Strategy<any>>>`

**Context:** The rotation is the recovery curve stated in M3: strangers score 1, a repeat recovers toward 1 with age but never reaches it, so a stranger always outranks any repeat and among repeats the least recent wins, which is what "next feasible stranger in rotation, then least-recent repeat" means for build 1. `d` is fractional days, `(now - createdAt) / 86400000`, with `createdAt` of the newest record naming both members; `now` is `ctx.now`. `STRATEGIES` holds only `round-robin` in build 1; build 2 adds `never-met`, `interest-overlap` and `schedulable` here. `compose` normalizes by the sum of the weights it was given, ignores a strategy the weights do not name, and clamps each part's score to `[0, 1]` before summing. `buildContext` copies references, never the arrays. The `Context<R>` type in `src/types.ts` makes an undeclared read a type error; `buildContext` makes it a runtime absence too. No IO, no clock, no Discord.

**Proof:**
- Test: `tests/strategies.test.ts`
- Guard: `tests/strategies.test.ts`
- Legs: (a) `Object.keys(buildContext(all, ['pairing-history', 'timezone'], 0)).sort()` deep-equals `['now', 'pairing-history', 'timezone']`, and `'tags' in ctx` is `false` [M1]; (b) `roundRobin.name` and `roundRobin.reads` equal their literals, and a pair absent from a three-record history scores exactly `1` [M2]; (c) with one record for the pair created 14 days before `now`, the score is `0.5`; with the record 28 days old it is `2/3` within `1e-9`; with two records the newer one is used, so a 28-day record plus a 14-day record scores `0.5`; a history containing only pairings between other members scores `1` [M3]; (d) over every one of the 45 pairs of a ten-member fixture whose history pairs members 0 to 5 at assorted ages, `score(a, b)` strictly equals `score(b, a)` [M4]; (e) composing two stub strategies scoring `1` and `0` with weights `0.5` and `0.5` gives `0.5`; weights `1` and `3` give `0.25`; a stub returning `7` composed alone gives `1`; a stub returning `-2` composed alone gives `0`; weights all `0` give `0`; and the composed `reads` of stubs reading `['tags']` and `['tags', 'timezone']` deep-equals `['tags', 'timezone']` after sorting [M5]; (f) `compose({ 'never-met': 1 }, [roundRobin])` throws an `Error` whose message contains `never-met` [M6].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 3: The matcher

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/core/matching.ts`
- Test: `tests/matching.test.ts`

**Claim:** Only pairs who can actually meet are scored, nobody is paired with themselves or twice at once, and greedy is measured against optimal on every small fixture. (derived)
Machine: M1. `match(pool, history, strategy, opts)` never returns a pair whose two ids are equal, and no id appears in more than one returned pair.
M2. No returned pair has `opts.feasible(a, b) === false`, and no returned pair contains a member whose `avoid` lists the other.
M3. Among feasible, non-avoided pairs, `match` is greedy by descending score with ties broken by the lexicographically smaller `[min(id), max(id)]`, so a pool of four with scores `{ab: 0.9, cd: 0.8, ac: 0.95, bd: 0.1}` returns `[ac, bd]` and a pool of two equal-scored candidates for `a` picks the smaller id.
M4. `bruteForceOptimal(pool, history, strategy, opts)` returns the maximum total score over every set of disjoint feasible pairs: on the four-member table of M3 it returns `1.7` while the greedy sum is `1.05`; on a two-member pool it returns that pair's score; and for each of six fixtures of two to ten members the test reports `optimal - greedy` as a number `>= 0`, `<= 1e-9` on the two-member fixture.
M5. A pool of fewer than two members returns `[]`, and with `opts.feasible` always `false` a pool of ten returns `[]`.

**Authorized-by:** #16; spec §4 "core/matching", "The matcher"; §8 "Matching properties"

**Interfaces:**
- Consumes: none
- Produces: `match(pool: readonly Participant[], history: readonly PairingRecord[], strategy: Strategy<any>, opts: MatchOptions): ProposedPair[]`
- Produces: `bruteForceOptimal(pool: readonly Participant[], history: readonly PairingRecord[], strategy: Strategy<any>, opts: MatchOptions): number`
- Produces: `type MatchOptions = { now: number; feasible(a: Participant, b: Participant): boolean; signals?: Partial<AllSignals> }`
- Produces: `type ProposedPair = { a: MemberId; b: MemberId; score: number; fresh: boolean }`

**Context:** The matcher is the greedy best-non-overlapping set behind an interface (§4). Build the strategy's context from `opts.signals` merged over defaults (`'pairing-history'` is always `history`; the other signals default to empty maps and lists) with `now`, restricted to `strategy.reads`; the test passes stub strategies with explicit score tables, so this task does not consume Task 2. `fresh` is true when no record in `history` names both ids. Feasibility and avoid notes are preconditions applied before any scoring (§4). `bruteForceOptimal` enumerates matchings recursively over the first unmatched member (either skip it or pair it with each later compatible member), which is cheap at ten members. The gap is reported with `console.log` from the test, one line per fixture, and asserted as M4 says: greedy equals optimal on tiny pools, and is never above it. Pure: no IO, no clock, no Discord.

**Proof:**
- Test: `tests/matching.test.ts`
- Guard: `tests/matching.test.ts`
- Legs: (a) over a ten-member pool with a constant-score stub, every returned pair has `a !== b`, and the multiset of ids across returned pairs has no duplicate [M1]; (b) with `feasible` returning `false` for exactly the pair `[m1, m2]` and every other pair `true`, no returned pair is `{m1, m2}` even when its stub score is `1` and every other score is `0.1`; and in a second scenario where the stub scores `[m3, m4]` at `1` and every other pair at `0.1` with `feasible` always `true` and `m3.avoid` containing `m4`, no returned pair is `{m3, m4}` [M2]; (c) the four-member table yields exactly `[{a: 'a', b: 'c'}, {a: 'b', b: 'd'}]` by ids, and a three-member pool where `ab` and `ac` both score `0.5` returns `[{a: 'a', b: 'b'}]` [M3]; (d) `bruteForceOptimal` on the M3 four-member table is `1.7` within `1e-9` while the greedy pairs sum to `1.05` within `1e-9`; on a two-member pool with score `0.4` it is `0.4`; and for each of six fixtures of sizes 2, 4, 6, 8, 9 and 10 with a seeded random score table, `optimal - greedySum` is `>= 0`, the gap is logged, and for the size 2 fixture it is `<= 1e-9` [M4]; (e) a pool of one returns `[]`, an empty pool returns `[]`, and a ten-member pool with `feasible` always `false` returns `[]` [M5].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 4: Enrollment and the ack gate

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/core/enrollment.ts`
- Test: `tests/enrollment.test.ts`

**Claim:** After one silent pairing the bot asks before spending another partner's turn, a partner's Yes counts as proof I was there, and coming back is one command with my history intact. (derived)
Machine: M1. `joinMember(null, { timezone: 'Europe/Belgrade' }, now, cfg, null)` returns a row with `state: 'active'`, `eligibleAt: now`, `joinedAt: now`, `mask` equal to `DEFAULT_MASK_LITERAL`, `preset: 'any-reasonable-hour'`, `needsAck: false`, `checkinsIgnored: 0`, `welcome: false`, and `joinMember(null, {}, …)` throws an `Error` whose message contains `timezone`.
M2. `joinMember(pausedRow, {}, now, cfg, lastPairingAt)` and `resumeMember(pausedRow, now, cfg, lastPairingAt)` return the same row: `state: 'active'`, `needsAck: false`, `checkinsIgnored: 0`, `eligibleAt` equal to `max(now, lastPairingAt + cfg.cadenceMs)` when `lastPairingAt` is a number and equal to `now` when it is `null`, with `mask`, `preset`, `timezone`, `avoid` and `joinedAt` unchanged.
M3. `joinMember(activeRow, { timezone: 'Asia/Tokyo' }, …)` changes only `timezone`; `joinMember(activeRow, { avoid: ['x'] }, …)` changes only `avoid`; `pauseMember(activeRow)` sets `state: 'paused'` and nothing else.
M4. `isSilent({ posted, tapped, partnerYes })` is `true` exactly when all three are `false`, and its evidence type has exactly those three fields, so a partner's Not yet has no way in.
M5. `closePairing(row, silent, now, cfg)` sets `needsAck: true` when `silent` and leaves it `false` otherwise, and never changes `eligibleAt`; `recordEvidence(row)` sets `needsAck: false` and changes nothing else.
M6. `sendCheckin(row, now)` sets `checkinSentAt: now`; `answerCheckin(row, 'keep')` sets `needsAck: false` and `checkinSentAt: null`; `answerCheckin(row, 'pause')` sets `state: 'paused'`.
M7. `expireCheckin(row, now, cfg)` returns `{ action: 'none' }` when `now - checkinSentAt < cfg.cadenceMs` or `needsAck` is `false`; otherwise it increments `checkinsIgnored`, and returns `{ action: 'resend' }` with `checkinSentAt: now` when the new count is 1, or `{ action: 'auto-paused' }` with `state: 'paused'` when the new count is 2.
M8. `inPool(row, now, openPairingMembers)` is `true` exactly when `state === 'active'`, `needsAck === false`, `eligibleAt <= now`, and the id is not in `openPairingMembers`.

**Authorized-by:** #18; spec §4a "Enrollment is standing", "The gate, precisely", "Coming back", "Returning clears"

**Interfaces:**
- Consumes: none
- Produces: `joinMember(existing: MemberRow | null, opts: { timezone?: string; avoid?: readonly MemberId[] }, now: number, cfg: EnrollmentConfig, lastPairingAt: number | null, ids: { guildId: GuildId; id: MemberId }): MemberRow`
- Produces: `resumeMember(row: MemberRow, now: number, cfg: EnrollmentConfig, lastPairingAt: number | null): MemberRow`
- Produces: `pauseMember(row: MemberRow): MemberRow`
- Produces: `isSilent(evidence: { posted: boolean; tapped: boolean; partnerYes: boolean }): boolean`
- Produces: `closePairing(row: MemberRow, silent: boolean, now: number, cfg: EnrollmentConfig): MemberRow`
- Produces: `recordEvidence(row: MemberRow): MemberRow`
- Produces: `sendCheckin(row: MemberRow, now: number): MemberRow`
- Produces: `answerCheckin(row: MemberRow, answer: 'keep' | 'pause'): MemberRow`
- Produces: `expireCheckin(row: MemberRow, now: number, cfg: EnrollmentConfig): { row: MemberRow; action: 'none' | 'resend' | 'auto-paused' }`
- Produces: `inPool(row: MemberRow, now: number, openPairingMembers: ReadonlySet<MemberId>): boolean`
- Produces: `type EnrollmentConfig = { cadenceMs: number }`
- Produces: `DEFAULT_MASK_LITERAL: Mask`

**Context:** Pure functions returning new rows; never mutate the input. `DEFAULT_MASK_LITERAL` is the 168-character default of #4 written out in this file so the task does not consume Task 1: for each day, hours 9 through 20 are `1` (indices `d*24+9 … d*24+20`), all else `0`, 84 ones in total. Task 1 defines the same string as `DEFAULT_MASK`; Task 13 asserts the two are equal. Being paired sets `eligibleAt` (§4a) and that happens in the pool decision, not here, which is why `closePairing` never touches it. `joinMember` on an active row is the "re-running it with any option updates just that option" path (#5) and returns the row with only the given fields changed; on a paused row it is the resume path of #18's "returning clears `needs_ack` and zeroes `checkins_ignored`". `lastPairingAt` is `null` for a member never paired, in which case `eligibleAt` is `now`. `expireCheckin` is the housekeeping counter of §4a: one ignored check-in re-sends, two auto-pause, and it is a no-op while nothing is pending. All fields not named as changing are copied through unchanged, including `overlapNoticeAt`, `welcome` and `lastWelcomeAt`.

**Proof:**
- Test: `tests/enrollment.test.ts`
- Guard: `tests/enrollment.test.ts`
- Legs: (a) a fresh join yields the eight literal fields of M1, its `mask` strictly equals `DEFAULT_MASK_LITERAL`, which itself has 168 characters, 84 ones, a `1` at index 9 and a `0` at index 8, while a join with no timezone throws an `Error` whose message contains `timezone` [M1]; (b) for a paused row with `needsAck: true`, `checkinsIgnored: 2` and a custom mask, `joinMember` and `resumeMember` deep-equal each other, have the four literal fields of M2, `eligibleAt` equal to `lastPairingAt + cadence` when that is later than `now`, equal to `now` when `lastPairingAt + cadence` is one millisecond before `now`, and equal to `now` when `lastPairingAt` is `null`, and the five unchanged fields deep-equal the input's [M2]; (c) a timezone-only rejoin with `'Asia/Tokyo'` on an active `'Europe/Belgrade'` row yields `timezone === 'Asia/Tokyo'` and every other field deep-equal to the input's; an avoid-only rejoin with `['x']` on a row whose `avoid` is `[]` yields `avoid` deep-equal to `['x']` and every other field deep-equal; and `pauseMember` on an active row yields `state === 'paused'` and every other field deep-equal [M3]; (d) `isSilent` is `true` for all-false and `false` for each of the three single-true cases, and a call site passing `{ posted: false, tapped: false, partnerYes: false, partnerNotYet: true }` is a type error under `bunx tsc --noEmit` (the test keeps it behind `// @ts-expect-error`) and at runtime still returns `true` [M4]; (e) `closePairing` with `silent: true` sets `needsAck: true` and leaves `eligibleAt` equal to the input's, with `silent: false` leaves `needsAck: false` and likewise leaves `eligibleAt` equal to the input's, and `recordEvidence` on a `needsAck: true` row differs from it in `needsAck` alone [M5]; (f) `sendCheckin` sets `checkinSentAt` to `now`, `answerCheckin(…, 'keep')` yields `needsAck: false` and `checkinSentAt: null`, and `answerCheckin(…, 'pause')` yields `state: 'paused'` [M6]; (g) `expireCheckin` one millisecond short of the cadence returns `'none'` with the row unchanged, on a `needsAck: false` row returns `'none'`, at the cadence with `checkinsIgnored: 0` returns `'resend'` with `checkinsIgnored: 1` and `checkinSentAt: now`, and at the cadence with `checkinsIgnored: 1` returns `'auto-paused'` with `state: 'paused'` and `checkinsIgnored: 2` [M7]; (h) `inPool` is `true` for an active, acked, eligible, unpaired row and `false` for each of: `state: 'paused'`, `needsAck: true`, `eligibleAt: now + 1`, and id present in `openPairingMembers` [M8].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 5: The pool decision: holding, pull-forward, novelty

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/core/pool.ts`
- Test: `tests/pool.test.ts`

**Claim:** There is no pairing day: I join and within about a day I have someone to talk to, it waits for a stranger rather than repeating while one exists, and when I have met everyone it reconnects me and says so. (derived)
Machine: M1. `decidePool(input)` pairs two eligible, feasible, never-paired members in the pool at once with `novelty: 'fresh'`; a paused member, a `needsAck` member, a member in `openPairingMembers`, or a member whose `eligibleAt` is more than `pullForwardMaxMs` after `now` is never in a returned pairing and never in `pullForward`, even when a lone pool member has waited past the holding window.
M2. A member alone in the pool for less than `holdingWindowMs` gets no pairing and no `pullForward`; alone for at least `holdingWindowMs`, with a feasible stranger whose `eligibleAt` is within `pullForwardMaxMs` of `now`, they are paired with the soonest such stranger, that stranger's id is in `pullForward`, and the pairing's novelty is `'held'`.
M3. A lone member past the window whose only in-reach member is a repeat, while a feasible stranger exists among active members out of reach, gets no pairing and no `pullForward`; when no stranger exists anywhere among active members, the soonest-eligible in-reach repeat is pulled forward and the pairing's novelty is `'reconnect'`.
M4. When the matcher's best pairing for a member is a repeat and a feasible stranger exists among active members, the member is not paired and a `'holding-for-stranger'` notice names them, unless `now - eligibleAt >= cadenceMs`, in which case the repeat is paired with novelty `'held'`.
M5. When `pick` proposes a repeat pair and neither side has any stranger among active members, the pairing's novelty is `'reconnect'` and a `'met-everyone'` notice names each side with the other as `partnerId` and their most recent shared `createdAt` as `lastPairedAt`.
M6. A pool member feasible with no active member gets a `'no-overlap'` notice and is never paired or pulled forward, and no other notice names them.
M7. Every returned pairing has two distinct ids, no id appears in two returned pairings, every returned pairing is feasible and not avoided, and no member's `eligibleAt` in the returned `updates` is earlier than `now`.
M8. Under the simulation of leg (h) the twelve original members hold at least 3 distinct `eligibleAt` values after 42 simulated days.

**Authorized-by:** #15; #16; spec §4a "There is no pairing day", "Holding and pull-forward", "The novelty rule"; §8 "Eligibility"

**Interfaces:**
- Consumes: none
- Produces: `decidePool(input: PoolInput): PoolDecision`
- Produces: `type PoolInput = { members: readonly MemberRow[]; history: readonly PairingRecord[]; openPairingMembers: ReadonlySet<MemberId>; now: number; cfg: PoolConfig; feasible(a: MemberRow, b: MemberRow): boolean; pick(pool: readonly MemberRow[]): readonly { a: MemberId; b: MemberId }[] }`
- Produces: `type PoolConfig = { cadenceMs: number; holdingWindowMs: number; pullForwardMaxMs: number }`
- Produces: `type PoolDecision = { pairings: readonly { members: readonly [MemberId, MemberId]; novelty: Novelty }[]; pullForward: readonly MemberId[]; updates: readonly MemberRow[]; notices: readonly PoolNotice[] }`
- Produces: `type PoolNotice = { memberId: MemberId; kind: 'holding-for-stranger' | 'met-everyone' | 'no-overlap'; partnerId?: MemberId; lastPairedAt?: number }`

**Context:** The pool is `members` filtered by the `inPool` rule restated here so the task consumes nothing: `state === 'active'`, `needsAck === false`, `eligibleAt <= now`, id not in `openPairingMembers`. `pick` is the matcher already composed with the strategy; the test passes a stub that returns pairs in a fixed order, and Task 13 passes Task 3's `match`. "Stranger" means a feasible active member the member has never been paired with and who is not avoided in either direction; "active members" includes those not yet eligible and those in open pairings (they exist, so waiting can help). The algorithm, in order: (1) compute the pool and, for each pool member, their strangers among active members; a pool member with no feasible active member at all gets `'no-overlap'` and is removed from consideration. (2) Call `pick(pool)`; walk its pairs in order, skipping any pair already touched, any infeasible or avoided pair; a fresh pair is accepted as `'fresh'`; a repeat pair is held (notice `'holding-for-stranger'` for each side that has a stranger and has waited less than a cadence since `eligibleAt`) or accepted as `'held'` (a side has waited a full cadence) or `'reconnect'` (neither side has any stranger: the notice carries the partner and the newest `createdAt` naming both). (3) For each pool member still unpaired whose `now - eligibleAt >= holdingWindowMs`: in-reach candidates are active members not in the pool, not in an open pairing, not `needsAck`, with `now < eligibleAt <= now + pullForwardMaxMs`, feasible and not avoided; pair with the soonest-eligible stranger in reach as `'held'`; if none, and a stranger exists anywhere among active members, do nothing (novelty outranks the window); if no stranger exists anywhere, pair with the soonest-eligible in-reach repeat as `'reconnect'`. (4) `updates` carries a copy of every paired member's row with `eligibleAt = now + cadenceMs` (being paired sets it, §4a), and every pulled-forward member also appears in `pullForward`. Ties on "soonest" break by smaller id. The measured reference: this plan's author ran these rules with `feasible` always true and a two-day open pairing, cohort of twelve paired at day 0, one newcomer every 5 days, hourly decisions for 42 days, and observed 4 distinct `eligibleAt` days among the originals (42, 44, 50, 56); daily newcomers gave 1, because newcomers pair with each other, which is the finding behind M8's floor of 3 and behind the spec amendment noted in the plan's report.

**Proof:**
- Test: `tests/pool.test.ts`
- Guard: `tests/pool.test.ts`
- Legs: (a) two eligible strangers with a stub `pick` returning them yield exactly one pairing with `novelty: 'fresh'` and an empty `pullForward`; and for each of a paused member, a `needsAck` member, a member with `eligibleAt: now + pullForwardMaxMs + 1`, and a member in `openPairingMembers`, an input holding only a lone pool member at `eligibleAt: now - holdingWindowMs - 1` plus that one other member, feasible and never paired, yields `pairings: []` and `pullForward: []` [M1]; (b) a lone member with `eligibleAt: now - holdingWindow + 1` gets `pairings: []` and `pullForward: []`; the same member at `now - holdingWindow` with a stranger at `eligibleAt: now + 2 days` and another at `now + 1 day` is paired with the `now + 1 day` one, that id is the sole `pullForward` entry, and the novelty is `'held'` [M2]; (c) a lone member past the window whose only in-reach members are two repeats at `eligibleAt: now + 2 days` and `now + 1 day`, with a stranger at `eligibleAt: now + 10 days`, gets no pairing and `pullForward: []`; with the far stranger removed and their history covering every active member, the `now + 1 day` repeat is the one pulled forward, the pairing names exactly those two, and the novelty is `'reconnect'` [M3]; (d) a pool of two repeats with `eligibleAt: now` and a stub `pick` returning them, plus a third active stranger feasible with both at `eligibleAt: now + 10 days`, yields no pairing and a `'holding-for-stranger'` notice naming each pool member; with both pool members' `eligibleAt` set to `now - cadenceMs`, the same input yields one pairing with novelty `'held'` [M4]; (e) a pool of two members whose history names each other and every other active member, with `pick` returning them, yields one pairing with novelty `'reconnect'` and two notices of kind `'met-everyone'`, one per member, each carrying the other's id as `partnerId` and `lastPairedAt` equal to the newest `createdAt` naming both [M5]; (f) a pool member for whom `feasible` is `false` against every other member gets exactly one notice, of kind `'no-overlap'`, appears in no pairing, and appears in no `pullForward` even at `now - 30 days` [M6]; (g) over a 20-member randomized input with a seeded `feasible` table in which member `m01` avoids `m02` through `m06` and `m07` avoids `m01`, and a stub `pick` that proposes every pair including the avoided ones, every pairing has distinct ids, the ids across pairings are unique, `feasible` is `true` for each, no pairing joins `m01` with any of `m02` through `m07`, and every `updates` row has `eligibleAt >= now` [M7]; (h) a simulation in the test drives `decidePool` hourly for 42 days from a cohort of twelve members joined at hour 0 with `feasible` always true, a stub `pick` that greedily prefers never-paired pairs then oldest repeats, each pairing held open for two days, and a newcomer added every 5 days; at the end the set of the twelve originals' `eligibleAt` values has size `>= 3` [M8].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 6: The scheduling state machine

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/core/scheduling.ts`
- Test: `tests/scheduling.test.ts`

**Claim:** An introduction arrives with a proposed time, either of us can change it once, and when we both say Works for me it is locked; if we never agree, the thread is ours and the bot steps back. (derived)
Machine: M1. `transition(s, ev, now, cfg)` implements exactly this table and throws `IllegalTransition` for every other `(state, event.kind)` pair: `created`+`propose` gives `time_proposed`; `time_proposed`+`confirm` gives `one_confirmed`; `time_proposed`+`counter` gives `time_proposed`; `time_proposed`+`negotiation-timeout` gives `released`; `time_proposed`+`overlap-lost` gives `released`; `one_confirmed`+`confirm` gives `locked`; `one_confirmed`+`counter` gives `time_proposed`; `one_confirmed`+`negotiation-timeout` gives `released`; `one_confirmed`+`overlap-lost` gives `released`; `locked`+`tz-repropose` gives `time_proposed` when the event carries a `startUtc` and `released` when it carries `null`; `locked`+`follow-up-due` gives `completed`; `released`+`release-review` gives `completed` when `hadActivity` and `expired` otherwise; `completed`+`archive` gives `completed`.
M2. A `counter` by a member whose `countersUsed` is already 1 throws `IllegalTransition`, and a `counter` from `one_confirmed` empties `confirmedBy`, so the new proposal needs both confirmations again.
M3. A `confirm` by a member already in `confirmedBy` throws `IllegalTransition`; a second distinct `confirm` yields `locked` with `lockedStartUtc` equal to the current proposal's start.
M4. Entering `time_proposed` by `propose` or `counter` yields effects containing `{ type: 'cancel', kind: 'negotiation-release' }` followed by `{ type: 'schedule', kind: 'negotiation-release', runAt: now + cfg.negotiationTimeoutMs }`; entering `locked` yields cancels of `negotiation-release` and schedules of `room-open` at `start - 600000`, `room-close` at `start + callMs + 3600000`, and `follow-up` at `start + callMs + 86400000`.
M5. Entering `released` yields a `schedule` of `expire` at `now + 604800000` and a `say` of `released-timeout`, `released-overlap` or `released-overlap` for `negotiation-timeout`, `overlap-lost` and a null `tz-repropose` respectively, plus cancels of `negotiation-release`, `room-open`, `room-close` and `follow-up`; entering `completed` yields a `say` of `follow-up` and a `schedule` of `archive` at `now + 604800000`; entering `expired` yields `{ type: 'archive' }`.
M6. `tz-repropose` with a `startUtc` resets `countersUsed` to `{}` and `confirmedBy` to `[]`, cancels `room-open`, `room-close` and `follow-up`, and schedules a fresh `negotiation-release`.
M7. `dueTimes(lockedStartUtc, cfg)` returns `{ roomOpen: start - 600000, roomClose: start + callMs + 3600000, followUp: start + callMs + 86400000 }`.

**Authorized-by:** #14; #9; spec §5 "Pairing state machine", "Negotiation limit", "Follow-up", "But the bot notices"; §8 "Scheduling"

**Interfaces:**
- Consumes: none
- Produces: `transition(s: SchedulingState, ev: SchedulingEvent, now: number, cfg: SchedulingConfig): { next: SchedulingState; effects: readonly Effect[] }`
- Produces: `initialState(members: readonly [MemberId, MemberId]): SchedulingState`
- Produces: `dueTimes(lockedStartUtc: number, cfg: SchedulingConfig): { roomOpen: number; roomClose: number; followUp: number }`
- Produces: `class IllegalTransition extends Error`
- Produces: `type SchedulingState = { state: PairingState; members: readonly [MemberId, MemberId]; proposedStartUtc: number | null; proposedBy: MemberId | null; countersUsed: Readonly<Record<MemberId, number>>; confirmedBy: readonly MemberId[]; lockedStartUtc: number | null }`
- Produces: `type SchedulingEvent = { kind: 'propose'; startUtc: number } | { kind: 'confirm'; by: MemberId } | { kind: 'counter'; by: MemberId; startUtc: number } | { kind: 'negotiation-timeout' } | { kind: 'overlap-lost' } | { kind: 'tz-repropose'; startUtc: number | null } | { kind: 'follow-up-due' } | { kind: 'release-review'; hadActivity: boolean } | { kind: 'archive' }`
- Produces: `type SchedulingConfig = { negotiationTimeoutMs: number; callMs: number }`
- Produces: `type Effect = { type: 'schedule'; kind: JobKind; runAt: number } | { type: 'cancel'; kind: JobKind } | { type: 'say'; copy: CopyKey; vars?: Readonly<Record<string, string | number>> } | { type: 'archive' }`

**Context:** Pure; the app (Task 13) executes effects against storage, jobs and Discord. `initialState` is `created` with no proposal, empty counters and confirmations. `propose` and `counter` set `proposedStartUtc` and `proposedBy` (the bot's initial proposal has `proposedBy: null`); `counter` increments the counterer's `countersUsed`. `confirm` appends to `confirmedBy`. The `say` copy keys and their `vars` are: `proposal` and `counter` with `{ start }` (the epoch ms of the proposal); `one-confirmed` with `{ by }`; `locked` with `{ start }`; the three released keys with no vars; `follow-up` with no vars. Effects are ordered cancels first, then schedules, then says. A `follow-up-due` on `locked` and a `release-review` on `released` are raised by the app when the corresponding job fires. The `expire` job on a released pairing is what raises `release-review`; the app decides `hadActivity` from `pairingMembers(...).lastActivityAt`. The exhaustive test iterates all seven states against all nine event kinds (63 combinations), asserts the 13 legal combinations of M1 (14 target rows, since `tz-repropose` and `release-review` each branch) produce their target and every other combination throws `IllegalTransition`, and treats the two `tz-repropose` targets and the two `release-review` targets as rows of one combination each. `cfg.callMs` is `callMinutes * 60000`, 1800000 by default.

**Proof:**
- Test: `tests/scheduling.test.ts`
- Guard: `tests/scheduling.test.ts`
- Legs: (a) for each of the 63 `(state, kind)` combinations, the test builds a representative state and event and asserts either the target of M1's table or that `transition` throws `IllegalTransition`, and the count of legal combinations found is exactly 13 [M1]; (b) a member's second `counter` throws `IllegalTransition`, and a `counter` by the other member from `one_confirmed` yields `confirmedBy` deep-equal to `[]` and `countersUsed` for that member equal to 1 [M2]; (c) `confirm` twice by the same member throws `IllegalTransition`, and `confirm` by each member in turn ends in `locked` with `lockedStartUtc` equal to the proposal's `startUtc` [M3]; (d) the effects of `propose` and of a `counter` each contain, in order, a cancel of `negotiation-release` and a schedule of `negotiation-release` at `now + negotiationTimeoutMs`; the effects of the locking `confirm` contain a cancel of `negotiation-release` and schedules of `room-open`, `room-close` and `follow-up` at the three literal offsets of M4 [M4]; (e) for each of the five entries into `released` (`negotiation-timeout` from `time_proposed`, `negotiation-timeout` from `one_confirmed`, `overlap-lost` from `time_proposed`, `overlap-lost` from `one_confirmed`, and `tz-repropose` with `null` from `locked`) the effects contain a schedule of `expire` at `now + 604800000` and cancels of `negotiation-release`, `room-open`, `room-close` and `follow-up`, and the `say` key is `released-timeout` for the two timeouts and `released-overlap` for the other three; `follow-up-due` from `locked` yields `completed` with a `say` of `follow-up` and a schedule of `archive` at `now + 604800000`; `release-review` with `hadActivity: true` yields `completed` with the same two effects; with `false` yields `expired` and an effect `{ type: 'archive' }` [M5]; (f) `tz-repropose` with a `startUtc` from `locked` yields `time_proposed`, `countersUsed` deep-equal to `{}`, `confirmedBy` deep-equal to `[]`, cancels of `room-open`, `room-close` and `follow-up`, and a schedule of `negotiation-release` [M6]; (g) `dueTimes(1_000_000_000_000, { negotiationTimeoutMs: 0, callMs: 1800000 })` deep-equals `{ roomOpen: 999999400000, roomClose: 1000005400000, followUp: 1000088200000 }` [M7].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 7: Slot proposal and the calendar file

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/core/calendar.ts`
- Test: `tests/calendar.test.ts`

**Claim:** The proposed time is drawn from hours we both actually have, leaning toward an evening for both of us, and once we lock I get a calendar file that points at our thread. (derived)
Machine: M1. `proposeSlots(shared, now, opts)` returns only elements of `shared` that lie in `[now + opts.minDays * 86400000, now + opts.maxDays * 86400000]`, each on the hour (`% 3600000 === 0`), with no duplicates.
M2. The returned order puts every slot whose local hour is 17 through 20 in both `opts.zoneA` and `opts.zoneB` before every slot that is not, and within each group ascending by time.
M3. `alternatives(shared, now, chosen, opts)` returns at most 5 slots from `proposeSlots` order that are not equal to `chosen`.
M4. `ics(event)` returns a string whose lines are joined by `\r\n`, that starts with `BEGIN:VCALENDAR`, ends with `END:VCALENDAR` followed by `\r\n`, contains exactly one `BEGIN:VEVENT`, and contains the lines `UID:<uid>`, `DTSTAMP:<stamp>`, `DTSTART:<start>`, `DTEND:<end>`, `SUMMARY:<summary>`, `DESCRIPTION:<description>` and `LOCATION:<threadUrl>` where the three times are `YYYYMMDDTHHMMSSZ` in UTC and `DTEND` is `DTSTART` plus `durationMin`.
M5. `ics(event)` contains no line beginning `ORGANIZER` or `ATTENDEE`, and two calls with the same `uid` and different starts share the `UID:` line byte for byte.
M6. `formatIcsTime(ms)` of `Date.UTC(2026, 8, 17, 19, 0, 0)` is `20260917T190000Z`.

**Authorized-by:** #14; spec §5 "Slot proposal", "On lock"

**Interfaces:**
- Consumes: none
- Produces: `proposeSlots(shared: readonly number[], now: number, opts: SlotOptions): number[]`
- Produces: `alternatives(shared: readonly number[], now: number, chosen: number, opts: SlotOptions): number[]`
- Produces: `ics(event: IcsEvent): string`
- Produces: `formatIcsTime(ms: number): string`
- Produces: `type SlotOptions = { minDays: number; maxDays: number; zoneA: string; zoneB: string }`
- Produces: `type IcsEvent = { uid: string; dtstamp: number; startUtc: number; durationMin: number; summary: string; description: string; threadUrl: string }`

**Context:** `shared` is the list of UTC hour starts that Task 1's `sharedHours` produces; this task takes the numbers and never imports Task 1. Local hour of a UTC instant in a zone comes from `Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' })`. The window is 3 to 10 days by default (`minDays: 3, maxDays: 10` is what Task 13 passes); calls are 30 minutes and the mask is hourly, so proposals land on the hour (§5). The `.ics` is a single `VEVENT` with `UID`, `DTSTAMP`, `DTSTART`, `DTEND`, `SUMMARY`, `DESCRIPTION`, `LOCATION` and no `ORGANIZER` or `ATTENDEE` (#14); include `VERSION:2.0` and a `PRODID:-//Matchbook//EN` line; a re-lock after a timezone change posts a fresh file with the same `UID` so a calendar keeps one entry. Escape commas, semicolons and newlines in `SUMMARY`, `DESCRIPTION` and `LOCATION` per RFC 5545 (`\,` `\;` `\n`). No wrapping of long lines is required in build 1.

**Proof:**
- Test: `tests/calendar.test.ts`
- Guard: `tests/calendar.test.ts`
- Legs: (a) given `shared` containing hours at 2, 3, 5, 10 and 11 days after `now` plus one off-hour value, `proposeSlots` with `{ minDays: 3, maxDays: 10 }` returns exactly the day-3, day-5 and day-10 hours, none of the day-2, day-11 or off-hour values, and no value twice when `shared` repeats one [M1]; (b) with `zoneA: 'Etc/GMT-1'` and `zoneB: 'Etc/GMT-3'`, given the input order [day 5 at 18:00 UTC, day 4 at 08:00 UTC, day 6 at 16:00 UTC, day 3 at 16:00 UTC], the result is exactly [day 3 at 16:00, day 6 at 16:00, day 4 at 08:00, day 5 at 18:00]: the two 16:00 UTC slots (17:00 and 19:00 local, evening in both zones) come first in time order, and the 18:00 UTC slot (19:00 in zoneA but 21:00 in zoneB, evening in only one zone) sorts with the non-evening 08:00 slot, after it, in time order [M2]; (c) with eight qualifying slots, `alternatives(…, chosen = the first)` has length 5, contains no element equal to `chosen`, and equals `proposeSlots(...)` with `chosen` removed, truncated to 5 [M3]; (d) the output of a fixed event splits on `\r\n` into lines whose first is `BEGIN:VCALENDAR` and last is `END:VCALENDAR` with the string ending in `\r\n`, contains exactly one `BEGIN:VEVENT` line, and contains each of the seven literal lines of M4 with `DTSTART:20260917T190000Z` and `DTEND:20260917T193000Z` for a 30-minute event at `Date.UTC(2026, 8, 17, 19)` and `LOCATION:https://discord.com/channels/1/2/3` [M4]; (e) no line starts with `ORGANIZER` or `ATTENDEE`, and two events with `uid: 'abc'` and starts one day apart produce outputs whose `UID:abc` line is present in both [M5]; (f) `formatIcsTime(Date.UTC(2026, 8, 17, 19, 0, 0))` is `'20260917T190000Z'` [M6].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 8: Durable jobs

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/jobs/scheduler.ts`
- Create: `src/jobs/memory-store.ts`
- Test: `tests/jobs.test.ts`

**Claim:** Everything time-based is a row with a run time, so a restart loses nothing and nothing fires twice. (derived)
Machine: M1. `scheduler.schedule(guildId, kind, refId, runAt, now)` inserts a pending `Job` with a unique id and returns it; `runDue(now, handler)` calls `handler` once for each pending job with `runAt <= now`, ascending by `runAt`, and returns that count.
M2. A job is never handled before its `runAt`: `runDue(runAt - 1, …)` handles nothing and `runDue(runAt, …)` handles it.
M3. A job is handled at most once: two `runDue` calls over one store, or two `Scheduler` instances over one store run back to back, call `handler` exactly once for it.
M4. `cancel(guildId, kind, refId)` returns the number of pending jobs cancelled, and a cancelled job is never handled.
M5. A job scheduled through one `Scheduler` is handled by a new `Scheduler` constructed over the same `JobStore` afterwards, with no other action in between.
M6. `MemoryJobStore` satisfies `JobStore`: `dueJobs` returns only pending jobs with `runAt <= now` ascending by `runAt` then `id`; `completeJob` returns `true` once and `false` on a second call or for an unknown id; `pendingJobs(guildId)` returns only that guild's pending jobs.
M7. When `handler` throws, the job stays `done`, `runDue` continues with the next due job, and the thrown errors are returned in the result's `errors` array rather than propagated.

**Authorized-by:** spec §6 "Durable scheduling"; §8 "Jobs"

**Interfaces:**
- Consumes: none
- Produces: `class Scheduler { constructor(store: JobStore, ids?: () => string); schedule(guildId: GuildId, kind: JobKind, refId: string, runAt: number, now: number): Job; cancel(guildId: GuildId, kind: JobKind, refId: string): number; runDue(now: number, handler: (job: Job) => Promise<void> | void): Promise<{ fired: number; errors: readonly Error[] }> }`
- Produces: `class MemoryJobStore implements JobStore`

**Context:** The `JobStore` interface is in `src/types.ts`; Task 9's SQLite storage implements it too, and Task 13 runs this scheduler over that. At-most-once is claimed by `completeJob` before the handler runs: a `false` return means another runner took it, so skip. `runDue` returns `fired` as the count of handlers invoked (including ones that threw). `ids` defaults to `crypto.randomUUID`. `MemoryJobStore` is a `Map` and exists for tests and for Task 13's simulated month. No timers, no `setTimeout`, no sleeping anywhere in this task or its test: time is the `now` argument.

**Proof:**
- Test: `tests/jobs.test.ts`
- Guard: `tests/jobs.test.ts`
- Legs: (a) three jobs at `runAt` 30, 10, 20 handled by `runDue(25)` give `fired: 2`, handler calls in `refId` order of the 10 then the 20 job, three distinct ids, and `runDue(30)` gives `fired: 1` [M1]; (b) a job at `runAt: 1000` is not handled by `runDue(999)` and is handled by `runDue(1000)` [M2]; (c) a due job handled by `runDue` then by a second `runDue` at a later `now` is handled once, and two `Scheduler` instances over one `MemoryJobStore` calling `runDue` in sequence handle it once in total [M3]; (d) `cancel` after scheduling two jobs of one kind and ref returns `2`, a subsequent `runDue` handles neither, and `cancel` of a kind with nothing pending returns `0` [M4]; (e) a job scheduled via scheduler A is handled by `new Scheduler(sameStore).runDue(runAt)` [M5]; (f) `dueJobs` on the memory store returns jobs sorted by `runAt` then `id` and excludes a `done` job and a `cancelled` job, `completeJob` returns `true` then `false`, `completeJob('nope')` returns `false`, and `pendingJobs('g1')` excludes a `g2` job [M6]; (g) with two due jobs whose handler throws on the first, `runDue` resolves with `fired: 2` and `errors.length === 1`, and the first job is `done` in the store [M7].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 9: SQLite storage

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/storage/sqlite.ts`
- Test: `tests/storage.test.ts`

**Claim:** Everything the bot remembers about me is one member row, my pairings, my answers and the jobs about me, scoped to the server, and /forget really deletes it. (derived)
Machine: M1. `openStorage(':memory:')` returns a `Storage` whose database has exactly the tables `guilds`, `members`, `pairings`, `pairing_members`, `proposals`, `confirmations`, `outcomes` and `jobs`, and each of those eight tables has a `guild_id` column.
M2. `upsertMember` then `getMember` round-trips every `MemberRow` field, including `tags` and `avoid` arrays, `null` timestamps and the 168-character `mask`; `getMember` for another guild id returns `null`; `listMembers('g2')` excludes `g1` rows.
M3. `insertPairing` with two `PairingMemberRow`s, then `getPairing`, `pairingsOf` (newest first) and `pairingMembers` round-trip the pairing; `openPairings` excludes `completed` and `expired` pairings and includes every other state; `touchPairingMember` sets `lastActivityAt`; `pairingByThread` finds a pairing by its `threadId`.
M4. Proposals, confirmations and outcomes round-trip through their insert and read functions, `updateProposal` changes `state`, and `allOutcomes` returns every outcome of a guild.
M5. `forgetMember(g, m)` deletes the member row, their `pairing_members` rows, their confirmations and their outcomes, sets `proposedBy` to `null` on proposals they authored, cancels every pending job whose `refId` is `m`, and leaves their partner's member row, the pairing row, the partner's outcome and jobs whose `refId` is the pairing id untouched.
M6. The `JobStore` methods behave as `src/types.ts` documents: `dueJobs(now)` returns pending jobs with `runAt <= now` ascending by `runAt` then `id`; `completeJob` returns `true` once and then `false`; `cancelJobs` returns the count cancelled and leaves them out of `dueJobs`; `pendingJobs` is guild-scoped.
M7. Every SQL statement in `src/storage/sqlite.ts` uses only generic SQL: the file contains no `AUTOINCREMENT`, no `WITHOUT ROWID`, no `json_extract`, no `STRICT`, and no `PRAGMA` other than `foreign_keys` and `journal_mode`.

**Authorized-by:** spec §6 "Data model"; §9 "/forget deletes"; §10 item 4

**Interfaces:**
- Consumes: none
- Produces: `openStorage(path: string): Storage`
- Produces: `SCHEMA_SQL: readonly string[]`

**Context:** Use `bun:sqlite` (`import { Database } from 'bun:sqlite'`). `SCHEMA_SQL` is the list of `CREATE TABLE IF NOT EXISTS` statements run on open, in order, the tables of §6 with these columns: `guilds(guild_id TEXT PRIMARY KEY, created_at INTEGER)`; `members(guild_id, discord_user_id, state, timezone, tags, avoid_notes, availability_mask, availability_preset, eligible_at, welcome, last_welcome_at, needs_ack, checkins_ignored, checkin_sent_at, overlap_notice_at, joined_at, PRIMARY KEY(guild_id, discord_user_id))`; `pairings(id TEXT PRIMARY KEY, guild_id, thread_id, voice_channel_id, state, novelty, created_at)`; `pairing_members(guild_id, pairing_id, discord_user_id, last_activity_at, PRIMARY KEY(guild_id, pairing_id, discord_user_id))`; `proposals(id TEXT PRIMARY KEY, guild_id, pairing_id, start_utc, duration_min, state, proposed_by, created_at)`; `confirmations(guild_id, proposal_id, discord_user_id, confirmed_at, PRIMARY KEY(guild_id, proposal_id, discord_user_id))`; `outcomes(guild_id, pairing_id, discord_user_id, connected, answered_at, PRIMARY KEY(guild_id, pairing_id, discord_user_id))`; `jobs(id TEXT PRIMARY KEY, guild_id, kind, ref_id, run_at, state, created_at)`. `overlap_notice_at` and `pairing_members.last_activity_at` are the two columns this plan adds to §6 (the "tells them once" flag and the thread-activity record); the plan's report files them as a spec amendment. `tags` and `avoid_notes` are stored as JSON text arrays; booleans as 0/1 integers; timestamps as integers. The `Storage` interface and every row type are in `src/types.ts`. Table names come from `SELECT name FROM sqlite_master WHERE type = 'table'` and columns from `PRAGMA table_info(<table>)`, which the test uses through `(storage as any).db` or a `rawQuery(sql: string): unknown[]` helper you may add to the returned object. Every write and read is scoped by `guild_id`. `forgetMember` also marks `cancelled` every pending job whose `ref_id` is the member id (check-ins, eligibility and hold jobs about them), since a job about a deleted member has nobody to act for; jobs about a pairing stay, because the partner's thread still runs.

**Proof:**
- Test: `tests/storage.test.ts`
- Guard: `tests/storage.test.ts`
- Legs: (a) the sorted table names from `sqlite_master` deep-equal the eight literal names, and for each of the eight, `PRAGMA table_info` lists a column named `guild_id` [M1]; (b) a fully populated `MemberRow` with `tags: ['a', 'b']`, `avoid: ['z']`, `checkinSentAt: null` and a 168-character mask deep-equals `getMember` after `upsertMember`, a second `upsertMember` with a changed `state` reads back changed, `getMember('other', id)` is `null`, and `listMembers('g2')` is `[]` after inserting only `g1` rows [M2]; (c) after `insertPairing`, `getPairing` deep-equals the record, `pairingMembers` has two rows with `lastActivityAt: null`, `pairingsOf` for one member returns two pairings with the newer `createdAt` first, `openPairings` after inserting one pairing in each of the seven states returns exactly the five non-terminal ones by id, `touchPairingMember` then `pairingMembers` shows the given `at`, and `pairingByThread` returns the pairing with that `threadId` and `null` for an unknown thread [M3]; (d) a proposal, a confirmation and an outcome each deep-equal their read-back, `updateProposal` with `state: 'superseded'` reads back superseded, and `allOutcomes` returns both of two inserted outcomes [M4]; (e) after `forgetMember(g, 'm1')` on a pairing between `m1` and `m2` with a confirmation and an outcome each and a proposal by `m1`: `getMember(g, 'm1')` is `null`, `pairingMembers` has only `m2`, `confirmationsOf` has only `m2`'s, `outcomesOf` has only `m2`'s, the proposal's `proposedBy` is `null`, a pending `check-in` job with `refId: 'm1'` is absent from `dueJobs` afterwards while a pending `follow-up` job with the pairing's id as `refId` is still returned, `getMember(g, 'm2')` is unchanged and `getPairing` still returns the pairing [M5]; (f) three `g1` jobs at `runAt` 30, 10, 20 give `dueJobs(25)` of exactly the 10 and 20 jobs in that order; two further `g1` jobs with equal `runAt` 5 and ids `b` then `a` come back from `dueJobs(5)` as `a` then `b`; `completeJob` on the 10 job returns `true` then `false`; `cancelJobs` for the 20 job's kind and ref returns `1`; `dueJobs(100)` then contains exactly the 30 job and the two `runAt` 5 jobs; and `pendingJobs('g2')` is `[]` [M6]; (g) reading `src/storage/sqlite.ts` as text, it contains none of `AUTOINCREMENT`, `WITHOUT ROWID`, `json_extract`, `STRICT`, and every `PRAGMA` occurrence is followed by `foreign_keys` or `journal_mode` [M7].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 10: Config file and copy templates

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/config/file-store.ts`
- Create: `src/config/copy.ts`
- Create: `config.example.toml`
- Test: `tests/config.test.ts`

**Claim:** I edit one TOML file for the server, the channels, the cadence and the weights, and every sentence the bot says lives there too so nobody forks the repo to change its voice. (derived)
Machine: M1. `loadConfig('config.example.toml')` returns a `ConfigStore` whose `guildIds()` has length 1 and whose `get` for that id returns `cadenceMs: 1209600000`, `holdingWindowMs: 86400000`, `pullForwardMaxMs: 259200000`, `negotiationTimeoutMs: 172800000`, `callMinutes: 30`, `weights` deep-equal to `{ 'round-robin': 1 }`, and a `copy` whose `join-confirmation` entry is a non-empty string read from the file's `[guilds.copy]` table.
M2. `parseConfig(toml)` fills every omitted numeric field with those defaults and `weights` with `{ 'round-robin': 1 }`, carries every entry of a `[guilds.copy]` table into `cfg.copy` so that `renderCopy` returns it, leaves `cfg.copy` equal to `{}` when the table is absent, and throws an `Error` naming the missing field when `guild_id`, `thread_parent_channel_id` or `voice_category_id` is absent.
M3. `DEFAULT_COPY` has a non-empty string for every `CopyKey`, and `renderCopy(cfg, key, vars)` substitutes each `{name}` with `String(vars[name])`, uses `cfg.copy[key]` when present and `DEFAULT_COPY[key]` otherwise, and throws an `Error` naming the placeholder when a `{name}` has no value in `vars`.
M4. `DEFAULT_COPY['check-in']` contains `Still up for these? You weren't around for your last introduction, and I'd rather ask than guess.`; `DEFAULT_COPY['follow-up']` contains `Did you two connect?`; `DEFAULT_COPY['holding-for-stranger']` contains `Holding a while for someone new rather than repeating.`; `DEFAULT_COPY['join-confirmation']` contains `When I ask whether you connected, your answer counts toward your stats, tells me you're still active, and helps me avoid re-pairing people who already met.` and `/availability`; `DEFAULT_COPY['room-open']` contains `Starts in ten minutes. Your room: {link}`.
M5. No value in `DEFAULT_COPY` and no line of `config.example.toml` contains U+2014, or, lower-cased, the substrings `experiment`, `kmikeym`, `shareholder`, or the whole words `vote` or `votes`.

**Authorized-by:** #4; #19; spec §4 "config"; §9 "What data is allowed to decide"; §11 "The shipped code and the configuration contain no mention"

**Interfaces:**
- Consumes: none
- Produces: `loadConfig(path: string): ConfigStore`
- Produces: `parseConfig(toml: string): ConfigStore`
- Produces: `DEFAULT_COPY: Readonly<Record<CopyKey, string>>`
- Produces: `renderCopy(cfg: Pick<GuildConfig, 'copy'>, key: CopyKey, vars?: Readonly<Record<string, string | number>>): string`

**Context:** Parse with `Bun.TOML.parse(text)` (present in Bun 1.3; no package needed). The file shape is `[[guilds]]` tables with `guild_id`, `thread_parent_channel_id`, `voice_category_id`, optional `cadence_days` (14), `holding_window_hours` (24), `pull_forward_days` (3), `negotiation_timeout_hours` (48), `call_minutes` (30), a `[guilds.weights]` table (default `round-robin = 1.0`) and a `[guilds.copy]` table whose keys are `CopyKey` values. `config.example.toml` carries one guild with placeholder ids `"000000000000000000"`, every numeric default written out, the weights table, and a `[guilds.copy]` table holding at least `join-confirmation` so an adopter sees where the voice lives; a comment block above says what each field is. The `join-confirmation` default says roughly when to expect the first introduction (within about a day when someone is free), states the default availability (09:00 to 21:00 in your timezone), names `/availability`, and includes the §9 sentence verbatim; keep every sentence free of em dashes, the word "experiment", and any mention of KmikeyM, shares or votes (§11), including in the word `shareholder`. The `met-everyone` default is `You've met everyone in Matchbook. Reconnecting you with {partner}, it's been {since}.` and the released copy tells the pair the thread is theirs and that the bot is stepping back. Placeholders are `{name}` with `name` matching `[a-zA-Z_]+`.

**Proof:**
- Test: `tests/config.test.ts`
- Guard: `tests/config.test.ts`
- Legs: (a) loading `config.example.toml` from the repo root yields one guild id, and its config has the six literal values of M1 and a `copy['join-confirmation']` that is a non-empty string [M1]; (b) a TOML with only the three required ids yields the five numeric defaults, `weights` deep-equal to `{ 'round-robin': 1 }` and `copy` deep-equal to `{}`; a TOML adding `[guilds.copy]` with `paused = "Custom pause text"` yields a config for which `renderCopy(cfg, 'paused')` is `'Custom pause text'` while `renderCopy(cfg, 'resumed')` is `DEFAULT_COPY['resumed']`; and for each of the three required fields, a TOML omitting that field throws an `Error` whose message contains the field name [M2]; (c) for each `CopyKey` (the test enumerates the keys of `DEFAULT_COPY` and asserts the count is at least 27 and every value is a non-empty string), `renderCopy` with a `cfg.copy` override for `paused` returns the override, without it returns the default, `renderCopy(cfg, 'room-open', { link: 'X' })` contains `Your room: X`, and `renderCopy(cfg, 'room-open', {})` throws an `Error` whose message contains `link` [M3]; (d) each of the six substrings of M4 (the check-in sentence, `Did you two connect?`, the holding sentence, the join-confirmation sentence, `/availability`, and `Starts in ten minutes. Your room: {link}`) is found in its named default [M4]; (e) the joined values of `DEFAULT_COPY` and the text of `config.example.toml` each contain no U+2014 character, lower-cased contain none of the substrings `experiment`, `kmikeym`, `shareholder`, and match neither `/\bvote\b/` nor `/\bvotes\b/` [M5].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 11: Slash command definitions, zone autocomplete, availability menus

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/adapters/discord/commands.ts`
- Create: `src/adapters/discord/zones.ts`
- Create: `src/adapters/discord/components.ts`
- Test: `tests/discord-commands.test.ts`

**Claim:** I type /join, start typing my city, and the timezone fills itself in; availability is a few presets and two menus, never a text box that has to parse English. (derived)
Machine: M1. `commandDefinitions()` returns JSON bodies whose names are exactly `join`, `timezone`, `availability`, `pause`, `resume`, `forget` and `matchbook`; `join` has a required string option `timezone` with `autocomplete: true` and an optional string option `avoid`, and no option named `interests`; `timezone` has a required autocompleting string option `timezone`; `matchbook` has subcommands `config`, `status` and `pair`, and `pair` has two required user options `a` and `b`.
M2. `zoneSuggestions('oak')` includes `America/Los_Angeles` and `zoneSuggestions('kos')` includes `Europe/Belgrade`; `zoneSuggestions('belg')` includes `Europe/Belgrade`; every result of any query is an element of `Intl.supportedValuesOf('timeZone')`; no result list is longer than 25; `zoneSuggestions('')` is non-empty.
M3. `PERMISSIONS` is exactly the seven names `View Channels`, `Send Messages`, `Create Private Threads`, `Send Messages in Threads`, `Manage Threads`, `Manage Channels`, `Connect`; `permissionsBitfield()` is `360778304528n`; `inviteUrl('123')` contains `client_id=123`, `permissions=360778304528` and `scope=bot%20applications.commands`.
M4. `availabilityMenu(preset)` returns an `OutgoingMessage` with exactly six buttons whose ids are `avail:weekdays-9-5-off`, `avail:evenings-only`, `avail:weekends-only`, `avail:any-reasonable-hour`, `avail:custom`, `avail:clear`, and the button for `preset` has style `primary` while the others are `secondary`.
M5. `daysSelect()` is a `SelectMenu` with id `avail-days`, seven options valued `0` through `6` labelled Monday through Sunday, `min: 1`, `max: 7`; `hoursSelect()` has id `avail-hours`, 24 options valued `0` through `23`, `min: 1`, `max: 24`.
M6. `parseCustomId('confirm:p1')` returns `{ action: 'confirm', ref: 'p1' }`, and `customId('confirm', 'p1')` returns `'confirm:p1'`.

**Authorized-by:** #5; #14; spec §5 "Timezones are mandatory", "Entering it must not involve parsing English"; §7 "Member commands", "Admin commands", "Permissions requested"

**Interfaces:**
- Consumes: none
- Produces: `commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[]`
- Produces: `zoneSuggestions(query: string, limit?: number): string[]`
- Produces: `ZONE_ALIASES: Readonly<Record<string, string>>`
- Produces: `PERMISSIONS: readonly string[]`
- Produces: `permissionsBitfield(): bigint`
- Produces: `inviteUrl(clientId: string): string`
- Produces: `availabilityMenu(preset: AvailabilityPreset): OutgoingMessage`
- Produces: `daysSelect(): SelectMenu`
- Produces: `hoursSelect(): SelectMenu`
- Produces: `customId(action: string, ref: string): string`
- Produces: `parseCustomId(id: string): { action: string; ref: string }`

**Context:** Build the definitions with `SlashCommandBuilder` from `discord.js` and return `.toJSON()`; the test reads the JSON (`options[].name`, `.required`, `.autocomplete`, `.type`, subcommand `type` 1, user option `type` 6). `/welcome` and the `interests` option are build 2 (#19) and are absent. Zone matching: lower-case the query; a zone matches when the query is a substring of the zone id with `_` replaced by a space (`america/los angeles`), or when the query is a prefix of an alias key in `ZONE_ALIASES`, whose value is the zone; `ZONE_ALIASES` must contain at least `oakland` and `portland` mapping to `America/Los_Angeles`, and `kosovo` and `pristina` mapping to `Europe/Belgrade`; results are de-duplicated, alias hits first, then id hits alphabetically, cut to `limit` (default 25, Discord's autocomplete cap). The bitfield is `ViewChannel | SendMessages | CreatePrivateThreads | SendMessagesInThreads | ManageThreads | ManageChannels | Connect` from `PermissionFlagsBits`, which this plan's author computed as `360778304528` with discord.js 14.27.0 at BASE. `inviteUrl` is `https://discord.com/oauth2/authorize?client_id=<id>&permissions=<bitfield>&scope=bot%20applications.commands`. Button and select shapes are `Button` and `SelectMenu` from `src/types.ts`; `customId` joins with `:` and `parseCustomId` splits on the first `:`. The `OutgoingMessage.content` of the availability menu is a short prompt; Task 13 renders the copy around it.

**Proof:**
- Test: `tests/discord-commands.test.ts`
- Guard: `tests/discord-commands.test.ts`
- Legs: (a) the sorted command names deep-equal the seven literals; `join`'s `timezone` option has `type: 3`, `required: true` and `autocomplete: true`, its `avoid` option has `type: 3` and `required` falsy, no `join` option is named `interests`; `timezone`'s option has `type: 3`, `required: true` and `autocomplete: true`; `matchbook`'s subcommand names deep-equal `['config', 'pair', 'status']` when sorted and `pair` has two `type: 6` required options named `a` and `b` [M1]; (b) `'oak'` yields a list containing `America/Los_Angeles`, `'kos'` and `'belg'` each yield one containing `Europe/Belgrade`, for each of the queries `''`, `'a'`, `'europe'`, `'zzzz'` every element is in `Intl.supportedValuesOf('timeZone')` and the length is `<= 25`, and `''` yields a non-empty list [M2]; (c) `PERMISSIONS` deep-equals the seven literal strings, `permissionsBitfield()` is `360778304528n`, and `inviteUrl('123')` contains the three literal substrings [M3]; (d) `availabilityMenu('evenings-only')` has six buttons with the six literal ids, the `avail:evenings-only` button has style `primary`, and the other five have style `secondary` [M4]; (e) `daysSelect()` has id `avail-days`, options whose values deep-equal `['0','1','2','3','4','5','6']` and whose labels deep-equal `['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']` in that order, `min: 1`, `max: 7`; `hoursSelect()` has id `avail-hours`, 24 options valued `'0'` through `'23'`, `min: 1`, `max: 24` [M5]; (f) `parseCustomId('confirm:p1')` deep-equals `{ action: 'confirm', ref: 'p1' }`, `parseCustomId('x:a:b')` has `ref: 'a:b'`, and `customId('confirm', 'p1')` is `'confirm:p1'` [M6].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 12: Docker Compose, Dockerfile, README quickstart

**Type:** implementation

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.dockerignore`
- Modify: `README.md`

**Claim:** Clone, edit one TOML file, docker compose up, and I have a working bot in under ten minutes, with each permission it asks for explained in one line. (derived)
Machine: M1. `Dockerfile` starts from an `oven/bun` image, runs `bun install`, and has a `CMD` line naming `src/main.ts`.
M2. `docker-compose.yml` defines exactly one service, named `matchbook`, that builds from `.`, carries the environment line `- DISCORD_TOKEN=${DISCORD_TOKEN}`, mounts `./config.toml` read-only at `/app/config.toml` and `./data` at `/app/data`, and has `restart: unless-stopped`.
M3. `README.md` has a `## Quickstart` section that contains, in order, the four lines `git clone https://github.com/Publicly-Traded-Person/matchbook`, `cp config.example.toml config.toml`, `export DISCORD_TOKEN=...` and `docker compose up`.
M4. `README.md` has a `## Permissions` section with, for each of the seven permissions `View Channels`, `Send Messages`, `Create Private Threads`, `Send Messages in Threads`, `Manage Threads`, `Manage Channels`, `Connect`, a bullet of the exact form `- **<name>**: <reason>` with a non-empty reason, and a line beginning `Not requested:` that names Move Members, Mute Members, Manage Events and Manage Roles in that order.
M5. `README.md` has a `## Writing a scorer` section containing a fenced code block that includes `interface Strategy`, `readonly reads`, and `score(a: Participant, b: Participant, ctx: Context`.
M6. `README.md`'s status paragraph no longer says there is no code: the string `There is no code yet` is absent.
M7. `.dockerignore` lists `node_modules`, `config.toml`, `data` and `.git`.

**Authorized-by:** spec §11 "README quickstart (once code exists)"; §7 "Permissions requested"

**Interfaces:**
- Consumes: none
- Produces: none

**Context:** The README at BASE is the design-era README (it says "design spec only", no code); keep its story, its idea section, its differences table and its feedback list, and replace the status paragraph with one that says build 1 exists and links the spec. Put `## Quickstart` (with the invite-link instruction: run `bun run src/main.ts --check-config config.toml` to print the invite URL, which Task 14 builds; the README may name it now), `## Permissions` (one bullet per permission in the exact form `- **Name**: reason`, then a paragraph line beginning `Not requested:`; Connect because the bot can only grant the pair a permission it holds itself; Manage Channels because the voice channel is created with its overwrites in the create call; then the not-requested sentence), and `## Writing a scorer` (the `Strategy` interface from `src/types.ts` reproduced in a `ts` fence, about fifteen lines, with a sentence on `reads` and a sentence that the `round-robin` default ships and build 2 adds the scorers) below the existing sections. No em dashes anywhere in the README. The compose file has a single top-level `services:` key with one service `matchbook`, no top-level `volumes:` section (bind mounts only), and its `environment:` written as the list form `- DISCORD_TOKEN=${DISCORD_TOKEN}`. The Dockerfile: `FROM oven/bun:1`, `WORKDIR /app`, copy `package.json` and `bun.lock` if present, `RUN bun install --frozen-lockfile || bun install`, copy the rest, `CMD ["bun", "run", "src/main.ts"]`. `data/` is where `config.toml`'s database path points (`/app/data/matchbook.db` in the example config's comments is fine to mention; the path is passed by Task 14 as `MATCHBOOK_DB`, default `./data/matchbook.db`).

**Proof:**
- Run: grep -q '^FROM oven/bun' Dockerfile && grep -q 'bun install' Dockerfile && grep -qE '^CMD .*src/main\.ts' Dockerfile
- Run: test "$(grep -cE '^  [a-z][a-z0-9_-]*:$' docker-compose.yml)" = 1 && grep -q '^  matchbook:$' docker-compose.yml && grep -q 'build: \.' docker-compose.yml && grep -qE '^ *- DISCORD_TOKEN=\$\{DISCORD_TOKEN\}$' docker-compose.yml && grep -q './config.toml:/app/config.toml:ro' docker-compose.yml && grep -q './data:/app/data' docker-compose.yml && grep -q 'restart: unless-stopped' docker-compose.yml
- Run: sed -n '/^## Quickstart/,/^## /p' README.md | tr '\n' ' ' | grep -q 'git clone https://github.com/Publicly-Traded-Person/matchbook.*cp config.example.toml config.toml.*export DISCORD_TOKEN=\.\.\..*docker compose up'
- Run: sed -n '/^## Permissions/,/^## /p' README.md > /tmp/perm.txt && for p in 'View Channels' 'Send Messages' 'Create Private Threads' 'Send Messages in Threads' 'Manage Threads' 'Manage Channels' 'Connect'; do grep -qE "^- \*\*$p\*\*: ." /tmp/perm.txt || exit 1; done && grep -E '^Not requested:' /tmp/perm.txt | grep -q 'Move Members.*Mute Members.*Manage Events.*Manage Roles'
- Run: sed -n '/^## Writing a scorer/,/^## /p' README.md | tr '\n' ' ' | grep -q 'interface Strategy.*readonly reads.*score(a: Participant, b: Participant, ctx: Context'
- Run: ! grep -q 'There is no code yet' README.md
- Run: grep -q '^node_modules' .dockerignore && grep -q '^config.toml' .dockerignore && grep -q '^data' .dockerignore && grep -q '^.git$' .dockerignore
- Legs: (a) the first Run exits 0 only when a `FROM oven/bun` line, a `bun install` and a `CMD` line naming `src/main.ts` are all present [M1]; (b) the second Run counts exactly one two-space-indented service key and requires it to be `matchbook`, then requires the build line, the exact `- DISCORD_TOKEN=${DISCORD_TOKEN}` environment line (a hardcoded value or a comment does not match), both mounts and the restart policy, exiting non-zero if any is absent [M2]; (c) the third Run scopes to the Quickstart section and pins the four lines in order [M3]; (d) the fourth Run scopes to the Permissions section, requires for each of the seven names an exact `- **<name>**: ` bullet followed by at least one character (so the `Send Messages in Threads` bullet cannot stand in for `Send Messages`) and exits 1 on the first missing one, then requires a line beginning `Not requested:` carrying the four names in order [M4]; (e) the fifth Run scopes to the scorer section and pins the three interface fragments in order [M5]; (f) the sixth Run fails when the old status sentence survives [M6]; (g) the seventh Run pins the four ignore entries [M7].

**Stale-if:**
- path-absent: `README.md`

### Task 13: The app: handlers, jobs, and the simulated month

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/app/index.ts`
- Create: `src/app/handlers.ts`
- Create: `src/app/jobs.ts`
- Create: `tests/helpers/fake-discord.ts`
- Create: `tests/fixtures/members-20.json`
- Test: `tests/app.test.ts`
- Test: `tests/e2e-month.test.ts`

**Claim:** I run /join on the KmikeyM Discord and within about a day a private thread introduces me to a shareholder with a proposed time already in it; we each tap Works for me, get a calendar file, a voice room opens ten minutes early, and the next day the bot asks whether we connected. (elicited)
Machine: M1. `createApp(deps)` returns an `App`; `handle({ kind: 'join', timezone })` for a new member stores a row via `deps.storage` with `eligibleAt: now`, replies ephemerally with the rendered `join-confirmation`, and schedules an `eligible` job at `now`; a `join` with no `timezone` for a new member replies ephemerally with a message containing `timezone` and stores nothing.
M2. `tick(now)` with two feasible strangers eligible creates one pairing in storage, creates one private thread through `deps.discord` with both members, posts the introduction and a proposal whose `startUtc` is one of Task 1's shared hours between 3 and 10 days out, sets both members' `eligibleAt` to `now + cadenceMs`, and schedules a `negotiation-release` job.
M3. Two `confirm` buttons, one per member, on the current proposal lock the pairing: storage shows `locked`, the thread receives a post whose `file.name` ends in `.ics` and whose content is the rendered `locked` copy, and `room-open`, `room-close` and `follow-up` jobs exist at the offsets of Task 6's `dueTimes`.
M4. When the `room-open` job fires, `deps.discord.createVoiceChannel` is called once with the configured category and exactly the two member ids, the thread receives a post whose content equals `renderCopy(cfg, 'room-open', { link })` with `link` the returned channel url, and when `room-close` fires `deleteChannel` is called once with that channel id.
M5. When `follow-up` fires on a locked pairing the thread receives the `follow-up` copy with buttons `yes:<pairingId>` and `notyet:<pairingId>`, the pairing becomes `completed`; a `yes` button records an outcome with `connected: true`, a `notyet` records `connected: false`, a second answer by the same member replies ephemerally and records nothing.
M6. A pairing that ends silent for a member (no thread message from them, no button, and no partner Yes) sets that member's `needsAck`; when their `eligibleAt` arrives the `check-in` job posts the `check-in` copy with buttons `keep:<memberId>` and `pausme:<memberId>` in a thread with only them, and no pairing includes them until `keep` is pressed; a partner's `yes` clears `needsAck` for both members; a partner's `notyet` clears it for neither.
M7. `handle({ kind: 'pause' })` sets `state: 'paused'`; `resume` and a second `join` on a paused member both set `state: 'active'` with `eligibleAt` equal to `max(now, lastPairingAt + cadenceMs)`; `forget` calls `storage.forgetMember` and replies with the `forgotten` copy; `timezone` updates the row and, for a locked pairing whose start falls outside the member's mask under the new zone, posts the `tz-changed-locked-call` copy with buttons `keepit:<pairingId>` and `newtime:<pairingId>`.
M8. `handle({ kind: 'admin-pair', a, b })` creates a pairing with `novelty: 'forced'` when `feasible(a, b)` and replies with the `admin-pair-infeasible` copy and creates nothing otherwise; `admin-status` replies with a message containing the lines `pool: <n>`, `open pairings: <n>` and `reconnection share: <p>%`, where `p` is reconnect pairings over all pairings as a whole-number percent, `0` when there are none.
M9. Over the simulated month of `tests/e2e-month.test.ts` (20 members from the fixture, `tick` every simulated hour for 30 days, the fake Discord recording every call, members confirming proposals with probability drawn from a seeded generator), at no tick is any member in two open pairings, every pairing has a thread, every pairing whose locked start plus `callMs` plus 3600000 is at or before the final tick had exactly one `createVoiceChannel` and one `deleteChannel` while every pairing whose locked start minus 600000 is after the final tick had zero of each, every `completed` pairing received exactly one `follow-up` post, no member is paired again sooner than `cadenceMs - pullForwardMaxMs` after their previous pairing's `createdAt`, and the test reports completion rate and reconnection share as two numbers.
M10. `DEFAULT_MASK` from `src/core/availability.ts` equals `DEFAULT_MASK_LITERAL` from `src/core/enrollment.ts`.

**Authorized-by:** #19; #15; #18; #14; #9; spec §4a, §5, §7, §8 "End to end"

**Interfaces:**
- Consumes: `feasible(a: { mask: Mask; timezone: string }, b: { mask: Mask; timezone: string }, now: number): boolean`
- Consumes: `sharedHours(a: { mask: Mask; timezone: string }, b: { mask: Mask; timezone: string }, fromUtc: number, hours: number): number[]`
- Consumes: `DEFAULT_MASK: Mask`
- Consumes: `orBlock(mask: Mask, days: readonly number[], hours: readonly number[]): Mask`
- Consumes: `PRESETS: Readonly<Record<Exclude<AvailabilityPreset, 'custom'>, Mask>>`
- Consumes: `compose(weights: Weights, strategies: readonly Strategy<any>[]): Strategy`
- Consumes: `STRATEGIES: Readonly<Record<string, Strategy<any>>>`
- Consumes: `match(pool: readonly Participant[], history: readonly PairingRecord[], strategy: Strategy<any>, opts: MatchOptions): ProposedPair[]`
- Consumes: `joinMember(existing: MemberRow | null, opts: { timezone?: string; avoid?: readonly MemberId[] }, now: number, cfg: EnrollmentConfig, lastPairingAt: number | null, ids: { guildId: GuildId; id: MemberId }): MemberRow`
- Consumes: `resumeMember(row: MemberRow, now: number, cfg: EnrollmentConfig, lastPairingAt: number | null): MemberRow`
- Consumes: `pauseMember(row: MemberRow): MemberRow`
- Consumes: `isSilent(evidence: { posted: boolean; tapped: boolean; partnerYes: boolean }): boolean`
- Consumes: `closePairing(row: MemberRow, silent: boolean, now: number, cfg: EnrollmentConfig): MemberRow`
- Consumes: `recordEvidence(row: MemberRow): MemberRow`
- Consumes: `sendCheckin(row: MemberRow, now: number): MemberRow`
- Consumes: `answerCheckin(row: MemberRow, answer: 'keep' | 'pause'): MemberRow`
- Consumes: `expireCheckin(row: MemberRow, now: number, cfg: EnrollmentConfig): { row: MemberRow; action: 'none' | 'resend' | 'auto-paused' }`
- Consumes: `DEFAULT_MASK_LITERAL: Mask`
- Consumes: `decidePool(input: PoolInput): PoolDecision`
- Consumes: `transition(s: SchedulingState, ev: SchedulingEvent, now: number, cfg: SchedulingConfig): { next: SchedulingState; effects: readonly Effect[] }`
- Consumes: `initialState(members: readonly [MemberId, MemberId]): SchedulingState`
- Consumes: `proposeSlots(shared: readonly number[], now: number, opts: SlotOptions): number[]`
- Consumes: `alternatives(shared: readonly number[], now: number, chosen: number, opts: SlotOptions): number[]`
- Consumes: `ics(event: IcsEvent): string`
- Consumes: `class Scheduler { constructor(store: JobStore, ids?: () => string); schedule(guildId: GuildId, kind: JobKind, refId: string, runAt: number, now: number): Job; cancel(guildId: GuildId, kind: JobKind, refId: string): number; runDue(now: number, handler: (job: Job) => Promise<void> | void): Promise<{ fired: number; errors: readonly Error[] }> }`
- Consumes: `openStorage(path: string): Storage`
- Consumes: `renderCopy(cfg: Pick<GuildConfig, 'copy'>, key: CopyKey, vars?: Readonly<Record<string, string | number>>): string`
- Consumes: `parseConfig(toml: string): ConfigStore`
- Consumes: `availabilityMenu(preset: AvailabilityPreset): OutgoingMessage`
- Consumes: `daysSelect(): SelectMenu`
- Consumes: `hoursSelect(): SelectMenu`
- Consumes: `customId(action: string, ref: string): string`
- Consumes: `parseCustomId(id: string): { action: string; ref: string }`
- Produces: `createApp(deps: AppDeps): App`
- Produces: `type AppDeps = { storage: Storage; config: ConfigStore; discord: DiscordPort; ids?: () => string }`
- Produces: `class FakeDiscord implements DiscordPort`

**Context:** This is the composition root and the only place the modules meet; it needs their runtime behaviour, which is why it waits for wave 1. Read every consumed module's exports before writing a handler. The scheduling state of a pairing is rebuilt from storage on each event: `proposedStartUtc`/`proposedBy` from the newest `open` proposal, `countersUsed` from the count of proposals per `proposedBy`, `confirmedBy` from the confirmations of the open proposal, `lockedStartUtc` from the `locked` proposal; write the result back as proposal and confirmation rows, and run the effects: `schedule` and `cancel` through the `Scheduler` with `refId` = pairing id (or member id for `check-in`, `check-in-expiry`, `eligible`, `hold-expiry`, `novelty-hold-expiry`), `say` through `renderCopy` then `discord.post` into the thread, `archive` through `discord.archiveThread`. Job handling (`src/app/jobs.ts`): `eligible`, `hold-expiry`, `novelty-hold-expiry` run `decidePool` for the guild and act on its decision (create pairings, apply `updates`, send notices, schedule `hold-expiry` at `eligibleAt + holdingWindowMs` and `novelty-hold-expiry` at `eligibleAt + cadenceMs` for a member left waiting, posting `holding-for-stranger` only when scheduling a `novelty-hold-expiry` that was not already pending, and `no-overlap` only when `overlapNoticeAt` is null, then setting it); `negotiation-release` raises `negotiation-timeout`; `room-open`/`room-close` do M4; `follow-up` raises `follow-up-due`; `expire` raises `release-review` with `hadActivity` = any `pairingMembers` row has `lastActivityAt`; `check-in` sends the check-in (a private thread for that member alone under the parent channel, named for them) and calls `sendCheckin`; `check-in-expiry` calls `expireCheckin`; `archive` archives the thread. `tick(now)` is `scheduler.runDue(now, handler)` and returns `fired`. A pairing "ends" at `completed` or `expired`; at that moment each member's silence is `isSilent` over their thread activity, their confirmations and outcomes, and the partner's Yes; a silent member gets `closePairing(row, true)` and an `check-in` job at their `eligibleAt`. Button custom ids: `confirm:<proposalId>`, `counter:<proposalId>` (replies with a select of `alternatives` whose id is `slot:<pairingId>` and whose option values are epoch ms), `yes:<pairingId>`, `notyet:<pairingId>`, `keep:<memberId>`, `pausme:<memberId>`, `keepit:<pairingId>`, `newtime:<pairingId>`, `avail:<preset>`, `avail-days`, `avail-hours`. A `counter` from a member whose counter is spent replies ephemerally and changes nothing. `newtime` runs `tz-repropose` with a fresh `proposeSlots` pick or `null`. The pool `pick` is `match` composed with `compose(cfg.weights, Object.values(STRATEGIES))` over `Participant`s built from rows; `feasible` is Task 1's over the two rows. Proposal `startUtc` is `proposeSlots(sharedHours(a, b, now, 240), now, { minDays: 3, maxDays: 10, zoneA, zoneB })[0]`; `durationMin` is `cfg.callMinutes`. The `.ics` event: `uid` = pairing id + `@matchbook`, `summary` = `Matchbook call`, `description` = the two display names are not known to the bot, so use `Your Matchbook call`, `threadUrl` = the thread url the port returned. `FakeDiscord` records every call in a public `calls` array, returns ids from a counter and urls of the form `https://discord.com/channels/<guild>/<id>`, and exposes `postsTo(channelId)`. The 20-member fixture holds ids `m01` through `m20`, a spread of IANA zones (at least five distinct, including one `Etc/GMT+8` and one `Etc/GMT-9`) and presets. The simulated month drives `handle` for joins on day 0 (with two members joining on day 3 and day 10), then `tick` hourly, and for each proposal post it finds, has each member confirm with probability 0.7 from a seeded PRNG the test defines, and posts a thread message from one member with probability 0.5; the reconnection share is pairings with `novelty: 'reconnect'` over all pairings; completion rate is pairings with at least one `connected: true` outcome over pairings that reached `completed`. The database is `openStorage(':memory:')`; the config is `parseConfig` over an inline TOML with the placeholder ids. No sleeps; no wall clock.

**Proof:**
- Test: `tests/app.test.ts`
- Test: `tests/e2e-month.test.ts`
- Guard: `tests/app.test.ts`
- Guard: `tests/e2e-month.test.ts`
- Legs: (a) after a `join` with a zone, `storage.getMember` has `eligibleAt: now`, the reply is ephemeral and equals the rendered `join-confirmation`, and `pendingJobs` holds one `eligible` job with `runAt: now`; a `join` without a zone replies ephemerally with `timezone` in the content and `getMember` is `null` [M1]; (b) two joined strangers then `tick(now)` yield one pairing in `openPairings`, one `createPrivateThread` call naming both ids, a post in that thread whose content strictly equals `renderCopy(cfg, 'introduction', …)` followed by a post whose content strictly equals `renderCopy(cfg, 'proposal', { start })` carrying buttons `confirm:<proposalId>` and `counter:<proposalId>`, a proposal in storage whose `startUtc` is in `sharedHours(a, b, now, 240)` and between `now + 3 days` and `now + 10 days`, both rows' `eligibleAt` equal to `now + cadenceMs`, and a pending `negotiation-release` job [M2]; (c) `confirm:<proposalId>` from each member yields `getPairing(...).state === 'locked'`, a thread post whose `file.name` ends in `.ics` with content equal to the rendered `locked` copy, and pending `room-open`, `room-close` and `follow-up` jobs at `start - 600000`, `start + 1800000 + 3600000` and `start + 1800000 + 86400000` [M3]; (d) ticking to the `room-open` time yields exactly one `createVoiceChannel` call with the configured category and exactly the two ids, a thread post whose content strictly equals `renderCopy(cfg, 'room-open', { link: <the returned url> })`, and ticking to `room-close` yields exactly one `deleteChannel` with that id [M4]; (e) ticking to `follow-up` yields a thread post with buttons `yes:<id>` and `notyet:<id>` and state `completed`; `yes` from one member stores `connected: true`; `notyet` from the other stores `connected: false`; a second `yes` from the first replies ephemerally and `outcomesOf` still has two rows [M5]; (f) a pairing completed with no thread messages, no buttons and no partner Yes leaves both `needsAck: true`; ticking to `eligibleAt` yields a `createPrivateThread` for that member alone and a post whose content strictly equals `renderCopy(cfg, 'check-in')` with buttons `keep:<id>` and `pausme:<id>`; a further `tick` with a fresh stranger eligible creates no pairing containing them; `keep` then `tick` does; in a second scenario a partner's `yes` leaves both `needsAck: false` and a partner's `notyet` alone leaves both `true` [M6]; (g) `pause` reads back `paused`; `resume` and `join` on a paused row each read back `active` with `eligibleAt` equal to `max(now, lastPairingAt + cadenceMs)`; `forget` leaves `getMember` null and replies with the `forgotten` copy; `timezone` to a zone under which the locked start falls outside the member's mask posts `tz-changed-locked-call` with buttons `keepit:<id>` and `newtime:<id>`, and to a zone where it still fits posts nothing [M7]; (h) `admin-pair` on a feasible pair stores a pairing with `novelty: 'forced'`, on an infeasible pair (masks with no shared hours) stores nothing and replies with the `admin-pair-infeasible` copy, and `admin-status` content, with two members in the pool, one open pairing and no reconnections, contains the lines `pool: 2`, `open pairings: 1` and `reconnection share: 0%`, and after a second pairing with `novelty: 'reconnect'` is inserted contains `reconnection share: 50%` [M8]; (i) the simulated month asserts, at every hourly tick, that the ids across `openPairings` are unique; at the end, that every pairing has a non-null `threadId`, that for each pairing with a locked proposal whose `startUtc + callMs + 3600000` is at or before the final tick the fake's `createVoiceChannel` and `deleteChannel` counts for it are both 1 and for each pairing with a locked proposal whose `startUtc - 600000` is after the final tick both counts are 0, that each completed pairing has exactly one post whose content equals the `follow-up` copy, that for every member the gap between consecutive pairings' `createdAt` is `>= cadenceMs - pullForwardMaxMs`, and it logs `completion rate` and `reconnection share` as numbers between 0 and 1 [M9]; (j) `DEFAULT_MASK === DEFAULT_MASK_LITERAL` [M10].

**Stale-if:**
- path-absent: `src/types.ts`

### Task 14: The discord.js client and the entry point

**Type:** implementation
**Review:** peer

**Files:**
- Create: `src/adapters/discord/client.ts`
- Create: `src/main.ts`
- Test: `tests/discord-client.test.ts`

**Claim:** I export a token, run one command, and the bot is on my server with its commands registered; without a token it still tells me the invite link and checks my config. (derived)
Machine: M1. `toIncoming(i)` maps an interaction-like object to the `Incoming` union: a chat input `join` with a `timezone` string option and an `avoid` string option gives `{ kind: 'join', guildId, userId, timezone, avoid }`; `timezone`, `availability`, `pause`, `resume`, `forget` give their kinds; `matchbook status`, `matchbook config` and `matchbook pair` with user options give `admin-status`, `admin-config` and `admin-pair` with `a` and `b`; a button gives `{ kind: 'button', customId, channelId }`; a string select gives `{ kind: 'select', customId, values, channelId }`; anything else gives `null`.
M2. `toThreadMessage(m)` maps a message-like object in a thread from a non-bot user to `{ kind: 'thread-message', guildId, userId, threadId, at }` and returns `null` for a bot author or a non-thread channel.
M3. `createDiscordPort(client)` returns a `DiscordPort` whose `createVoiceChannel` calls `guild.channels.create` once with `type` voice, the given `parent`, and `permissionOverwrites` containing a deny of `ViewChannel` for the guild's `@everyone` role id and an allow of `ViewChannel` and `Connect` for each of the two member ids, and never calls `permissionOverwrites.edit` on any channel.
M4. `bun run src/main.ts --check-config config.example.toml` exits 0 with no `DISCORD_TOKEN` set and prints a line containing `permissions=360778304528` and a line containing `guilds: 1`.
M5. `bun run src/main.ts --check-config /nonexistent.toml` exits 1 and prints a line containing `nonexistent.toml`.
M6. `autocompleteZones(i)` responds with choices whose `name` equals `value`, whose values are exactly `zoneSuggestions(focused)` in order, and which number exactly 25 when the focused value is the empty string.

**Authorized-by:** #14; spec §7 "adapters/discord", "Permissions requested"; §11 "README quickstart"

**Interfaces:**
- Consumes: `createApp(deps: AppDeps): App`
- Consumes: `commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[]`
- Consumes: `zoneSuggestions(query: string, limit?: number): string[]`
- Consumes: `permissionsBitfield(): bigint`
- Consumes: `inviteUrl(clientId: string): string`
- Consumes: `loadConfig(path: string): ConfigStore`
- Consumes: `openStorage(path: string): Storage`
- Produces: `toIncoming(i: InteractionLike): Incoming | null`
- Produces: `toThreadMessage(m: MessageLike): Incoming | null`
- Produces: `createDiscordPort(client: ClientLike): DiscordPort`
- Produces: `autocompleteZones(i: AutocompleteLike): Promise<void>`
- Produces: `startBot(opts: { token: string; configPath: string; dbPath: string; tickMs: number }): Promise<void>`

**Context:** `InteractionLike`, `MessageLike`, `AutocompleteLike` and `ClientLike` are structural types you define in `client.ts` over the subset of `discord.js` surface the adapter touches (`isChatInputCommand()`, `isButton()`, `isStringSelectMenu()`, `commandName`, `options.getString`, `options.getSubcommand`, `options.getUser`, `customId`, `values`, `channelId`, `guildId`, `user.id`, `reply`, `respond`, `channel.isThread()`, `author.bot`, `guilds.fetch`, `channels.create`, `threads.create`, `members.add`, `send`, `setArchived`, `delete`) so the test can pass plain objects; real `discord.js` objects satisfy them structurally. `startBot` builds a `Client` with intents `Guilds`, `GuildMessages` and `GuildVoiceStates` (no `MessageContent`: the bot records that a member posted, never what), registers `commandDefinitions()` per configured guild through `client.application.commands.set(defs, guildId)` on `ready`, routes `InteractionCreate` through `toIncoming` to `app.handle` and replies with the returned `Reply` (buttons and selects rendered as `ActionRowBuilder`s, files as `AttachmentBuilder`), routes autocomplete through `autocompleteZones`, routes `MessageCreate` through `toThreadMessage`, and runs `app.tick(Date.now())` every `tickMs` on `setInterval`, which is the one timer in the codebase. `main.ts` reads `MATCHBOOK_CONFIG` (default `./config.toml`), `MATCHBOOK_DB` (default `./data/matchbook.db`, creating the directory), `DISCORD_TOKEN`, and `DISCORD_CLIENT_ID` (optional; when absent the invite line prints `client_id=<your-application-id>`). `--check-config <path>` loads the config, prints `guilds: <n>`, the permissions bitfield, the invite URL, and exits 0; a missing or invalid file prints the error with the path and exits 1. Without `--check-config` and without `DISCORD_TOKEN`, print a one-line error naming `DISCORD_TOKEN` and exit 1. The private voice channel is created with its overwrites in the create call and never edited afterwards (#14).

**Proof:**
- Test: `tests/discord-client.test.ts`
- Guard: `tests/discord-client.test.ts`
- Run: DISCORD_TOKEN= bun run src/main.ts --check-config config.example.toml > /tmp/check.txt && grep -q 'permissions=360778304528' /tmp/check.txt && grep -q 'guilds: 1' /tmp/check.txt
- Run: DISCORD_TOKEN= bun run src/main.ts --check-config /nonexistent.toml > /tmp/check2.txt 2>&1; test $? -eq 1 && grep -q 'nonexistent.toml' /tmp/check2.txt
- Legs: (a) for each of the eleven command shapes listed in M1 the test builds a plain object and asserts `toIncoming` deep-equals the expected `Incoming`, and an object whose `isChatInputCommand`, `isButton` and `isStringSelectMenu` all return `false` gives `null` [M1]; (b) a thread message from a user gives the four-field `thread-message`, a bot author gives `null`, and a non-thread channel gives `null` [M2]; (c) a fake client whose `guilds.fetch` returns a guild with a recording `channels.create` and `roles.everyone.id` of `'E'` yields exactly one `create` call with voice `type`, the given `parent`, overwrites containing `{ id: 'E', deny: [ViewChannel] }` and for each member `{ id, allow: [ViewChannel, Connect] }`, and the fake's `permissionOverwrites.edit` spy is never called [M3]; (d) the first Run exits 0 and its output contains the two literal substrings [M4]; (e) the second Run requires an exit status of exactly 1 from main and `nonexistent.toml` in its output, so a zero exit or a silent failure fails the leg [M5]; (f) an autocomplete-like object with a focused value `'oak'` receives one `respond` call whose choice values deep-equal `zoneSuggestions('oak')` and each choice has `name === value`; a focused value `''` receives choices of length exactly 25 whose values deep-equal `zoneSuggestions('')` [M6].

**Stale-if:**
- path-absent: `config.example.toml`

### Task 15: Install on the KmikeyM Discord and complete one call

**Type:** manual

**Files:** none

**Claim:** I run /join on the KmikeyM Discord and within about a day a private thread introduces me to a shareholder with a proposed time already in it; we each tap Works for me, get a calendar file, a voice room opens ten minutes early, and the next day the bot asks whether we connected. (elicited)
Machine: M1. The bot is invited with the invite URL that `--check-config` printed (Mike pastes that URL and no other), each of `/join`, `/timezone`, `/availability`, `/pause`, `/resume`, `/forget` and `/matchbook` appears in the KmikeyM server's command picker, and the container is running again after the host is rebooted.
M2. Mike and one shareholder each run `/join`, a private thread is created under the configured channel within 26 hours of the later of the two `/join`s and carries a proposal, both confirm, an `.ics` is posted, the room-link post's Discord timestamp is between 9 and 11 minutes before the locked start, the voice channel is absent from the category 61 minutes or more after the locked end, and the follow-up is posted 24 to 25 hours after the locked end and answered by at least one of them.

**Authorized-by:** #19; spec §12 "Rollout on the KmikeyM Discord"

**Interfaces:**
- Consumes: none
- Produces: none

**Context:** This is the step the fleet cannot do: it needs the Discord application, the token, a host, and two humans. Mike creates the application at discord.com/developers, copies the token into the host's environment, runs the check-config command for the invite URL, invites the bot, fills `config.toml` with the guild id, the parent channel id and the voice category id, and runs `docker compose up -d`. The first two members to join are paired within the holding window (§12). Record the outcome in `DECISIONS.md` in Charlie's workspace and file any `verify` issue the install surfaces.

**Proof:**
- Legs: (a) Mike records the invite URL he pasted and Charlie confirms it equals the `--check-config` output line, Mike types `/` in the server and confirms, naming them, that all seven commands are listed, and after `sudo reboot` on the host `docker compose ps` shows the service `running` [M1]; (b) Charlie reads the pairing thread and records in `DECISIONS.md` the two `/join` timestamps, the thread's creation timestamp (which must be at most 26 hours after the later `/join`), the pairing id, the parent channel it sits under (which must be the configured one), the thread's type as Discord shows it (which must be a private thread, not visible to a third member Mike asks to look for it), the proposal post's timestamp and proposed time, the two confirmation taps (one per member), the `.ics` attachment's filename, the locked start, the room-link post's timestamp (and that it is 9 to 11 minutes before the start), the time the channel was observed gone (61 minutes or more after the end), the follow-up post's timestamp (24 to 25 hours after the end), and the answer each member gave, of which at least one must be present [M2].

**Stale-if:**
- path-absent: `docker-compose.yml`
