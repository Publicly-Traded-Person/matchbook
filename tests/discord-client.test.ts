// Exam for Task 14: the discord.js client adapter and the entry point. Every
// assertion below names the Proof leg (a)-(f) and the Machine clause M1-M6 it
// comes from, so the exam maps back to the contract.
//
// The task's Context says `InteractionLike`, `MessageLike`, `AutocompleteLike`
// and `ClientLike` are structural types the implementation declares over the
// subset of discord.js surface it touches, "so the test can pass plain
// objects". The exam therefore resolves the four in-process produced symbols
// out of a dynamic import of src/adapters/discord/client.ts and gives each a local
// signature with an `unknown` parameter: it pins the Produces names and the
// return shapes (`Incoming` and `DiscordPort` both come from src/types.ts) and
// stays out of the way of how the implementation spells its own structural
// types. A missing module reads as "the implementation does not exist yet"; a
// missing export names itself in the thrown message.
//
// No test here reads the wall clock: the one timestamp is the constant `AT`.
// The two subprocess legs point MATCHBOOK_DB at their own mkdtemp directory so
// the exam writes nothing into the tree.

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { zoneSuggestions } from "../src/adapters/discord/zones"
import type { DiscordPort, Incoming } from "../src/types"

const MODULE_PATH = "../src/adapters/discord/client"

const api: Record<string, unknown> = await import(MODULE_PATH)

function produced<T>(name: string): T {
  const value = api[name]
  if (value === undefined) {
    throw new Error(
      `Produces: ${name} is not exported by src/adapters/discord/client.ts`,
    )
  }
  return value as T
}

// ------------------------------------------------------------- the surface --

const toIncoming = produced<(i: unknown) => Incoming | null>("toIncoming")
const toThreadMessage =
  produced<(m: unknown) => Incoming | null>("toThreadMessage")
const createDiscordPort =
  produced<(client: unknown) => DiscordPort>("createDiscordPort")
const autocompleteZones =
  produced<(i: unknown) => Promise<void>>("autocompleteZones")

// --------------------------------------------------------------- the fakes --

const GUILD = "G1"
const USER = "U1"
const CHANNEL = "C1"
const THREAD = "T1"
/** A fixed instant. Nothing in this file reads a clock. */
const AT = 1_700_000_000_000

/**
 * The three predicates the Context names, plus the neighbouring ones a real
 * discord.js interaction answers, so an adapter that guards with one of them
 * does not trip over a missing method.
 */
function predicates(which: {
  chatInput?: boolean
  button?: boolean
  select?: boolean
  autocomplete?: boolean
}): Record<string, () => boolean> {
  const chatInput = which.chatInput === true
  const button = which.button === true
  const select = which.select === true
  return {
    isChatInputCommand: () => chatInput,
    isCommand: () => chatInput,
    isButton: () => button,
    isStringSelectMenu: () => select,
    isAnySelectMenu: () => select,
    isSelectMenu: () => select,
    isAutocomplete: () => which.autocomplete === true,
    isModalSubmit: () => false,
    isContextMenuCommand: () => false,
    isUserContextMenuCommand: () => false,
    isMessageContextMenuCommand: () => false,
    isRepliable: () => true,
    inGuild: () => true,
  }
}

type OptionValues = {
  strings?: Record<string, string>
  users?: Record<string, string>
  subcommand?: string
}

/** A chat input interaction: `commandName`, `options.getString/getUser/getSubcommand`. */
function commandInteraction(
  commandName: string,
  values: OptionValues = {},
): Record<string, unknown> {
  const strings = values.strings ?? {}
  const users = values.users ?? {}
  return {
    ...predicates({ chatInput: true }),
    guildId: GUILD,
    guild: { id: GUILD },
    channelId: CHANNEL,
    user: { id: USER },
    member: { id: USER, user: { id: USER } },
    commandName,
    options: {
      getString(name: string): string | null {
        return strings[name] ?? null
      },
      getUser(name: string): { id: string } | null {
        const id = users[name]
        return id === undefined ? null : { id }
      },
      getSubcommand(required?: boolean): string | null {
        if (values.subcommand === undefined) {
          if (required === false) return null
          throw new Error(`/${commandName} has no subcommand`)
        }
        return values.subcommand
      },
      getSubcommandGroup(): string | null {
        return null
      },
    },
    async reply(): Promise<void> {},
  }
}

