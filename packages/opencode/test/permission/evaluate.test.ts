import { describe, expect, test } from "bun:test"
import path from "path"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../../src/permission"
import { DONT_ASK_REASON, combine, decide, planReason, type DecideInput } from "../../src/permission/evaluate"

const rules = (config: Parameters<typeof Permission.fromConfig>[0]) => Permission.fromConfig(config)
const builtin = (config: Parameters<typeof Permission.fromConfig>[0]): PermissionV1.Rule[] =>
  Permission.fromConfig(config).map((rule) => ({ ...rule, source: "builtin" as const }))

const run = (input: Partial<DecideInput> & Pick<DecideInput, "permission" | "pattern">) =>
  decide({ rules: [], mode: "default", ...input })

const floor: PermissionV1.Guard = { level: "floor", category: "critical_rm", reason: "removes the project folder" }
const guard: PermissionV1.Guard = { level: "guard", category: "destructive_git", reason: "force-pushes" }

describe("decide - rule precedence", () => {
  test("an explicit deny beats a later catch-all allow", () => {
    const ruleset = [...rules({ bash: { "git push *": "deny" } }), ...rules({ "*": "allow" })]
    expect(run({ permission: "bash", pattern: "git push -f", rules: ruleset }).action).toBe("deny")
  })

  test("a specific allow refines a tool-level catch-all ask", () => {
    const ruleset = rules({ "*": "ask", bash: { "git *": "allow" } })
    expect(run({ permission: "bash", pattern: "git status", rules: ruleset }).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", rules({ bash: { "*": "ask", "git *": "allow" } })).action).toBe(
      "allow",
    )
  })

  test("a specific ask beats a broader specific allow and withholds always", () => {
    const decision = run({
      permission: "bash",
      pattern: "git push origin main",
      rules: rules({ bash: { "git *": "allow", "git push *": "ask" } }),
    })
    expect(decision.action).toBe("ask")
    expect(decision.via).toBe("spec-ask")
    expect(decision.withholdAlways).toBe(true)
  })

  test("a tool-level deny is absolute, even for specific allows under it", () => {
    expect(
      run({ permission: "bash", pattern: "ls -la", rules: rules({ bash: { "*": "deny", "ls *": "allow" } }) }).action,
    ).toBe("deny")
  })

  test("deny rules also match the strict and loose command forms", () => {
    const hint: PermissionV1.Hint = { pattern: "sudo git push -f", strict: "sudo git push -f", loose: "git push -f" }
    const decision = run({
      permission: "bash",
      pattern: hint.pattern,
      hint,
      rules: rules({ bash: { "git push *": "deny" } }),
    })
    expect(decision.action).toBe("deny")
  })

  test("allow rules match only the strict form", () => {
    const hint: PermissionV1.Hint = { pattern: "FOO=1 npm test", strict: "FOO=1 npm test", loose: "npm test" }
    expect(
      run({ permission: "bash", pattern: hint.pattern, hint, rules: rules({ bash: { "npm test*": "allow" } }) }).action,
    ).toBe("ask")
  })

  test("without a strict form, allow rules also match the loose form (webfetch URL rules)", () => {
    const hint: PermissionV1.Hint = { pattern: "docs.github.com", loose: "https://docs.github.com/en/x" }
    const ruleset = rules({ webfetch: { "*": "ask", "https://docs.github.com/*": "allow" } })
    expect(run({ permission: "webfetch", pattern: hint.pattern, hint, rules: ruleset }).action).toBe("allow")
    const other: PermissionV1.Hint = { pattern: "evil.dev", loose: "https://evil.dev/docs.github.com/" }
    expect(run({ permission: "webfetch", pattern: other.pattern, hint: other, rules: ruleset }).action).toBe("ask")
    const host = rules({ webfetch: { "*": "ask", "docs.github.com": "allow" } })
    expect(run({ permission: "webfetch", pattern: hint.pattern, hint, rules: host }).action).toBe("allow")
  })
})

