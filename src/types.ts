// Shared shapes for Matchbook. Every unit imports from here and nothing
// redeclares these. The design lives in docs/design.md; section numbers below
// refer to it. Times are epoch milliseconds (UTC) everywhere. A `Mask` is the
// weekly availability pattern of §5: 168 characters of '0' or '1', index 0
// being Monday 00:00 in the member's own local time.

// ---------------------------------------------------------------- identity --

export type GuildId = string
export type MemberId = string // the Discord user id
export type Mask = string // 168 chars of '0' | '1'

export const HOURS_PER_WEEK = 168

// ------------------------------------------------------- strategies (§4) --

export type Signal =
  | 'pairing-history' // who has been paired with whom, and when
  | 'follow-up' // the per-member "did you two connect" answers
  | 'tags' // self-declared interests
  | 'availability' // the weekly mask
  | 'timezone'

/** Everything a strategy could read. A Context is a Pick of this. */
export interface AllSignals {
  'pairing-history': readonly PairingRecord[]
  'follow-up': readonly Outcome[]
  tags: ReadonlyMap<MemberId, readonly string[]>
  availability: ReadonlyMap<MemberId, Mask>
  timezone: ReadonlyMap<MemberId, string>
}

/** The signals a strategy declared, and nothing else (#6, made structural). */
export type Context<R extends Signal = Signal> = Pick<AllSignals, R> & {
  readonly now: number
}

export interface Participant {
  readonly id: MemberId
  readonly timezone: string // IANA zone id
  readonly mask: Mask
  readonly tags: readonly string[]
  readonly avoid: readonly MemberId[] // never paired with these (§4)
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

/** Weighted composition, configured per server (§4). Weights sum need not be 1. */
export type Weights = Readonly<Record<string, number>>

// ------------------------------------------------------------ pairings (§5) --

export type PairingState =
  | 'created'
  | 'time_proposed'
  | 'one_confirmed'
  | 'locked'
  | 'released'
  | 'completed'
  | 'expired'

export type Novelty = 'fresh' | 'held' | 'reconnect' | 'welcome' | 'forced'

export interface PairingRecord {
  readonly id: string
  readonly guildId: GuildId
  readonly members: readonly [MemberId, MemberId]
  readonly state: PairingState
  readonly novelty: Novelty
  readonly createdAt: number
  readonly threadId: string | null
  readonly voiceChannelId: string | null
}

export interface Proposal {
  readonly id: string
  readonly guildId: GuildId
  readonly pairingId: string
  readonly startUtc: number
  readonly durationMin: number
  readonly state: 'open' | 'superseded' | 'locked'
  readonly proposedBy: MemberId | null // null after /forget, or the bot's own
  readonly createdAt: number
}

export interface Confirmation {
  readonly guildId: GuildId
  readonly proposalId: string
  readonly memberId: MemberId
  readonly confirmedAt: number
}

export interface Outcome {
  readonly guildId: GuildId
  readonly pairingId: string
  readonly memberId: MemberId
  readonly connected: boolean // true for Yes, false for Not yet
  readonly answeredAt: number
}

// ------------------------------------------------------------- members (§6) --

export type MemberState = 'active' | 'paused'

export type AvailabilityPreset =
  | 'weekdays-9-5-off'
  | 'evenings-only'
  | 'weekends-only'
  | 'any-reasonable-hour'
  | 'custom'

export interface MemberRow {
  readonly guildId: GuildId
  readonly id: MemberId
  readonly state: MemberState
  readonly timezone: string
  readonly tags: readonly string[]
  readonly avoid: readonly MemberId[]
  readonly mask: Mask
  readonly preset: AvailabilityPreset
  readonly eligibleAt: number
  readonly welcome: boolean
  readonly lastWelcomeAt: number | null
  readonly needsAck: boolean
  readonly checkinsIgnored: number
  readonly checkinSentAt: number | null
  /** When the bot last told this member nobody shares their hours; null if never. */
  readonly overlapNoticeAt: number | null
  readonly joinedAt: number
}

export interface PairingMemberRow {
  readonly guildId: GuildId
  readonly pairingId: string
  readonly memberId: MemberId
  /** Most recent post by this member in the pairing thread; null if none. */
  readonly lastActivityAt: number | null
}

// ------------------------------------------------------- durable jobs (§6) --

export type JobKind =
  | 'eligible' // a member's eligible_at arrived: run the matcher for the guild
  | 'hold-expiry' // a lone member's 24h holding window ended
  | 'novelty-hold-expiry' // a member held for a stranger for one cadence
  | 'negotiation-release' // 48h since the latest proposal with no lock
  | 'room-open' // T-10: create the voice channel and post the link
  | 'room-close' // T+60: delete the voice channel
  | 'follow-up' // T+24h after a locked call, or release+7d with activity
  | 'expire' // release+7d with no activity: archive
  | 'check-in' // eligible_at arrived for a needs_ack member: send the check-in
  | 'check-in-expiry' // one cadence after a check-in with no answer
  | 'archive' // thread archival 7d after completion

export type JobState = 'pending' | 'done' | 'cancelled'

export interface Job {
  readonly id: string
  readonly guildId: GuildId
  readonly kind: JobKind
  /** What the job is about: a pairing id, a member id, or the guild id. */
  readonly refId: string
  readonly runAt: number
  readonly state: JobState
  readonly createdAt: number
}

export interface JobStore {
  insertJob(job: Job): void
  /** Pending jobs with runAt <= now, ascending by runAt then id. */
  dueJobs(now: number): Job[]
  /** Mark done. Returns false if the job was not pending (already done, cancelled, or unknown). */
  completeJob(id: string): boolean
  /** Cancel every pending job of this kind for this ref. Returns how many were cancelled. */
  cancelJobs(guildId: GuildId, kind: JobKind, refId: string): number
  pendingJobs(guildId: GuildId): Job[]
}

// ------------------------------------------------------------ storage (§6) --

export interface Storage extends JobStore {
  ensureGuild(guildId: GuildId, now: number): void

