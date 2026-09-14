// An in-memory JobStore: one Map keyed by job id. It exists for tests and for
// the simulated month, and it is the reference semantics the SQLite store has
// to match. Time is always the `now` argument, never the wall clock.

import type { GuildId, Job, JobKind, JobStore } from '../types'

/** Pending first by run time, then by id so the order is total and stable. */
function byRunAtThenId(a: Job, b: Job): number {
  return a.runAt - b.runAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export class MemoryJobStore implements JobStore {
  /** Every job ever inserted, in whatever state it reached. */
  readonly jobs = new Map<string, Job>()

  insertJob(job: Job): void {
    this.jobs.set(job.id, job)
  }

  /** Pending jobs with runAt <= now, ascending by runAt then id. */
  dueJobs(now: number): Job[] {
    const due: Job[] = []
    for (const job of this.jobs.values()) {
      if (job.state === 'pending' && job.runAt <= now) due.push(job)
    }
    return due.sort(byRunAtThenId)
  }

  /**
   * Claim a job. True exactly once per pending job: a false return means it was
   * already taken, cancelled, or never existed, so the caller must not run it.
   */
  completeJob(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || job.state !== 'pending') return false
    this.jobs.set(id, { ...job, state: 'done' })
    return true
  }

  cancelJobs(guildId: GuildId, kind: JobKind, refId: string): number {
    let cancelled = 0
    for (const job of this.jobs.values()) {
      if (job.state !== 'pending') continue
      if (job.guildId !== guildId || job.kind !== kind || job.refId !== refId) continue
      this.jobs.set(job.id, { ...job, state: 'cancelled' })
      cancelled++
    }
    return cancelled
  }

  pendingJobs(guildId: GuildId): Job[] {
    const pending: Job[] = []
    for (const job of this.jobs.values()) {
      if (job.state === 'pending' && job.guildId === guildId) pending.push(job)
    }
    return pending.sort(byRunAtThenId)
  }

  /** Read one job back in whatever state it is now, for tests and simulations. */
  get(id: string): Job | null {
    return this.jobs.get(id) ?? null
  }
}
