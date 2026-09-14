// Exam for Task 9 "SQLite storage".
//
// Every test below names the Machine clause (M1..M7) and the Proof leg
// ((a)..(g)) it encodes, so a reader can map an assertion back to the task.
//
// Global constraints honoured here: each test opens its own `:memory:`
// database (tests never share on-disk state) and nothing platform-specific is
// imported; every shared shape comes from `src/types.ts`.

import { describe, expect, test } from "bun:test"
import { SCHEMA_SQL, openStorage } from "../src/storage/sqlite"
import type {
  Confirmation,
  Job,
  MemberRow,
  Outcome,
  PairingMemberRow,
  PairingRecord,
  PairingState,
  Proposal,
  Storage,
} from "../src/types"

// ------------------------------------------------------------- helpers --

/** 168 characters of '0'/'1' (§5), distinguishable from a constant mask. */
const MASK = "01".repeat(84)

function open(...guildIds: readonly string[]): Storage {
  const storage = openStorage(":memory:")
  for (const guildId of guildIds) storage.ensureGuild(guildId, 1_000)
  return storage
}

/**
 * Schema introspection. The task allows the implementation to expose either a
 * `rawQuery(sql)` helper on the returned object or the raw `db`; this exam
 * accepts either.
 */
function rawRows(storage: Storage, sql: string): Array<Record<string, unknown>> {
  const asAny = storage as unknown as {
    rawQuery?: (sql: string) => unknown[]
    db?: {
      query?: (sql: string) => { all: () => unknown[] }
      prepare?: (sql: string) => { all: () => unknown[] }
    }
  }
  if (typeof asAny.rawQuery === "function") {
    return asAny.rawQuery(sql) as Array<Record<string, unknown>>
  }
  const db = asAny.db
  if (db && typeof db.query === "function") {
    return db.query(sql).all() as Array<Record<string, unknown>>
  }
  if (db && typeof db.prepare === "function") {
    return db.prepare(sql).all() as Array<Record<string, unknown>>
  }
  throw new Error(
    "openStorage() exposes neither a rawQuery(sql) helper nor a `db` handle for schema inspection",
  )
}

function columnsOf(storage: Storage, table: string): string[] {
  return rawRows(storage, `PRAGMA table_info(${table})`).map((r) => String(r.name))
}

function member(over: Partial<MemberRow> & { guildId: string; id: string }): MemberRow {
  return {
    state: "active",
    timezone: "America/Los_Angeles",
    tags: [],
    avoid: [],
    mask: MASK,
    preset: "custom",
    eligibleAt: 0,
    welcome: false,
    lastWelcomeAt: null,
    needsAck: false,
    checkinsIgnored: 0,
    checkinSentAt: null,
    overlapNoticeAt: null,
    joinedAt: 0,
    ...over,
  }
}

function pairing(over: Partial<PairingRecord> & { guildId: string; id: string }): PairingRecord {
  return {
    members: ["m1", "m2"],
    state: "created",
    novelty: "fresh",
    createdAt: 5_000,
    threadId: null,
    voiceChannelId: null,
    ...over,
  }
}

function pairingMember(
  guildId: string,
  pairingId: string,
  memberId: string,
  lastActivityAt: number | null = null,
): PairingMemberRow {
  return { guildId, pairingId, memberId, lastActivityAt }
}

function job(over: Partial<Job> & { guildId: string; id: string }): Job {
  return {
    kind: "check-in",
    refId: "m1",
    runAt: 0,
    state: "pending",
    createdAt: 1,
    ...over,
  }
}

const byMemberId = (a: { memberId: string }, b: { memberId: string }) =>
  a.memberId.localeCompare(b.memberId)

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id)

// ------------------------------------------------- M1 / Proof leg (a) --

/** The eight tables of §6, sorted. */
const TABLES = [
  "confirmations",
  "guilds",
  "jobs",
  "members",
  "outcomes",
  "pairing_members",
  "pairings",
  "proposals",
]

/** The columns the task's Context names for each table. */
const COLUMNS: Record<string, readonly string[]> = {
  guilds: ["guild_id", "created_at"],
  members: [
    "guild_id",
    "discord_user_id",
    "state",
    "timezone",
    "tags",
    "avoid_notes",
    "availability_mask",
    "availability_preset",
    "eligible_at",
    "welcome",
    "last_welcome_at",
    "needs_ack",
    "checkins_ignored",
    "checkin_sent_at",
    "overlap_notice_at",
    "joined_at",
  ],
  pairings: ["id", "guild_id", "thread_id", "voice_channel_id", "state", "novelty", "created_at"],
  pairing_members: ["guild_id", "pairing_id", "discord_user_id", "last_activity_at"],
  proposals: [
    "id",
    "guild_id",
    "pairing_id",
    "start_utc",
    "duration_min",
    "state",
    "proposed_by",
    "created_at",
  ],
  confirmations: ["guild_id", "proposal_id", "discord_user_id", "confirmed_at"],
  outcomes: ["guild_id", "pairing_id", "discord_user_id", "connected", "answered_at"],
  jobs: ["id", "guild_id", "kind", "ref_id", "run_at", "state", "created_at"],
}