  getMember(guildId: GuildId, id: MemberId): MemberRow | null
  upsertMember(row: MemberRow): void
  deleteMember(guildId: GuildId, id: MemberId): void
  listMembers(guildId: GuildId): MemberRow[]

  insertPairing(p: PairingRecord, members: readonly PairingMemberRow[]): void
  getPairing(guildId: GuildId, id: string): PairingRecord | null
  updatePairing(p: PairingRecord): void
  /** Every pairing this member has been in, newest first. */
  pairingsOf(guildId: GuildId, id: MemberId): PairingRecord[]
  /** Pairings in a non-terminal state (not completed, not expired). */
  openPairings(guildId: GuildId): PairingRecord[]
  pairingMembers(guildId: GuildId, pairingId: string): PairingMemberRow[]
  touchPairingMember(guildId: GuildId, pairingId: string, id: MemberId, at: number): void
  pairingByThread(guildId: GuildId, threadId: string): PairingRecord | null

  insertProposal(p: Proposal): void
  updateProposal(p: Proposal): void
  proposalsOf(guildId: GuildId, pairingId: string): Proposal[]

  insertConfirmation(c: Confirmation): void
  confirmationsOf(guildId: GuildId, proposalId: string): Confirmation[]

  insertOutcome(o: Outcome): void
  outcomesOf(guildId: GuildId, pairingId: string): Outcome[]
  allOutcomes(guildId: GuildId): Outcome[]