describe("decide - built-ins, catch-alls and read-only commands", () => {
  const readOnly: PermissionV1.Hint = { pattern: "ls -la", readOnly: true }

  test("a built-in ask lets a read-only command through", () => {
    const decision = run({ permission: "bash", pattern: "ls -la", hint: readOnly, rules: builtin({ "*": "ask" }) })
    expect(decision.action).toBe("allow")
    expect(decision.via).toBe("readonly")
  })

  test("a user catch-all ask still asks for read-only commands", () => {
    expect(run({ permission: "bash", pattern: "ls -la", hint: readOnly, rules: rules({ "*": "ask" }) }).action).toBe(
      "ask",
    )
  })

  test("a user bash ask still asks for read-only commands", () => {
    const decision = run({ permission: "bash", pattern: "ls -la", hint: readOnly, rules: rules({ bash: "ask" }) })
    expect(decision.action).toBe("ask")
    expect(decision.via).toBe("tool-ask")
  })

  test("a custom agent that denies everything but read", () => {
    const ruleset = [...builtin({ "*": "ask", read: "allow" }), ...rules({ "*": "deny", read: "allow" })]
    expect(run({ permission: "read", pattern: "src/a.ts", rules: ruleset }).action).toBe("allow")
    expect(run({ permission: "bash", pattern: "ls", hint: readOnly, rules: ruleset }).action).toBe("deny")
  })

  test("no rule at all counts as a built-in ask", () => {
    expect(run({ permission: "unknown", pattern: "x" }).action).toBe("ask")
    expect(run({ permission: "unknown", pattern: "x" }).via).toBe("none")
  })

  test("built-in rules keep last-match order among themselves", () => {
    const ruleset = builtin({ edit: { "*": "deny", ".opencode/plans/*.md": "allow" } })
    expect(run({ permission: "edit", pattern: ".opencode/plans/a.md", rules: ruleset }).action).toBe("allow")
    expect(run({ permission: "edit", pattern: "src/a.ts", rules: ruleset }).action).toBe("deny")
  })
})

describe("decide - approvals", () => {
  test("a session approval for edit * cannot override an explicit edit deny", () => {
    const ruleset = [
      ...builtin({ "*": "ask" }),
      ...rules({ edit: { "secrets/*": "deny" } }),
      { permission: "edit", pattern: "*", action: "allow" as const },
    ]
    expect(run({ permission: "edit", pattern: "secrets/key.pem", rules: ruleset }).action).toBe("deny")
    expect(run({ permission: "edit", pattern: "src/a.ts", rules: ruleset }).action).toBe("allow")
  })
})