describe("M1: openStorage(':memory:') builds the eight guild-scoped tables", () => {
  test("leg (a): the sorted table names from sqlite_master are exactly the eight", () => {
    const storage = open()
    const names = rawRows(storage, "SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => String(r.name))
      .sort()
    expect(names).toEqual(TABLES)
  })

  test("leg (a): PRAGMA table_info lists a guild_id column on each of the eight", () => {
    const storage = open()
    for (const table of TABLES) {
      expect(columnsOf(storage, table)).toContain("guild_id")
    }
  })

  test("leg (a): each table carries the columns the data model names", () => {
    const storage = open()
    for (const table of TABLES) {
      const actual = columnsOf(storage, table)
      for (const column of COLUMNS[table] ?? []) {
        expect(actual).toContain(column)
      }
    }
  })

  test("leg (a): SCHEMA_SQL is the eight CREATE TABLE IF NOT EXISTS statements, in order", () => {
    expect(Array.isArray(SCHEMA_SQL)).toBe(true)
    expect(SCHEMA_SQL.length).toBe(8)
    for (const statement of SCHEMA_SQL) {
      expect(statement).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i)
    }
    const joined = SCHEMA_SQL.join("\n")
    for (const table of TABLES) {
      expect(joined).toContain(table)
    }
  })
})

// ------------------------------------------------- M2 / Proof leg (b) --

describe("M2: member rows round-trip and stay inside their guild", () => {
  const populated = member({
    guildId: "g1",
    id: "m1",
    state: "active",
    timezone: "Europe/Berlin",
    tags: ["a", "b"],
    avoid: ["z"],
    mask: MASK,
    preset: "evenings-only",
    eligibleAt: 1_700,
    welcome: true,
    lastWelcomeAt: 1_600,
    needsAck: true,
    checkinsIgnored: 2,
    checkinSentAt: null,
    overlapNoticeAt: 1_500,
    joinedAt: 1_400,
  })

  test("leg (b): a fully populated MemberRow reads back field for field", () => {
    expect(populated.mask.length).toBe(168)
    const storage = open("g1")
    storage.upsertMember(populated)
    const read = storage.getMember("g1", "m1")
    expect(read).toEqual(populated)
    // The arrays and the null timestamp survive their storage encoding.
    expect(read?.tags).toEqual(["a", "b"])
    expect(read?.avoid).toEqual(["z"])
    expect(read?.checkinSentAt).toBe(null)
    expect(read?.mask).toBe(MASK)
    expect(read?.mask.length).toBe(168)
    expect(read?.welcome).toBe(true)
    expect(read?.needsAck).toBe(true)
  })

  test("leg (b): a second upsert with a changed state reads back changed", () => {
    const storage = open("g1")
    storage.upsertMember(populated)
    const paused: MemberRow = { ...populated, state: "paused" }
    storage.upsertMember(paused)
    expect(storage.getMember("g1", "m1")).toEqual(paused)
    expect(storage.listMembers("g1")).toEqual([paused])
  })

  test("leg (b): getMember for another guild is null and listMembers('g2') is []", () => {
    const storage = open("g1", "g2", "other")
    storage.upsertMember(populated)
    storage.upsertMember(member({ guildId: "g1", id: "m2" }))
    expect(storage.getMember("other", "m1")).toBe(null)
    expect(storage.listMembers("g2")).toEqual([])
    expect(storage.listMembers("g1").length).toBe(2)
  })
})

// ------------------------------------------------- M3 / Proof leg (c) --

