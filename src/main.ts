// The entry point (§11 "README quickstart"): export a token, run one command.
//
// Two modes, and the useful one needs no token. `--check-config <path>` reads
// the config, says what it found and prints the install link with the exact
// permissions the OAuth screen will ask for, so an admin can read the scopes
// before clicking. Without the flag it starts the bot, which does need a token.
//
// Everything is configured by environment variable, because that is what a
// container hands you:
//   MATCHBOOK_CONFIG   path of the config file    (default ./config.toml)
//   MATCHBOOK_DB       path of the database       (default ./data/matchbook.db)
//   DISCORD_TOKEN      the bot token, required to start
//   DISCORD_CLIENT_ID  the application id, only used to fill in the invite link

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { startBot } from './adapters/discord/client'
import { PERMISSIONS, inviteUrl, permissionsBitfield } from './adapters/discord/commands'
import { loadConfig } from './config/file-store'

const DEFAULT_CONFIG_PATH = './config.toml'
const DEFAULT_DB_PATH = './data/matchbook.db'

/** How often the job queue is drained. Every deadline in the bot is a job. */
const TICK_MS = 60_000

/** Printed in place of a client id the operator has not told us about. */
const CLIENT_ID_PLACEHOLDER = '<your-application-id>'

const CHECK_FLAG = '--check-config'

/** The path `--check-config` was given, `''` for the flag with no path, `null` for no flag. */
function checkConfigArg(argv: readonly string[]): string | null {
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (arg === CHECK_FLAG) return argv[at + 1] ?? ''
    if (arg !== undefined && arg.startsWith(`${CHECK_FLAG}=`)) {
      return arg.slice(CHECK_FLAG.length + 1)
    }
  }
  return null
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Read the config and print what an admin needs before the first launch. */
function checkConfig(path: string, clientId: string): number {
  let config
  try {
    config = loadConfig(path)
  } catch (err) {
    console.error(`${path}: ${messageOf(err)}`)
    return 1
  }

  const guildIds = config.guildIds()
  console.log(`${path}: read`)
  console.log(`guilds: ${guildIds.length}`)
  for (const guildId of guildIds) {
    const guild = config.get(guildId)
    if (guild === null) continue
    console.log(
      `  ${guildId}: threads under channel ${guild.threadParentChannelId}, ` +
        `call rooms in category ${guild.voiceCategoryId}`,
    )
  }

  console.log(`permissions=${permissionsBitfield().toString()}`)
  console.log(`  ${PERMISSIONS.join(', ')}`)
  console.log(`invite: ${inviteUrl(clientId)}`)
  return 0
}

export async function main(argv: readonly string[]): Promise<number> {
  const configPath = process.env.MATCHBOOK_CONFIG ?? DEFAULT_CONFIG_PATH
  const clientId = process.env.DISCORD_CLIENT_ID ?? ''

  const requested = checkConfigArg(argv)
  if (requested !== null) {
    return checkConfig(
      requested === '' ? configPath : requested,
      clientId === '' ? CLIENT_ID_PLACEHOLDER : clientId,
    )
  }

  const token = process.env.DISCORD_TOKEN ?? ''
  if (token === '') {
    console.error(
      `DISCORD_TOKEN is not set: export the bot token, or run ${CHECK_FLAG} <path> to check the config without one.`,
    )
    return 1
  }

  const dbPath = process.env.MATCHBOOK_DB ?? DEFAULT_DB_PATH
  mkdirSync(dirname(dbPath), { recursive: true })

  await startBot({ token, configPath, dbPath, tickMs: TICK_MS })
  return 0
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  // A zero falls off the end instead of exiting: when the bot started, the
  // gateway connection and the tick are what keep the process alive.
  if (code !== 0) process.exit(code)
}