function buttonInteraction(customId: string): Record<string, unknown> {
  return {
    ...predicates({ button: true }),
    guildId: GUILD,
    guild: { id: GUILD },
    channelId: CHANNEL,
    user: { id: USER },
    member: { id: USER, user: { id: USER } },
    customId,
    async reply(): Promise<void> {},
  }
}

function selectInteraction(
  customId: string,
  values: readonly string[],
): Record<string, unknown> {
  return {
    ...predicates({ select: true }),
    guildId: GUILD,
    guild: { id: GUILD },
    channelId: CHANNEL,
    user: { id: USER },
    member: { id: USER, user: { id: USER } },
    customId,
    values: [...values],
    async reply(): Promise<void> {},
  }
}

/**
 * A message-like object. The Context's surface list names `channel.isThread()`
 * and `author.bot` but not the field `at` is read from, so the fake carries
 * both `createdTimestamp` and `createdAt` at the same instant.
 */
function threadMessage(
  over: { bot?: boolean; thread?: boolean } = {},
): Record<string, unknown> {
  const inThread = over.thread ?? true
  return {
    id: "M1",
    guildId: GUILD,
    guild: { id: GUILD },
    channelId: THREAD,
    createdTimestamp: AT,
    createdAt: new Date(AT),
    content: "hello",
    author: { id: USER, bot: over.bot ?? false },
    channel: {
      id: THREAD,
      type: inThread ? 12 : 0,
      isThread: () => inThread,
      isTextBased: () => true,
      async send(): Promise<{ id: string }> {
        return { id: "S1" }
      },
    },
  }
}

// --------------------------- permission and channel type value normalization --

// Overwrite entries are compared by flag *name*, so `PermissionFlagsBits.
// ViewChannel` (a bigint), a combined bigint, a `PermissionsBitField` and the
// string `'ViewChannel'` all read the same. Bits with no name here surface as
// `bit:<n>` so a failure says what the implementation actually asked for.
const FLAG_BITS: Readonly<Record<string, bigint>> = Object.freeze({
  CreateInstantInvite: 1n << 0n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  AddReactions: 1n << 6n,
  ViewAuditLog: 1n << 7n,
  PrioritySpeaker: 1n << 8n,
  Stream: 1n << 9n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  SendTTSMessages: 1n << 12n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  UseExternalEmojis: 1n << 18n,
  ViewGuildInsights: 1n << 19n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  MuteMembers: 1n << 22n,
  DeafenMembers: 1n << 23n,
  MoveMembers: 1n << 24n,
  UseVAD: 1n << 25n,
  ChangeNickname: 1n << 26n,
  ManageNicknames: 1n << 27n,
  ManageRoles: 1n << 28n,
  ManageWebhooks: 1n << 29n,
  ManageGuildExpressions: 1n << 30n,
  UseApplicationCommands: 1n << 31n,
  RequestToSpeak: 1n << 32n,
  ManageEvents: 1n << 33n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  UseExternalStickers: 1n << 37n,
  SendMessagesInThreads: 1n << 38n,
  UseEmbeddedActivities: 1n << 39n,
  ModerateMembers: 1n << 40n,
})

function addBits(bits: bigint, into: Set<string>): void {
  let rest = bits
  for (const [name, bit] of Object.entries(FLAG_BITS)) {
    if ((rest & bit) === bit) {
      into.add(name)
      rest &= ~bit
    }
  }
  if (rest !== 0n) into.add(`bit:${rest.toString()}`)
}

