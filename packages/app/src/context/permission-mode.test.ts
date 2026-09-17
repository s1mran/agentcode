import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  alwaysLabelKey,
  alwaysPatternsLabel,
  createSessionModeQueue,
  folderDefaultAllowed,
  FOLDER_MODES,
  folderModeOptions,
  hadAutoAccept,
  isGuarded,
  isMode,
  migrateAutoAccept,
  MODES,
  nextCycleMode,
  projectRoot,
  resolveChainMode,
  resolveModeSelection,
} from "./permission-mode"

describe("nextCycleMode", () => {
  test("cycles default -> acceptEdits -> plan -> default", () => {
    expect(nextCycleMode("default")).toBe("acceptEdits")
    expect(nextCycleMode("acceptEdits")).toBe("plan")
    expect(nextCycleMode("plan")).toBe("default")
    expect(nextCycleMode(undefined)).toBe("acceptEdits")
  })

  test("bypassPermissions and dontAsk return to default", () => {
    expect(nextCycleMode("bypassPermissions")).toBe("default")
    expect(nextCycleMode("dontAsk")).toBe("default")
  })
})

describe("folderDefaultAllowed", () => {
  test("never allows bypassPermissions or dontAsk as a folder default", () => {
    expect(folderDefaultAllowed("bypassPermissions")).toBe(false)
    expect(folderDefaultAllowed("dontAsk")).toBe(false)
    expect(folderDefaultAllowed("default")).toBe(true)
    expect(folderDefaultAllowed("acceptEdits")).toBe(true)
    expect(folderDefaultAllowed("plan")).toBe(true)
    expect(FOLDER_MODES).toEqual(["default", "acceptEdits", "plan"])
  })
})

describe("folderModeOptions", () => {
  test("lists the folder modes, plus a config default outside them while it applies", () => {
    expect(folderModeOptions("acceptEdits")).toEqual(["default", "acceptEdits", "plan"])
    expect(folderModeOptions("dontAsk")).toEqual(["default", "acceptEdits", "plan", "dontAsk"])
  })
})

describe("isMode", () => {
  test("accepts only the five modes", () => {
    for (const mode of MODES) expect(isMode(mode)).toBe(true)
    expect(isMode("auto")).toBe(false)
    expect(isMode(undefined)).toBe(false)
  })
})

describe("migrateAutoAccept", () => {
  test("maps only true directory wildcard keys to acceptEdits", () => {
    const a = base64Encode("/tmp/a")
    const b = base64Encode("/tmp/b")
    const result = migrateAutoAccept({
      [`${a}/*`]: true,
      [`${b}/*`]: false,
      [`${a}/ses_1`]: true,
      ses_legacy: true,
    })
    expect(result).toEqual({ [a]: "acceptEdits" })
  })

  test("never produces bypassPermissions and handles an empty store", () => {
    expect(migrateAutoAccept({})).toEqual({})
    expect(migrateAutoAccept(undefined)).toEqual({})
    const key = base64Encode("/tmp/x")
    expect(Object.values(migrateAutoAccept({ [`${key}/*`]: true }))).toEqual(["acceptEdits"])
  })
})

describe("resolveChainMode", () => {
  test("uses the outermost stored mode, else default", () => {
    expect(resolveChainMode([])).toBe("default")
    expect(resolveChainMode([{}, { permissionMode: "acceptEdits" }])).toBe("acceptEdits")
  })

  test("a subagent's stored mode narrows but never loosens its parent's, like the engine", () => {
    expect(resolveChainMode([{ permissionMode: "bypassPermissions" }, { permissionMode: "acceptEdits" }])).toBe(
      "acceptEdits",
    )
    expect(resolveChainMode([{ permissionMode: "default" }, { permissionMode: "bypassPermissions" }])).toBe("default")
  })

  test("plan and dontAsk carry down from any ancestor", () => {
    expect(resolveChainMode([{ permissionMode: "bypassPermissions" }, { permissionMode: "plan" }])).toBe("plan")
    expect(resolveChainMode([{ permissionMode: "acceptEdits" }, { permissionMode: "dontAsk" }])).toBe("dontAsk")
  })

  test("falls back to the config default when no session on the chain stored a mode", () => {
    expect(resolveChainMode([], "dontAsk")).toBe("dontAsk")
    expect(resolveChainMode([{}, {}], "plan")).toBe("plan")
    expect(resolveChainMode([{}, { permissionMode: "default" }], "acceptEdits")).toBe("default")
    expect(resolveChainMode([{ permissionMode: "acceptEdits" }], "bypassPermissions")).toBe("acceptEdits")
  })
})

describe("hadAutoAccept", () => {
  test("counts folder and session keys that were on", () => {
    expect(hadAutoAccept(undefined)).toBe(false)
    expect(hadAutoAccept({ "abc/*": false })).toBe(false)
    expect(hadAutoAccept({ [`${base64Encode("/tmp/a")}/ses_1`]: true })).toBe(true)
    expect(hadAutoAccept({ ses_legacy: true })).toBe(true)
  })
})

