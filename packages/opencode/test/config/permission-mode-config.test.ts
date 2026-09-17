import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ConfigParse } from "../../src/config/parse"

const parse = (data: object) =>
  ConfigParse.schema(ConfigV1.Info, { $schema: "https://opencode.ai/config.json", ...data }, "test")

describe("permission mode config", () => {
  test("decodes default_permission_mode and disable_bypass_permissions", () => {
    const config = parse({ default_permission_mode: "acceptEdits", disable_bypass_permissions: true })
    expect(config.default_permission_mode).toBe("acceptEdits")
    expect(config.disable_bypass_permissions).toBe(true)

    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"] as const) {
      expect(parse({ default_permission_mode: mode }).default_permission_mode).toBe(mode)
    }
    const empty = parse({})
    expect(empty.default_permission_mode).toBeUndefined()
    expect(empty.disable_bypass_permissions).toBeUndefined()
  })

  test("an invalid mode string fails", () => {
    expect(() => parse({ default_permission_mode: "auto" })).toThrow()
    expect(() => parse({ default_permission_mode: "BypassPermissions" })).toThrow()
    expect(() => parse({ disable_bypass_permissions: "yes" })).toThrow()
  })

  test("webfetch and websearch accept host-keyed objects and plain actions", () => {
    const config = parse({
      permission: {
        webfetch: { "*": "ask", "docs.github.com": "allow", "evil.example": "deny" },
        websearch: { "*": "ask" },
      },
    })
    expect(config.permission?.webfetch).toEqual({ "*": "ask", "docs.github.com": "allow", "evil.example": "deny" })
    expect(Object.keys(config.permission?.webfetch as object)).toEqual(["*", "docs.github.com", "evil.example"])
    expect(config.permission?.websearch).toEqual({ "*": "ask" })

    const plain = parse({ permission: { webfetch: "allow", websearch: "deny" } })
    expect(plain.permission?.webfetch).toBe("allow")
    expect(plain.permission?.websearch).toBe("deny")

    expect(() => parse({ permission: { webfetch: { "docs.github.com": "maybe" } } })).toThrow()
  })

  test("the permission schema alone decodes a host-keyed webfetch rule", () => {
    const decoded = ConfigParse.schema(ConfigPermissionV1.Info, { webfetch: { "docs.github.com": "allow" } }, "test")
    expect(decoded.webfetch).toEqual({ "docs.github.com": "allow" })
  })
})
