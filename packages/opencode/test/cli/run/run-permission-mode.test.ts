import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import yargs from "yargs"
import {
  applySessionPermissionMode,
  askedInPlanMode,
  parsePermissionMode,
  replyRunPermission,
  resolvePermissionModeArgs,
  RunCommand,
  runSessionTree,
  withPermissionMode,
  type PermissionModeArgs,
  type RunPermissionRequest,
} from "@/cli/cmd/run"
import { TuiThreadCommand, workerEnv } from "@/cli/cmd/tui"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

type Call = { method: string; params: Record<string, unknown> }

// Records every SDK call with the exact parameters run.ts hands to the client.
function fakeClient(options: { updateError?: unknown } = {}) {
  const calls: Call[] = []
  const record = (method: string, result: unknown) => (params: Record<string, unknown>) => {
    calls.push({ method, params })
    return Promise.resolve(result)
  }
  const client = {
    session: {
      create: record("session.create", { data: { id: "ses_fake", title: "fake" } }),
      update: record(
        "session.update",
        options.updateError ? { error: options.updateError } : { data: { id: "ses_fake" } },
      ),
      prompt: record("session.prompt", { data: {} }),
      command: record("session.command", { data: {} }),
    },
    permission: {
      reply: record("permission.reply", { data: true }),
    },
  }
  return { calls, client: client as unknown as OpencodeClient }
}

function request(input: Partial<RunPermissionRequest> = {}): RunPermissionRequest {
  return {
    id: "per_1",
    sessionID: "ses_fake",
    permission: "bash",
    patterns: ["git status"],
    metadata: {},
    always: [],
    ...input,
  }
}

async function parse(argv: string[]) {
  const args = await yargs([])
    .command({ ...RunCommand, handler: () => {} })
    .exitProcess(false)
    .parse(argv)
  return args as PermissionModeArgs
}

describe("run --permission-mode parsing", () => {
  test("parses canonical names and aliases case-insensitively", () => {
    expect(parsePermissionMode("accept-edits")).toBe("acceptEdits")
    expect(parsePermissionMode("acceptEdits")).toBe("acceptEdits")
    expect(parsePermissionMode("ACCEPTEDITS")).toBe("acceptEdits")
    expect(parsePermissionMode("manual")).toBe("default")
    expect(parsePermissionMode("Default")).toBe("default")
    expect(parsePermissionMode("plan")).toBe("plan")
    expect(parsePermissionMode("bypass")).toBe("bypassPermissions")
    expect(parsePermissionMode("bypassPermissions")).toBe("bypassPermissions")
    expect(parsePermissionMode("dont-ask")).toBe("dontAsk")
    expect(parsePermissionMode("dontAsk")).toBe("dontAsk")
  })

  test("rejects unknown modes", () => {
    expect(parsePermissionMode("yolo-ish")).toBeUndefined()
    expect(parsePermissionMode("")).toBeUndefined()
    const resolved = resolvePermissionModeArgs({ "permission-mode": "yolo-ish" })
    expect(resolved.error).toContain('invalid --permission-mode "yolo-ish"')
  })

  test("--auto and its aliases conflict with any mode other than bypassPermissions and never become a mode", () => {
    for (const flag of ["auto", "yolo", "dangerously-skip-permissions"] as const) {
      expect(resolvePermissionModeArgs({ [flag]: true, "permission-mode": "plan" })).toEqual({
        error: "--auto conflicts with --permission-mode",
      })
      expect(resolvePermissionModeArgs({ [flag]: true, "permission-mode": "bypass" })).toEqual({
        auto: true,
        mode: "bypassPermissions",
      })
      expect(resolvePermissionModeArgs({ [flag]: true })).toEqual({ auto: true, mode: undefined })
    }
    expect(resolvePermissionModeArgs({})).toEqual({ auto: false, mode: undefined })
    expect(resolvePermissionModeArgs({ "permission-mode": "accept-edits" })).toEqual({
      auto: false,
      mode: "acceptEdits",
    })
  })

  test("run and tui accept the --permission-mode option", async () => {
    const run = await parse(["run", "hello", "--permission-mode", "accept-edits"])
    expect(resolvePermissionModeArgs(run)).toEqual({ auto: false, mode: "acceptEdits" })

    const skip = await parse(["run", "hello", "--dangerously-skip-permissions"])
    expect(resolvePermissionModeArgs(skip)).toEqual({ auto: true, mode: undefined })

    const tui = await yargs([])
      .command({ ...TuiThreadCommand, handler: () => {} })
      .exitProcess(false)
      .parse(["--permission-mode", "plan"])
    expect(resolvePermissionModeArgs(tui as PermissionModeArgs)).toEqual({ auto: false, mode: "plan" })
  })
})

