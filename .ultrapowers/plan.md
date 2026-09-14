# Matchbook build 1, part 2: enrollment, the app, the client

**Grammar:** claims-v1

**Claim:** I run /join on the KmikeyM Discord and within about a day a private thread introduces me to a shareholder with a proposed time already in it; we each tap Works for me, get a calendar file, a voice room opens ten minutes early, and the next day the bot asks whether we connected. (elicited)
**Summary:** Matchbook is a Discord bot that introduces two people and then schedules the call, and build 1 is the shortest loop that produces a completed call and a measured answer. It exists because the 2019 Dialup line was how shareholders knew each other, it stopped existing, and every replacement stops at the introduction and leaves the scheduling to politeness. What you get is a bot you can self-host from one config file, pairing by rotation behind a can-they-actually-meet check, with the scorers left off until there are real pairings to learn from.

**Goal:** Part 2 of build 1 of `docs/design.md` (#19), after PR #23 merged eleven of fourteen tasks: standing enrollment with the ack gate, rolling pairing by `round-robin` behind the feasibility precondition, the whole scheduling state machine with .ics and a T-10 voice room, the follow-up, SQLite storage behind an interface, durable jobs, a thin discord.js adapter, and a Docker Compose deploy. Scorers, tags and the welcome pool are build 2 and are not built here; their tests against the interface are.
**Closes:** #4 #5 #6 #9 #14 #15 #16 #18 #19

**Tech Stack:** Bun 1.3, TypeScript 5 (strict, `noUncheckedIndexedAccess`), `bun:sqlite`, `Bun.TOML`, `discord.js` 14.27. `bootstrapCmd: bun install`. `testCmd: bunx tsc --noEmit && bun test`. State is SQLite behind the `Storage` interface per spec §4 and §6; this plan deliberately leaves the TinyBase default of the greenfield reference because the spec names SQLite and generic SQL.
**Exam command:** bun test {paths}
**Spec:** `docs/design.md` in this repo, at BASE. Section numbers in every Context refer to it. Every shape the tasks share is already committed in `src/types.ts` at BASE; tasks import from it and never redeclare it.

**Parallelization rationale:** This is the re-drive of run-2's three unfinished tasks; the other eleven merged in PR #23 and are at BASE. Wave 1 is Task 4 alone (enrollment; run-2's session ended without a hand-off after a one-line review finding on the `ids` argument, which must stay required). Wave 2 is Task 13 alone and wave 3 is Task 14 alone, for the reasons the original plan gave. The original rationale follows for the record: Wave 1 was twelve wide (Tasks 1 to 12): availability, strategies, matching, enrollment, the pool decision, the scheduling machine, calendar, jobs, storage, config, the Discord command definitions and the deploy files share only `src/types.ts`, which exists at BASE, and each takes its collaborators as injected parameters or plain data, so none needs a sibling's runtime behaviour. Wave 2 is Task 13 alone: the app composes the real modules and its exam is a simulated month over their actual behaviour, which no contract can promise. Wave 3 is Task 14 alone: the entry point boots the real app, and its config check runs the real loader. Task 15 is manual and waves nothing.

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
