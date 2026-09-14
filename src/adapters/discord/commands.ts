// Slash command definitions and the install link (§7 "Member commands",
// "Admin commands", "Permissions requested").
//
// Definitions are built with discord.js and handed to the REST registration
// call as plain JSON, so this is one of the two places allowed to import
// discord.js. Everything the commands need at runtime (zone autocomplete, the
// availability components) lives beside it and is re-exported here, so callers
// have a single entry point for the adapter's pure pieces.

import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'
import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js'

export * from './components'
export * from './zones'

const TIMEZONE_OPTION_DESCRIPTION = 'Start typing your city or country, then pick a zone from the list.'

/**
 * Every command the bot registers. Build 1 has the six member commands and the
 * admin group; /welcome and the interests option arrive with build 2.
 */
export function commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const join = new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join the pairing rotation for this server.')
    .addStringOption((option) =>
      option
        .setName('timezone')
        .setDescription(TIMEZONE_OPTION_DESCRIPTION)
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName('avoid')
        .setDescription('People you should never be paired with, as a comma separated list of user ids.')
        .setRequired(false),
    )

  const timezone = new SlashCommandBuilder()
    .setName('timezone')
    .setDescription('Change the timezone your calls are scheduled in.')
    .addStringOption((option) =>
      option
        .setName('timezone')
        .setDescription(TIMEZONE_OPTION_DESCRIPTION)
        .setRequired(true)
        .setAutocomplete(true),
    )

  const availability = new SlashCommandBuilder()
    .setName('availability')
    .setDescription('Set the hours you could take a call.')

  const pause = new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Stop being paired for now. Your settings are kept.')

  const resume = new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Start being paired again.')

  const forget = new SlashCommandBuilder()
    .setName('forget')
    .setDescription('Delete everything this bot stores about you on this server.')

  const admin = new SlashCommandBuilder()
    .setName('matchbook')
    .setDescription('Admin commands for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub.setName('config').setDescription('Show how pairing is configured on this server.'),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show the pool, the open pairings and the pending jobs.'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('pair')
        .setDescription('Pair two members now, outside the usual cadence.')
        .addUserOption((option) =>
          option.setName('a').setDescription('First member of the pair.').setRequired(true),
        )
        .addUserOption((option) =>
          option.setName('b').setDescription('Second member of the pair.').setRequired(true),
        ),
    )

  return [join, timezone, availability, pause, resume, forget, admin].map((builder) => builder.toJSON())
}

/**
 * The permissions the install link asks for, by their name in the Discord UI,
 * so the README and the OAuth screen can be checked against each other.
 */
export const PERMISSIONS: readonly string[] = Object.freeze([
  'View Channels',
  'Send Messages',
  'Create Private Threads',
  'Send Messages in Threads',
  'Manage Threads',
  'Manage Channels',
  'Connect',
])

/** The same seven permissions as the bitfield the OAuth URL carries. */
export function permissionsBitfield(): bigint {
  return (
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.CreatePrivateThreads |
    PermissionFlagsBits.SendMessagesInThreads |
    PermissionFlagsBits.ManageThreads |
    PermissionFlagsBits.ManageChannels |
    PermissionFlagsBits.Connect
  )
}

/** The install link an admin opens to add the bot to a server. */
export function inviteUrl(clientId: string): string {
  return (
    'https://discord.com/oauth2/authorize' +
    `?client_id=${clientId}` +
    `&permissions=${permissionsBitfield().toString()}` +
    '&scope=bot%20applications.commands'
  )
}
