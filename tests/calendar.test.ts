// Exam for Task 7: "Slot proposal and the calendar file".
//
// Every assertion below names the Proof leg it discharges and the Machine
// clause that leg comes from, so the exam maps back to the contract one line
// at a time. The clock is a fixed literal everywhere: nothing here reads the
// wall clock and nothing sleeps.

import { describe, expect, test } from "bun:test"
import {
  alternatives,
  formatIcsTime,
  ics,
  proposeSlots,
} from "../src/core/calendar"
import type { IcsEvent, SlotOptions } from "../src/core/calendar"

const DAY = 86400000

/** A UTC instant on `1 + n` September 2026 at `hourUtc`:00, always on the hour. */
const day = (n: number, hourUtc: number): number =>
  Date.UTC(2026, 8, 1 + n, hourUtc)

/** The fixed "now" every slot test is driven from: 1 Sept 2026, 12:00 UTC. */
const NOW = day(0, 12)

/** The default window of the Context, with both zones collapsed onto UTC. */
const UTC_OPTS: SlotOptions = {
  minDays: 3,
  maxDays: 10,
  zoneA: "UTC",
  zoneB: "UTC",
}

describe("leg (a) [M1] proposeSlots keeps the window, the hour and uniqueness", () => {
  // `shared` holds hours at 2, 3, 5, 10 and 11 days after `now`, one off-hour
  // value, and one repeat of the day-5 value. Deliberately out of order.
  const d2 = NOW + 2 * DAY
  const d3 = NOW + 3 * DAY
  const d5 = NOW + 5 * DAY
  const d10 = NOW + 10 * DAY
  const d11 = NOW + 11 * DAY
  const offHour = NOW + 4 * DAY + 1800000 // 04d 00:30 -> not % 3600000 === 0

  const shared: readonly number[] = [d10, d2, d5, d3, d11, offHour, d5]
  const result = proposeSlots(shared, NOW, UTC_OPTS)

  test("returns exactly the day-3, day-5 and day-10 hours [M1]", () => {
    // Both zones are UTC and every surviving slot is at 12:00 local, so none
    // of them is an evening slot and the M2 order is plain ascending. That
    // keeps this leg about the filter and leg (b) about the order.
    expect(result).toEqual([d3, d5, d10])
  })

  test("drops the day-2 and day-11 values as outside the window [M1]", () => {
    expect(result).not.toContain(d2)
    expect(result).not.toContain(d11)
  })

  test("drops the off-hour value [M1]", () => {
    expect(offHour % 3600000).not.toBe(0) // the fixture really is off the hour
    expect(result).not.toContain(offHour)
    for (const slot of result) expect(slot % 3600000).toBe(0)
  })

  test("returns no value twice when shared repeats one [M1]", () => {
    expect(shared.filter((s) => s === d5).length).toBe(2) // the fixture repeats
    expect(result.filter((s) => s === d5).length).toBe(1)
    expect(new Set(result).size).toBe(result.length)
  })

  test("keeps the closed window boundaries inclusive [M1]", () => {
    // M1 writes the window as [now + minDays * 86400000, now + maxDays *
    // 86400000]; d3 and d10 sit exactly on those two endpoints.
    expect(d3).toBe(NOW + UTC_OPTS.minDays * 86400000)
    expect(d10).toBe(NOW + UTC_OPTS.maxDays * 86400000)
    expect(result).toContain(d3)
    expect(result).toContain(d10)
  })
})

