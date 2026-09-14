// Exam for Task 8, "Durable jobs".
//
// Every test names the Proof leg it encodes and the Machine clause that leg
// carries. Time is never read from the clock and nothing sleeps: every instant
// below is a literal passed as `now`, per the task's Context and §8 "No test
// sleeps".

import { describe, expect, test } from "bun:test"
import { MemoryJobStore } from "../src/jobs/memory-store"
import { Scheduler } from "../src/jobs/scheduler"
import type { Job, JobStore } from "../src/types"

/** A deterministic id source for the tests that need to pin ids. */
function seqIds(prefix = "id"): () => string {
  let n = 0
  return () => `${prefix}-${++n}`
}

/** Records the jobs a handler was called with, in call order. */
function recorder() {
  const seen: Job[] = []
  return {
    seen,
    handler: (job: Job) => {
      seen.push(job)
    },
    refIds: () => seen.map((j) => j.refId),
    ids: () => seen.map((j) => j.id),
  }
}

describe("leg (a) [M1] schedule inserts a pending job; runDue fires the due ones in runAt order", () => {
  test("three jobs at runAt 30, 10, 20: runDue(25) fires 2 in runAt order, ids are distinct, runDue(30) fires the last", async () => {
    const store = new MemoryJobStore()
    // No `ids` argument: the default generator is under test here, so the
    // distinctness check below is a real check (Context: defaults to
    // crypto.randomUUID).
    const scheduler = new Scheduler(store)

    const j30 = scheduler.schedule("g1", "hold-expiry", "j30", 30, 1)
    const j10 = scheduler.schedule("g1", "hold-expiry", "j10", 10, 2)
    const j20 = scheduler.schedule("g1", "hold-expiry", "j20", 20, 3)

    // M1: "inserts a pending Job with a unique id and returns it".
    expect(j10.guildId).toBe("g1")
    expect(j10.kind).toBe("hold-expiry")
    expect(j10.refId).toBe("j10")
    expect(j10.runAt).toBe(10)
    expect(j10.state).toBe("pending")
    expect(j10.createdAt).toBe(2)
    expect(typeof j10.id).toBe("string")
    expect(j10.id.length).toBeGreaterThan(0)

    // Leg (a): three distinct ids.
    expect(new Set([j30.id, j10.id, j20.id]).size).toBe(3)

    // M1: "inserts" — the store holds all three as pending.
    expect(new Set(store.pendingJobs("g1").map((j) => j.id))).toEqual(
      new Set([j30.id, j10.id, j20.id]),
    )

    // Leg (a): runDue(25) gives fired: 2, handler calls in refId order 10 then 20.
    const rec = recorder()
    const first = await scheduler.runDue(25, rec.handler)
    expect(first.fired).toBe(2)
    expect(first.errors.length).toBe(0)
    expect(rec.refIds()).toEqual(["j10", "j20"])
    expect(rec.ids()).toEqual([j10.id, j20.id])

    // Leg (a): runDue(30) gives fired: 1 — the 30 job, and only it.
    const rec2 = recorder()
    const second = await scheduler.runDue(30, rec2.handler)
    expect(second.fired).toBe(1)
    expect(second.errors.length).toBe(0)
    expect(rec2.refIds()).toEqual(["j30"])
    expect(rec2.ids()).toEqual([j30.id])
  })
})

describe("leg (b) [M2] a job is never handled before its runAt", () => {
  test("a job at runAt 1000 is untouched by runDue(999) and handled by runDue(1000)", async () => {
    const store = new MemoryJobStore()
    const scheduler = new Scheduler(store, seqIds())

    const job = scheduler.schedule("g1", "room-open", "p1", 1000, 0)

    const early = recorder()
    const before = await scheduler.runDue(999, early.handler)
    expect(before.fired).toBe(0)
    expect(before.errors.length).toBe(0)
    expect(early.seen.length).toBe(0)
    // Still pending: runDue(999) did not consume it.
    expect(store.pendingJobs("g1").map((j) => j.id)).toEqual([job.id])

    const onTime = recorder()
    const at = await scheduler.runDue(1000, onTime.handler)
    expect(at.fired).toBe(1)
    expect(at.errors.length).toBe(0)
    expect(onTime.ids()).toEqual([job.id])
  })
})

