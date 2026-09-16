import { describe, expect, test } from "bun:test"
import { dict as app } from "./en"

// OpenCode's own external services and upstream docs keep their names.
const ALLOWED_UPSTREAM = /OpenCode (Zen|Go)\b|OpenCode provider config docs/g
const FORBIDDEN = /OpenCode|Discord|agentcode\.ai/

async function dictionary(file: string) {
  const module: unknown = await import(file)
  if (typeof module !== "object" || module === null || !("dict" in module)) {
    throw new Error(`Invalid translation dictionary: ${file}`)
  }
  return module.dict as Record<string, string>
}

function offenders(dict: Record<string, string>) {
  return Object.entries(dict)
    .filter(([, value]) => FORBIDDEN.test(value.replace(ALLOWED_UPSTREAM, "")))
    .map(([key, value]) => `${key}: ${value}`)
}

describe("English brand strings", () => {
  test("app, ui and desktop English dictionaries say AgentCode", async () => {
    const ui = await dictionary("../../../ui/src/i18n/en.ts")
    const desktop = await dictionary("../../../desktop/src/renderer/i18n/en.ts")

    expect(offenders(app)).toEqual([])
    expect(offenders(ui)).toEqual([])
    expect(offenders(desktop)).toEqual([])
  })

  test("OpenCode Zen keeps its real name and link text", () => {
    expect(app["provider.connect.opencodeZen.line1"].startsWith("OpenCode Zen ")).toBe(true)
    expect(app["provider.connect.opencodeZen.visit.link"]).toBe("opencode.ai/zen")
  })

  test("error reports point at GitHub", () => {
    expect(app["error.page.report.discord"]).toBe("on GitHub")
  })
})
