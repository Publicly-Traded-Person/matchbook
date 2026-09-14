// Exam for Task 11: slash command definitions, zone autocomplete, availability
// menus. Every assertion below names the Proof leg (a)-(f) and the Machine
// clause M1-M6 it comes from, so the exam maps back to the contract.
//
// The task declares three files -- src/adapters/discord/commands.ts, zones.ts
// and components.ts -- but does not pin which of the three exports which
// symbol, so the exam loads all three and resolves each name from the Produces
// list out of the merged namespace. Missing module => the implementation does
// not exist yet; missing symbol => a named assertion below says which.

import { describe, expect, test } from "bun:test"
import type {
  AvailabilityPreset,
  Button,
  OutgoingMessage,
  SelectMenu,
} from "../src/types"

const MODULES = ["commands", "zones", "components"] as const

async function loadAdapterApi(): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = {}
  for (const name of MODULES) {
    const mod: Record<string, unknown> = await import(
      `../src/adapters/discord/${name}`
    )
    for (const [key, value] of Object.entries(mod)) merged[key] = value
  }
  return merged
}

const api = await loadAdapterApi()

function produced<T>(name: string): T {
  const value = api[name]
  if (value === undefined) {
    throw new Error(
      `Produces: ${name} is not exported by any of ${MODULES.map((m) => `src/adapters/discord/${m}.ts`).join(", ")}`,
    )
  }
  return value as T
}

// ------------------------------------------------------------- the surface --

const commandDefinitions = produced<() => CommandJson[]>("commandDefinitions")
const zoneSuggestions =
  produced<(query: string, limit?: number) => string[]>("zoneSuggestions")
const ZONE_ALIASES =
  produced<Readonly<Record<string, string>>>("ZONE_ALIASES")
const PERMISSIONS = produced<readonly string[]>("PERMISSIONS")
const permissionsBitfield = produced<() => bigint>("permissionsBitfield")
const inviteUrl = produced<(clientId: string) => string>("inviteUrl")
const availabilityMenu =
  produced<(preset: AvailabilityPreset) => OutgoingMessage>("availabilityMenu")
const daysSelect = produced<() => SelectMenu>("daysSelect")
const hoursSelect = produced<() => SelectMenu>("hoursSelect")
const customId = produced<(action: string, ref: string) => string>("customId")
const parseCustomId =
  produced<(id: string) => { action: string; ref: string }>("parseCustomId")

// The shape the test reads out of the command JSON, per the task's Context:
// options[].name, .required, .autocomplete, .type; subcommands are type 1 and
// user options are type 6.
interface OptionJson {
  readonly name: string
  readonly type: number
  readonly required?: boolean
  readonly autocomplete?: boolean
  readonly options?: readonly OptionJson[]
}
interface CommandJson {
  readonly name: string
  readonly options?: readonly OptionJson[]
}

function command(name: string): CommandJson {
  const found = commandDefinitions().find((c) => c.name === name)
  if (!found) throw new Error(`no command definition named ${name}`)
  return found
}

function option(cmd: CommandJson, name: string): OptionJson {
  const found = (cmd.options ?? []).find((o) => o.name === name)
  if (!found) throw new Error(`command ${cmd.name} has no option named ${name}`)
  return found
}

// --------------------------------------------------------------- leg (a) M1 --