/** The permission names an `allow`/`deny` value stands for, sorted. */
function flagNames(value: unknown): string[] {
  const names = new Set<string>()

  const add = (v: unknown): void => {
    if (v === null || v === undefined) return
    if (Array.isArray(v)) {
      for (const entry of v) add(entry)
      return
    }
    if (typeof v === "bigint") {
      addBits(v, names)
      return
    }
    if (typeof v === "number") {
      addBits(BigInt(Math.trunc(v)), names)
      return
    }
    if (typeof v === "string") {
      if (Object.hasOwn(FLAG_BITS, v)) names.add(v)
      else if (/^\d+$/.test(v)) addBits(BigInt(v), names)
      else names.add(v)
      return
    }
    if (typeof v === "object") {
      const bag = v as { toArray?: () => string[]; bitfield?: unknown }
      if (typeof bag.toArray === "function") {
        for (const name of bag.toArray()) add(name)
        return
      }
      if (bag.bitfield !== undefined) {
        add(bag.bitfield)
        return
      }
    }
    names.add(String(v))
  }

  add(value)
  return [...names].sort()
}

/** `ChannelType.GuildVoice` is 2; a name spelling reads the same. */
function channelTypeName(value: unknown): string {
  const raw = String(value)
  if (raw === "2" || raw === "GuildVoice" || raw === "GUILD_VOICE" || raw === "voice") {
    return "GuildVoice"
  }
  return raw
}

// ---------------------------------------------------------------- leg (a) M1 --

describe("leg (a) [M1] toIncoming maps interactions to the Incoming union", () => {
  test("/join with timezone and avoid gives the five-field join", () => {
    const expected: Incoming = {
      kind: "join",
      guildId: GUILD,
      userId: USER,
      timezone: "Europe/London",
      avoid: "U9,U8",
    }
    expect(
      toIncoming(
        commandInteraction("join", {
          strings: { timezone: "Europe/London", avoid: "U9,U8" },
        }),
      ),
    ).toEqual(expected)
  })

  test("/timezone gives the timezone kind", () => {
    const expected: Incoming = {
      kind: "timezone",
      guildId: GUILD,
      userId: USER,
      timezone: "Asia/Tokyo",
    }
    expect(
      toIncoming(
        commandInteraction("timezone", { strings: { timezone: "Asia/Tokyo" } }),
      ),
    ).toEqual(expected)
  })

  test("/availability gives the availability kind", () => {
    const expected: Incoming = {
      kind: "availability",
      guildId: GUILD,
      userId: USER,
    }
    expect(toIncoming(commandInteraction("availability"))).toEqual(expected)
  })

  test("/pause gives the pause kind", () => {
    const expected: Incoming = { kind: "pause", guildId: GUILD, userId: USER }
    expect(toIncoming(commandInteraction("pause"))).toEqual(expected)
  })

  test("/resume gives the resume kind", () => {
    const expected: Incoming = { kind: "resume", guildId: GUILD, userId: USER }
    expect(toIncoming(commandInteraction("resume"))).toEqual(expected)
  })

  test("/forget gives the forget kind", () => {
    const expected: Incoming = { kind: "forget", guildId: GUILD, userId: USER }
    expect(toIncoming(commandInteraction("forget"))).toEqual(expected)
  })

  test("/matchbook status gives admin-status", () => {
    const expected: Incoming = {
      kind: "admin-status",
      guildId: GUILD,
      userId: USER,
    }
    expect(
      toIncoming(commandInteraction("matchbook", { subcommand: "status" })),
    ).toEqual(expected)
  })

  test("/matchbook config gives admin-config", () => {
    const expected: Incoming = {
      kind: "admin-config",
      guildId: GUILD,
      userId: USER,
    }
    expect(
      toIncoming(commandInteraction("matchbook", { subcommand: "config" })),
    ).toEqual(expected)
  })

  test("/matchbook pair with user options a and b gives admin-pair", () => {
    const expected: Incoming = {
      kind: "admin-pair",
      guildId: GUILD,
      userId: USER,
      a: "UA",
      b: "UB",
    }
    expect(
      toIncoming(
        commandInteraction("matchbook", {
          subcommand: "pair",
          users: { a: "UA", b: "UB" },
        }),
      ),
    ).toEqual(expected)
  })

  test("a button gives the button kind with its customId and channelId", () => {
    const expected: Incoming = {
      kind: "button",
      guildId: GUILD,
      userId: USER,
      customId: "confirm:p1",
      channelId: CHANNEL,
    }
    expect(toIncoming(buttonInteraction("confirm:p1"))).toEqual(expected)
  })

  test("a string select gives the select kind with its values", () => {
    const expected: Incoming = {
      kind: "select",
      guildId: GUILD,
      userId: USER,
      customId: "avail-days",
      values: ["0", "2"],
      channelId: CHANNEL,
    }
    expect(toIncoming(selectInteraction("avail-days", ["0", "2"]))).toEqual(
      expected,
    )
  })

  test("an interaction that is none of the three gives null", () => {
    const other = {
      ...predicates({}),
      guildId: GUILD,
      channelId: CHANNEL,
      user: { id: USER },
      customId: "modal:1",
    }
    expect(toIncoming(other)).toBeNull()
  })
})