describe("M3: pairings and their members", () => {
  test("leg (c): insertPairing then getPairing and pairingMembers round-trip", () => {
    const storage = open("g1", "g2")
    const p = pairing({
      guildId: "g1",
      id: "p1",
      members: ["m1", "m2"],
      state: "created",
      novelty: "welcome",
      createdAt: 5_000,
      threadId: "t1",
      voiceChannelId: "v1",
    })
    storage.insertPairing(p, [
      pairingMember("g1", "p1", "m1"),
      pairingMember("g1", "p1", "m2"),
    ])

    expect(storage.getPairing("g1", "p1")).toEqual(p)
    // Every read is scoped by guild_id.
    expect(storage.getPairing("g2", "p1")).toBe(null)

    const members = [...storage.pairingMembers("g1", "p1")].sort(byMemberId)
    expect(members.length).toBe(2)
    expect(members).toEqual([
      pairingMember("g1", "p1", "m1", null),
      pairingMember("g1", "p1", "m2", null),
    ])
  })

  test("leg (c): pairingsOf returns a member's pairings newest first", () => {
    const storage = open("g1")
    const older = pairing({ guildId: "g1", id: "p-old", createdAt: 5_000, threadId: "t-old" })
    const newer = pairing({
      guildId: "g1",
      id: "p-new",
      members: ["m1", "m3"],
      createdAt: 9_000,
      threadId: "t-new",
    })
    storage.insertPairing(older, [
      pairingMember("g1", "p-old", "m1"),
      pairingMember("g1", "p-old", "m2"),
    ])
    storage.insertPairing(newer, [
      pairingMember("g1", "p-new", "m1"),
      pairingMember("g1", "p-new", "m3"),
    ])

    const found = storage.pairingsOf("g1", "m1")
    expect(ids(found)).toEqual(["p-new", "p-old"])
    expect(found).toEqual([newer, older])
    expect(ids(storage.pairingsOf("g1", "m3"))).toEqual(["p-new"])
  })

  test("leg (c): openPairings returns the five non-terminal states and no others", () => {
    const storage = open("g1")
    const states: readonly PairingState[] = [
      "created",
      "time_proposed",
      "one_confirmed",
      "locked",
      "released",
      "completed",
      "expired",
    ]
    states.forEach((state, i) => {
      const id = `p-${state}`
      storage.insertPairing(
        pairing({ guildId: "g1", id, state, createdAt: 1_000 + i, threadId: `t-${state}` }),
        [pairingMember("g1", id, "m1"), pairingMember("g1", id, "m2")],
      )
    })

    expect(ids(storage.openPairings("g1")).sort()).toEqual(
      ["p-created", "p-locked", "p-one_confirmed", "p-released", "p-time_proposed"].sort(),
    )
  })

  test("leg (c): touchPairingMember records lastActivityAt for that member only", () => {
    const storage = open("g1")
    storage.insertPairing(pairing({ guildId: "g1", id: "p1", threadId: "t1" }), [
      pairingMember("g1", "p1", "m1"),
      pairingMember("g1", "p1", "m2"),
    ])
    storage.touchPairingMember("g1", "p1", "m1", 4_242)

    const members = [...storage.pairingMembers("g1", "p1")].sort(byMemberId)
    expect(members).toEqual([
      pairingMember("g1", "p1", "m1", 4_242),
      pairingMember("g1", "p1", "m2", null),
    ])
  })

  test("leg (c): pairingByThread finds by threadId and is null for an unknown thread", () => {
    const storage = open("g1")
    const p = pairing({ guildId: "g1", id: "p1", threadId: "t1" })
    storage.insertPairing(p, [pairingMember("g1", "p1", "m1"), pairingMember("g1", "p1", "m2")])

    expect(storage.pairingByThread("g1", "t1")).toEqual(p)
    expect(storage.pairingByThread("g1", "nope")).toBe(null)
  })
})

// ------------------------------------------------- M4 / Proof leg (d) --

