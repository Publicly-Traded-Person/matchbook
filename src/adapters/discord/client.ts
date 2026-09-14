// The gateway adapter: the one place that speaks discord.js at runtime (§7
// "adapters/discord"). Everything above it works in the shapes of
// `src/types.ts`, so this file is where an interaction becomes an `Incoming`,
// where an `OutgoingMessage` becomes a message payload, and where the
// `DiscordPort` is implemented against a live client.
//
// The `*Like` interfaces below are the subset of the discord.js surface the
// adapter actually touches, written structurally so a test can hand in plain
// objects and a real discord.js object still fits. They are deliberately loose:
// every member the adapter can do without is optional, and the adapter reaches
// for nothing it has not declared here.

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js'

import { commandDefinitions } from './commands'
import { zoneSuggestions } from './zones'
import { createApp } from '../../app'
import { loadConfig } from '../../config/file-store'
import { openStorage } from '../../storage/sqlite'
import type {
  Button,
  DiscordPort,
  GuildId,
  Incoming,
  MemberId,
  OutgoingMessage,
  Reply,
} from '../../types'

// ------------------------------------------------- the structural surface --

/** Anything with a Discord id: a user, a role, a channel. */
export interface IdLike {
  readonly id: string
}

/** The option resolver of a chat input command, as far as we read it. */
export interface CommandOptionsLike {
  getString?(name: string, required?: boolean): string | null | undefined
  getSubcommand?(required?: boolean): string | null | undefined
  getUser?(name: string, required?: boolean): IdLike | null | undefined
  /** Autocomplete only: the option the member is still typing into. */
  getFocused?(full?: boolean): string | { value?: string } | null | undefined
}

/** A slash command, button or select interaction. */
export interface InteractionLike {
  isChatInputCommand?(): boolean
  isButton?(): boolean
  isStringSelectMenu?(): boolean
  readonly commandName?: string
  readonly options?: CommandOptionsLike
  readonly customId?: string
  readonly values?: readonly string[]
  readonly channelId?: string | null
  readonly guildId?: string | null
  readonly user?: IdLike
}

/** An autocomplete interaction, which answers with choices instead of a reply. */
export interface AutocompleteLike {
  readonly options?: CommandOptionsLike
  respond(choices: readonly { name: string; value: string }[]): Promise<unknown> | unknown
}

/** One posted message, as far as thread activity tracking reads it. */
export interface MessageLike {
  readonly guildId?: string | null
  readonly channelId?: string | null
  readonly author?: { readonly id?: string; readonly bot?: boolean }
  readonly channel?: { readonly id?: string; isThread?(): boolean } | null
  readonly createdTimestamp?: number
  readonly createdAt?: Date | number
}

/** A channel the adapter posts in, archives or deletes. */
export interface ChannelLike {
  readonly id?: string
  send?(payload: unknown): Promise<IdLike | null | undefined> | IdLike | null | undefined
  setArchived?(archived: boolean): Promise<unknown> | unknown
  delete?(reason?: string): Promise<unknown> | unknown
  isThread?(): boolean
  /** Text channels only: where a pairing's private thread is created. */
  readonly threads?: {
    create(options: unknown): Promise<ThreadLike | null | undefined> | ThreadLike | null | undefined
  }
  /**
   * Declared so a fake can carry the spy that proves we never edit overwrites
   * after the fact (#14). The adapter never calls this.
   */
  readonly permissionOverwrites?: {
    edit?(...args: readonly unknown[]): unknown
    create?(...args: readonly unknown[]): unknown
  }
}

/** A thread, which unlike other channels has a member list we add to. */
export interface ThreadLike extends ChannelLike {
  readonly members?: { add(id: string, reason?: string): Promise<unknown> | unknown }
}

/** One guild, as far as the port reaches into it. */
export interface GuildLike {
  readonly id?: string
  readonly roles?: { readonly everyone?: IdLike }
  readonly channels: {
    create(options: unknown): Promise<ChannelLike | null | undefined> | ChannelLike | null | undefined
    fetch?(id: string): Promise<ChannelLike | null | undefined> | ChannelLike | null | undefined
  }
}

