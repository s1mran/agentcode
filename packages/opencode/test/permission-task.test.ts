import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Permission } from "../src/permission"
import { Config } from "@/config/config"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Config.node))

const load = Config.use.get()

describe("Permission.evaluate for permission.task", () => {
  const createRuleset = (rules: Record<string, "allow" | "deny" | "ask">): PermissionV1.Ruleset =>
    Object.entries(rules).map(([pattern, action]) => ({
      permission: "task",
      pattern,
      action,
    }))

  test("returns ask when no match (default)", () => {
    expect(Permission.evaluate("task", "code-reviewer", []).action).toBe("ask")
  })

  test("returns deny for explicit deny", () => {
    const ruleset = createRuleset({ "code-reviewer": "deny" })
    expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
  })

  test("returns allow for explicit allow", () => {
    const ruleset = createRuleset({ "code-reviewer": "allow" })
    expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("allow")
  })

  test("returns ask for explicit ask", () => {
    const ruleset = createRuleset({ "code-reviewer": "ask" })
    expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("ask")
  })

  test("matches wildcard patterns with deny", () => {
    const ruleset = createRuleset({ "orchestrator-*": "deny" })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("deny")
    expect(Permission.evaluate("task", "orchestrator-slow", ruleset).action).toBe("deny")
    expect(Permission.evaluate("task", "general", ruleset).action).toBe("ask")
  })

  test("matches wildcard patterns with allow", () => {
    const ruleset = createRuleset({ "orchestrator-*": "allow" })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("allow")
    expect(Permission.evaluate("task", "orchestrator-slow", ruleset).action).toBe("allow")
  })

  test("matches wildcard patterns with ask", () => {
    const ruleset = createRuleset({ "orchestrator-*": "ask" })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("ask")
    const globalRuleset = createRuleset({ "*": "ask" })
    expect(Permission.evaluate("task", "code-reviewer", globalRuleset).action).toBe("ask")
  })

  test("a matching deny wins over a later specific allow", () => {
    const ruleset = createRuleset({
      "orchestrator-*": "deny",
      "orchestrator-fast": "allow",
    })
    expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("deny")
    expect(Permission.evaluate("task", "orchestrator-slow", ruleset).action).toBe("deny")
  })

  test("matches global wildcard", () => {
    expect(Permission.evaluate("task", "any-agent", createRuleset({ "*": "allow" })).action).toBe("allow")
    expect(Permission.evaluate("task", "any-agent", createRuleset({ "*": "deny" })).action).toBe("deny")
    expect(Permission.evaluate("task", "any-agent", createRuleset({ "*": "ask" })).action).toBe("ask")
  })
})

describe("Permission.disabled for task tool", () => {
  // Note: The `disabled` function checks if a TOOL should be completely removed from the tool list.
  // It disables a tool when an explicit rule has `pattern: "*"` and `action: "deny"`: denies are absolute, so no
  // specific allow under it can ever apply. Specific subagent patterns are handled at runtime by `evaluate`.
  const createRuleset = (rules: Record<string, "allow" | "deny" | "ask">): PermissionV1.Ruleset =>
    Object.entries(rules).map(([pattern, action]) => ({
      permission: "task",
      pattern,
      action,
    }))

  test("task tool is disabled when global deny pattern exists (even with specific allows)", () => {
    // When "*": "deny" exists, the task tool is disabled because the disabled() function
    // only checks for wildcard deny patterns - it doesn't consider that specific subagents might be allowed
    const ruleset = createRuleset({
      "orchestrator-*": "allow",
      "*": "deny",
    })
    const disabled = Permission.disabled(["task", "bash", "read"], ruleset)
    // The task tool IS disabled because there's a pattern: "*" with action: "deny"
    expect(disabled.has("task")).toBe(true)
  })

  test("task tool is disabled when global deny pattern exists (even with ask overrides)", () => {
    const ruleset = createRuleset({
      "orchestrator-*": "ask",
      "*": "deny",
    })
    const disabled = Permission.disabled(["task"], ruleset)
    // The task tool IS disabled because there's a pattern: "*" with action: "deny"
    expect(disabled.has("task")).toBe(true)
  })

  test("task tool is disabled when global deny pattern exists", () => {
    const ruleset = createRuleset({ "*": "deny" })
    const disabled = Permission.disabled(["task"], ruleset)
    expect(disabled.has("task")).toBe(true)
  })

  test("task tool is NOT disabled when only specific patterns are denied (no wildcard)", () => {
    // The disabled() function only disables tools when pattern: "*" && action: "deny"
    // Specific subagent denies don't disable the task tool - those are handled at runtime
    const ruleset = createRuleset({
      "orchestrator-*": "deny",
      general: "deny",
    })
    const disabled = Permission.disabled(["task"], ruleset)
    // The task tool is NOT disabled because no rule has pattern: "*" with action: "deny"
    expect(disabled.has("task")).toBe(false)
  })

  test("task tool is enabled when no task rules exist (default ask)", () => {
    const disabled = Permission.disabled(["task"], [])
    expect(disabled.has("task")).toBe(false)
  })

  test("task tool is disabled by a wildcard deny even when a specific allow comes after it", () => {
    // Explicit denies always win, so "orchestrator-coder" is denied too and the tool is hidden
    const ruleset = createRuleset({
      "*": "deny",
      "orchestrator-coder": "allow",
    })
    const disabled = Permission.disabled(["task"], ruleset)
    expect(Permission.evaluate("task", "orchestrator-coder", ruleset).action).toBe("deny")
    expect(disabled.has("task")).toBe(true)
  })
})