// ---------------------------------------------------------------- leg (b) M2 --

describe("leg (b) [M2] toThreadMessage", () => {
  test("a thread message from a user gives the four-field thread-message", () => {
    const expected: Incoming = {
      kind: "thread-message",
      guildId: GUILD,
      userId: USER,
      threadId: THREAD,
      at: AT,
    }
    expect(toThreadMessage(threadMessage())).toEqual(expected)
  })

  test("a bot author gives null", () => {
    expect(toThreadMessage(threadMessage({ bot: true }))).toBeNull()
  })

  test("a non-thread channel gives null", () => {
    expect(toThreadMessage(threadMessage({ thread: false }))).toBeNull()
  })
})

// ---------------------------------------------------------------- leg (c) M3 --

type CreatePayload = Record<string, unknown>

function fakeClient(): {
  client: Record<string, unknown>
  createCalls: CreatePayload[]
  overwriteEdits: unknown[][]
  fetched: string[]
} {
  const createCalls: CreatePayload[] = []
  const overwriteEdits: unknown[][] = []
  const fetched: string[] = []

  const voiceChannel: Record<string, unknown> = {
    id: "V1",
    name: "call",
    type: 2,
    url: `https://discord.com/channels/${GUILD}/V1`,
    guild: { id: GUILD },
    permissionOverwrites: {
      // The spy leg (c) requires never to be called: the overwrites belong in
      // the create call itself (#14).
      async edit(...args: unknown[]): Promise<void> {
        overwriteEdits.push(args)
      },
    },
    async send(): Promise<{ id: string }> {
      return { id: "S1" }
    },
    async setName(): Promise<void> {},
    async delete(): Promise<void> {},
  }

  const guild: Record<string, unknown> = {
    id: GUILD,
    // Distinct from the guild id on purpose: the adapter has to read
    // roles.everyone.id rather than assume it equals the guild id.
    roles: { everyone: { id: "E" } },
    channels: {
      async create(payload: CreatePayload): Promise<Record<string, unknown>> {
        createCalls.push(payload)
        return voiceChannel
      },
      async fetch(): Promise<Record<string, unknown>> {
        return voiceChannel
      },
      cache: new Map<string, unknown>([["V1", voiceChannel]]),
    },
    members: {
      async add(): Promise<void> {},
      async fetch(id: string): Promise<{ id: string; displayName?: string }> {
        if (id === "GHOST") throw new Error("Unknown Member")
        return { id, displayName: `Name ${id}` }
      },
    },
  }

  const client: Record<string, unknown> = {
    guilds: {
      async fetch(id: string): Promise<Record<string, unknown>> {
        fetched.push(id)
        return guild
      },
      cache: new Map<string, unknown>([[GUILD, guild]]),
    },
    channels: {
      async fetch(): Promise<Record<string, unknown>> {
        return voiceChannel
      },
      cache: new Map<string, unknown>([["V1", voiceChannel]]),
    },
  }

  return { client, createCalls, overwriteEdits, fetched }
}