/** The client the port is built over. */
export interface ClientLike {
  readonly guilds: { fetch(id: string): Promise<GuildLike | null | undefined> | GuildLike | null | undefined }
  readonly channels?: {
    fetch?(id: string): Promise<ChannelLike | null | undefined> | ChannelLike | null | undefined
  }
}

// ------------------------------------------------- interactions coming in --

/** `null` for anything the app has no shape for, so the caller can ignore it. */
export function toIncoming(i: InteractionLike): Incoming | null {
  const guildId = i.guildId
  const userId = i.user?.id
  // Every table is scoped by guild, so an interaction outside one has nowhere
  // to land.
  if (guildId === null || guildId === undefined || guildId === '') return null
  if (userId === undefined || userId === '') return null

  const channelId = i.channelId ?? ''

  if (i.isButton?.() === true) {
    const customId = i.customId
    if (customId === undefined) return null
    return { kind: 'button', guildId, userId, customId, channelId }
  }

  if (i.isStringSelectMenu?.() === true) {
    const customId = i.customId
    if (customId === undefined) return null
    return { kind: 'select', guildId, userId, customId, values: [...(i.values ?? [])], channelId }
  }

  if (i.isChatInputCommand?.() !== true) return null

  const string = (name: string): string | undefined => {
    const value = i.options?.getString?.(name)
    return value === null || value === undefined ? undefined : value
  }

  switch (i.commandName) {
    case 'join': {
      // Both options are optional here even though /join marks the timezone
      // required: absent means absent, never the string "undefined".
      const timezone = string('timezone')
      const avoid = string('avoid')
      return {
        kind: 'join',
        guildId,
        userId,
        ...(timezone === undefined ? {} : { timezone }),
        ...(avoid === undefined ? {} : { avoid }),
      }
    }
    case 'timezone': {
      const timezone = string('timezone')
      if (timezone === undefined) return null
      return { kind: 'timezone', guildId, userId, timezone }
    }
    case 'availability':
      return { kind: 'availability', guildId, userId }
    case 'pause':
      return { kind: 'pause', guildId, userId }
    case 'resume':
      return { kind: 'resume', guildId, userId }
    case 'forget':
      return { kind: 'forget', guildId, userId }
    case 'matchbook': {
      switch (i.options?.getSubcommand?.()) {
        case 'status':
          return { kind: 'admin-status', guildId, userId }
        case 'config':
          return { kind: 'admin-config', guildId, userId }
        case 'pair': {
          const a = i.options?.getUser?.('a')?.id
          const b = i.options?.getUser?.('b')?.id
          if (a === undefined || b === undefined) return null
          return { kind: 'admin-pair', guildId, userId, a, b }
        }
        default:
          return null
      }
    }
    default:
      return null
  }
}

/** When the message was posted, in epoch milliseconds. */
function postedAt(m: MessageLike): number {
  if (typeof m.createdTimestamp === 'number') return m.createdTimestamp
  if (typeof m.createdAt === 'number') return m.createdAt
  if (m.createdAt instanceof Date) return m.createdAt.getTime()
  return 0
}

/**
 * A member posting in a pairing thread is the activity signal of §6. We record
 * that they posted and when, never what: the bot asks for no MessageContent
 * intent and this shape has nowhere to put the text.
 */
export function toThreadMessage(m: MessageLike): Incoming | null {
  if (m.author?.bot === true) return null

  const guildId = m.guildId
  const userId = m.author?.id
  if (guildId === null || guildId === undefined || guildId === '') return null
  if (userId === undefined || userId === '') return null

  if (m.channel?.isThread?.() !== true) return null
  const threadId = m.channelId ?? m.channel?.id
  if (threadId === null || threadId === undefined || threadId === '') return null

  return { kind: 'thread-message', guildId, userId, threadId, at: postedAt(m) }
}

// ----------------------------------------------------- zone autocomplete --