describe("run permission mode requests", () => {
  test("--dangerously-skip-permissions is a reply policy and sends no permissionMode", async () => {
    const resolved = resolvePermissionModeArgs(await parse(["run", "hello", "--dangerously-skip-permissions"]))
    if (resolved.error !== undefined) throw new Error(resolved.error)
    const { calls, client } = fakeClient()

    await client.session.create(withPermissionMode({ title: "hello", permission: [] }, resolved.mode))
    await client.session.prompt(
      withPermissionMode({ sessionID: "ses_fake", parts: [{ type: "text", text: "hello" }] }, resolved.mode),
    )
    expect(await applySessionPermissionMode(client, "ses_fake", resolved.mode)).toBeUndefined()

    expect(resolved.auto).toBe(true)
    expect(calls.map((call) => [call.method, "permissionMode" in call.params])).toEqual([
      ["session.create", false],
      ["session.prompt", false],
    ])
  })

  test("--permission-mode bypassPermissions sends permissionMode in create, prompt, command and update bodies", async () => {
    const args = await parse(["run", "hello", "--permission-mode", "bypassPermissions"])
    const resolved = resolvePermissionModeArgs(args)
    if (resolved.error !== undefined) throw new Error(resolved.error)
    const { calls, client } = fakeClient()

    await client.session.create(withPermissionMode({ title: "hello", permission: [] }, resolved.mode))
    await client.session.prompt(
      withPermissionMode({ sessionID: "ses_fake", parts: [{ type: "text", text: "hello" }] }, resolved.mode),
    )
    await client.session.command(
      withPermissionMode({ sessionID: "ses_fake", command: "init", arguments: "" }, resolved.mode),
    )
    expect(await applySessionPermissionMode(client, "ses_fake", resolved.mode)).toBeUndefined()

    expect(calls.map((call) => [call.method, call.params.permissionMode])).toEqual([
      ["session.create", "bypassPermissions"],
      ["session.prompt", "bypassPermissions"],
      ["session.command", "bypassPermissions"],
      ["session.update", "bypassPermissions"],
    ])
    expect(calls[3]?.params).toEqual({ sessionID: "ses_fake", permissionMode: "bypassPermissions" })
  })

  test("without a mode the bodies stay unchanged and no update is sent", async () => {
    const { calls, client } = fakeClient()
    const body = { title: "hello" }
    expect(withPermissionMode(body, undefined)).toBe(body)
    expect(await applySessionPermissionMode(client, "ses_fake", undefined)).toBeUndefined()
    expect(calls).toEqual([])
  })

  test("a refused mode on update surfaces the server reason", async () => {
    const { client } = fakeClient({
      updateError: {
        name: "BadRequest",
        data: { message: "Permission mode not changed: bypassPermissions is disabled" },
      },
    })
    expect(await applySessionPermissionMode(client, "ses_fake", "bypassPermissions")).toBe(
      "Permission mode not changed: bypassPermissions is disabled",
    )
  })

  test("an update the server could not decode warns instead of ending the run", async () => {
    const { client } = fakeClient({
      updateError: { name: "BadRequest", data: { message: "Expected object, got undefined", kind: "Payload" } },
    })
    const warnings: string[] = []
    expect(
      await applySessionPermissionMode(client, "ses_fake", "plan", (message) => warnings.push(message)),
    ).toBeUndefined()
    expect(warnings).toEqual(["permission mode plan was not applied: Expected object, got undefined"])
  })
})

