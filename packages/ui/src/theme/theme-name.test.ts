import { describe, expect, test } from "bun:test"
import opencode from "./themes/opencode.json"

describe("opencode theme display name", () => {
  test("keeps the opencode id but shows AgentCode", () => {
    expect(opencode.id).toBe("opencode")
    expect(opencode.name).toBe("AgentCode")
  })

  test("the fallback names map labels the opencode theme AgentCode", async () => {
    // `names` is not exported and context.tsx depends on import.meta.glob, so scan the source.
    const source = await Bun.file(new URL("./context.tsx", import.meta.url)).text()
    expect(source).toMatch(/\bopencode: "AgentCode",/)
    expect(source.includes('"OpenCode"')).toBe(false)
  })
})