/** What the member has typed into the focused option so far. */
function focusedValue(i: AutocompleteLike): string {
  const focused = i.options?.getFocused?.()
  if (typeof focused === 'string') return focused
  if (focused !== null && focused !== undefined && typeof focused.value === 'string') {
    return focused.value
  }
  // A resolver that does not expose the focused option still knows the value
  // of the only autocompleting option there is.
  return i.options?.getString?.('timezone') ?? ''
}

/**
 * Answer a timezone autocomplete with real IANA zone ids (§5). The id is both
 * what the member reads and what we store, so the list never needs translating
 * back.
 */
export async function autocompleteZones(i: AutocompleteLike): Promise<void> {
  const choices = zoneSuggestions(focusedValue(i)).map((zoneId) => ({ name: zoneId, value: zoneId }))
  await i.respond(choices)
}

// ----------------------------------------------------- messages going out --

const BUTTON_STYLES: Readonly<Record<Button['style'], ButtonStyle>> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
}

/** Discord fits five buttons on one action row. */
const BUTTONS_PER_ROW = 5

type ComponentRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>

function componentRows(message: OutgoingMessage): ComponentRow[] {
  const rows: ComponentRow[] = []

  const buttons = message.buttons ?? []
  for (let at = 0; at < buttons.length; at += BUTTONS_PER_ROW) {
    const row = new ActionRowBuilder<ButtonBuilder>()
    for (const button of buttons.slice(at, at + BUTTONS_PER_ROW)) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(button.id)
          .setLabel(button.label)
          .setStyle(BUTTON_STYLES[button.style]),
      )
    }
    rows.push(row)
  }

  const select = message.select
  if (select !== undefined) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(select.id)
      .setPlaceholder(select.placeholder)
      .addOptions(
        select.options.map((option) =>
          new StringSelectMenuOptionBuilder().setValue(option.value).setLabel(option.label),
        ),
      )
    if (select.min !== undefined) menu.setMinValues(select.min)
    if (select.max !== undefined) menu.setMaxValues(select.max)
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu))
  }

  return rows
}

/** One `OutgoingMessage` as the payload `send` and `reply` both take. */
export function toMessagePayload(message: OutgoingMessage): {
  content: string
  components: ComponentRow[]
  files: AttachmentBuilder[]
} {
  const file = message.file
  return {
    content: message.content,
    components: componentRows(message),
    files: file === undefined ? [] : [new AttachmentBuilder(Buffer.from(file.bytes), { name: file.name })],
  }
}

// ------------------------------------------------------- the discord port --