describe("leg (b) [M2] evening-in-both first, then the rest, each ascending", () => {
  // Etc/GMT-1 is UTC+1 and Etc/GMT-3 is UTC+3 (POSIX sign inversion), so:
  //   16:00 UTC -> 17:00 zoneA / 19:00 zoneB  -> evening in both
  //   18:00 UTC -> 19:00 zoneA / 21:00 zoneB  -> evening in zoneA only
  //   08:00 UTC -> 09:00 zoneA / 11:00 zoneB  -> evening in neither
  const opts: SlotOptions = {
    minDays: 3,
    maxDays: 10,
    zoneA: "Etc/GMT-1",
    zoneB: "Etc/GMT-3",
  }

  const d5at18 = day(5, 18)
  const d4at08 = day(4, 8)
  const d6at16 = day(6, 16)
  const d3at16 = day(3, 16)

  const shared: readonly number[] = [d5at18, d4at08, d6at16, d3at16]

  test("orders the four slots exactly as the leg spells them [M2]", () => {
    expect(proposeSlots(shared, NOW, opts)).toEqual([
      d3at16, // evening in both, earlier
      d6at16, // evening in both, later
      d4at08, // evening in neither, earlier
      d5at18, // evening in zoneA only, so it sorts after the 08:00 slot
    ])
  })

  test("the evening-in-both pair precedes every other slot [M2]", () => {
    const result = proposeSlots(shared, NOW, opts)
    expect(result.indexOf(d3at16)).toBeLessThan(result.indexOf(d4at08))
    expect(result.indexOf(d3at16)).toBeLessThan(result.indexOf(d5at18))
    expect(result.indexOf(d6at16)).toBeLessThan(result.indexOf(d4at08))
    expect(result.indexOf(d6at16)).toBeLessThan(result.indexOf(d5at18))
  })

  test("each group is ascending by time [M2]", () => {
    const result = proposeSlots(shared, NOW, opts)
    expect(result.indexOf(d3at16)).toBeLessThan(result.indexOf(d6at16))
    expect(result.indexOf(d4at08)).toBeLessThan(result.indexOf(d5at18))
  })

  test("an hour that is evening in only one zone is not an evening slot [M2]", () => {
    // 18:00 UTC is 19:00 in zoneA but 21:00 in zoneB. If it were treated as
    // evening it would lead the result; it must trail the 08:00 slot instead.
    const result = proposeSlots(shared, NOW, opts)
    expect(result[result.length - 1]).toBe(d5at18)
  })
})

describe("leg (c) [M3] alternatives is the proposal order minus chosen, capped at 5", () => {
  // Eight qualifying slots, none of them on a window boundary and none of them
  // an evening slot, so proposeSlots order is plain ascending.
  const eight: readonly number[] = [
    day(3, 13),
    day(4, 13),
    day(5, 13),
    day(6, 13),
    day(7, 13),
    day(8, 13),
    day(9, 13),
    day(10, 11),
  ]

  test("the fixture really does yield eight qualifying slots [M1]", () => {
    expect(proposeSlots(eight, NOW, UTC_OPTS).length).toBe(8)
  })

  test("returns exactly 5 slots, none equal to chosen [M3]", () => {
    const proposed = proposeSlots(eight, NOW, UTC_OPTS)
    const chosen = proposed[0]!
    const alts = alternatives(eight, NOW, chosen, UTC_OPTS)

    expect(alts.length).toBe(5)
    expect(alts).not.toContain(chosen)
  })

  test("equals proposeSlots with chosen removed, truncated to 5 [M3]", () => {
    const proposed = proposeSlots(eight, NOW, UTC_OPTS)
    const chosen = proposed[0]!
    const expected = proposed.filter((s) => s !== chosen).slice(0, 5)

    expect(alternatives(eight, NOW, chosen, UTC_OPTS)).toEqual(expected)
  })

  test("returns at most 5 even when fewer slots remain [M3]", () => {
    const three: readonly number[] = [day(3, 13), day(4, 13), day(5, 13)]
    const proposed = proposeSlots(three, NOW, UTC_OPTS)
    const chosen = proposed[0]!
    const alts = alternatives(three, NOW, chosen, UTC_OPTS)

    expect(alts.length).toBeLessThanOrEqual(5)
    expect(alts).toEqual(proposed.filter((s) => s !== chosen))
  })
})