  /**
   * /forget: delete the member row, their pairing memberships, confirmations
   * and outcomes; null proposedBy on proposals they authored. Partners' rows
   * are untouched (§9).
   */
  forgetMember(guildId: GuildId, id: MemberId): void
}

// ------------------------------------------------------------- config (§4) --

export interface GuildConfig {
  readonly guildId: GuildId
  /** Parent text channel that pairing threads are created under. */
  readonly threadParentChannelId: string
  /** Category the private voice channels are created in. */
  readonly voiceCategoryId: string
  readonly cadenceMs: number // default 14 days
  readonly holdingWindowMs: number // default 24h
  readonly pullForwardMaxMs: number // default 3 days
  readonly negotiationTimeoutMs: number // default 48h
  readonly callMinutes: number // default 30
  readonly weights: Weights // build 1 default: { 'round-robin': 1 }
  /** User-facing copy templates keyed by CopyKey; `{name}` placeholders. */
  readonly copy: Readonly<Partial<Record<CopyKey, string>>>
}

export type CopyKey =
  | 'join-confirmation'
  | 'join-updated'
  | 'resumed'
  | 'paused'
  | 'forgotten'
  | 'no-overlap'
  | 'holding-for-stranger'
  | 'met-everyone'
  | 'introduction'
  | 'proposal'
  | 'counter'
  | 'one-confirmed'
  | 'locked'
  | 'released-timeout'
  | 'released-overlap'
  | 'released-limit'
  | 'room-open'
  | 'follow-up'
  | 'follow-up-thanks'
  | 'check-in'
  | 'check-in-kept'
  | 'tz-changed-locked-call'
  | 'pick-another-time'
  | 'availability-menu'
  | 'availability-saved'
  | 'admin-status'
  | 'admin-pair-infeasible'
  | 'ics-summary'
  | 'ics-description'

export interface ConfigStore {
  get(guildId: GuildId): GuildConfig | null
  guildIds(): GuildId[]
}

// ----------------------------------------------------- discord port (§7) --

export interface Button {
  readonly id: string // custom id, `<action>:<refId>` by convention
  readonly label: string
  readonly style: 'primary' | 'secondary' | 'success' | 'danger'
}

export interface SelectOption {
  readonly value: string
  readonly label: string
}

export interface SelectMenu {
  readonly id: string
  readonly placeholder: string
  readonly options: readonly SelectOption[]
  readonly min?: number
  readonly max?: number
}

export interface OutgoingMessage {
  readonly content: string
  readonly buttons?: readonly Button[]
  readonly select?: SelectMenu
  readonly file?: { readonly name: string; readonly bytes: Uint8Array }
}

/** A slash command or button reply. Ephemeral replies are seen only by the invoker. */
export interface Reply extends OutgoingMessage {
  readonly ephemeral: boolean
}

/** The only surface that touches Discord. adapters/discord implements it; tests fake it. */
export interface DiscordPort {
  createPrivateThread(guildId: GuildId, parentChannelId: string, name: string, members: readonly MemberId[]): Promise<{ id: string; url: string }>
  post(guildId: GuildId, channelId: string, message: OutgoingMessage): Promise<{ id: string }>
  archiveThread(guildId: GuildId, threadId: string): Promise<void>
  /** View Channel and Connect for `members` are set in the create call itself (#14). */
  createVoiceChannel(guildId: GuildId, categoryId: string, name: string, members: readonly MemberId[]): Promise<{ id: string; url: string }>
  deleteChannel(guildId: GuildId, channelId: string): Promise<void>
  /** The member's display name in this guild, read once and never stored; the id when unknown (#27). */
  displayName(guildId: GuildId, memberId: MemberId): Promise<string>
}

// ---------------------------------------------------------- app port (§7) --

/** What the Discord adapter hands the app. One shape per interaction kind. */
export type Incoming =
  | { kind: 'join'; guildId: GuildId; userId: MemberId; timezone?: string; avoid?: string }
  | { kind: 'timezone'; guildId: GuildId; userId: MemberId; timezone: string }
  | { kind: 'availability'; guildId: GuildId; userId: MemberId }
  | { kind: 'pause'; guildId: GuildId; userId: MemberId }
  | { kind: 'resume'; guildId: GuildId; userId: MemberId }
  | { kind: 'forget'; guildId: GuildId; userId: MemberId }
  | { kind: 'admin-status'; guildId: GuildId; userId: MemberId }
  | { kind: 'admin-pair'; guildId: GuildId; userId: MemberId; a: MemberId; b: MemberId }
  | { kind: 'admin-config'; guildId: GuildId; userId: MemberId }
  | { kind: 'button'; guildId: GuildId; userId: MemberId; customId: string; channelId: string }
  | { kind: 'select'; guildId: GuildId; userId: MemberId; customId: string; values: readonly string[]; channelId: string }
  | { kind: 'thread-message'; guildId: GuildId; userId: MemberId; threadId: string; at: number }

export interface App {
  /** Handle one interaction and return what to reply, if anything. */
  handle(incoming: Incoming, now: number): Promise<Reply | null>
  /** Run every due job once. Returns how many jobs fired. */
  tick(now: number): Promise<number>
}