describe("M4: proposals, confirmations and outcomes", () => {
  const proposal: Proposal = {
    id: "pr1",
    guildId: "g1",
    pairingId: "p1",
    startUtc: 7_000,
    durationMin: 30,
    state: "open",
    proposedBy: "m1",
    createdAt: 6_000,
  }
  const confirmation: Confirmation = {
    guildId: "g1",
    proposalId: "pr1",
    memberId: "m1",
    confirmedAt: 6_500,
  }
  const outcomeYes: Outcome = {
    guildId: "g1",
    pairingId: "p1",
    memberId: "m1",
    connected: true,
    answeredAt: 8_000,
  }
  const outcomeNo: Outcome = {
    guildId: "g1",
    pairingId: "p1",
    memberId: "m2",
    connected: false,
    answeredAt: 8_100,
  }

  function seeded(): Storage {
    const storage = open("g1")
    storage.insertPairing(pairing({ guildId: "g1", id: "p1", threadId: "t1" }), [
      pairingMember("g1", "p1", "m1"),
      pairingMember("g1", "p1", "m2"),
    ])
    return storage
  }

  test("leg (d): a proposal, a confirmation and an outcome each read back whole", () => {
    const storage = seeded()
    storage.insertProposal(proposal)
    storage.insertConfirmation(confirmation)
    storage.insertOutcome(outcomeYes)

    expect(storage.proposalsOf("g1", "p1")).toEqual([proposal])
    expect(storage.confirmationsOf("g1", "pr1")).toEqual([confirmation])
    expect(storage.outcomesOf("g1", "p1")).toEqual([outcomeYes])
  })

  test("leg (d): updateProposal with state 'superseded' reads back superseded", () => {
    const storage = seeded()
    storage.insertProposal(proposal)
    const superseded: Proposal = { ...proposal, state: "superseded" }
    storage.updateProposal(superseded)

    expect(storage.proposalsOf("g1", "p1")).toEqual([superseded])
  })

  test("leg (d): allOutcomes returns every outcome of the guild", () => {
    const storage = seeded()
    storage.insertOutcome(outcomeYes)
    storage.insertOutcome(outcomeNo)

    const all = [...storage.allOutcomes("g1")].sort(byMemberId)
    expect(all).toEqual([outcomeYes, outcomeNo])
    // `connected` is a boolean on both sides of its 0/1 encoding.
    expect(all.map((o) => o.connected)).toEqual([true, false])
    expect(storage.allOutcomes("g2")).toEqual([])
  })
})

// ------------------------------------------------- M5 / Proof leg (e) --

describe("M5: forgetMember deletes only what is the member's own", () => {
  const m1 = member({ guildId: "g1", id: "m1", tags: ["a"], joinedAt: 100 })
  const m2 = member({ guildId: "g1", id: "m2", tags: ["b"], joinedAt: 200 })
  const p = pairing({
    guildId: "g1",
    id: "p1",
    members: ["m1", "m2"],
    state: "locked",
    createdAt: 5_000,
    threadId: "t1",
  })
  const proposal: Proposal = {
    id: "pr1",
    guildId: "g1",
    pairingId: "p1",
    startUtc: 7_000,
    durationMin: 30,
    state: "open",
    proposedBy: "m1",
    createdAt: 6_000,
  }
  const conf1: Confirmation = { guildId: "g1", proposalId: "pr1", memberId: "m1", confirmedAt: 6_100 }
  const conf2: Confirmation = { guildId: "g1", proposalId: "pr1", memberId: "m2", confirmedAt: 6_200 }
  const out1: Outcome = { guildId: "g1", pairingId: "p1", memberId: "m1", connected: true, answeredAt: 8_000 }
  const out2: Outcome = { guildId: "g1", pairingId: "p1", memberId: "m2", connected: false, answeredAt: 8_100 }
  const checkIn = job({ guildId: "g1", id: "job-check-in", kind: "check-in", refId: "m1", runAt: 100 })
  const followUp = job({ guildId: "g1", id: "job-follow-up", kind: "follow-up", refId: "p1", runAt: 100 })

  function forgotten(): Storage {
    const storage = open("g1", "g2")
    storage.upsertMember(m1)
    storage.upsertMember(m2)
    storage.upsertMember(member({ guildId: "g2", id: "m1", tags: ["elsewhere"] }))
    storage.insertPairing(p, [pairingMember("g1", "p1", "m1"), pairingMember("g1", "p1", "m2")])
    storage.insertProposal(proposal)
    storage.insertConfirmation(conf1)
    storage.insertConfirmation(conf2)
    storage.insertOutcome(out1)
    storage.insertOutcome(out2)
    storage.insertJob(checkIn)
    storage.insertJob(followUp)
    storage.forgetMember("g1", "m1")
    return storage
  }

  test("leg (e): the member's own rows are gone", () => {
    const storage = forgotten()
    expect(storage.getMember("g1", "m1")).toBe(null)
    expect(storage.pairingMembers("g1", "p1")).toEqual([pairingMember("g1", "p1", "m2", null)])
    expect(storage.confirmationsOf("g1", "pr1")).toEqual([conf2])
    expect(storage.outcomesOf("g1", "p1")).toEqual([out2])
  })

  test("leg (e): proposals they authored keep the row with proposedBy null", () => {
    const storage = forgotten()
    const proposals = storage.proposalsOf("g1", "p1")
    expect(proposals).toEqual([{ ...proposal, proposedBy: null }])
    expect(proposals[0]?.proposedBy).toBe(null)
  })

  test("leg (e): pending jobs about the member are cancelled, jobs about the pairing are not", () => {
    const storage = forgotten()
    expect(ids(storage.dueJobs(200))).toEqual(["job-follow-up"])
    expect(ids(storage.pendingJobs("g1"))).toEqual(["job-follow-up"])
  })

  test("leg (e): the partner's row, the pairing and the partner's outcome are untouched", () => {
    const storage = forgotten()
    expect(storage.getMember("g1", "m2")).toEqual(m2)

    // The pairing row itself survives /forget. `members` is the one field not
    // compared: §6 gives `pairings` no member columns, so the pair is read back
    // out of `pairing_members` - the very rows /forget deletes for m1. Every
    // other field of the record must be untouched.
    const still = storage.getPairing("g1", "p1")
    expect(still).not.toBe(null)
    const { members: _forgotten, ...survived } = still as PairingRecord
    const { members: _expected, ...expectedSurvived } = p
    expect(survived).toEqual(expectedSurvived)
    expect(still?.members).toContain("m2")
    expect(storage.pairingByThread("g1", "t1")?.id).toBe("p1")

    expect(storage.allOutcomes("g1")).toEqual([out2])
    // The same user id in another guild is a different person's row here.
    expect(storage.getMember("g2", "m1")).toEqual(
      member({ guildId: "g2", id: "m1", tags: ["elsewhere"] }),
    )
  })
})

