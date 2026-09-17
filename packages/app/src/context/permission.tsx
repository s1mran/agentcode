import { createEffect, createMemo, createRoot, createSignal, getOwner, onCleanup, untrack } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import type { PermissionMode, PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import type { ServerSDK } from "@/context/server-sdk"
import type { ServerSync } from "./server-sync"
import { useParams, useSearchParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import { useGlobal } from "./global"
import { useLanguage } from "./language"
import { ServerConnection, useServer } from "./server"
import { type DraftTab, useTabs } from "./tabs"
import { useSettings } from "./settings"
import { requireServerKey } from "@/utils/session-route"
import type { ServerScope } from "@/utils/server-scope"
import {
  createSessionModeQueue,
  folderDefaultAllowed,
  folderKey,
  hadAutoAccept,
  isMode,
  migrateAutoAccept,
  projectRoot,
  resolveChainMode,
} from "./permission-mode"
import { serverPermissionModes } from "@/utils/permission-modes"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
  directory?: string
}) => void

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasPermissionPromptRules(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  return Object.values(config).some(isNonAllowRule)
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  gate: false,
  init: () => {
    const params = useParams<{ serverKey?: string; dir?: string; id?: string }>()
    const [search] = useSearchParams<{ draftId?: string }>()
    const global = useGlobal()
    const server = useServer()
    const tabs = useTabs()
    const settings = useSettings()
    const language = useLanguage()
    const owner = getOwner()
    const states = new Map<ServerScope, { key: ServerConnection.Key; dispose: () => void; state: PermissionState }>()

    const activeDraft = createMemo(() => {
      if (!search.draftId) return
      return tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)
    })

    const activeServer = createMemo(() => {
      if (params.serverKey && settings.general.newLayoutDesigns()) return requireServerKey(params.serverKey)
      return activeDraft()?.server ?? server.key
    })

    const ensure = (key: ServerConnection.Key) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      if (!conn) throw new Error(`Permission server not found: ${key}`)
      const ctx = global.ensureServerCtx(conn)
      const existing = states.get(ctx.sdk.scope)
      if (existing && global.servers.list().some((item) => ServerConnection.key(item) === existing.key)) {
        return existing.state
      }
      if (existing) {
        existing.dispose()
        states.delete(ctx.sdk.scope)
      }
      const root = createRoot(
        (dispose) => ({
          key,
          dispose,
          state: createServerPermissionState({ sdk: ctx.sdk, sync: ctx.sync, language }),
        }),
        owner ?? undefined,
      )
      states.set(ctx.sdk.scope, root)
      return root.state
    }

    createEffect(() => {
      global.servers.list().forEach((conn) => ensure(ServerConnection.key(conn)))
    })

    createEffect(() => {
      const list = global.servers.list()
      const keys = new Set(list.map(ServerConnection.key))
      states.forEach((value, scope) => {
        if (keys.has(value.key)) return
        value.dispose()
        states.delete(scope)
        const replacement = list.find((conn) => server.scope(ServerConnection.key(conn)) === scope)
        if (replacement) ensure(ServerConnection.key(replacement))
      })
    })

    onCleanup(() => states.forEach((value) => value.dispose()))

    let lastSelected: PermissionState | undefined
    const selected = () => {
      const key = activeServer()
      if (global.servers.list().some((conn) => ServerConnection.key(conn) === key)) {
        lastSelected = ensure(key)
      }
      if (lastSelected) return lastSelected
      return ensure(server.key)
    }
    const activeDirectory = createMemo(() => {
      const directory = decode64(params.dir)
      if (directory) return directory
      const draft = activeDraft()
      if (draft) return draft.directory
      if (!params.id) return
      if (!global.servers.list().some((conn) => ServerConnection.key(conn) === activeServer())) return
      return selected().sync.session.lineage.peek(params.id)?.session.directory
    })

    const permissionsEnabled = createMemo(() => {
      const directory = activeDirectory()
      if (!directory) return false
      return selected().permissionsEnabled(directory)
    })

    return {
      ready: () => selected().ready(),
      ensureServerState: (key: ServerConnection.Key) => ensure(key).api,
      currentServerState: () => selected().api,
      respond(input: Parameters<PermissionRespondFn>[0]) {
        selected().respond(input)
      },
      autoResponds(permission: PermissionRequest, directory?: string) {
        return selected().autoResponds(permission, directory)
      },
      modesSupported() {
        return selected().modesSupported()
      },
      sessionMode(sessionID: string, directory?: string) {
        return selected().sessionMode(sessionID, directory)
      },
      pendingMode(sessionID: string) {
        return selected().pendingMode(sessionID)
      },
      folderMode(directory: string) {
        return selected().folderMode(directory)
      },
      configMode(directory: string) {
        return selected().configMode(directory)
      },
      defaultMode(directory: string) {
        return selected().defaultMode(directory)
      },
      setFolderMode(directory: string, mode: PermissionMode | undefined) {
        selected().setFolderMode(directory, mode)
      },
      setSessionMode(sessionID: string, directory: string, mode: PermissionMode) {
        return selected().setSessionMode(sessionID, directory, mode)
      },
      draftMode(directory: string) {
        return selected().draftMode(directory)
      },
      setDraftMode(directory: string, mode: PermissionMode | undefined) {
        selected().setDraftMode(directory, mode)
      },
      permissionsEnabled,
      activeDirectory,
      isPermissionAllowAll(directory: string) {
        return selected().isPermissionAllowAll(directory)
      },
    }
  },
})