describe("run permission replies", () => {
  test("a floor request is rejected with a warning even under --auto", async () => {
    const { calls, client } = fakeClient()
    const warnings: string[] = []
    const result = await replyRunPermission({
      client,
      auto: true,
      warn: (message) => warnings.push(message),
      request: request({
        permission: "edit",
        patterns: [".git/config"],
        guard: { level: "floor", category: "protected_path", reason: "writes to .git/config" },
      }),
    })
    expect(result).toBe("reject")
    expect(warnings).toEqual(["blocked: writes to .git/config needs interactive approval (approve in the app or TUI)"])
    expect(calls).toEqual([{ method: "permission.reply", params: { requestID: "per_1", reply: "reject" } }])
  })

  test("a request without a guard is approved once under --auto", async () => {
    const { calls, client } = fakeClient()
    const warnings: string[] = []
    expect(await replyRunPermission({ client, auto: true, warn: (m) => warnings.push(m), request: request() })).toBe(
      "once",
    )
    expect(warnings).toEqual([])
    expect(calls).toEqual([{ method: "permission.reply", params: { requestID: "per_1", reply: "once" } }])
  })

  test("without --auto every request is rejected, naming the guard reason when present", async () => {
    const { calls, client } = fakeClient()
    const warnings: string[] = []
    const warn = (message: string) => warnings.push(message)
    expect(await replyRunPermission({ client, auto: false, warn, request: request() })).toBe("reject")
    expect(
      await replyRunPermission({
        client,
        auto: false,
        warn,
        request: request({
          id: "per_2",
          patterns: ["git push --force"],
          guard: { level: "guard", category: "destructive_git", reason: "force push rewrites remote history" },
        }),
      }),
    ).toBe("reject")
    expect(warnings).toEqual([
      "permission requested: bash (git status); auto-rejecting",
      "permission requested: bash (git push --force); auto-rejecting (force push rewrites remote history)",
    ])
    expect(calls.map((call) => call.params)).toEqual([
      { requestID: "per_1", reply: "reject" },
      { requestID: "per_2", reply: "reject" },
    ])
  })

  test("a request raised in plan mode is rejected under --auto, and a failed plan lookup counts as plan", async () => {
    const { calls, client } = fakeClient()
    const warnings: string[] = []
    const warn = (message: string) => warnings.push(message)
    expect(
      await replyRunPermission({ client, auto: true, warn, request: request(), inPlanMode: async () => true }),
    ).toBe("reject")
    expect(
      await replyRunPermission({
        client,
        auto: true,
        warn,
        request: request({ id: "per_2" }),
        inPlanMode: () => Promise.reject(new Error("lookup failed")),
      }),
    ).toBe("reject")
    expect(
      await replyRunPermission({
        client,
        auto: true,
        warn,
        request: request({ id: "per_3" }),
        inPlanMode: async () => false,
      }),
    ).toBe("once")
    expect(warnings).toEqual([
      "permission requested in plan mode: bash (git status); auto-rejecting (plan mode is read-only, --auto does not approve it)",
      "permission requested in plan mode: bash (git status); auto-rejecting (plan mode is read-only, --auto does not approve it)",
    ])
    expect(calls.map((call) => call.params)).toEqual([
      { requestID: "per_1", reply: "reject" },
      { requestID: "per_2", reply: "reject" },
      { requestID: "per_3", reply: "once" },
    ])
  })

  test("the plan lookup is skipped without --auto and for floor requests", async () => {
    const { client } = fakeClient()
    let lookups = 0
    const inPlanMode = async () => {
      lookups++
      return false
    }
    await replyRunPermission({ client, auto: false, warn: () => {}, request: request(), inPlanMode })
    await replyRunPermission({
      client,
      auto: true,
      warn: () => {},
      request: request({ guard: { level: "floor", category: "critical_rm", reason: "removes the home folder" } }),
      inPlanMode,
    })
    expect(lookups).toBe(0)
  })

  test("askedInPlanMode reads the asking assistant message", async () => {
    const messages: Record<string, unknown> = {
      msg_plan_mode: { role: "assistant", agent: "build", permissionMode: "plan" },
      msg_plan_agent: { role: "assistant", agent: "plan", permissionMode: "default" },
      msg_build: { role: "assistant", agent: "build", permissionMode: "acceptEdits" },
      msg_user: { role: "user", agent: "plan" },
    }
    const asked: unknown[] = []
    const client = {
      session: {
        message: (params: { sessionID: string; messageID: string }) => {
          asked.push(params)
          const info = messages[params.messageID]
          return Promise.resolve(info ? { data: { info, parts: [] } } : { error: { name: "NotFound" } })
        },
      },
    } as unknown as OpencodeClient
    const ask = (messageID?: string) =>
      askedInPlanMode(client, { sessionID: "ses_child", tool: messageID ? { messageID, callID: "call_1" } : undefined })

    expect(await ask()).toBe(false)
    expect(asked).toEqual([])
    expect(await ask("msg_plan_mode")).toBe(true)
    expect(await ask("msg_plan_agent")).toBe(true)
    expect(await ask("msg_build")).toBe(false)
    expect(await ask("msg_user")).toBe(false)
    expect(await ask("msg_missing")).toBe(false)
    expect(asked[0]).toEqual({ sessionID: "ses_child", messageID: "msg_plan_mode" })
  })
})

