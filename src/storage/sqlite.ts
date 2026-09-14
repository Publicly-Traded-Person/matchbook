// Durable storage for Matchbook (§6), on bun:sqlite. Every shape comes from
// src/types.ts; nothing here is platform-specific. Every table carries a
// `guild_id` and every statement below is scoped by it, so two servers sharing
// one database file never see each other's rows.
//
// The SQL stays deliberately plain: no vendor-only table options, no JSON
// functions (arrays are stored as JSON text and parsed in TypeScript), and the
// one setting touched at open is journal_mode. There are no FOREIGN KEY
// clauses either (nor any delete action naming one): a
// pairing may be written for members whose rows have already been forgotten,
// and /forget removes a member while their partner's pairing lives on.

import { Database } from 'bun:sqlite'
import type {
  AvailabilityPreset,
  Confirmation,
  GuildId,
  Job,
  JobKind,
  JobState,
  Mask,
  MemberId,
  MemberRow,
  MemberState,
  Novelty,
  Outcome,
  PairingMemberRow,
  PairingRecord,
  PairingState,
  Proposal,
  Storage,
} from '../types'

/** The tables of §6, created in this order when a database is opened. */
export const SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS guilds (
    guild_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    guild_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    state TEXT NOT NULL,
    timezone TEXT NOT NULL,
    tags TEXT NOT NULL,
    avoid_notes TEXT NOT NULL,
    availability_mask TEXT NOT NULL,
    availability_preset TEXT NOT NULL,
    eligible_at INTEGER NOT NULL,
    welcome INTEGER NOT NULL,
    last_welcome_at INTEGER,
    needs_ack INTEGER NOT NULL,
    checkins_ignored INTEGER NOT NULL,
    checkin_sent_at INTEGER,
    overlap_notice_at INTEGER,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, discord_user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS pairings (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    thread_id TEXT,
    voice_channel_id TEXT,
    state TEXT NOT NULL,
    novelty TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pairing_members (
    guild_id TEXT NOT NULL,
    pairing_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    last_activity_at INTEGER,
    PRIMARY KEY (guild_id, pairing_id, discord_user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    pairing_id TEXT NOT NULL,
    start_utc INTEGER NOT NULL,
    duration_min INTEGER NOT NULL,
    state TEXT NOT NULL,
    proposed_by TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS confirmations (
    guild_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    confirmed_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, proposal_id, discord_user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS outcomes (
    guild_id TEXT NOT NULL,
    pairing_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    connected INTEGER NOT NULL,
    answered_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, pairing_id, discord_user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
]

/** What a statement can be bound to: every column here is text, number or null. */
type Bind = string | number | null

/** `openStorage` returns a `Storage`, plus the two escape hatches tests use. */
export interface SqliteStorage extends Storage {
  readonly db: Database
  /** Run one read-only statement and return its rows, for schema assertions. */
  rawQuery(sql: string): unknown[]
}

// ------------------------------------------------------------- row shapes --

interface MemberRaw {
  guild_id: string
  discord_user_id: string
  state: string
  timezone: string
  tags: string
  avoid_notes: string
  availability_mask: string
  availability_preset: string
  eligible_at: number
  welcome: number
  last_welcome_at: number | null
  needs_ack: number
  checkins_ignored: number
  checkin_sent_at: number | null
  overlap_notice_at: number | null
  joined_at: number
}

interface PairingRaw {
  id: string
  guild_id: string
  thread_id: string | null
  voice_channel_id: string | null
  state: string
  novelty: string
  created_at: number
}

interface PairingMemberRaw {
  guild_id: string
  pairing_id: string
  discord_user_id: string
  last_activity_at: number | null
}

interface ProposalRaw {
  id: string
  guild_id: string
  pairing_id: string
  start_utc: number
  duration_min: number
  state: string
  proposed_by: string | null
  created_at: number
}

interface ConfirmationRaw {
  guild_id: string
  proposal_id: string
  discord_user_id: string
  confirmed_at: number
}

interface OutcomeRaw {
  guild_id: string
  pairing_id: string
  discord_user_id: string
  connected: number
  answered_at: number
}

interface JobRaw {
  id: string
  guild_id: string
  kind: string
  ref_id: string
  run_at: number
  state: string
  created_at: number
}

// ------------------------------------------------------------ conversions --

const bool = (n: number): boolean => n !== 0
const flag = (b: boolean): number => (b ? 1 : 0)

/** Arrays live as JSON text; a row written by hand may still be missing one. */
const strings = (text: string | null): readonly string[] => {
  if (text === null || text === '') return []
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? (parsed as string[]) : []
}

const toMember = (r: MemberRaw): MemberRow => ({
  guildId: r.guild_id,
  id: r.discord_user_id,
  state: r.state as MemberState,
  timezone: r.timezone,
  tags: strings(r.tags),
  avoid: strings(r.avoid_notes),
  mask: r.availability_mask as Mask,
  preset: r.availability_preset as AvailabilityPreset,
  eligibleAt: r.eligible_at,
  welcome: bool(r.welcome),
  lastWelcomeAt: r.last_welcome_at,
  needsAck: bool(r.needs_ack),
  checkinsIgnored: r.checkins_ignored,
  checkinSentAt: r.checkin_sent_at,
  overlapNoticeAt: r.overlap_notice_at,
  joinedAt: r.joined_at,
})

const toPairingMember = (r: PairingMemberRaw): PairingMemberRow => ({
  guildId: r.guild_id,
  pairingId: r.pairing_id,
  memberId: r.discord_user_id,
  lastActivityAt: r.last_activity_at,
})

const toProposal = (r: ProposalRaw): Proposal => ({
  id: r.id,
  guildId: r.guild_id,
  pairingId: r.pairing_id,
  startUtc: r.start_utc,
  durationMin: r.duration_min,
  state: r.state as Proposal['state'],
  proposedBy: r.proposed_by,
  createdAt: r.created_at,
})

const toConfirmation = (r: ConfirmationRaw): Confirmation => ({
  guildId: r.guild_id,
  proposalId: r.proposal_id,
  memberId: r.discord_user_id,
  confirmedAt: r.confirmed_at,
})

const toOutcome = (r: OutcomeRaw): Outcome => ({
  guildId: r.guild_id,
  pairingId: r.pairing_id,
  memberId: r.discord_user_id,
  connected: bool(r.connected),
  answeredAt: r.answered_at,
})

const toJob = (r: JobRaw): Job => ({
  id: r.id,
  guildId: r.guild_id,
  kind: r.kind as JobKind,
  refId: r.ref_id,
  runAt: r.run_at,
  state: r.state as JobState,
  createdAt: r.created_at,
})

// ------------------------------------------------------------------- open --

/**
 * Open (or create) the database at `path` and return the §6 storage. Pass
 * `':memory:'` for a private database, which is what tests use.
 */
export function openStorage(path: string): SqliteStorage {
  const db = new Database(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  for (const statement of SCHEMA_SQL) db.exec(statement)

  const all = <T>(sql: string, ...params: Bind[]): T[] => db.query(sql).all(...params) as T[]
  const one = <T>(sql: string, ...params: Bind[]): T | null => {
    const rows = all<T>(sql, ...params)
    return rows.length > 0 ? (rows[0] as T) : null
  }
  const run = (sql: string, ...params: Bind[]): void => {
    db.query(sql).run(...params)
  }

  // Reads that must come back in the order they were written use the implicit
  // insertion order of the row store: a pairing's two members are a tuple, and
  // the outcomes of a pairing read best oldest first.
  const MEMBER_COLUMNS =
    'guild_id, discord_user_id, state, timezone, tags, avoid_notes, availability_mask, ' +
    'availability_preset, eligible_at, welcome, last_welcome_at, needs_ack, ' +
    'checkins_ignored, checkin_sent_at, overlap_notice_at, joined_at'
  const PAIRING_COLUMNS = 'id, guild_id, thread_id, voice_channel_id, state, novelty, created_at'
  const PROPOSAL_COLUMNS =
    'id, guild_id, pairing_id, start_utc, duration_min, state, proposed_by, created_at'
  const JOB_COLUMNS = 'id, guild_id, kind, ref_id, run_at, state, created_at'

  const membersOfPairing = (guildId: GuildId, pairingId: string): PairingMemberRow[] =>
    all<PairingMemberRaw>(
      `SELECT guild_id, pairing_id, discord_user_id, last_activity_at
         FROM pairing_members
        WHERE guild_id = ? AND pairing_id = ?
        ORDER BY rowid`,
      guildId,
      pairingId,
    ).map(toPairingMember)

  const toPairing = (r: PairingRaw): PairingRecord => {
    const ids = membersOfPairing(r.guild_id, r.id).map((m) => m.memberId)
    return {
      id: r.id,
      guildId: r.guild_id,
      members: [ids[0] ?? '', ids[1] ?? ''],
      state: r.state as PairingState,
      novelty: r.novelty as Novelty,
      createdAt: r.created_at,
      threadId: r.thread_id,
      voiceChannelId: r.voice_channel_id,
    }
  }

  const storage: SqliteStorage = {
    db,

    rawQuery(sql: string): unknown[] {
      return db.query(sql).all() as unknown[]
    },

    // ----------------------------------------------------------- guilds --

    ensureGuild(guildId, now) {
      run(
        `INSERT INTO guilds (guild_id, created_at) VALUES (?, ?)
           ON CONFLICT (guild_id) DO NOTHING`,
        guildId,
        now,
      )
    },

    // ---------------------------------------------------------- members --

    getMember(guildId, id) {
      const row = one<MemberRaw>(
        `SELECT ${MEMBER_COLUMNS} FROM members WHERE guild_id = ? AND discord_user_id = ?`,
        guildId,
        id,
      )
      return row === null ? null : toMember(row)
    },

    upsertMember(row) {
      run(
        `INSERT INTO members (${MEMBER_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET
             state = excluded.state,
             timezone = excluded.timezone,
             tags = excluded.tags,
             avoid_notes = excluded.avoid_notes,
             availability_mask = excluded.availability_mask,
             availability_preset = excluded.availability_preset,
             eligible_at = excluded.eligible_at,
             welcome = excluded.welcome,
             last_welcome_at = excluded.last_welcome_at,
             needs_ack = excluded.needs_ack,
             checkins_ignored = excluded.checkins_ignored,
             checkin_sent_at = excluded.checkin_sent_at,
             overlap_notice_at = excluded.overlap_notice_at,
             joined_at = excluded.joined_at`,
        row.guildId,
        row.id,
        row.state,
        row.timezone,
        JSON.stringify(row.tags),
        JSON.stringify(row.avoid),
        row.mask,
        row.preset,
        row.eligibleAt,
        flag(row.welcome),
        row.lastWelcomeAt,
        flag(row.needsAck),
        row.checkinsIgnored,
        row.checkinSentAt,
        row.overlapNoticeAt,
        row.joinedAt,
      )
    },

    deleteMember(guildId, id) {
      run('DELETE FROM members WHERE guild_id = ? AND discord_user_id = ?', guildId, id)
    },

    listMembers(guildId) {
      return all<MemberRaw>(
        `SELECT ${MEMBER_COLUMNS} FROM members WHERE guild_id = ? ORDER BY discord_user_id`,
        guildId,
      ).map(toMember)
    },

    // --------------------------------------------------------- pairings --

    insertPairing(p, members) {
      db.transaction(() => {
        run(
          `INSERT INTO pairings (${PAIRING_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          p.id,
          p.guildId,
          p.threadId,
          p.voiceChannelId,
          p.state,
          p.novelty,
          p.createdAt,
        )
        for (const m of members) {
          run(
            `INSERT INTO pairing_members
               (guild_id, pairing_id, discord_user_id, last_activity_at)
             VALUES (?, ?, ?, ?)`,
            m.guildId,
            m.pairingId,
            m.memberId,
            m.lastActivityAt,
          )
        }
      })()
    },

    getPairing(guildId, id) {
      const row = one<PairingRaw>(
        `SELECT ${PAIRING_COLUMNS} FROM pairings WHERE guild_id = ? AND id = ?`,
        guildId,
        id,
      )
      return row === null ? null : toPairing(row)
    },

    updatePairing(p) {
      run(
        `UPDATE pairings
            SET thread_id = ?, voice_channel_id = ?, state = ?, novelty = ?, created_at = ?
          WHERE guild_id = ? AND id = ?`,
        p.threadId,
        p.voiceChannelId,
        p.state,
        p.novelty,
        p.createdAt,
        p.guildId,
        p.id,
      )
    },

    pairingsOf(guildId, id) {
      return all<PairingRaw>(
        `SELECT p.id, p.guild_id, p.thread_id, p.voice_channel_id,
                p.state, p.novelty, p.created_at
           FROM pairings p
           JOIN pairing_members pm
             ON pm.guild_id = p.guild_id AND pm.pairing_id = p.id
          WHERE p.guild_id = ? AND pm.discord_user_id = ?
          ORDER BY p.created_at DESC, p.id ASC`,
        guildId,
        id,
      ).map(toPairing)
    },

    openPairings(guildId) {
      return all<PairingRaw>(
        `SELECT ${PAIRING_COLUMNS}
           FROM pairings
          WHERE guild_id = ? AND state <> 'completed' AND state <> 'expired'
          ORDER BY created_at ASC, id ASC`,
        guildId,
      ).map(toPairing)
    },

    pairingMembers(guildId, pairingId) {
      return membersOfPairing(guildId, pairingId)
    },

    touchPairingMember(guildId, pairingId, id, at) {
      run(
        `UPDATE pairing_members
            SET last_activity_at = ?
          WHERE guild_id = ? AND pairing_id = ? AND discord_user_id = ?`,
        at,
        guildId,
        pairingId,
        id,
      )
    },

    pairingByThread(guildId, threadId) {
      const row = one<PairingRaw>(
        `SELECT ${PAIRING_COLUMNS} FROM pairings WHERE guild_id = ? AND thread_id = ?`,
        guildId,
        threadId,
      )
      return row === null ? null : toPairing(row)
    },

    // ------------------------------------------- proposals and answers --

    insertProposal(p) {
      run(
        `INSERT INTO proposals (${PROPOSAL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        p.id,
        p.guildId,
        p.pairingId,
        p.startUtc,
        p.durationMin,
        p.state,
        p.proposedBy,
        p.createdAt,
      )
    },

    updateProposal(p) {
      run(
        `UPDATE proposals
            SET pairing_id = ?, start_utc = ?, duration_min = ?, state = ?,
                proposed_by = ?, created_at = ?
          WHERE guild_id = ? AND id = ?`,
        p.pairingId,
        p.startUtc,
        p.durationMin,
        p.state,
        p.proposedBy,
        p.createdAt,
        p.guildId,
        p.id,
      )
    },

    proposalsOf(guildId, pairingId) {
      return all<ProposalRaw>(
        `SELECT ${PROPOSAL_COLUMNS}
           FROM proposals
          WHERE guild_id = ? AND pairing_id = ?
          ORDER BY created_at ASC, rowid ASC`,
        guildId,
        pairingId,
      ).map(toProposal)
    },

    insertConfirmation(c) {
      run(
        `INSERT INTO confirmations (guild_id, proposal_id, discord_user_id, confirmed_at)
         VALUES (?, ?, ?, ?)
           ON CONFLICT (guild_id, proposal_id, discord_user_id) DO UPDATE SET
             confirmed_at = excluded.confirmed_at`,
        c.guildId,
        c.proposalId,
        c.memberId,
        c.confirmedAt,
      )
    },

    confirmationsOf(guildId, proposalId) {
      return all<ConfirmationRaw>(
        `SELECT guild_id, proposal_id, discord_user_id, confirmed_at
           FROM confirmations
          WHERE guild_id = ? AND proposal_id = ?
          ORDER BY rowid`,
        guildId,
        proposalId,
      ).map(toConfirmation)
    },

    insertOutcome(o) {
      run(
        `INSERT INTO outcomes (guild_id, pairing_id, discord_user_id, connected, answered_at)
         VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (guild_id, pairing_id, discord_user_id) DO UPDATE SET
             connected = excluded.connected,
             answered_at = excluded.answered_at`,
        o.guildId,
        o.pairingId,
        o.memberId,
        flag(o.connected),
        o.answeredAt,
      )
    },

    outcomesOf(guildId, pairingId) {
      return all<OutcomeRaw>(
        `SELECT guild_id, pairing_id, discord_user_id, connected, answered_at
           FROM outcomes
          WHERE guild_id = ? AND pairing_id = ?
          ORDER BY rowid`,
        guildId,
        pairingId,
      ).map(toOutcome)
    },

    allOutcomes(guildId) {
      return all<OutcomeRaw>(
        `SELECT guild_id, pairing_id, discord_user_id, connected, answered_at
           FROM outcomes
          WHERE guild_id = ?
          ORDER BY rowid`,
        guildId,
      ).map(toOutcome)
    },

    // ----------------------------------------------------------- forget --

    forgetMember(guildId, id) {
      db.transaction(() => {
        run('DELETE FROM pairing_members WHERE guild_id = ? AND discord_user_id = ?', guildId, id)
        run('DELETE FROM confirmations WHERE guild_id = ? AND discord_user_id = ?', guildId, id)
        run('DELETE FROM outcomes WHERE guild_id = ? AND discord_user_id = ?', guildId, id)
        run('DELETE FROM members WHERE guild_id = ? AND discord_user_id = ?', guildId, id)
        run(
          'UPDATE proposals SET proposed_by = NULL WHERE guild_id = ? AND proposed_by = ?',
          guildId,
          id,
        )
        // A job about a member nobody remembers has nobody to act for. Jobs
        // whose ref is a pairing id stay: the partner's thread still runs.
        run(
          `UPDATE jobs SET state = 'cancelled'
            WHERE guild_id = ? AND ref_id = ? AND state = 'pending'`,
          guildId,
          id,
        )
      })()
    },

    // ------------------------------------------------------------- jobs --

    insertJob(job) {
      run(
        `INSERT INTO jobs (${JOB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        job.id,
        job.guildId,
        job.kind,
        job.refId,
        job.runAt,
        job.state,
        job.createdAt,
      )
    },

    dueJobs(now) {
      return all<JobRaw>(
        `SELECT ${JOB_COLUMNS}
           FROM jobs
          WHERE state = 'pending' AND run_at <= ?
          ORDER BY run_at ASC, id ASC`,
        now,
      ).map(toJob)
    },

    completeJob(id) {
      const row = one<{ state: string }>('SELECT state FROM jobs WHERE id = ?', id)
      if (row === null || row.state !== 'pending') return false
      run(`UPDATE jobs SET state = 'done' WHERE id = ? AND state = 'pending'`, id)
      return true
    },

    cancelJobs(guildId, kind: JobKind, refId) {
      const pending = all<{ id: string }>(
        `SELECT id FROM jobs
          WHERE guild_id = ? AND kind = ? AND ref_id = ? AND state = 'pending'`,
        guildId,
        kind,
        refId,
      )
      if (pending.length === 0) return 0
      run(
        `UPDATE jobs SET state = 'cancelled'
          WHERE guild_id = ? AND kind = ? AND ref_id = ? AND state = 'pending'`,
        guildId,
        kind,
        refId,
      )
      return pending.length
    },

    pendingJobs(guildId) {
      return all<JobRaw>(
        `SELECT ${JOB_COLUMNS}
           FROM jobs
          WHERE guild_id = ? AND state = 'pending'
          ORDER BY run_at ASC, id ASC`,
        guildId,
      ).map(toJob)
    },
  }

  return storage
}