describe("projectRoot", () => {
  const projects = [
    { worktree: "/repo", sandboxes: ["/repo-wt/a", "/repo-wt/b"] },
    { worktree: "/other", sandboxes: [] },
  ]

  test("maps a sandbox to its project worktree and leaves other directories alone", () => {
    expect(projectRoot("/repo-wt/a", projects)).toBe("/repo")
    expect(projectRoot("/repo", projects)).toBe("/repo")
    expect(projectRoot("/unknown", projects)).toBe("/unknown")
    expect(projectRoot("/repo-wt/a", [])).toBe("/repo-wt/a")
  })

  test("survives a cycle", () => {
    expect(
      projectRoot("/a", [
        { worktree: "/b", sandboxes: ["/a"] },
        { worktree: "/a", sandboxes: ["/b"] },
      ]),
    ).toBe("/a")
  })
})

describe("createSessionModeQueue", () => {
  function setup() {
    const applied: string[] = []
    const pending: string[] = []
    const gates: Array<{ mode: string; release: (ok: boolean) => void }> = []
    const set = createSessionModeQueue({
      apply: (sessionID, _directory, mode) =>
        new Promise<boolean>((resolve) => {
          applied.push(`${sessionID}:${mode}`)
          gates.push({ mode, release: resolve })
        }),
      onPending: (sessionID, mode) => pending.push(mode === undefined ? `${sessionID}:-` : `${sessionID}:${mode}`),
    })
    return { applied, pending, gates, set }
  }

  test("sends one change at a time and skips changes replaced before they were sent", async () => {
    const { applied, pending, gates, set } = setup()
    const first = set("ses_1", "/repo", "acceptEdits")
    await Bun.sleep(0)
    const second = set("ses_1", "/repo", "plan")
    const third = set("ses_1", "/repo", "default")
    await Bun.sleep(0)
    expect(applied).toEqual(["ses_1:acceptEdits"])

    gates[0]!.release(true)
    expect(await first).toBe(true)
    expect(await second).toBe(false)
    await Bun.sleep(0)
    expect(applied).toEqual(["ses_1:acceptEdits", "ses_1:default"])
    expect(pending.at(-1)).toBe("ses_1:default")

    gates[1]!.release(true)
    expect(await third).toBe(true)
    expect(pending.at(-1)).toBe("ses_1:-")
  })

  test("keeps sessions independent and clears pending after a failure", async () => {
    const { applied, pending, gates, set } = setup()
    const a = set("ses_1", "/repo", "plan")
    const b = set("ses_2", "/repo", "acceptEdits")
    await Bun.sleep(0)
    expect(applied).toEqual(["ses_1:plan", "ses_2:acceptEdits"])
    gates[0]!.release(false)
    gates[1]!.release(true)
    expect(await a).toBe(false)
    expect(await b).toBe(true)
    expect(pending.filter((item) => item.endsWith(":-")).sort()).toEqual(["ses_1:-", "ses_2:-"])
  })
})

describe("always labels", () => {
  test("alwaysPatternsLabel", () => {
    expect(alwaysPatternsLabel([])).toBeUndefined()
    expect(alwaysPatternsLabel(undefined)).toBeUndefined()
    expect(alwaysPatternsLabel(["*"])).toBe("everything")
    expect(alwaysPatternsLabel(["*"], "everything for this tool")).toBe("everything for this tool")
    expect(alwaysPatternsLabel(["git status *"])).toBe("git status *")
    expect(alwaysPatternsLabel(["a *", "b *", "c *"])).toBe("a *, b *, c *")
    expect(alwaysPatternsLabel(["a *", "b *", "c *", "d *"])).toBe("a *, b *, c * +1")
  })

  test("alwaysLabelKey", () => {
    expect(alwaysLabelKey("project")).toBe("ui.permission.always.project")
    expect(alwaysLabelKey("session")).toBe("ui.permission.always.session")
    expect(alwaysLabelKey("acceptEdits")).toBe("ui.permission.always.acceptEdits")
    expect(alwaysLabelKey(undefined)).toBe("ui.permission.allowAlways")
  })
})

describe("guards and selection", () => {
  test("isGuarded", () => {
    expect(isGuarded({ guard: { level: "floor" } })).toBe(true)
    expect(isGuarded({})).toBe(false)
    expect(isGuarded(undefined)).toBe(false)
  })

  test("resolveModeSelection", () => {
    expect(resolveModeSelection("bypassPermissions")).toBe("confirm")
    expect(resolveModeSelection("default")).toBe("apply")
    expect(resolveModeSelection("acceptEdits")).toBe("apply")
    expect(resolveModeSelection("plan")).toBe("apply")
    expect(resolveModeSelection("dontAsk")).toBe("apply")
  })
})