describe("decide - floor and guard", () => {
  const hint = (value: PermissionV1.Guard): PermissionV1.Hint => ({ pattern: "rm -rf .", guard: value })

  test("floor asks in default, acceptEdits and bypassPermissions and denies in dontAsk", () => {
    for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) {
      const decision = run({
        permission: "bash",
        pattern: "rm -rf .",
        hint: hint(floor),
        mode,
        rules: builtin({ "*": "ask" }),
      })
      expect(decision.action).toBe("ask")
      expect(decision.guard?.level).toBe("floor")
      expect(decision.withholdAlways).toBe(true)
    }
    const denied = run({ permission: "bash", pattern: "rm -rf .", hint: hint(floor), mode: "dontAsk" })
    expect(denied.action).toBe("deny")
    expect(denied.reason).toBe(DONT_ASK_REASON)
  })

  test("an explicit allow does not skip the floor, an explicit deny still denies", () => {
    expect(
      run({ permission: "bash", pattern: "rm -rf .", hint: hint(floor), rules: rules({ bash: { "rm *": "allow" } }) })
        .action,
    ).toBe("ask")
    expect(
      run({ permission: "bash", pattern: "rm -rf .", hint: hint(floor), rules: rules({ bash: "allow" }) }).action,
    ).toBe("ask")
    expect(
      run({ permission: "bash", pattern: "rm -rf .", hint: hint(floor), rules: rules({ bash: { "rm *": "deny" } }) })
        .action,
    ).toBe("deny")
  })

  test("guard asks in default, acceptEdits and plan, allows in bypassPermissions, denies in dontAsk", () => {
    const pattern = "git push -f"
    const guarded: PermissionV1.Hint = { pattern, guard }
    const ruleset = rules({ bash: { "git *": "allow" } })
    for (const mode of ["default", "acceptEdits", "plan"] as const)
      expect(run({ permission: "bash", pattern, hint: guarded, mode, rules: ruleset }).action).toBe("ask")
    expect(run({ permission: "bash", pattern, hint: guarded, mode: "bypassPermissions", rules: ruleset }).action).toBe(
      "allow",
    )
    expect(run({ permission: "bash", pattern, hint: guarded, mode: "dontAsk", rules: ruleset }).action).toBe("deny")
  })

  test("an edit floor asks even in acceptEdits and bypassPermissions", () => {
    const edit = {
      abs: "/repo/.git/hooks/pre-commit",
      inProject: true,
      floor: { reason: "writes inside .git", category: "protected_path" as const },
    }
    for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) {
      const decision = run({
        permission: "edit",
        pattern: ".git/hooks/pre-commit",
        edit,
        mode,
        rules: builtin({ "*": "ask" }),
      })
      expect(decision.action).toBe("ask")
      expect(decision.guard).toMatchObject({ level: "floor", category: "protected_path", paths: [edit.abs] })
    }
  })

  test("combine keeps the first deny and the most severe guard among asks", () => {
    const ask = run({ permission: "bash", pattern: "npm test" })
    const guarded = run({ permission: "bash", pattern: "git push -f", hint: { pattern: "git push -f", guard } })
    const floored = run({ permission: "bash", pattern: "rm -rf .", hint: hint(floor) })
    const combined = combine([ask, guarded, floored])
    expect(combined.action).toBe("ask")
    expect(combined.guard?.level).toBe("floor")
    expect(combined.withholdAlways).toBe(true)
    expect(combine([ask, run({ permission: "bash", pattern: "x", rules: rules({ bash: "deny" }) })]).action).toBe(
      "deny",
    )
    expect(combine([]).action).toBe("allow")
  })
})