type PermissionState = ReturnType<typeof createServerPermissionState>

const MAX_CHAIN = 16

function createServerPermissionState(input: {
  sdk: ServerSDK
  sync: ServerSync
  language: ReturnType<typeof useLanguage>
}) {
  const meta = { disposed: false }
  // Whether this server resolves permission modes: undefined until known. Resolved from a promise rather than a
  // resource, so reading it inside a memo never suspends the sidebar or composer while detection is pending. Only an
  // engine that advertises modes counts; a stock server answering the v1 API silently ignores permissionMode.
  const [capability, setCapability] = createSignal<boolean>()
  void serverPermissionModes(input.sdk).then((value) => {
    if (meta.disposed) return
    setCapability(value)
  })
  const supported = () => capability() === true

  // The old client auto-accept switch. It is only read for the one-time migration below: the client never answers
  // permission requests on its own any more, on any server, so nothing can be approved without a visible control.
  const [store, , , ready] = persisted(
    {
      ...Persist.serverGlobal(input.sdk.scope, "permission", ["permission.v3"]),
      migrate(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value

        const data = value as Record<string, unknown>
        if (data.autoAccept) return value

        return {
          ...data,
          autoAccept:
            typeof data.autoAcceptEdits === "object" && data.autoAcceptEdits && !Array.isArray(data.autoAcceptEdits)
              ? data.autoAcceptEdits
              : {},
        }
      },
    },
    createStore({
      autoAccept: {} as Record<string, boolean>,
    }),
  )

  const [modes, setModes, , modesReady] = persisted(
    Persist.serverGlobal(input.sdk.scope, "permission-mode", ["permission-mode.v1"]),
    createStore({
      folder: {} as Record<string, PermissionMode>,
      migrated: false,
      notified: false,
    }),
  )

  const root = (directory: string) => projectRoot(directory, input.sync.data.project)
  const rootKey = (directory: string) => folderKey(root(directory))

  // One-time move from the old client auto-accept switch: folders that auto-accepted become Accept edits (never
  // bypass, which needs the confirmation dialog). Session-level keys are not carried over, but anyone who had
  // auto-accept on anywhere is told it is gone, so prompts coming back is never a silent change.
  createEffect(() => {
    const known = capability()
    if (meta.disposed || known === undefined || !ready() || !modesReady()) return
    if (known ? modes.migrated : modes.notified) return
    untrack(() => {
      const had = hadAutoAccept(store.autoAccept)
      if (!known) {
        setModes("notified", true)
        if (!had) return
        showToast({
          title: input.language.t("toast.permissions.autoAcceptRemoved.title"),
          description: input.language.t("toast.permissions.autoAcceptRemoved.rules"),
        })
        return
      }
      const added = Object.entries(migrateAutoAccept(store.autoAccept))
        .map(([key, mode]) => {
          const directory = decode64(key)
          return [directory === undefined ? key : rootKey(directory), mode] as const
        })
        .filter(([key]) => modes.folder[key] === undefined)
      setModes(
        produce((draft) => {
          for (const [key, mode] of added) draft.folder[key] = mode
          draft.migrated = true
          draft.notified = true
        }),
      )
      if (added.length > 0) {
        showToast({
          title: input.language.t("toast.permissions.modeMigrated.title"),
          description: input.language.t("toast.permissions.modeMigrated.description"),
        })
        return
      }
      if (!had) return
      showToast({
        title: input.language.t("toast.permissions.autoAcceptRemoved.title"),
        description: input.language.t("toast.permissions.autoAcceptRemoved.modes"),
      })
    })
  })

  function sessionInfo(sessionID: string, directory?: string): Session | undefined {
    const info = input.sync.session.data.info[sessionID]
    if (info || !directory) return info
    return input.sync.child(directory, { bootstrap: false })[0].session.find((item) => item.id === sessionID)
  }

  /** The engine's configured default_permission_mode for a directory (config file or OPENCODE_PERMISSION_MODE). */
  function configMode(directory: string): PermissionMode | undefined {
    if (meta.disposed) return
    const value = input.sync.child(directory, { bootstrap: false })[0].config?.default_permission_mode
    return isMode(value) ? value : undefined
  }

  function sessionMode(sessionID: string, directory?: string): PermissionMode {
    const chain: Session[] = []
    const seen = new Set<string>()
    let id: string | undefined = sessionID
    while (id && !seen.has(id) && chain.length < MAX_CHAIN) {
      seen.add(id)
      const info = sessionInfo(id, directory)
      if (!info) break
      chain.push(info)
      id = info.parentID
    }
    const configDirectory = chain.at(-1)?.directory ?? directory
    return resolveChainMode(chain, configDirectory ? configMode(configDirectory) : undefined)
  }

  /** The folder default the user chose in settings, or undefined when none is stored. */
  function folderMode(directory: string): PermissionMode | undefined {
    const value = modes.folder[rootKey(directory)]
    if (isMode(value) && folderDefaultAllowed(value)) return value
    return undefined
  }

  /** The mode a new session in this folder starts in: the stored folder default, else the engine's config default. */
  function defaultMode(directory: string): PermissionMode {
    return folderMode(directory) ?? configMode(directory) ?? "default"
  }

  /** Stores the folder default; choosing what the engine would use anyway (or undefined) clears the override. */
  function setFolderMode(directory: string, mode: PermissionMode | undefined) {
    if (meta.disposed) return
    const key = rootKey(directory)
    if (mode === undefined || mode === (configMode(directory) ?? "default")) {
      setModes(
        "folder",
        produce((draft) => {
          delete draft[key]
        }),
      )
      return
    }
    if (!isMode(mode) || !folderDefaultAllowed(mode)) return
    setModes("folder", key, mode)
  }

  // The mode chosen in a new-session composer before the session exists. It is kept in memory only, so a draft never
  // starts in bypassPermissions after a reload; the composer clears it once the session is created.
  const [drafts, setDrafts] = createStore<Record<string, PermissionMode | undefined>>({})

  function draftMode(directory: string): PermissionMode | undefined {
    const value = drafts[folderKey(directory)]
    return isMode(value) ? value : undefined
  }

  function setDraftMode(directory: string, mode: PermissionMode | undefined) {
    if (meta.disposed) return
    if (mode !== undefined && !isMode(mode)) return
    setDrafts(folderKey(directory), mode)
  }

  // The newest mode requested for a session while its update is outstanding, shared by every composer control.
  const [pending, setPending] = createStore<Record<string, PermissionMode | undefined>>({})

  function pendingMode(sessionID: string): PermissionMode | undefined {
    return pending[sessionID]
  }

  // A session mode change applies to that session only; it never rewrites the folder default in settings.
  const setSessionMode = createSessionModeQueue({
    onPending: (sessionID, mode) => {
      if (meta.disposed) return
      setPending(sessionID, mode)
    },
    apply: async (sessionID, directory, mode) => {
      if (meta.disposed) return false
      if (!(await serverPermissionModes(input.sdk))) return false
      try {
        const result = await input.sdk.client.session.update(
          { sessionID, directory, permissionMode: mode },
          { throwOnError: true },
        )
        if (meta.disposed) return false
        if (result.data) input.sync.session.remember(result.data)
        return true
      } catch (error) {
        if (meta.disposed) return false
        showToast({
          variant: "error",
          title: input.language.t("toast.permissions.mode.error.title"),
          description: formatServerError(error, input.language.t, input.language.t("common.requestFailed")),
        })
        return false
      }
    },
  })

  const respond: PermissionRespondFn = (request) => {
    if (meta.disposed) return
    void input.sdk.api.permission
      .reply({
        sessionID: request.sessionID,
        requestID: request.permissionID,
        reply: request.response,
        location: request.directory ? { directory: request.directory } : undefined,
      })
      .catch(() => undefined)
  }

  onCleanup(() => {
    meta.disposed = true
  })

  const api = {
    ready: () => !meta.disposed && ready(),
    respond,
    /** The client no longer auto-answers permission requests; every request is shown to the user. */
    autoResponds(_permission: PermissionRequest, _directory?: string) {
      return false
    },
    modesSupported: supported,
    sessionMode,
    pendingMode,
    folderMode,
    configMode,
    defaultMode,
    setFolderMode,
    setSessionMode,
    draftMode,
    setDraftMode,
    isPermissionAllowAll(directory: string) {
      if (meta.disposed) return false
      const [childStore] = input.sync.child(directory)
      return childStore.config.permission === "allow"
    },
  }

  return {
    ...api,
    api,
    sync: input.sync,
    permissionsEnabled(directory: string) {
      if (meta.disposed) return false
      const [childStore] = input.sync.child(directory)
      return hasPermissionPromptRules(childStore.config.permission)
    },
  }
}
