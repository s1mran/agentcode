import { afterEach, describe, expect, it } from "bun:test"
import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { createTwoFilesPatch } from "diff"
import { Effect, ManagedRuntime } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ACPEvent } from "@/acp/event"
import { ACPSession } from "@/acp/session"

type PermissionEvent = Extract<Event, { type: "permission.asked" }>
type PermissionReplyParams = Parameters<OpencodeClient["permission"]["reply"]>[0]
type SessionUpdateParams = Parameters<AgentSideConnection["sessionUpdate"]>[0]
const cleanupDirs: string[] = []

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const pollUntil = async (
  check: () => boolean | Promise<boolean>,
  message: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
) => {
  const started = Date.now()
  while (true) {
    if (await check()) return
    if (Date.now() - started > (opts?.timeoutMs ?? 2000)) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, opts?.intervalMs ?? 5))
  }
}

function makeSessionService() {
  return ManagedRuntime.make(LayerNode.compile(ACPSession.node)).runSync(
    ACPSession.Service.use((service) => Effect.succeed(service)),
  )
}

function createHarness(
  requestPermission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse> = () =>
    Promise.resolve({ outcome: { outcome: "selected", optionId: "once" } }),
) {
  const replies: PermissionReplyParams[] = []
  const requests: RequestPermissionRequest[] = []
  const updates: SessionUpdateParams[] = []
  const session = makeSessionService()
  const sdk = {
    permission: {
      reply: (params: PermissionReplyParams) => {
        replies.push(params)
        return Promise.resolve({ data: true })
      },
    },
    session: {
      message: () => Promise.resolve({ data: undefined }),
    },
  } as unknown as OpencodeClient
  const connection = {
    requestPermission: (params: RequestPermissionRequest) => {
      requests.push(params)
      return requestPermission(params)
    },
    sessionUpdate: (params: SessionUpdateParams) => {
      updates.push(params)
      return Promise.resolve()
    },
  } satisfies Pick<AgentSideConnection, "requestPermission" | "sessionUpdate">
  const subscription = new ACPEvent.Subscription({ sdk, connection, session })

  return { connection, replies, requests, sdk, session, subscription, updates }
}

async function createSession(session: ACPSession.Interface, sessionId: string, cwd = "/workspace") {
  await Effect.runPromise(session.create({ id: sessionId, cwd }))
}

async function createKnownTextPart(
  session: ACPSession.Interface,
  sessionId: string,
  messageId: string,
  partId: string,
) {
  await Effect.runPromise(
    session.recordPartMetadata({
      sessionId,
      messageId,
      partId,
      partType: "text",
      role: "assistant",
    }),
  )
}

function permissionAsked(
  sessionID: string,
  id: string,
  input: {
    permission?: string
    metadata?: Record<string, unknown>
    tool?: { messageID: string; callID: string }
    always?: string[]
    guard?: { level: "floor" | "guard"; category: string; reason: string }
    alwaysScope?: "project" | "session" | "acceptEdits"
  } = {},
) {
  return {
    id: `evt_${id}`,
    type: "permission.asked",
    properties: {
      id,
      sessionID,
      permission: input.permission ?? "bash",
      patterns: ["*"],
      metadata: input.metadata ?? { command: "printf hello" },
      always: input.always ?? [],
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.guard ? { guard: input.guard } : {}),
      ...(input.alwaysScope ? { alwaysScope: input.alwaysScope } : {}),
    },
  } as PermissionEvent
}

function textDelta(sessionID: string, messageID: string, partID: string, delta: string) {
  return {
    id: `evt_${sessionID}_${messageID}_${partID}`,
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta,
    },
  } as Event
}

function textFromUpdates(updates: SessionUpdateParams[], sessionId: string) {
  return updates
    .filter((item) => item.sessionId === sessionId)
    .map((item) => item.update)
    .filter((update): update is Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }> => {
      return update.sessionUpdate === "agent_message_chunk"
    })
    .map((update) => (update.content.type === "text" ? update.content.text : ""))
    .join("")
}

async function tempFile(name: string, content: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-acp-permission-"))
  cleanupDirs.push(dir)
  const file = path.join(dir, name)
  await Bun.write(file, content)
  return file
}

