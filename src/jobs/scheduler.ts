// The ticker over a JobStore. Every time-based action in the app is a row with
// a run time, so a restart loses nothing: a new Scheduler over the same store
// picks up whatever is still pending. Nothing here uses a timer or the wall
// clock, and at-most-once is claimed by the store before the handler runs.

import type { GuildId, Job, JobKind, JobStore } from '../types'

export interface RunResult {
  /** How many handlers were invoked, including ones that threw. */
  readonly fired: number
  /** What those handlers threw, in the order they threw it. */
  readonly errors: readonly Error[]
}

export type JobHandler = (job: Job) => Promise<void> | void

function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown))
}

export class Scheduler {
  private readonly store: JobStore
  private readonly ids: () => string

  constructor(store: JobStore, ids: () => string = () => crypto.randomUUID()) {
    this.store = store
    this.ids = ids
  }

  /** Insert a pending job and return it. */
  schedule(guildId: GuildId, kind: JobKind, refId: string, runAt: number, now: number): Job {
    const job: Job = {
      id: this.ids(),
      guildId,
      kind,
      refId,
      runAt,
      state: 'pending',
      createdAt: now,
    }
    this.store.insertJob(job)
    return job
  }

  /** Cancel every pending job of this kind for this ref. Returns how many. */
  cancel(guildId: GuildId, kind: JobKind, refId: string): number {
    return this.store.cancelJobs(guildId, kind, refId)
  }

  /**
   * Run every job due at `now`, oldest run time first. Each job is claimed
   * before its handler runs, so a second pass, or a second Scheduler over the
   * same store, never runs it again. A handler that throws does not stop the
   * pass and does not reject: the error comes back in the result.
   */
  async runDue(now: number, handler: JobHandler): Promise<RunResult> {
    const due = this.store.dueJobs(now)
    const errors: Error[] = []
    let fired = 0
    for (const job of due) {
      // A false claim means another runner took it first: skip it.
      if (!this.store.completeJob(job.id)) continue
      fired++
      try {
        await handler(job)
      } catch (thrown) {
        errors.push(asError(thrown))
      }
    }
    return { fired, errors }
  }
}
