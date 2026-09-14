// The file-backed `ConfigStore` of §4: one TOML file holds every server, its
// channels, its cadence, its weights and its copy. A hosted service swaps this
// for a database-backed store behind the same interface (§10).

import { readFileSync } from "node:fs"

import type { ConfigStore, CopyKey, GuildConfig, GuildId, Weights } from "../types"

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** Written in the units an operator thinks in; §4 converts them to ms. */
const DEFAULTS = {
  cadence_days: 14,
  holding_window_hours: 24,
  pull_forward_days: 3,
  negotiation_timeout_hours: 48,
  call_minutes: 30,
} as const

/** Keys of a guild table, used to recognize a single guild written at top level. */
const GUILD_KEYS: readonly string[] = [
  "guild_id",
  "thread_parent_channel_id",
  "voice_category_id",
  ...Object.keys(DEFAULTS),
  "weights",
  "copy",
]

type Table = Readonly<Record<string, unknown>>

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A required id. Numbers are accepted so an unquoted snowflake is not a silent failure. */
function requiredId(table: Table, key: string): string {
  const raw = table[key]
  if (raw === undefined || raw === null || raw === "") {
    throw new Error(`config: guild is missing required field ${key}`)
  }
  if (typeof raw === "number" || typeof raw === "bigint") return String(raw)
  if (typeof raw !== "string") {
    throw new Error(`config: field ${key} must be a string`)
  }
  return raw
}

function optionalNumber(table: Table, key: keyof typeof DEFAULTS): number {
  const raw = table[key]
  if (raw === undefined || raw === null) return DEFAULTS[key]
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`config: field ${key} must be a number`)
  }
  return raw
}

function parseWeights(table: Table): Weights {
  const raw = table.weights
  if (raw === undefined || raw === null) return { "round-robin": 1 }
  if (!isTable(raw)) throw new Error("config: weights must be a table")

  const weights: Record<string, number> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`config: weight ${name} must be a number`)
    }
    weights[name] = value
  }
  // An empty table means "no opinion", which is the shipped default (§4, #19).
  return Object.keys(weights).length === 0 ? { "round-robin": 1 } : weights
}

function parseCopy(table: Table): Readonly<Partial<Record<CopyKey, string>>> {
  const raw = table.copy
  if (raw === undefined || raw === null) return {}
  if (!isTable(raw)) throw new Error("config: copy must be a table")

  const copy: Partial<Record<CopyKey, string>> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw new Error(`config: copy ${key} must be a string`)
    }
    copy[key as CopyKey] = value
  }
  return copy
}

function parseGuild(table: Table): GuildConfig {
  return {
    guildId: requiredId(table, "guild_id"),
    threadParentChannelId: requiredId(table, "thread_parent_channel_id"),
    voiceCategoryId: requiredId(table, "voice_category_id"),
    cadenceMs: optionalNumber(table, "cadence_days") * DAY_MS,
    holdingWindowMs: optionalNumber(table, "holding_window_hours") * HOUR_MS,
    pullForwardMaxMs: optionalNumber(table, "pull_forward_days") * DAY_MS,
    negotiationTimeoutMs: optionalNumber(table, "negotiation_timeout_hours") * HOUR_MS,
    callMinutes: optionalNumber(table, "call_minutes"),
    weights: parseWeights(table),
    copy: parseCopy(table),
  }
}

/**
 * The guild tables in a parsed document. The shipped shape is `[[guilds]]`; a
 * single `[guilds]` table and a lone guild written at top level are both
 * accepted, because an operator with one server writes either one.
 */
function guildTables(doc: Table): Table[] {
  const guilds = doc.guilds
  if (Array.isArray(guilds)) {
    return guilds.map((entry, i) => {
      if (!isTable(entry)) throw new Error(`config: guilds[${i}] must be a table`)
      return entry
    })
  }
  if (isTable(guilds)) return [guilds]
  if (guilds !== undefined) throw new Error("config: guilds must be a table or an array of tables")
  if (GUILD_KEYS.some((key) => doc[key] !== undefined)) return [doc]
  return []
}

class FileConfigStore implements ConfigStore {
  private readonly guilds: ReadonlyMap<GuildId, GuildConfig>

  constructor(guilds: readonly GuildConfig[]) {
    this.guilds = new Map(guilds.map((cfg) => [cfg.guildId, cfg]))
  }

  get(guildId: GuildId): GuildConfig | null {
    return this.guilds.get(guildId) ?? null
  }

  guildIds(): GuildId[] {
    return [...this.guilds.keys()]
  }
}

/** Parse the TOML text of a config file. Throws on a guild missing a required id. */
export function parseConfig(toml: string): ConfigStore {
  const doc: unknown = Bun.TOML.parse(toml)
  if (!isTable(doc)) throw new Error("config: the file must be a TOML table")
  return new FileConfigStore(guildTables(doc).map(parseGuild))
}

/** Read and parse a config file from disk. */
export function loadConfig(path: string): ConfigStore {
  return parseConfig(readFileSync(path, "utf8"))
}