// Integration tests that load permissions from real config files
describe("permission.task with real config files", () => {
  it.instance(
    "loads task permissions from opencode.json config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})
        // general and orchestrator-fast should be allowed, code-reviewer denied
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "allow",
            "code-reviewer": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "loads task permissions with wildcard patterns from config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})
        // general and code-reviewer should be ask, orchestrator-* denied
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("ask")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("ask")
        expect(Permission.evaluate("task", "orchestrator-fast", ruleset).action).toBe("deny")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "ask",
            "orchestrator-*": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "evaluate respects task permission from config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("allow")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
        // Unspecified agents default to "ask"
        expect(Permission.evaluate("task", "unknown-agent", ruleset).action).toBe("ask")
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            general: "allow",
            "code-reviewer": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "mixed permission config with task and other tools",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        // Verify task permissions: the "*" deny is absolute, so the "general" allow never applies
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("deny")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")

        // Verify other tool permissions
        expect(Permission.evaluate("bash", "*", ruleset).action).toBe("allow")
        expect(Permission.evaluate("edit", "*", ruleset).action).toBe("ask")

        // Verify disabled tools
        const disabled = Permission.disabled(["bash", "edit", "task"], ruleset)
        expect(disabled.has("bash")).toBe(false)
        expect(disabled.has("edit")).toBe(false)
        // task is disabled because an explicit "*" deny matches it
        expect(disabled.has("task")).toBe(true)
      }),
    {
      git: true,
      config: {
        permission: {
          bash: "allow",
          edit: "ask",
          task: {
            "*": "deny",
            general: "allow",
          },
        },
      },
    },
  )

  it.instance(
    "task tool disabled when global deny comes last in config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        // The explicit "*" deny matches every agent, so all agents are denied
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("deny")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")
        expect(Permission.evaluate("task", "unknown", ruleset).action).toBe("deny")

        // disabled() sees an explicit pattern: "*" rule with action: "deny", so task is disabled
        const disabled = Permission.disabled(["task"], ruleset)
        expect(disabled.has("task")).toBe(true)
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            general: "allow",
            "code-reviewer": "allow",
            "*": "deny",
          },
        },
      },
    },
  )

  it.instance(
    "task tool disabled when a specific allow comes after a wildcard deny in config",
    () =>
      Effect.gen(function* () {
        const config = yield* load
        const ruleset = Permission.fromConfig(config.permission ?? {})

        // Explicit denies always win, whatever the order: "general" is denied by the "*" deny
        expect(Permission.evaluate("task", "general", ruleset).action).toBe("deny")
        expect(Permission.evaluate("task", "code-reviewer", ruleset).action).toBe("deny")

        // disabled() hides the tool because an explicit "*" deny matches it
        const disabled = Permission.disabled(["task"], ruleset)
        expect(disabled.has("task")).toBe(true)
      }),
    {
      git: true,
      config: {
        permission: {
          task: {
            "*": "deny",
            general: "allow",
          },
        },
      },
    },
  )
})