describe("run session tree", () => {
  function treeClient(parents: Record<string, string | undefined>) {
    const lookups: string[] = []
    let failing = new Set<string>()
    const client = {
      session: {
        get: ({ sessionID }: { sessionID: string }) => {
          lookups.push(sessionID)
          if (failing.has(sessionID) || !(sessionID in parents)) return Promise.resolve({ error: { name: "NotFound" } })
          return Promise.resolve({ data: { id: sessionID, parentID: parents[sessionID] } })
        },
      },
    } as unknown as OpencodeClient
    return { client, lookups, fail: (ids: string[]) => (failing = new Set(ids)) }
  }

  test("answers for the root, its subagents at any depth, and nothing else", async () => {
    const { client, lookups } = treeClient({
      ses_root: undefined,
      ses_child: "ses_root",
      ses_grandchild: "ses_child",
      ses_other: undefined,
      ses_other_child: "ses_other",
    })
    const inRun = runSessionTree(client, "ses_root")
    expect(await inRun("ses_root")).toBe(true)
    expect(lookups).toEqual([])
    expect(await inRun("ses_grandchild")).toBe(true)
    expect(await inRun("ses_child")).toBe(true)
    expect(await inRun("ses_other_child")).toBe(false)
    expect(await inRun("ses_other")).toBe(false)
    // Every session is looked up once; later answers come from the cache.
    expect(lookups).toEqual(["ses_grandchild", "ses_child", "ses_other_child", "ses_other"])
  })

  test("a failed lookup is not remembered, so the next prompt from that session tries again", async () => {
    const tree = treeClient({ ses_root: undefined, ses_child: "ses_root" })
    const inRun = runSessionTree(tree.client, "ses_root")
    tree.fail(["ses_child"])
    expect(await inRun("ses_child")).toBe(false)
    tree.fail([])
    expect(await inRun("ses_child")).toBe(true)
    expect(tree.lookups).toEqual(["ses_child", "ses_child"])
  })
})

describe("tui worker environment", () => {
  test("only an explicit mode reaches the worker, and the launching environment is left alone", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin", EMPTY: undefined }
    expect(workerEnv(env, undefined)).toEqual({ PATH: "/bin" })
    expect(workerEnv(env, "plan")).toEqual({ PATH: "/bin", OPENCODE_PERMISSION_MODE: "plan" })
    expect(env).toEqual({ PATH: "/bin", EMPTY: undefined })

    const auto = resolvePermissionModeArgs({ auto: true })
    if (auto.error !== undefined) throw new Error(auto.error)
    expect(workerEnv({ PATH: "/bin" }, auto.mode)).toEqual({ PATH: "/bin" })
  })
})