describe("acp permissions", () => {
  it("sends requestPermission and replies with the selected outcome", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_1", { tool: { messageID: "msg_1", callID: "call_1" }, always: ["printf *"] }),
    )

    await pollUntil(() => harness.replies.length === 1, "permission was never replied")

    expect(harness.requests[0]).toMatchObject({
      sessionId: "ses_a",
      toolCall: {
        toolCallId: "call_1",
        status: "pending",
        title: "printf hello",
        rawInput: { command: "printf hello" },
        kind: "execute",
        locations: [],
      },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    })
    expect(harness.replies).toEqual([{ requestID: "perm_1", reply: "once", directory: "/workspace" }])
  })

  it("uses permission metadata for non-shell titles", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_fetch", {
        permission: "webfetch",
        metadata: {
          url: "https://example.com/docs",
          format: "markdown",
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "webfetch permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: "https://example.com/docs",
      kind: "fetch",
      rawInput: { url: "https://example.com/docs", format: "markdown" },
    })
  })

  it("includes a diff content block for edit permission metadata", async () => {
    const filepath = await tempFile("file.ts", "before\n")
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_edit", {
        permission: "edit",
        metadata: {
          filepath,
          diff: createTwoFilesPatch(filepath, filepath, "before\n", "after\n"),
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "edit permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: filepath,
      kind: "edit",
      locations: [{ path: filepath }],
      content: [
        {
          type: "diff",
          path: filepath,
          oldText: "before\n",
          newText: "after\n",
        },
      ],
    })
  })

  it("includes per-file diff blocks and locations for apply_patch permission metadata", async () => {
    const first = await tempFile("first.ts", "one\n")
    const second = await tempFile("second.ts", "alpha\n")
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_patch", {
        permission: "edit",
        metadata: {
          filepath: "first.ts, second.ts",
          files: [
            {
              filePath: first,
              relativePath: "first.ts",
              patch: createTwoFilesPatch(first, first, "one\n", "two\n"),
            },
            {
              filePath: second,
              relativePath: "second.ts",
              patch: createTwoFilesPatch(second, second, "alpha\n", "beta\n"),
            },
          ],
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "apply_patch permission was never replied")

    expect(harness.requests[0]?.toolCall).toMatchObject({
      toolCallId: "call_1",
      title: "2 files",
      locations: [{ path: first }, { path: second }],
      content: [
        {
          type: "diff",
          path: first,
          oldText: "one\n",
          newText: "two\n",
        },
        {
          type: "diff",
          path: second,
          oldText: "alpha\n",
          newText: "beta\n",
        },
      ],
    })
  })

  it("forwards external_directory metadata and locations to requestPermission", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_external", {
        permission: "external_directory",
        metadata: {
          command: "mkdir -p /tmp/outside",
          description: "Create external directory",
          directories: ["/tmp/outside"],
          patterns: ["/tmp/outside/*"],
        },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "external_directory permission was never replied")

    expect(harness.requests[0]).toMatchObject({
      sessionId: "ses_a",
      toolCall: {
        toolCallId: "call_1",
        status: "pending",
        title: "Create external directory",
        rawInput: {
          command: "mkdir -p /tmp/outside",
          description: "Create external directory",
          directories: ["/tmp/outside"],
          patterns: ["/tmp/outside/*"],
        },
        locations: [{ path: "/tmp/outside" }],
      },
    })
  })

  it("offers only allow once and reject for a guarded request and sends always as once", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "selected", optionId: "always" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_guard", {
        metadata: { command: "git push --force origin main" },
        always: ["git push *"],
        alwaysScope: "project",
        guard: { level: "guard", category: "destructive_git", reason: "force push rewrites remote history" },
        tool: { messageID: "msg_1", callID: "call_1" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "guarded permission was never replied")

    expect(harness.requests[0]?.options).toEqual([
      { optionId: "once", kind: "allow_once", name: "Allow once" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ])
    expect(harness.requests[0]?.toolCall.title).toBe("Needs review: git push --force origin main")
    expect(harness.replies).toEqual([{ requestID: "perm_guard", reply: "once", directory: "/workspace" }])
  })

  it("prefixes floor requests as protected and never offers always", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_floor", {
        metadata: { command: "printf x > .git/config" },
        always: [],
        guard: { level: "floor", category: "protected_path", reason: "writes to .git/config" },
      }),
    )

    await pollUntil(() => harness.replies.length === 1, "floor permission was never replied")

    expect(harness.requests[0]?.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"])
    expect(harness.requests[0]?.toolCall.title).toBe("Protected: printf x > .git/config")
  })

  it("does not offer always for a request without always patterns", async () => {
    const harness = createHarness()
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_none"))

    await pollUntil(() => harness.replies.length === 1, "permission without always patterns was never replied")

    expect(harness.requests[0]?.options.map((option) => option.optionId)).toEqual(["once", "reject"])
    expect(harness.requests[0]?.toolCall.title).toBe("printf hello")
  })

  it("names the always option after the scope it grants", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "selected", optionId: "always" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(
      permissionAsked("ses_a", "perm_project", {
        metadata: { command: "git checkout main" },
        always: ["git checkout *"],
        alwaysScope: "project",
      }),
    )
    harness.subscription.handle(
      permissionAsked("ses_a", "perm_session", {
        permission: "read",
        metadata: { filePath: "/workspace/.env" },
        always: ["/workspace/.env"],
        alwaysScope: "session",
      }),
    )
    harness.subscription.handle(
      permissionAsked("ses_a", "perm_edits", {
        permission: "edit",
        metadata: { filepath: "/workspace/missing.ts" },
        always: ["missing.ts"],
        alwaysScope: "acceptEdits",
      }),
    )

    await pollUntil(() => harness.replies.length === 3, "scoped permissions were never replied")

    expect(harness.requests.map((request) => request.options.find((option) => option.optionId === "always"))).toEqual([
      { optionId: "always", kind: "allow_always", name: "Always allow in this project" },
      { optionId: "always", kind: "allow_always", name: "Allow for this session" },
      { optionId: "always", kind: "allow_always", name: "Allow all edits (Accept edits)" },
    ])
    expect(harness.replies.map((reply) => [reply.requestID, reply.reply])).toEqual([
      ["perm_project", "always"],
      ["perm_session", "always"],
      ["perm_edits", "always"],
    ])
  })

  it("rejects non-selected outcomes", async () => {
    const harness = createHarness(() => Promise.resolve({ outcome: { outcome: "cancelled" } }))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_cancelled"))

    await pollUntil(() => harness.replies.length === 1, "cancelled permission was never replied")

    expect(harness.replies[0]).toMatchObject({ requestID: "perm_cancelled", reply: "reject" })
  })

  it("rejects when requestPermission fails", async () => {
    const harness = createHarness(() => Promise.reject(new Error("client permission UI failed")))
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_failed"))

    await pollUntil(() => harness.replies.length === 1, "failed permission was never rejected")

    expect(harness.replies[0]).toMatchObject({ requestID: "perm_failed", reply: "reject" })
  })

  it("does not let a blocked session A permission block session B message updates", async () => {
    let releasePermission: (() => void) | undefined
    const blocked = new Promise<RequestPermissionResponse>((resolve) => {
      releasePermission = () => resolve({ outcome: { outcome: "selected", optionId: "once" } })
    })
    const harness = createHarness(() => blocked)
    await createSession(harness.session, "ses_a")
    await createSession(harness.session, "ses_b")
    await createKnownTextPart(harness.session, "ses_b", "msg_b", "part_b")

    harness.subscription.handle(permissionAsked("ses_a", "perm_blocked"))
    await pollUntil(() => harness.requests.length === 1, "blocked permission was never requested")

    await harness.subscription.handle(textDelta("ses_b", "msg_b", "part_b", "session_b_message"))

    expect(textFromUpdates(harness.updates, "ses_b")).toBe("session_b_message")
    expect(harness.replies).toHaveLength(0)

    releasePermission?.()
    await pollUntil(() => harness.replies.length === 1, "blocked permission was never replied after release")
  })

  it("serializes permission requests per session", async () => {
    let releaseFirst: (() => void) | undefined
    const first = new Promise<RequestPermissionResponse>((resolve) => {
      releaseFirst = () => resolve({ outcome: { outcome: "selected", optionId: "once" } })
    })
    const harness = createHarness(() =>
      harness.requests.length === 1 ? first : Promise.resolve({ outcome: { outcome: "selected", optionId: "always" } }),
    )
    await createSession(harness.session, "ses_a")

    harness.subscription.handle(permissionAsked("ses_a", "perm_1"))
    harness.subscription.handle(permissionAsked("ses_a", "perm_2", { always: ["printf *"] }))

    await pollUntil(() => harness.requests.length === 1, "first permission was never requested")
    expect(harness.requests.map((request) => request.toolCall.toolCallId)).toEqual(["perm_1"])

    releaseFirst?.()
    await pollUntil(() => harness.requests.length === 2, "second permission was not requested after first resolved")
    await pollUntil(() => harness.replies.length === 2, "serialized permissions were not both replied")

    expect(harness.replies.map((reply) => [reply.requestID, reply.reply])).toEqual([
      ["perm_1", "once"],
      ["perm_2", "always"],
    ])
  })
})
