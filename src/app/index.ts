// The composition root: the only place where storage, config, the Discord port
// and the job queue are held together in one object.
//
// Everything below it is either pure (`src/core/`, `src/config/`) or a single
// seam (`src/storage/`, `src/jobs/`, `src/adapters/`). `createApp` is what a
// test constructs with a `:memory:` database and a fake port, and what
// `src/main.ts` constructs with a file and the real client, so both run the
// same code.

import { Scheduler } from '../jobs/scheduler'
import { handle } from './handlers'
import { runJob, type Runtime } from './jobs'
import type { App, ConfigStore, DiscordPort, Incoming, Reply, Storage } from '../types'

/** Everything the app cannot make for itself. */
export type AppDeps = {
  storage: Storage
  config: ConfigStore
  discord: DiscordPort
  /** Id source for pairings, proposals and jobs. Tests pass a counter. */
  ids?: () => string
}

export function createApp(deps: AppDeps): App {
  const ids = deps.ids ?? ((): string => crypto.randomUUID())
  const rt: Runtime = {
    storage: deps.storage,
    config: deps.config,
    discord: deps.discord,
    scheduler: new Scheduler(deps.storage, ids),
    ids,
    pendingDays: new Map(),
  }

  return {
    async handle(incoming: Incoming, now: number): Promise<Reply | null> {
      return handle(rt, incoming, now)
    },

    /**
     * One beat of the clock. Every time-based behaviour in the bot is a due
     * job, so a tick is exactly "run what is due", and the caller decides how
     * often that happens: a real deployment on an interval, a test by handing
     * over the instants it wants to inspect.
     */
    async tick(now: number): Promise<number> {
      const { fired } = await rt.scheduler.runDue(now, async (job) => {
        await runJob(rt, job, now)
      })
      return fired
    },
  }
}

export type { Runtime } from './jobs'
