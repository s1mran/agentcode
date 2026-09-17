import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { Prompt, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const sessionCreateInputs: Array<{
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  location?: { directory: string }
  permissionMode?: string
}> = []
const sessionModeCalls: Array<{ server: string; sessionID: string; directory: string; mode: string }> = []
const draftModeClears: Array<{ server: string; directory: string }> = []
const events: string[] = []
let sessionModeResult = true
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: Array<{ sessionID: string; id?: string; command: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
const sentPrompts: string[] = []
const promptInputs: unknown[] = []
const sentCommands: unknown[] = []
const commands: Array<{ name: string; agent?: string; template?: string }> = []
let serverSessionSyncs = 0

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let permissionServer = "server-a"
let createSessionGate: Promise<void> | undefined

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const prompt = {
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  reset: () => undefined,
  set: () => undefined,
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => prompt,
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    api: {
      session: {
        create: async (input: (typeof sessionCreateInputs)[number]) => {
          await createSessionGate
          const location = input.location?.directory ?? directory
          createdSessions.push(location)
          sessionCreateInputs.push(input)
          events.push("create")
          return {
            id: `session-${createdSessions.length}`,
            projectID: "project",
            agent: input.agent,
            model: input.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            title: `New session ${createdSessions.length}`,
            location: { directory: location },
          }
        },
        prompt: async (input: unknown) => {
          sentPrompts.push(directory)
          promptInputs.push(input)
          events.push("prompt")
          return { data: undefined }
        },
        command: async (input: unknown) => {
          sentCommands.push(input)
        },
        shell: async (input: { sessionID: string; id?: string; command: string }) => {
          sentShell.push(input)
          events.push("shell")
        },
      },
    },
    session: {
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: () => 0,
    toaster: { dismiss: () => undefined },
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => {
    const state = (server: string) => ({
      async setSessionMode(sessionID: string, directory: string, mode: string) {
        sessionModeCalls.push({ server, sessionID, directory, mode })
        events.push(`setSessionMode:${mode}`)
        return sessionModeResult
      },
      setDraftMode(directory: string, mode: string | undefined) {
        if (mode === undefined) draftModeClears.push({ server, directory })
      },
    })
    return { usePermission: () => ({ currentServerState: () => state(permissionServer) }) }
  })

  mock.module("@/context/server", () => ({
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      draft: () => ({ server: "project-server" }),
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        api: rootClient.api,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: commands },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        remember: () => undefined,
        set: () => undefined,
        sync: async () => {
          serverSessionSyncs++
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  sessionCreateInputs.length = 0
  sessionModeCalls.length = 0
  draftModeClears.length = 0
  events.length = 0
  sessionModeResult = true
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  sentPrompts.length = 0
  promptInputs.length = 0
  sentCommands.length = 0
  commands.length = 0
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  params = {}
  search = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  permissionServer = "server-a"
  createSessionGate = undefined
  serverSessionSyncs = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

const baseInput = () => ({
  prompt,
  info: () => undefined as { id: string } | undefined,
  imageAttachments: () => [],
  commentCount: () => 0,
  working: () => false,
  editor: () => undefined,
  queueScroll: () => undefined,
  promptLength: (value: Prompt) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
  addToHistory: () => undefined,
  resetHistoryNavigation: () => undefined,
  setMode: () => undefined,
  setPopover: () => undefined,
  onNewSessionWorktreeReset: () => undefined,
  onSubmit: () => undefined,
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sessionCreateInputs).toEqual([
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-a" },
      },
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-b" },
      },
    ])
    expect(sentShell).toEqual([
      expect.objectContaining({ sessionID: "session-1", id: expect.stringMatching(/^evt_/), command: "ls" }),
      expect.objectContaining({ sessionID: "session-2", id: expect.stringMatching(/^evt_/), command: "ls" }),
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(serverSessionSyncs).toBe(0)
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("creates new sessions in the draft's permission mode", async () => {
    const submit = createPromptSubmit({
      ...baseInput(),
      permissionMode: () => "acceptEdits",
      permissionModesSupported: () => true,
      mode: () => "shell",
      newSessionWorktree: () => selected,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sessionCreateInputs).toEqual([
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-a" },
        permissionMode: "acceptEdits",
      },
    ])
    expect(sessionModeCalls).toEqual([])
    expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", permissionMode: "acceptEdits" })
    expect(sentShell).toEqual([expect.objectContaining({ sessionID: "session-1", permissionMode: "acceptEdits" })])
    expect(draftModeClears).toEqual([{ server: "server-a", directory: "/repo/main" }])
  })

  test("creates a bypass draft without a mode, then switches it through the engine gate", async () => {
    const submit = createPromptSubmit({
      ...baseInput(),
      permissionMode: () => "bypassPermissions",
      permissionModesSupported: () => true,
      mode: () => "normal",
      newSessionWorktree: () => selected,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Bun.sleep(0)

    expect(sessionCreateInputs).toHaveLength(1)
    expect(sessionCreateInputs[0]).not.toHaveProperty("permissionMode")
    expect(sessionModeCalls).toEqual([
      { server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a", mode: "bypassPermissions" },
    ])
    expect(events).toEqual(["create", "setSessionMode:bypassPermissions", "prompt"])
    expect(promptInputs[0]).toMatchObject({ sessionID: "session-1", permissionMode: "bypassPermissions" })
  })

  test("does not send bypass with the first prompt when the engine refuses it", async () => {
    sessionModeResult = false
    const submit = createPromptSubmit({
      ...baseInput(),
      permissionMode: () => "bypassPermissions",
      permissionModesSupported: () => true,
      mode: () => "normal",
      newSessionWorktree: () => selected,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Bun.sleep(0)

    expect(sessionModeCalls).toHaveLength(1)
    expect(promptInputs).toHaveLength(1)
    expect((promptInputs[0] as { permissionMode?: string }).permissionMode).toBeUndefined()
  })

  test("keeps the bypass switch bound to the submission server", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = createPromptSubmit({
      ...baseInput(),
      permissionMode: () => "bypassPermissions",
      permissionModesSupported: () => true,
      mode: () => "shell",
      newSessionWorktree: () => selected,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    permissionServer = "server-b"
    release()
    await result

    expect(sessionModeCalls).toEqual([
      { server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a", mode: "bypassPermissions" },
    ])
  })

  test("includes the permission mode in prompts to existing sessions", async () => {
    params = { id: "session-1" }
    const submit = createPromptSubmit({
      ...baseInput(),
      info: () => ({ id: "session-1" }),
      permissionMode: () => "plan",
      permissionModesSupported: () => true,
      mode: () => "normal",
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Bun.sleep(0)

    expect(sessionCreateInputs).toEqual([])
    expect(sessionModeCalls).toEqual([])
    expect(promptInputs[0]).toMatchObject({ sessionID: "session-1", permissionMode: "plan" })
  })

  test("sends no mode when the composer has none", async () => {
    params = { id: "session-1" }
    commands.push({ name: "review" })
    promptValue = [{ type: "text", content: "/review", start: 0, end: 7 }]
    const submit = createPromptSubmit({
      ...baseInput(),
      info: () => ({ id: "session-1" }),
      mode: () => "normal",
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentCommands).toHaveLength(1)
    expect((sentCommands[0] as { permissionMode?: string }).permissionMode).toBeUndefined()
  })

  test("leaves the mode out of queued follow-ups", async () => {
    params = { id: "session-1" }
    const queued: Array<{ permissionMode?: string }> = []
    const submit = createPromptSubmit({
      ...baseInput(),
      info: () => ({ id: "session-1" }),
      permissionMode: () => "acceptEdits",
      permissionModesSupported: () => true,
      mode: () => "normal",
      shouldQueue: () => true,
      onQueue: (draft) => queued.push(draft),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(queued).toHaveLength(1)
    expect(queued[0]?.permissionMode).toBeUndefined()
    expect(promptInputs).toEqual([])
  })

  test("bare /plan switches the composer to Plan mode without sending anything", async () => {
    params = { id: "session-1" }
    commands.push({ name: "plan", agent: "plan", template: "$ARGUMENTS\n" })
    promptValue = [{ type: "text", content: "/plan", start: 0, end: 5 }]
    const selectedModes: string[] = []
    const submit = createPromptSubmit({
      ...baseInput(),
      info: () => ({ id: "session-1" }),
      permissionMode: () => "default",
      permissionModesSupported: () => true,
      selectPermissionMode: (mode) => selectedModes.push(mode),
      mode: () => "normal",
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(selectedModes).toEqual(["plan"])
    expect(sentCommands).toEqual([])
    expect(promptInputs).toEqual([])
  })

  test("/plan with a task runs the built-in plan command in Plan mode", async () => {
    params = { id: "session-1" }
    commands.push({ name: "plan", agent: "plan", template: "$ARGUMENTS\n" })
    promptValue = [{ type: "text", content: "/plan fix the login bug", start: 0, end: 23 }]
    const selectedModes: string[] = []
    const submit = createPromptSubmit({
      ...baseInput(),
      info: () => ({ id: "session-1" }),
      permissionMode: () => "acceptEdits",
      permissionModesSupported: () => true,
      selectPermissionMode: (mode) => selectedModes.push(mode),
      mode: () => "normal",
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(selectedModes).toEqual(["plan"])
    expect(sentCommands).toEqual([
      expect.objectContaining({ command: "plan", arguments: "fix the login bug", permissionMode: "plan" }),
    ])
  })

  test("a queued /plan task does not switch the running turn to Plan mode", async () => {
    params = { id: "session-1" }
    commands.push({ name: "plan", agent: "plan", template: "$ARGUMENTS\n" })
    promptValue = [{ type: "text", content: "/plan refactor auth next", start: 0, end: 24 }]
    const selectedModes: string[] = []
    const queued: Array<{ permissionMode?: string }> = []
    const submit = createPromptSubmit({
      ...baseInput(),
      info: () => ({ id: "session-1" }),
      permissionMode: () => "acceptEdits",
      permissionModesSupported: () => true,
      selectPermissionMode: (mode) => selectedModes.push(mode),
      mode: () => "normal",
      shouldQueue: () => true,
      onQueue: (draft) => queued.push(draft),
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(selectedModes).toEqual([])
    expect(sentCommands).toEqual([])
    expect(queued).toHaveLength(1)
    expect(queued[0]?.permissionMode).toBe("plan")
  })

  test("a user command named plan is not treated as Plan mode", async () => {
    params = { id: "session-1" }
    commands.push({ name: "plan", template: "Write a plan for $ARGUMENTS" })
    promptValue = [{ type: "text", content: "/plan x", start: 0, end: 7 }]
    const selectedModes: string[] = []
    const submit = createPromptSubmit({
      ...baseInput(),
      info: () => ({ id: "session-1" }),
      permissionMode: () => "acceptEdits",
      permissionModesSupported: () => true,
      selectPermissionMode: (mode) => selectedModes.push(mode),
      mode: () => "normal",
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(selectedModes).toEqual([])
    expect(sentCommands).toEqual([expect.objectContaining({ command: "plan", permissionMode: "acceptEdits" })])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await Bun.sleep(0)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-1",
      text: "ls",
      files: [],
      agents: [],
    })
    expect((promptInputs[0] as { id?: string }).id).toStartWith("msg_")
    expect((promptInputs[0] as { legacyParts?: { id: string; type: string; text?: string }[] }).legacyParts).toEqual([
      { id: expect.stringMatching(/^prt_/), type: "text", text: "ls" },
    ])
  })

  test("submits slash commands through the current session API", async () => {
    params = { id: "session-1" }
    variant = "high"
    commands.push({ name: "review" })
    promptValue = [{ type: "text", content: "/review staged changes", start: 0, end: 22 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentCommands).toEqual([
      {
        sessionID: "session-1",
        id: expect.stringMatching(/^msg_/),
        command: "review",
        arguments: "staged changes",
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: "high" },
        files: [],
      },
    ])
    expect(serverSessionSyncs).toBe(0)
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic[0]).toMatchObject({
      message: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
    expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", title: "New session 1" })
    expect(optimisticSeeded).toEqual([true])
  })
})