// ------------------------------------------------- M6 / Proof leg (f) --

describe("M6: the JobStore behaves as src/types.ts documents", () => {
  const j30 = job({ guildId: "g1", id: "j30", kind: "expire", refId: "p1", runAt: 30, createdAt: 1 })
  const j10 = job({ guildId: "g1", id: "j10", kind: "check-in", refId: "m1", runAt: 10, createdAt: 2 })
  const j20 = job({ guildId: "g1", id: "j20", kind: "room-open", refId: "p2", runAt: 20, createdAt: 3 })
  const jb = job({ guildId: "g1", id: "b", kind: "archive", refId: "p3", runAt: 5, createdAt: 4 })
  const ja = job({ guildId: "g1", id: "a", kind: "archive", refId: "p4", runAt: 5, createdAt: 5 })

  test("leg (f): dueJobs(now) is pending jobs with runAt <= now, ascending by runAt then id", () => {
    const storage = open("g1", "g2")
    storage.insertJob(j30)
    storage.insertJob(j10)
    storage.insertJob(j20)

    expect(ids(storage.dueJobs(25))).toEqual(["j10", "j20"])
    expect(storage.dueJobs(25)[0]).toEqual(j10)

    storage.insertJob(jb)
    storage.insertJob(ja)
    expect(ids(storage.dueJobs(5))).toEqual(["a", "b"])
  })

  test("leg (f): completeJob returns true once and false thereafter", () => {
    const storage = open("g1")
    storage.insertJob(j10)
    expect(storage.completeJob("j10")).toBe(true)
    expect(storage.completeJob("j10")).toBe(false)
    expect(storage.completeJob("no-such-job")).toBe(false)
    expect(ids(storage.dueJobs(100))).toEqual([])
  })

  test("leg (f): cancelJobs returns the count and drops them out of dueJobs", () => {
    const storage = open("g1", "g2")
    for (const j of [j30, j10, j20, jb, ja]) storage.insertJob(j)

    expect(storage.completeJob("j10")).toBe(true)
    expect(storage.cancelJobs("g1", "room-open", "p2")).toBe(1)
    expect(ids(storage.dueJobs(100))).toEqual(["a", "b", "j30"])
    expect(ids(storage.pendingJobs("g1")).sort()).toEqual(["a", "b", "j30"])
  })

  test("leg (f): pendingJobs is guild-scoped", () => {
    const storage = open("g1", "g2")
    for (const j of [j30, j10, j20, jb, ja]) storage.insertJob(j)
    expect(storage.pendingJobs("g2")).toEqual([])
  })
})

// ------------------------------------------------- M7 / Proof leg (g) --

describe("M7: the SQL stays generic", () => {
  test("leg (g): no AUTOINCREMENT, WITHOUT ROWID, json_extract or STRICT, and only the two pragmas", async () => {
    const path = new URL("../src/storage/sqlite.ts", import.meta.url).pathname
    const source = await Bun.file(path).text()

    expect(source.includes("AUTOINCREMENT")).toBe(false)
    expect(/WITHOUT\s+ROWID/.test(source)).toBe(false)
    expect(source.includes("json_extract")).toBe(false)
    expect(source.includes("STRICT")).toBe(false)

    const pragmas = [...source.matchAll(/pragma\s+([A-Za-z_]+)/gi)].map((m) =>
      String(m[1]).toLowerCase(),
    )
    for (const pragma of pragmas) {
      expect(["foreign_keys", "journal_mode"]).toContain(pragma)
    }
  })
})