describe("leg (c) [M3] createDiscordPort creates the voice room with its overwrites", () => {
  test("createVoiceChannel calls guild.channels.create exactly once", async () => {
    const fake = fakeClient()
    const port = createDiscordPort(fake.client)
    await port.createVoiceChannel(GUILD, "CAT1", "matchbook call", ["U1", "U2"])
    expect(fake.createCalls.length).toBe(1)
  })

  test("the create call carries a voice type and the given parent", async () => {
    const fake = fakeClient()
    const port = createDiscordPort(fake.client)
    await port.createVoiceChannel(GUILD, "CAT1", "matchbook call", ["U1", "U2"])
    const payload = fake.createCalls[0]
    if (payload === undefined) throw new Error("no channels.create call")
    expect(channelTypeName(payload.type)).toBe("GuildVoice")
    expect(payload.parent ?? payload.parentId).toBe("CAT1")
  })

  test("the overwrites deny ViewChannel to the @everyone role id 'E'", async () => {
    const fake = fakeClient()
    const port = createDiscordPort(fake.client)
    await port.createVoiceChannel(GUILD, "CAT1", "matchbook call", ["U1", "U2"])
    const payload = fake.createCalls[0]
    if (payload === undefined) throw new Error("no channels.create call")
    const overwrites = payload.permissionOverwrites
    expect(Array.isArray(overwrites)).toBe(true)
    const entries = overwrites as Array<Record<string, unknown>>
    const everyone = entries.filter((o) => String(o.id) === "E")
    expect(everyone.length).toBe(1)
    expect(flagNames(everyone[0]?.deny)).toEqual(["ViewChannel"])
    expect(flagNames(everyone[0]?.allow)).toEqual([])
  })

  test("the overwrites allow ViewChannel and Connect to each of the two members", async () => {
    const fake = fakeClient()
    const port = createDiscordPort(fake.client)
    await port.createVoiceChannel(GUILD, "CAT1", "matchbook call", ["U1", "U2"])
    const payload = fake.createCalls[0]
    if (payload === undefined) throw new Error("no channels.create call")
    const entries = payload.permissionOverwrites as Array<
      Record<string, unknown>
    >
    for (const member of ["U1", "U2"]) {
      const forMember = entries.filter((o) => String(o.id) === member)
      expect(forMember.length).toBe(1)
      expect(flagNames(forMember[0]?.allow)).toEqual(["Connect", "ViewChannel"])
      expect(flagNames(forMember[0]?.deny)).toEqual([])
    }
  })

  test("permissionOverwrites.edit is never called on the created channel", async () => {
    const fake = fakeClient()
    const port = createDiscordPort(fake.client)
    await port.createVoiceChannel(GUILD, "CAT1", "matchbook call", ["U1", "U2"])
    expect(fake.overwriteEdits).toEqual([])
  })

  test("createVoiceChannel returns the created channel's id", async () => {
    const fake = fakeClient()
    const port = createDiscordPort(fake.client)
    const made = await port.createVoiceChannel(GUILD, "CAT1", "matchbook call", [
      "U1",
      "U2",
    ])
    expect(made.id).toBe("V1")
    expect(typeof made.url).toBe("string")
  })

  test("the port implements the whole DiscordPort surface", () => {
    const fake = fakeClient()
    const port = createDiscordPort(fake.client)
    for (const name of [
      "createPrivateThread",
      "post",
      "archiveThread",
      "createVoiceChannel",
      "deleteChannel",
    ] as const) {
      expect(typeof port[name]).toBe("function")
    }
  })
})

// ---------------------------------------------------------- legs (d) and (e) --

const REPO_ROOT = join(import.meta.dir, "..")

type MainRun = { code: number; stdout: string; combined: string }