/** The fixed event of leg (d). 30 minutes at 17 Sept 2026, 19:00 UTC. */
const EVENT: IcsEvent = {
  uid: "abc",
  dtstamp: Date.UTC(2026, 8, 17, 18, 30, 0),
  startUtc: Date.UTC(2026, 8, 17, 19, 0, 0),
  durationMin: 30,
  summary: "Matchbook call",
  description: "A 30 minute call with your pairing.",
  threadUrl: "https://discord.com/channels/1/2/3",
}

/** Split an .ics body on CRLF, dropping the single empty tail the final CRLF leaves. */
function icsLines(out: string): string[] {
  const raw = out.split("\r\n")
  return raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw
}

describe("leg (d) [M4] the calendar file is one VEVENT with the seven lines", () => {
  const out = ics(EVENT)
  const lines = icsLines(out)

  test("lines are joined by CRLF and the body ends with CRLF [M4]", () => {
    expect(out.endsWith("\r\n")).toBe(true)
    expect(out.split("\n").every((l) => l === "" || l.endsWith("\r"))).toBe(true)
  })

  test("first line is BEGIN:VCALENDAR, last is END:VCALENDAR [M4]", () => {
    expect(lines[0]).toBe("BEGIN:VCALENDAR")
    expect(lines[lines.length - 1]).toBe("END:VCALENDAR")
  })

  test("contains exactly one BEGIN:VEVENT line [M4]", () => {
    expect(lines.filter((l) => l === "BEGIN:VEVENT").length).toBe(1)
  })

  test("contains the UID, DTSTAMP, SUMMARY, DESCRIPTION and LOCATION lines [M4]", () => {
    expect(lines).toContain("UID:abc")
    expect(lines).toContain("DTSTAMP:20260917T183000Z")
    expect(lines).toContain("SUMMARY:Matchbook call")
    expect(lines).toContain("DESCRIPTION:A 30 minute call with your pairing.")
    expect(lines).toContain("LOCATION:https://discord.com/channels/1/2/3")
  })

  test("DTSTART is the UTC start and DTEND is start plus durationMin [M4]", () => {
    expect(lines).toContain("DTSTART:20260917T190000Z")
    expect(lines).toContain("DTEND:20260917T193000Z")
  })

  test("carries VERSION:2.0 and the Matchbook PRODID [M4, Context]", () => {
    expect(lines).toContain("VERSION:2.0")
    expect(lines).toContain("PRODID:-//Matchbook//EN")
  })
})

describe("leg (e) [M5] no ORGANIZER or ATTENDEE, and UID survives a re-lock", () => {
  test("no line begins with ORGANIZER or ATTENDEE [M5]", () => {
    for (const line of icsLines(ics(EVENT))) {
      expect(line.startsWith("ORGANIZER")).toBe(false)
      expect(line.startsWith("ATTENDEE")).toBe(false)
    }
  })

  test("two events one day apart share the UID line byte for byte [M5]", () => {
    const first = ics(EVENT)
    const second = ics({ ...EVENT, startUtc: EVENT.startUtc + DAY })

    const uidOf = (out: string) =>
      icsLines(out).filter((l) => l.startsWith("UID:"))

    expect(uidOf(first)).toEqual(["UID:abc"])
    expect(uidOf(second)).toEqual(["UID:abc"])
    expect(uidOf(first)[0]).toBe(uidOf(second)[0]!)
  })

  test("the two outputs really do differ in their start [M5]", () => {
    // Otherwise the shared UID above would be trivially true.
    const first = ics(EVENT)
    const second = ics({ ...EVENT, startUtc: EVENT.startUtc + DAY })
    expect(icsLines(second)).toContain("DTSTART:20260918T190000Z")
    expect(first).not.toBe(second)
  })
})

describe("leg (f) [M6] formatIcsTime", () => {
  test("formats the fixed instant as 20260917T190000Z [M6]", () => {
    expect(formatIcsTime(Date.UTC(2026, 8, 17, 19, 0, 0))).toBe(
      "20260917T190000Z",
    )
  })
})