describe("leg (a) [M1] command definitions", () => {
  test("the sorted command names deep-equal the seven literals", () => {
    const names = commandDefinitions()
      .map((c) => c.name)
      .sort()
    expect(names).toEqual([
      "availability",
      "forget",
      "join",
      "matchbook",
      "pause",
      "resume",
      "timezone",
    ])
  })

  test("/join's timezone option is a required autocompleting string", () => {
    const opt = option(command("join"), "timezone")
    expect(opt.type).toBe(3)
    expect(opt.required).toBe(true)
    expect(opt.autocomplete).toBe(true)
  })

  test("/join's avoid option is an optional string", () => {
    const opt = option(command("join"), "avoid")
    expect(opt.type).toBe(3)
    expect(opt.required ?? false).toBe(false)
  })

  test("/join has no option named interests (build 2, #19)", () => {
    const names = (command("join").options ?? []).map((o) => o.name)
    expect(names).not.toContain("interests")
  })

  test("/timezone's timezone option is a required autocompleting string", () => {
    const opt = option(command("timezone"), "timezone")
    expect(opt.type).toBe(3)
    expect(opt.required).toBe(true)
    expect(opt.autocomplete).toBe(true)
  })

  test("/matchbook's sorted subcommand names deep-equal config, pair, status", () => {
    const subs = (command("matchbook").options ?? []).filter((o) => o.type === 1)
    expect(subs.map((s) => s.name).sort()).toEqual(["config", "pair", "status"])
  })

  test("/matchbook pair has two required user options a and b", () => {
    const subs = (command("matchbook").options ?? []).filter((o) => o.type === 1)
    const pair = subs.find((s) => s.name === "pair")
    if (!pair) throw new Error("no matchbook subcommand named pair")
    const opts = [...(pair.options ?? [])]
    expect(opts.length).toBe(2)
    expect(opts.map((o) => o.name).sort()).toEqual(["a", "b"])
    for (const o of opts) {
      expect(o.type).toBe(6)
      expect(o.required).toBe(true)
    }
  })
})

// --------------------------------------------------------------- leg (b) M2 --

describe("leg (b) [M2] zone suggestions", () => {
  test("'oak' yields a list containing America/Los_Angeles", () => {
    expect(zoneSuggestions("oak")).toContain("America/Los_Angeles")
  })

  test("'kos' yields a list containing Europe/Belgrade", () => {
    expect(zoneSuggestions("kos")).toContain("Europe/Belgrade")
  })

  test("'belg' yields a list containing Europe/Belgrade", () => {
    expect(zoneSuggestions("belg")).toContain("Europe/Belgrade")
  })

  test("every result is a real IANA zone and no list is longer than 25", () => {
    const zones = new Set(Intl.supportedValuesOf("timeZone"))
    for (const query of ["", "a", "europe", "zzzz"]) {
      const results = zoneSuggestions(query)
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeLessThanOrEqual(25)
      for (const r of results) {
        expect(zones.has(r)).toBe(true)
      }
    }
  })

  test("the empty query yields a non-empty list", () => {
    expect(zoneSuggestions("").length).toBeGreaterThan(0)
  })

  test("ZONE_ALIASES maps at least oakland, portland, kosovo and pristina", () => {
    expect(ZONE_ALIASES["oakland"]).toBe("America/Los_Angeles")
    expect(ZONE_ALIASES["portland"]).toBe("America/Los_Angeles")
    expect(ZONE_ALIASES["kosovo"]).toBe("Europe/Belgrade")
    expect(ZONE_ALIASES["pristina"]).toBe("Europe/Belgrade")
  })
})

// --------------------------------------------------------------- leg (c) M3 --

describe("leg (c) [M3] permissions and invite url", () => {
  test("PERMISSIONS deep-equals the seven literal names", () => {
    expect([...PERMISSIONS]).toEqual([
      "View Channels",
      "Send Messages",
      "Create Private Threads",
      "Send Messages in Threads",
      "Manage Threads",
      "Manage Channels",
      "Connect",
    ])
  })

  test("permissionsBitfield() is 360778304528n", () => {
    expect(permissionsBitfield()).toBe(360778304528n)
  })

  test("inviteUrl('123') contains the three literal substrings", () => {
    const url = inviteUrl("123")
    expect(url).toContain("client_id=123")
    expect(url).toContain("permissions=360778304528")
    expect(url).toContain("scope=bot%20applications.commands")
  })
})

// --------------------------------------------------------------- leg (d) M4 --

const AVAIL_BUTTON_IDS = [
  "avail:any-reasonable-hour",
  "avail:clear",
  "avail:custom",
  "avail:evenings-only",
  "avail:weekdays-9-5-off",
  "avail:weekends-only",
] // sorted, for a set comparison that does not pin button order

const PRESETS: readonly AvailabilityPreset[] = [
  "weekdays-9-5-off",
  "evenings-only",
  "weekends-only",
  "any-reasonable-hour",
  "custom",
]