describe("leg (c) [M3] a job is handled at most once", () => {
  test("a second runDue at a later now does not handle an already handled job", async () => {
    const store = new MemoryJobStore()
    const scheduler = new Scheduler(store, seqIds())
    const job = scheduler.schedule("g1", "follow-up", "p1", 10, 0)

    const rec = recorder()
    const first = await scheduler.runDue(10, rec.handler)
    expect(first.fired).toBe(1)

    const second = await scheduler.runDue(1_000_000, rec.handler)
    expect(second.fired).toBe(0)
    expect(second.errors.length).toBe(0)

    // Exactly one handler call in total, for that job.
    expect(rec.seen.length).toBe(1)
    expect(rec.ids()).toEqual([job.id])
  })

  test("two Scheduler instances over one MemoryJobStore, back to back, handle it once in total", async () => {
    const store = new MemoryJobStore()
    const a = new Scheduler(store, seqIds("a"))
    const b = new Scheduler(store, seqIds("b"))
    const job = a.schedule("g1", "negotiation-release", "p1", 50, 0)

    const rec = recorder()
    const viaA = await a.runDue(50, rec.handler)
    const viaB = await b.runDue(50, rec.handler)

    expect(viaA.fired).toBe(1)
    expect(viaB.fired).toBe(0)
    expect(rec.seen.length).toBe(1)
    expect(rec.ids()).toEqual([job.id])
  })
})

describe("leg (d) [M4] cancel returns how many it cancelled, and a cancelled job never fires", () => {
  test("cancel of two pending jobs of one kind and ref returns 2; the next runDue handles neither; cancel with nothing pending returns 0", async () => {
    const store = new MemoryJobStore()
    const scheduler = new Scheduler(store, seqIds())

    scheduler.schedule("g1", "hold-expiry", "p1", 10, 0)
    scheduler.schedule("g1", "hold-expiry", "p1", 20, 0)
    // Another guild's job of the same kind and ref, far in the future: cancel
    // is scoped by guild, so this one must survive untouched.
    const other = scheduler.schedule("g2", "hold-expiry", "p1", 9999, 0)

    expect(scheduler.cancel("g1", "hold-expiry", "p1")).toBe(2)

    const rec = recorder()
    const result = await scheduler.runDue(50, rec.handler)
    expect(result.fired).toBe(0)
    expect(result.errors.length).toBe(0)
    expect(rec.seen.length).toBe(0)
    expect(store.pendingJobs("g1")).toEqual([])

    // Scoped by guild: g2's job is still pending.
    expect(store.pendingJobs("g2").map((j) => j.id)).toEqual([other.id])

    // Cancelling a kind with nothing pending returns 0.
    expect(scheduler.cancel("g1", "expire", "p1")).toBe(0)
    expect(scheduler.cancel("g1", "hold-expiry", "p1")).toBe(0)
  })
})

describe("leg (e) [M5] a job survives the scheduler that scheduled it", () => {
  test("a job scheduled via scheduler A is handled by a new Scheduler over the same store, with nothing in between", async () => {
    const store: JobStore = new MemoryJobStore()
    const a = new Scheduler(store, seqIds("a"))
    const job = a.schedule("g1", "room-close", "p1", 500, 0)

    // The restart: a fresh Scheduler over the same store, no other action.
    const b = new Scheduler(store, seqIds("b"))
    const rec = recorder()
    const result = await b.runDue(500, rec.handler)

    expect(result.fired).toBe(1)
    expect(result.errors.length).toBe(0)
    expect(rec.seen.length).toBe(1)
    expect(rec.seen[0]?.id).toBe(job.id)
    expect(rec.seen[0]?.refId).toBe("p1")
    expect(rec.seen[0]?.kind).toBe("room-close")
    expect(rec.seen[0]?.guildId).toBe("g1")
    expect(rec.seen[0]?.runAt).toBe(500)
  })

  test("runDue awaits an async handler before it resolves (Produces: handler returns Promise<void> | void)", async () => {
    const store = new MemoryJobStore()
    const a = new Scheduler(store, seqIds("a"))
    a.schedule("g1", "archive", "p1", 500, 0)

    const b = new Scheduler(store, seqIds("b"))
    const seen: string[] = []
    const result = await b.runDue(500, async (job) => {
      await Promise.resolve()
      seen.push(job.refId)
    })

    expect(result.fired).toBe(1)
    expect(seen).toEqual(["p1"])
  })
})

