import { describe, expect, test } from "bun:test"
import type { PermissionMode } from "@opencode-ai/sdk/v2/client"
import {
  createPermissionModeSelector,
  isBuiltinPlanCommand,
  permissionModeOptions,
  permissionModeTone,
  planCommandArguments,
  resolveComposerMode,
  shouldCycleModeOnKey,
} from "./permission-mode-controls"

function setup(input: { sessionID?: string; directory?: string } = {}) {
  const calls: string[] = []
  const confirms: Array<() => Promise<boolean>> = []
  const target = { sessionID: input.sessionID, directory: input.directory ?? "/repo" }
  const selector = createPermissionModeSelector({
    sessionID: () => target.sessionID,
    directory: () => target.directory,
    setSessionMode: async (sessionID, directory, mode) => {
      calls.push(`session:${sessionID}:${directory}:${mode}`)
      return true
    },
    setDraftMode: (directory, mode) => calls.push(`draft:${directory}:${mode}`),
    confirm: (apply) => confirms.push(apply),
  })
  return { calls, confirms, selector, target }
}

describe("permission mode pill", () => {
  test("lists default, acceptEdits, plan and bypass in order; dontAsk only while active", () => {
    expect(permissionModeOptions("default")).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"])
    expect(permissionModeOptions("bypassPermissions")).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"])
    expect(permissionModeOptions("dontAsk")).toEqual(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"])
  })

  test("gives every mode a tone", () => {
    expect(
      (["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"] as PermissionMode[]).map(permissionModeTone),
    ).toEqual(["neutral", "success", "info", "critical", "warning"])
  })
})

describe("permission mode selection", () => {
  test("a session mode is applied on the engine right away", async () => {
    const { calls, confirms, selector } = setup({ sessionID: "ses_1" })
    expect(await selector.select("acceptEdits")).toBe(true)
    expect(calls).toEqual(["session:ses_1:/repo:acceptEdits"])
    expect(confirms).toEqual([])
  })

  test("a draft mode is kept locally and never rewrites the folder default", async () => {
    const { calls, selector } = setup()
    await selector.select("plan")
    await selector.cycle("plan")
    expect(calls).toEqual(["draft:/repo:plan", "draft:/repo:default"])
  })

  test("bypassPermissions waits for the confirmation before calling setSessionMode", async () => {
    const { calls, confirms, selector } = setup({ sessionID: "ses_1" })
    expect(await selector.select("bypassPermissions")).toBe(false)
    expect(calls).toEqual([])
    expect(confirms).toHaveLength(1)

    expect(await confirms[0]!()).toBe(true)
    expect(calls).toEqual(["session:ses_1:/repo:bypassPermissions"])
  })

  test("a cancelled bypass confirmation changes nothing", async () => {
    const { calls, confirms, selector } = setup()
    await selector.select("bypassPermissions")
    expect(confirms).toHaveLength(1)
    expect(calls).toEqual([])
  })

  test("the confirmation applies to the session it was opened for", async () => {
    const { calls, confirms, selector, target } = setup({ sessionID: "ses_1" })
    await selector.select("bypassPermissions")
    target.sessionID = "ses_2"
    await confirms[0]!()
    expect(calls).toEqual(["session:ses_1:/repo:bypassPermissions"])
  })

  test("cycle goes default -> acceptEdits -> plan -> default", async () => {
    const { calls, selector } = setup({ sessionID: "ses_1" })
    await selector.cycle("default")
    await selector.cycle("acceptEdits")
    await selector.cycle("plan")
    expect(calls).toEqual([
      "session:ses_1:/repo:acceptEdits",
      "session:ses_1:/repo:plan",
      "session:ses_1:/repo:default",
    ])
  })

  test("cycling out of bypassPermissions or dontAsk returns to default without a confirmation", async () => {
    const { calls, confirms, selector } = setup({ sessionID: "ses_1" })
    await selector.cycle("bypassPermissions")
    await selector.cycle("dontAsk")
    expect(calls).toEqual(["session:ses_1:/repo:default", "session:ses_1:/repo:default"])
    expect(confirms).toEqual([])
  })
})

describe("Shift+Tab", () => {
  const key = (input: Partial<KeyboardEvent> = {}) =>
    ({
      key: "Tab",
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      isComposing: false,
      ...input,
    }) as KeyboardEvent

  test("cycles when no popover is open", () => {
    expect(shouldCycleModeOnKey(key(), { popoverOpen: false })).toBe(true)
  })

  test("does not cycle while a slash or mention popover is open", () => {
    expect(shouldCycleModeOnKey(key(), { popoverOpen: true })).toBe(false)
  })

  test("does not cycle while composing", () => {
    expect(shouldCycleModeOnKey(key({ isComposing: true }), { popoverOpen: false })).toBe(false)
    expect(shouldCycleModeOnKey(key(), { popoverOpen: false, composing: true })).toBe(false)
  })

  test("ignores plain Tab and modified Shift+Tab", () => {
    expect(shouldCycleModeOnKey(key({ shiftKey: false }), { popoverOpen: false })).toBe(false)
    expect(shouldCycleModeOnKey(key({ ctrlKey: true }), { popoverOpen: false })).toBe(false)
    expect(shouldCycleModeOnKey(key({ metaKey: true }), { popoverOpen: false })).toBe(false)
    expect(shouldCycleModeOnKey(key({ altKey: true }), { popoverOpen: false })).toBe(false)
    expect(shouldCycleModeOnKey(key({ key: "Enter" }), { popoverOpen: false })).toBe(false)
  })
})

describe("/plan", () => {
  test("parses bare and task forms", () => {
    expect(planCommandArguments("/plan")).toBe("")
    expect(planCommandArguments("/plan   ")).toBe("")
    expect(planCommandArguments("/plan fix the login bug")).toBe("fix the login bug")
    expect(planCommandArguments("/plan\nmulti\nline")).toBe("multi\nline")
  })

  test("ignores other commands and text", () => {
    expect(planCommandArguments("/planner x")).toBeUndefined()
    expect(planCommandArguments("plan x")).toBeUndefined()
    expect(planCommandArguments(" /plan x")).toBeUndefined()
  })

  test("recognises only the engine's built-in plan command", () => {
    expect(isBuiltinPlanCommand({ name: "plan", agent: "plan", template: "$ARGUMENTS\n" })).toBe(true)
    expect(isBuiltinPlanCommand({ name: "plan", template: "Write a plan for $ARGUMENTS" })).toBe(false)
    expect(isBuiltinPlanCommand({ name: "plan", agent: "plan", template: "Plan: $ARGUMENTS" })).toBe(false)
    expect(isBuiltinPlanCommand({ name: "review", agent: "plan", template: "$ARGUMENTS" })).toBe(false)
  })
})

describe("resolveComposerMode", () => {
  test("a draft with no explicit choice shows the config default and sends nothing", () => {
    expect(resolveComposerMode({ config: "dontAsk" })).toEqual({ current: "dontAsk", submit: undefined })
    expect(resolveComposerMode({ config: "plan" })).toEqual({ current: "plan", submit: undefined })
    expect(resolveComposerMode({})).toEqual({ current: "default", submit: undefined })
  })

  test("a draft sends the explicit choice, else the folder default from settings", () => {
    expect(resolveComposerMode({ folder: "acceptEdits", config: "dontAsk" })).toEqual({
      current: "acceptEdits",
      submit: "acceptEdits",
    })
    expect(resolveComposerMode({ draft: "plan", folder: "acceptEdits" })).toEqual({ current: "plan", submit: "plan" })
  })

  test("a session shows the engine's effective mode but sends only a pending or stored mode", () => {
    expect(resolveComposerMode({ sessionID: "ses_1", effective: "dontAsk" })).toEqual({
      current: "dontAsk",
      submit: undefined,
    })
    expect(resolveComposerMode({ sessionID: "ses_1", effective: "acceptEdits", stored: "acceptEdits" })).toEqual({
      current: "acceptEdits",
      submit: "acceptEdits",
    })
    expect(
      resolveComposerMode({ sessionID: "ses_1", pending: "plan", effective: "default", stored: "default" }),
    ).toEqual({ current: "plan", submit: "plan" })
  })

  test("a session ignores draft and folder values", () => {
    expect(resolveComposerMode({ sessionID: "ses_1", draft: "bypassPermissions", folder: "plan" })).toEqual({
      current: "default",
      submit: undefined,
    })
  })
})
