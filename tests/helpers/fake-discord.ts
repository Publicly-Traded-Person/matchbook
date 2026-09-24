// An in-memory `DiscordPort` for the suite and the simulated month.
//
// Every call the app makes is appended to the public `calls` array in the order
// it was made, so a test asserts on what the bot did rather than on how it did
// it. Ids come from a counter, so a run is reproducible without a clock or a
// random source, and urls have the shape Discord uses:
// `https://discord.com/channels/<guildId>/<channelId>`.
//
// `calls` is a discriminated union on `kind`, matching the idiom the shared
// types use for `Incoming` and `Job`. `callsOf`, `postsTo` and `postsIn` are
// the three queries tests actually want.

import type { DiscordPort, GuildId, MemberId, OutgoingMessage } from '../../src/types'

export type ThreadCall = {
  kind: 'createPrivateThread'
  guildId: GuildId
  parentChannelId: string
  name: string
  members: readonly MemberId[]
  /** The thread id this call returned. */
  id: string
  url: string
}

export type PostCall = {
  kind: 'post'
  guildId: GuildId
  channelId: string
  message: OutgoingMessage
  /** The message id this call returned. */
  id: string
}

export type ArchiveCall = {
  kind: 'archiveThread'
  guildId: GuildId
  threadId: string
}

export type VoiceCall = {
  kind: 'createVoiceChannel'
  guildId: GuildId
  categoryId: string
  name: string
  members: readonly MemberId[]
  /** The channel id this call returned. */
  id: string
  url: string
}

export type DeleteCall = {
  kind: 'deleteChannel'
  guildId: GuildId
  channelId: string
}

export type FakeCall = ThreadCall | PostCall | ArchiveCall | VoiceCall | DeleteCall

/** The `kind` of a recorded call, for `callsOf`. */
export type FakeCallKind = FakeCall['kind']

type CallOfKind<K extends FakeCallKind> = Extract<FakeCall, { kind: K }>

export class FakeDiscord implements DiscordPort {
  /** Every call, oldest first. */
  readonly calls: FakeCall[] = []

  private counter = 0

  /** Ids are a plain ascending counter, so two runs of a fixture agree. */
  private nextId(): string {
    this.counter += 1
    return String(this.counter)
  }

  private urlFor(guildId: GuildId, channelId: string): string {
    return `https://discord.com/channels/${guildId}/${channelId}`
  }

  async createPrivateThread(
    guildId: GuildId,
    parentChannelId: string,
    name: string,
    members: readonly MemberId[],
  ): Promise<{ id: string; url: string }> {
    const id = this.nextId()
    const url = this.urlFor(guildId, id)
    this.calls.push({
      kind: 'createPrivateThread',
      guildId,
      parentChannelId,
      name,
      members: [...members],
      id,
      url,
    })
    return { id, url }
  }

  async post(
    guildId: GuildId,
    channelId: string,
    message: OutgoingMessage,
  ): Promise<{ id: string }> {
    const id = this.nextId()
    this.calls.push({ kind: 'post', guildId, channelId, message, id })
    return { id }
  }

  async archiveThread(guildId: GuildId, threadId: string): Promise<void> {
    this.calls.push({ kind: 'archiveThread', guildId, threadId })
  }

  async createVoiceChannel(
    guildId: GuildId,
    categoryId: string,
    name: string,
    members: readonly MemberId[],
  ): Promise<{ id: string; url: string }> {
    const id = this.nextId()
    const url = this.urlFor(guildId, id)
    this.calls.push({
      kind: 'createVoiceChannel',
      guildId,
      categoryId,
      name,
      members: [...members],
      id,
      url,
    })
    return { id, url }
  }

  async deleteChannel(guildId: GuildId, channelId: string): Promise<void> {
    this.calls.push({ kind: 'deleteChannel', guildId, channelId })
  }

  /** A stable readable name per id, so tests can tell a name from an id. */
  async displayName(_guildId: GuildId, memberId: MemberId): Promise<string> {
    return `Member ${memberId}`
  }

  // ------------------------------------------------------------- queries --

  /** Every recorded call of one kind, narrowed to that kind's shape. */
  callsOf<K extends FakeCallKind>(kind: K): CallOfKind<K>[] {
    return this.calls.filter((call): call is CallOfKind<K> => call.kind === kind)
  }

  /** The messages posted into one channel, oldest first. */
  postsTo(channelId: string): OutgoingMessage[] {
    return this.callsOf('post')
      .filter((call) => call.channelId === channelId)
      .map((call) => call.message)
  }

  /** The same, as the whole call record, for tests that want the message id. */
  postsIn(channelId: string): PostCall[] {
    return this.callsOf('post').filter((call) => call.channelId === channelId)
  }

  /** The thread creation whose member list is exactly `members`, in any order. */
  threadFor(members: readonly MemberId[]): ThreadCall | undefined {
    const wanted = [...members].sort().join(',')
    return this.callsOf('createPrivateThread').find(
      (call) => [...call.members].sort().join(',') === wanted,
    )
  }

  /** Forget everything recorded so far. */
  reset(): void {
    this.calls.length = 0
  }
}