describe("leg (f) [M6] MemoryJobStore satisfies JobStore", () => {
  function row(over: { id: string; runAt: number; guildId?: string; refId?: string }): Job {
    return {
      id: over.id,
      guildId: over.guildId ?? "g1",
      kind: "follow-up",
      refId: over.refId ?? "p1",
      runAt: over.runAt,
      state: "pending",
      createdAt: 0,
    }
  }

  test("dueJobs returns pending jobs with runAt <= now, ascending by runAt then id", () => {
    const store = new MemoryJobStore()
    // Inserted deliberately out of order, with a runAt tie to exercise the
    // id tiebreak, and one job past `now`.
    store.insertJob(row({ id: "b", runAt: 100 }))
    store.insertJob(row({ id: "z", runAt: 50 }))
    store.insertJob(row({ id: "a", runAt: 100 }))
    store.insertJob(row({ id: "c", runAt: 101 }))

    expect(store.dueJobs(100).map((j) => j.id)).toEqual(["z", "a", "b"])
    expect(store.dueJobs(101).map((j) => j.id)).toEqual(["z", "a", "b", "c"])
    expect(store.dueJobs(49)).toEqual([])
  })

  test("dueJobs excludes a done job and a cancelled job", () => {
    const store = new MemoryJobStore()
    store.insertJob(row({ id: "keep", runAt: 10 }))
    store.insertJob(row({ id: "done", runAt: 10 }))
    store.insertJob(row({ id: "gone", runAt: 10, refId: "p2" }))

    expect(store.completeJob("done")).toBe(true)
    expect(store.cancelJobs("g1", "follow-up", "p2")).toBe(1)

    expect(store.dueJobs(10).map((j) => j.id)).toEqual(["keep"])
    expect(store.pendingJobs("g1").map((j) => j.id)).toEqual(["keep"])
  })

  test("completeJob returns true once, false on a second call, and false for an unknown id", () => {
    const store = new MemoryJobStore()
    store.insertJob(row({ id: "j1", runAt: 10 }))

    expect(store.completeJob("j1")).toBe(true)
    expect(store.completeJob("j1")).toBe(false)
    expect(store.completeJob("nope")).toBe(false)
  })

  test("pendingJobs(guildId) returns only that guild's pending jobs", () => {
    const store = new MemoryJobStore()
    store.insertJob(row({ id: "g1-job", runAt: 10, guildId: "g1" }))
    store.insertJob(row({ id: "g2-job", runAt: 10, guildId: "g2" }))

    expect(store.pendingJobs("g1").map((j) => j.id)).toEqual(["g1-job"])
    expect(store.pendingJobs("g2").map((j) => j.id)).toEqual(["g2-job"])
    expect(store.pendingJobs("g3")).toEqual([])
  })
})

describe("leg (g) [M7] a throwing handler is collected, not propagated", () => {
  test("two due jobs, the first throws: fired is 2, errors has the one error, and the first job is done", async () => {
    const store = new MemoryJobStore()
    const scheduler = new Scheduler(store, seqIds())

    const first = scheduler.schedule("g1", "check-in", "m1", 10, 0)
    const second = scheduler.schedule("g1", "check-in", "m2", 20, 0)

    const seen: string[] = []
    const result = await scheduler.runDue(50, (job) => {
      seen.push(job.refId)
      if (job.id === first.id) throw new Error("boom")
    })

    // M7: runDue continues with the next due job and resolves rather than
    // rejecting; `fired` counts handlers invoked, including the thrower.
    expect(seen).toEqual(["m1", "m2"])
    expect(result.fired).toBe(2)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toBeInstanceOf(Error)
    expect(result.errors[0]?.message).toBe("boom")

    // M7: "the job stays done". Job.state is not readable through JobStore, so
    // done is observed as: no longer pending, no longer due, and no longer
    // completable. Nothing cancelled it, so that is done.
    expect(store.pendingJobs("g1")).toEqual([])
    expect(store.dueJobs(1_000_000)).toEqual([])
    expect(store.completeJob(first.id)).toBe(false)
    expect(store.completeJob(second.id)).toBe(false)

    // And it is not retried by a later runDue.
    const again = recorder()
    const rerun = await scheduler.runDue(1_000_000, again.handler)
    expect(rerun.fired).toBe(0)
    expect(again.seen.length).toBe(0)
  })
})