function channelUrl(guildId: GuildId, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`
}

/**
 * The live `DiscordPort` (§7). Nothing above this function knows that Discord
 * exists; nothing below the port pretends it does not.
 */
export function createDiscordPort(client: ClientLike): DiscordPort {
  async function guildOf(guildId: GuildId): Promise<GuildLike> {
    const guild = await client.guilds.fetch(guildId)
    if (guild === null || guild === undefined) {
      throw new Error(`discord: guild ${guildId} is not reachable`)
    }
    return guild
  }

  async function channelOf(guildId: GuildId, channelId: string): Promise<ChannelLike> {
    const guild = await guildOf(guildId)
    const found =
      (await guild.channels.fetch?.(channelId)) ?? (await client.channels?.fetch?.(channelId))
    if (found === null || found === undefined) {
      throw new Error(`discord: channel ${channelId} is not reachable in guild ${guildId}`)
    }
    return found
  }

  return {
    async createPrivateThread(
      guildId: GuildId,
      parentChannelId: string,
      name: string,
      members: readonly MemberId[],
    ): Promise<{ id: string; url: string }> {
      const parent = await channelOf(guildId, parentChannelId)
      const thread = await parent.threads?.create({
        name,
        type: ChannelType.PrivateThread,
        invitable: false,
      })
      if (thread === null || thread === undefined) {
        throw new Error(`discord: channel ${parentChannelId} cannot hold private threads`)
      }
      // The two members are added after creation: a private thread has no
      // member list in its create call.
      for (const memberId of members) await thread.members?.add(memberId)
      const id = thread.id ?? ''
      return { id, url: channelUrl(guildId, id) }
    },

    async post(
      guildId: GuildId,
      channelId: string,
      message: OutgoingMessage,
    ): Promise<{ id: string }> {
      const channel = await channelOf(guildId, channelId)
      const sent = await channel.send?.(toMessagePayload(message))
      return { id: sent?.id ?? '' }
    },

    async archiveThread(guildId: GuildId, threadId: string): Promise<void> {
      const thread = await channelOf(guildId, threadId)
      await thread.setArchived?.(true)
    },

    /**
     * The private call room. Both members and the deny for @everyone go in the
     * create call itself, so the channel is never visible to the server for
     * the moment between creating it and editing its overwrites (#14). Nothing
     * here touches `permissionOverwrites`.
     */
    async createVoiceChannel(
      guildId: GuildId,
      categoryId: string,
      name: string,
      members: readonly MemberId[],
    ): Promise<{ id: string; url: string }> {
      const guild = await guildOf(guildId)
      const everyoneId = guild.roles?.everyone?.id
      const permissionOverwrites = [
        ...(everyoneId === undefined
          ? []
          : [{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] }]),
        ...members.map((memberId) => ({
          id: memberId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
        })),
      ]

      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: categoryId,
        permissionOverwrites,
      })
      if (channel === null || channel === undefined) {
        throw new Error(`discord: could not create a voice channel in category ${categoryId}`)
      }
      const id = channel.id ?? ''
      return { id, url: channelUrl(guildId, id) }
    },

    async deleteChannel(guildId: GuildId, channelId: string): Promise<void> {
      const channel = await channelOf(guildId, channelId)
      await channel.delete?.()
    },
  }
}

// ------------------------------------------------------------- the daemon --

/**
 * Log in, register the commands, and route everything through the app.
 *
 * The intents are `Guilds`, `GuildMessages` and `GuildVoiceStates`. There is no
 * `MessageContent`: the bot records that a member posted in a pairing thread,
 * never what they said (§9).
 */
export async function startBot(opts: {
  token: string
  configPath: string
  dbPath: string
  tickMs: number
}): Promise<void> {
  const config = loadConfig(opts.configPath)
  const storage = openStorage(opts.dbPath)
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
    ],
  })
  const app = createApp({ storage, config, discord: createDiscordPort(client) })

  const report = (what: string, err: unknown): void => {
    console.error(`matchbook: ${what} failed:`, err)
  }

  client.once(Events.ClientReady, (ready) => {
    void (async () => {
      for (const guildId of config.guildIds()) {
        storage.ensureGuild(guildId, Date.now())
        try {
          await ready.application.commands.set(commandDefinitions(), guildId)
          console.log(`matchbook: commands registered in guild ${guildId}`)
        } catch (err) {
          report(`registering commands in guild ${guildId}`, err)
        }
      }
      console.log(`matchbook: ready as ${ready.user.tag}`)
    })()
  })

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      try {
        if (interaction.isAutocomplete()) {
          await autocompleteZones(interaction)
          return
        }
        // The three kinds the app has shapes for. Anything else (a modal, a
        // context menu) is not something this bot puts on screen.
        if (
          !interaction.isChatInputCommand() &&
          !interaction.isButton() &&
          !interaction.isStringSelectMenu()
        ) {
          return
        }
        const incoming = toIncoming(interaction)
        if (incoming === null) return
        const reply: Reply | null = await app.handle(incoming, Date.now())
        if (reply === null) return
        await interaction.reply({
          ...toMessagePayload(reply),
          ...(reply.ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
        })
      } catch (err) {
        report('handling an interaction', err)
      }
    })()
  })

  client.on(Events.MessageCreate, (message) => {
    void (async () => {
      try {
        const incoming = toThreadMessage(message)
        if (incoming === null) return
        await app.handle(incoming, Date.now())
      } catch (err) {
        report('handling a thread message', err)
      }
    })()
  })

  // The one timer in the codebase: every other time-based behaviour is a job
  // the tick runs when it comes due.
  setInterval(() => {
    void app.tick(Date.now()).catch((err: unknown) => report('a tick', err))
  }, opts.tickMs)

  await client.login(opts.token)
}
