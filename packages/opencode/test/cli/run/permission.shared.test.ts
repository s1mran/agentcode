import { describe, expect, test } from "bun:test"
import {
  createPermissionBodyState,
  permissionAlwaysAvailable,
  permissionAlwaysLines,
  permissionCancel,
  permissionEscape,
  permissionInfo,
  permissionOptions,
  permissionReject,
  permissionRun,
  permissionShift,
  type PermissionRequestInput,
} from "@/cli/cmd/run/permission.shared"

const floor = {
  level: "floor" as const,
  category: "protected_path" as const,
  reason: "writes to a protected path (.git/config)",
}
const guard = {
  level: "guard" as const,
  category: "destructive_git" as const,
  reason: "git push --force rewrites remote history",
}

function req(input: Partial<PermissionRequestInput> = {}): PermissionRequestInput {
  return {
    id: "perm-1",
    sessionID: "session-1",
    permission: "read",
    patterns: [],
    metadata: {},
    always: [],
    ...input,
  }
}

describe("run permission shared", () => {
  test("replies immediately for allow once", () => {
    const out = permissionRun(createPermissionBodyState("perm-1"), "perm-1", "once")

    expect(out.reply).toEqual({
      requestID: "perm-1",
      reply: "once",
    })
  })

  test("requires confirmation for allow always", () => {
    const next = permissionRun(createPermissionBodyState("perm-1"), "perm-1", "always")
    expect(next.state.stage).toBe("always")
    expect(next.state.selected).toBe("confirm")
    expect(next.reply).toBeUndefined()

    expect(permissionRun(next.state, "perm-1", "confirm").reply).toEqual({
      requestID: "perm-1",
      reply: "always",
    })

    expect(permissionRun(next.state, "perm-1", "cancel").state).toMatchObject({
      stage: "permission",
      selected: "always",
    })
  })

  test("builds trimmed reject replies and stage transitions", () => {
    const next = permissionRun(createPermissionBodyState("perm-1"), "perm-1", "reject")
    expect(next.state.stage).toBe("reject")

    const out = permissionReject({ ...next.state, message: "  use rg  " }, "perm-1")
    expect(out).toEqual({
      requestID: "perm-1",
      reply: "reject",
      message: "use rg",
    })

    expect(permissionCancel(next.state)).toMatchObject({
      stage: "permission",
      selected: "reject",
    })

    expect(permissionEscape(createPermissionBodyState("perm-1"))).toMatchObject({
      stage: "reject",
      selected: "reject",
    })

    expect(permissionEscape({ ...next.state, stage: "always", selected: "confirm" })).toMatchObject({
      stage: "permission",
      selected: "always",
    })
  })

  test("maps supported permission types into display info", () => {
    expect(
      permissionInfo(
        req({
          permission: "bash",
          metadata: {
            input: {
              command: "git status --short",
            },
          },
        }),
      ),
    ).toMatchObject({
      title: "Shell command",
      lines: ["$ git status --short"],
    })

    expect(
      permissionInfo(
        req({
          permission: "task",
          metadata: {
            description: "investigate stream",
            subagent_type: "general",
          },
        }),
      ),
    ).toMatchObject({
      title: "General Task",
      lines: ["◉ investigate stream"],
    })

    expect(
      permissionInfo(
        req({
          permission: "external_directory",
          patterns: ["/tmp/work/**/*.ts", "/tmp/work/**/*.tsx"],
        }),
      ),
    ).toMatchObject({
      title: "Access external directory /tmp/work",
      lines: ["- /tmp/work/**/*.ts", "- /tmp/work/**/*.tsx"],
    })

    expect(permissionInfo(req({ permission: "doom_loop" }))).toMatchObject({
      title: "Continue after repeated failures",
    })

    expect(permissionInfo(req({ permission: "custom_tool" }))).toMatchObject({
      title: "Call tool custom_tool",
      lines: ["Tool: custom_tool"],
    })
  })

  test("formats always-allow copy for wildcard and explicit patterns with the scope it grants", () => {
    expect(permissionAlwaysLines(req({ permission: "websearch", always: ["*"], alwaysScope: "project" }))).toEqual([
      "This will allow websearch (saved for this project).",
    ])

    expect(permissionAlwaysLines(req({ always: ["src/**/*.ts", "src/**/*.tsx"], alwaysScope: "session" }))).toEqual([
      "This will allow the following patterns (for this session).",
      "- src/**/*.ts",
      "- src/**/*.tsx",
    ])

    expect(
      permissionAlwaysLines(req({ permission: "bash", always: ["git checkout *"], alwaysScope: "project" })),
    ).toEqual(["This will allow the following patterns (saved for this project).", "- git checkout *"])

    expect(
      permissionAlwaysLines(req({ permission: "edit", always: ["src/a.ts"], alwaysScope: "acceptEdits" })),
    ).toEqual(["This allows all edits inside the project and switches this session to Accept edits."])

    // Older servers send no alwaysScope; an unknown scope is described as the narrowest one.
    expect(permissionAlwaysLines(req({ permission: "read", always: ["*"] }))).toEqual([
      "This will allow read (for this session).",
    ])
  })

  test("offers the always stage only when the request has always patterns and no guard", () => {
    const plain = req({ permission: "bash", always: ["npm test *"] })
    expect(permissionAlwaysAvailable(plain)).toBe(true)
    expect(permissionOptions("permission", plain)).toEqual(["once", "always", "reject"])

    for (const request of [
      req({ permission: "bash", always: [] }),
      req({ permission: "bash", always: ["git push *"], guard }),
      req({ permission: "edit", always: [".git/config"], guard: floor }),
    ]) {
      expect(permissionAlwaysAvailable(request)).toBe(false)
      expect(permissionOptions("permission", request)).toEqual(["once", "reject"])

      const state = createPermissionBodyState("perm-1")
      const step = permissionRun(state, "perm-1", "always", request)
      expect(step.reply).toBeUndefined()
      expect(step.state.stage).toBe("permission")

      // A stale always stage can never confirm an always reply for such a request.
      const stale = permissionRun({ ...state, stage: "always", selected: "confirm" }, "perm-1", "confirm", request)
      expect(stale.reply).toBeUndefined()
      expect(stale.state).toMatchObject({ stage: "permission", selected: "once" })

      expect(permissionShift({ ...state, selected: "once" }, 1, request).selected).toBe("reject")
      expect(permissionEscape({ ...state, stage: "always", selected: "confirm" }, request)).toMatchObject({
        stage: "permission",
        selected: "once",
      })
    }

    // Without the request (older callers) the three options stay.
    expect(permissionOptions("permission")).toEqual(["once", "always", "reject"])
  })

  test("renders the guard reason as the first line", () => {
    const info = permissionInfo(
      req({
        permission: "bash",
        metadata: { input: { command: "git push --force origin main" } },
        always: [],
        guard,
      }),
    )
    expect(info.lines[0]).toBe("Needs review: git push --force rewrites remote history")
    expect(info.lines).toContain("$ git push --force origin main")

    const external = permissionInfo(
      req({ permission: "external_directory", patterns: ["/etc/*"], always: [], guard: floor }),
    )
    expect(external.lines).toEqual(["Protected: writes to a protected path (.git/config)", "- /etc/*"])

    // A diff view hides the lines, so the guard also leads the title.
    const edit = permissionInfo(
      req({
        permission: "edit",
        patterns: [".git/config"],
        metadata: { filepath: ".git/config", diff: "--- a\n+++ b\n" },
        always: [],
        guard: floor,
      }),
    )
    expect(edit.diff).toBeDefined()
    expect(edit.title).toBe("Protected: writes to a protected path (.git/config) · Edit .git/config")

    expect(permissionInfo(req({ permission: "doom_loop" })).lines[0]).toBe(
      "This keeps the session running despite repeated failures.",
    )
  })
})