describe("decide - modes", () => {
  const inside = { abs: "/repo/src/a.ts", inProject: true }
  const outside = { abs: "/elsewhere/a.ts", inProject: false }
  const defaults = builtin({ "*": "ask", read: "allow" })

  test("acceptEdits allows built-in edit asks inside the project and bash project writes", () => {
    expect(
      run({ permission: "edit", pattern: "src/a.ts", edit: inside, mode: "acceptEdits", rules: defaults }).action,
    ).toBe("allow")
    expect(
      run({ permission: "edit", pattern: "../a.ts", edit: outside, mode: "acceptEdits", rules: defaults }).action,
    ).toBe("ask")
    expect(
      run({
        permission: "bash",
        pattern: "mkdir build",
        hint: { pattern: "mkdir build", projectWrite: true },
        mode: "acceptEdits",
        rules: defaults,
      }).action,
    ).toBe("allow")
    expect(run({ permission: "bash", pattern: "npm test", mode: "acceptEdits", rules: defaults }).action).toBe("ask")
    expect(
      run({
        permission: "edit",
        pattern: "src/a.ts",
        edit: inside,
        mode: "acceptEdits",
        rules: [...defaults, ...rules({ edit: "ask" })],
      }).action,
    ).toBe("ask")
  })

  test("plan denies edits except the plan file, even with a user edit allow", () => {
    const planFile = path.resolve("/repo/.opencode/plans/1-plan.md")
    const denied = run({
      permission: "edit",
      pattern: "src/a.ts",
      edit: inside,
      mode: "plan",
      planFile,
      rules: [...defaults, ...rules({ edit: "allow" })],
    })
    expect(denied.action).toBe("deny")
    expect(denied.reason).toBe(planReason(planFile))
    expect(denied.reason).toContain(planFile)

    const allowed = run({
      permission: "edit",
      pattern: ".opencode/plans/1-plan.md",
      edit: { abs: planFile, inProject: true },
      mode: "plan",
      planFile,
      rules: builtin({ "*": "ask", edit: "ask" }),
    })
    expect(allowed.action).toBe("allow")
  })

  test("plan asks for bash that is not read-only even with a specific allow", () => {
    const ruleset = [...defaults, ...rules({ bash: { "npm *": "allow" }, webfetch: { "example.com": "allow" } })]
    expect(run({ permission: "bash", pattern: "npm install", mode: "plan", rules: ruleset }).action).toBe("ask")
    expect(
      run({ permission: "bash", pattern: "ls", hint: { pattern: "ls", readOnly: true }, mode: "plan", rules: ruleset })
        .action,
    ).toBe("allow")
    expect(run({ permission: "webfetch", pattern: "example.com", mode: "plan", rules: ruleset }).action).toBe("allow")
  })

  test("bypassPermissions allows built-in asks but keeps explicit specific asks", () => {
    expect(run({ permission: "bash", pattern: "npm test", mode: "bypassPermissions", rules: defaults }).action).toBe(
      "allow",
    )
    expect(
      run({
        permission: "bash",
        pattern: "git push origin",
        mode: "bypassPermissions",
        rules: rules({ bash: { "git push *": "ask" } }),
      }).action,
    ).toBe("ask")
    expect(
      run({ permission: "bash", pattern: "npm test", mode: "bypassPermissions", rules: rules({ "*": "ask" }) }).action,
    ).toBe("ask")
  })

  test("dontAsk keeps allows and denies every would-be ask with a reason", () => {
    expect(
      run({ permission: "bash", pattern: "npm test", mode: "dontAsk", rules: rules({ bash: { "npm *": "allow" } }) })
        .action,
    ).toBe("allow")
    const denied = run({ permission: "bash", pattern: "npm test", mode: "dontAsk", rules: defaults })
    expect(denied.action).toBe("deny")
    expect(denied.reason).toBe(DONT_ASK_REASON)
    expect(
      run({ permission: "bash", pattern: "npm test", mode: "dontAsk", rules: rules({ bash: { "npm *": "ask" } }) })
        .action,
    ).toBe("deny")
  })
})

describe("disabled", () => {
  test("a specific deny does not hide the tool", () => {
    expect(Permission.disabled(["bash"], rules({ bash: { "rm *": "deny" } })).has("bash")).toBe(false)
  })

  test("a tool-level deny hides the tool", () => {
    expect(Permission.disabled(["bash"], rules({ bash: "deny" })).has("bash")).toBe(true)
  })

  test("a built-in * deny hides tools without explicit rules", () => {
    const explore = builtin({ "*": "deny", grep: "allow", read: "allow" })
    const hidden = Permission.disabled(["edit", "write", "grep", "read", "bash"], explore)
    expect([...hidden].sort()).toEqual(["bash", "edit", "write"])
  })

  test("a per-agent bash deny after a global specific allow hides bash", () => {
    const ruleset = [...rules({ bash: { "ls *": "allow" } }), ...rules({ bash: "deny" })]
    expect(Permission.disabled(["bash"], ruleset).has("bash")).toBe(true)
  })

  test("a built-in plan edit map keeps edit tools visible", () => {
    const plan = builtin({ edit: { "*": "deny", ".opencode/plans/*.md": "allow" } })
    expect(Permission.disabled(["edit", "write", "apply_patch"], plan).size).toBe(0)
  })
})