describe("leg (d) [M4] availability menu", () => {
  test("availabilityMenu('evenings-only') has the six literal button ids", () => {
    const buttons = [...(availabilityMenu("evenings-only").buttons ?? [])]
    expect(buttons.length).toBe(6)
    expect(buttons.map((b) => b.id).sort()).toEqual(AVAIL_BUTTON_IDS)
  })

  test("availabilityMenu('evenings-only') styles that button primary, the other five secondary", () => {
    const buttons = [...(availabilityMenu("evenings-only").buttons ?? [])]
    const chosen = buttons.filter((b) => b.id === "avail:evenings-only")
    const rest = buttons.filter((b) => b.id !== "avail:evenings-only")
    expect(chosen.length).toBe(1)
    expect(chosen[0]!.style).toBe("primary")
    expect(rest.length).toBe(5)
    for (const b of rest) expect(b.style).toBe("secondary")
  })

  test("for every preset the button for that preset is the only primary one", () => {
    for (const preset of PRESETS) {
      const buttons = [...(availabilityMenu(preset).buttons ?? [])]
      expect(buttons.map((b) => b.id).sort()).toEqual(AVAIL_BUTTON_IDS)
      const primaries = buttons.filter((b) => b.style === "primary")
      expect(primaries.map((b) => b.id)).toEqual([`avail:${preset}`])
      for (const b of buttons.filter((x) => x.style !== "primary")) {
        expect(b.style).toBe("secondary")
      }
    }
  })

  test("the menu carries a short prompt and copy free of the forbidden strings", () => {
    const message = availabilityMenu("custom")
    expect(typeof message.content).toBe("string")
    expect(message.content.length).toBeGreaterThan(0)
    const strings = [
      message.content,
      ...[...(message.buttons ?? [])].map((b: Button) => b.label),
    ]
    for (const s of strings) {
      // global constraint: no em dash, no "experiment", no KmikeyM, shares or votes
      expect(s).not.toContain("—")
      expect(s.toLowerCase()).not.toContain("experiment")
      expect(s.toLowerCase()).not.toContain("kmikeym")
    }
  })
})

// --------------------------------------------------------------- leg (e) M5 --

describe("leg (e) [M5] day and hour selects", () => {
  test("daysSelect() is avail-days with Monday through Sunday valued 0..6", () => {
    const menu = daysSelect()
    expect(menu.id).toBe("avail-days")
    const options = [...menu.options]
    expect(options.map((o) => o.value)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ])
    expect(options.map((o) => o.label)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ])
    expect(menu.min).toBe(1)
    expect(menu.max).toBe(7)
  })

  test("hoursSelect() is avail-hours with 24 options valued 0..23", () => {
    const menu = hoursSelect()
    expect(menu.id).toBe("avail-hours")
    const options = [...menu.options]
    expect(options.length).toBe(24)
    expect(options.map((o) => o.value)).toEqual(
      Array.from({ length: 24 }, (_, i) => String(i)),
    )
    expect(menu.min).toBe(1)
    expect(menu.max).toBe(24)
  })
})

// --------------------------------------------------------------- leg (f) M6 --

describe("leg (f) [M6] custom ids", () => {
  test("parseCustomId('confirm:p1') deep-equals { action, ref }", () => {
    expect(parseCustomId("confirm:p1")).toEqual({
      action: "confirm",
      ref: "p1",
    })
  })

  test("parseCustomId splits on the first colon only", () => {
    const parsed = parseCustomId("x:a:b")
    expect(parsed.action).toBe("x")
    expect(parsed.ref).toBe("a:b")
  })

  test("customId('confirm', 'p1') is 'confirm:p1'", () => {
    expect(customId("confirm", "p1")).toBe("confirm:p1")
  })

  test("the availability button ids round-trip through the pair", () => {
    expect(customId("avail", "evenings-only")).toBe("avail:evenings-only")
    expect(parseCustomId("avail:evenings-only")).toEqual({
      action: "avail",
      ref: "evenings-only",
    })
  })
})