/** One `bun run src/main.ts ...` with no DISCORD_TOKEN, as the Run lines spell it. */
async function runMain(args: readonly string[]): Promise<MainRun> {
  const dbDir = mkdtempSync(join(tmpdir(), "matchbook-exam-14-"))
  const env: Record<string, string | undefined> = {
    ...process.env,
    DISCORD_TOKEN: "",
    MATCHBOOK_DB: join(dbDir, "matchbook.db"),
  }
  delete env.DISCORD_CLIENT_ID
  delete env.MATCHBOOK_CONFIG

  const proc = Bun.spawn(["bun", "run", "src/main.ts", ...args], {
    cwd: REPO_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, stdout, combined: stdout + stderr }
}

describe("createDiscordPort.displayName reads the guild member's display name", () => {
  test("returns the member's displayName", async () => {
    const fake = fakeClient()
    const port = createDiscordPort(fake.client)
    expect(await port.displayName(GUILD, "U9")).toBe("Name U9")
  })

  test("falls back to the id when the member cannot be fetched", async () => {
    const fake = fakeClient()
    const port = createDiscordPort(fake.client)
    expect(await port.displayName(GUILD, "GHOST")).toBe("GHOST")
  })
})

describe("leg (d) [M4] --check-config on the shipped example", () => {
  test("exits 0 and prints the permissions bitfield and the guild count", async () => {
    const run = await runMain(["--check-config", "config.example.toml"])
    expect(run.code).toBe(0)
    expect(run.stdout).toContain("permissions=360778304528")
    expect(run.stdout).toContain("guilds: 1")
  }, 60_000)
})

describe("leg (e) [M5] --check-config on a missing file", () => {
  test("exits with status exactly 1 and names the path", async () => {
    const run = await runMain(["--check-config", "/nonexistent.toml"])
    expect(run.code).toBe(1)
    expect(run.combined).toContain("nonexistent.toml")
  }, 60_000)
})

// ---------------------------------------------------------------- leg (f) M6 --

type Choice = { name: string; value: string }

function autocompleteInteraction(focused: string): {
  interaction: Record<string, unknown>
  responses: unknown[]
} {
  const responses: unknown[] = []
  const interaction: Record<string, unknown> = {
    ...predicates({ autocomplete: true }),
    guildId: GUILD,
    guild: { id: GUILD },
    channelId: CHANNEL,
    user: { id: USER },
    commandName: "join",
    options: {
      getFocused(full?: boolean): string | Record<string, unknown> {
        return full === true
          ? { name: "timezone", value: focused, type: 3, focused: true }
          : focused
      },
      getString(name: string): string | null {
        return name === "timezone" ? focused : null
      },
      getSubcommand(required?: boolean): string | null {
        if (required === false) return null
        throw new Error("/join has no subcommand")
      },
    },
    async respond(choices: unknown): Promise<void> {
      responses.push(choices)
    },
  }
  return { interaction, responses }
}

async function choicesFor(focused: string): Promise<Choice[]> {
  const fake = autocompleteInteraction(focused)
  await autocompleteZones(fake.interaction)
  expect(fake.responses.length).toBe(1)
  const first = fake.responses[0]
  expect(Array.isArray(first)).toBe(true)
  return first as Choice[]
}

describe("leg (f) [M6] autocompleteZones", () => {
  test("'oak' responds once with exactly zoneSuggestions('oak') in order", async () => {
    const choices = await choicesFor("oak")
    expect(choices.map((c) => c.value)).toEqual(zoneSuggestions("oak"))
  })

  test("'oak' gives every choice a name equal to its value", async () => {
    const choices = await choicesFor("oak")
    expect(choices.length).toBeGreaterThan(0)
    for (const choice of choices) expect(choice.name).toBe(choice.value)
  })

  test("the empty focused value gives exactly 25 choices", async () => {
    const choices = await choicesFor("")
    expect(choices.length).toBe(25)
  })

  test("the empty focused value's choices deep-equal zoneSuggestions('')", async () => {
    const choices = await choicesFor("")
    expect(choices.map((c) => c.value)).toEqual(zoneSuggestions(""))
    for (const choice of choices) expect(choice.name).toBe(choice.value)
  })
})

// `startBot` is the fifth Produces name, and no Machine clause pins its
// behaviour: it opens a gateway connection, which an exam cannot do. The task
// does not say which of the two files exports it either, so the exam does not
// assert on the symbol -- legs (d) and (e) reach the entry point the way the
// Proof's Run lines do, as a subprocess.