describe("opencode run --permission-mode (subprocess)", () => {
  cliIt.concurrent(
    "exits 1 when --auto is combined with a different mode",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("say hi", { extraArgs: ["--auto", "--permission-mode", "plan"] })
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain("--auto conflicts with --permission-mode")
      }),
    60_000,
  )

  cliIt.concurrent(
    "exits 1 for an unknown mode",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("say hi", { extraArgs: ["--permission-mode", "yolo-ish"] })
        opencode.expectExit(result, 1)
        expect(result.stderr).toContain('invalid --permission-mode "yolo-ish"')
      }),
    60_000,
  )

  cliIt.concurrent(
    "resumes a session with --session and --auto",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        // The test preload sets an in-memory database; both runs need the same file to share the session.
        const env = { PWD: home, OPENCODE_DB: "resume.db" }
        yield* llm.text("first answer")
        const first = yield* opencode.run("first", { env, format: "json" })
        opencode.expectExit(first, 0)
        const sessionID = opencode.parseJsonEvents(first.stdout)[0]?.sessionID
        expect(typeof sessionID).toBe("string")

        yield* llm.text("second answer")
        const second = yield* opencode.run("second", {
          extraArgs: ["--session", String(sessionID), "--auto"],
          env,
        })
        opencode.expectExit(second, 0)
        expect(second.stdout).toBe("second answer\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects a protected-path write under --auto instead of approving it",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const target = path.join(".vscode", "agentcode-floor-test.json")
        yield* llm.push(
          reply().tool("bash", {
            command: `mkdir -p .vscode && printf x > ${target}`,
            description: "Write into a protected folder",
          }),
        )
        yield* llm.text("done")

        // PWD pins the run to the throwaway home, so even a regression could only write there.
        const result = yield* opencode.run("write it", { extraArgs: ["--auto"], env: { PWD: home } })
        opencode.expectExit(result, 0)
        expect(result.stderr).toContain("blocked:")
        expect(result.stderr).toContain(".vscode) needs interactive approval")
        expect(existsSync(path.join(home, target))).toBe(false)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--auto is not stored: a later --continue run without it asks again",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const env = { PWD: home, OPENCODE_DB: "persist.db" }
        yield* llm.text("first answer")
        const first = yield* opencode.run("first", { env, format: "json", extraArgs: ["--auto"] })
        opencode.expectExit(first, 0)

        yield* llm.push(reply().tool("bash", { command: "printf x > later.txt", description: "Write a file" }))
        yield* llm.text("done")
        const second = yield* opencode.run("second", { env, extraArgs: ["--continue"] })
        opencode.expectExit(second, 0)
        expect(second.stderr).toContain("auto-rejecting")
        expect(existsSync(path.join(home, "later.txt"))).toBe(false)
      }),
    60_000,
  )

  cliIt.concurrent(
    "answers a subagent's prompt instead of hanging the run",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().tool("task", { description: "write file", prompt: "write the file", subagent_type: "general" }),
        )
        yield* llm.push(reply().tool("bash", { command: "printf x > sub.txt", description: "Write a file" }))
        yield* llm.text("child done")
        yield* llm.text("parent done")
        const result = yield* opencode.run("delegate", { env: { PWD: home }, timeoutMs: 30_000 })
        opencode.expectExit(result, 0)
        expect(result.stderr).toContain("permission requested: bash (printf x > sub.txt); auto-rejecting")
        expect(existsSync(path.join(home, "sub.txt"))).toBe(false)
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects a subagent's protected-path write under --auto",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const target = path.join(".vscode", "agentcode-subagent-floor.json")
        yield* llm.push(
          reply().tool("task", { description: "write file", prompt: "write the file", subagent_type: "general" }),
        )
        yield* llm.push(
          reply().tool("bash", {
            command: `mkdir -p .vscode && printf x > ${target}`,
            description: "Write into a protected folder",
          }),
        )
        yield* llm.text("child done")
        yield* llm.text("parent done")
        const result = yield* opencode.run("delegate", {
          env: { PWD: home },
          extraArgs: ["--auto"],
          timeoutMs: 30_000,
        })
        opencode.expectExit(result, 0)
        expect(result.stderr).toContain("blocked:")
        expect(existsSync(path.join(home, target))).toBe(false)
      }),
    60_000,
  )
})
