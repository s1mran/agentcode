import { base64Encode } from "@opencode-ai/core/util/encode"
import { createQuery } from "@tanstack/solid-query"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Accessor, createComponent, createEffect, createMemo, on, onCleanup } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { PromptInputControls, PromptInputPermissionModeControl } from "@/components/prompt-input/contracts"
import { DialogBypassPermissions } from "@/components/dialog-bypass-permissions"
import {
  createPermissionModeSelector,
  permissionModeOptions,
  resolveComposerMode,
} from "@/components/prompt-input/permission-mode-controls"
import type { PromptProjectControls } from "@/components/prompt-project-selector"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useGlobal } from "@/context/global"
import { usePermission } from "@/context/permission"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import type { QueryOptionsApi } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { serverName, ServerConnection, useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { useProviders } from "@/hooks/use-providers"
import { pathKey } from "@/utils/path-key"

/**
 * The composer's permission mode: an existing session shows (and updates) its engine-side mode, a new-session draft
 * keeps a local choice that starts from the folder or config default. The draft choice and the mode being applied to a
 * session live in the permission context, so every control (composer, commands) sees the same value.
 */
export function createPermissionModeControl(input: { sessionID: Accessor<string | undefined> }) {
  const permission = usePermission()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()

  const selector = createPermissionModeSelector({
    sessionID: input.sessionID,
    directory: () => sdk().directory,
    setSessionMode: permission.setSessionMode,
    setDraftMode: permission.setDraftMode,
    confirm: (apply) => {
      void dialog.show(() => createComponent(DialogBypassPermissions, { onConfirm: apply }))
    },
  })

  // A draft never carries a choice into a later composer; bypass in particular must be confirmed again. The draft is
  // dropped when the composer leaves it (opening a session) or unmounts.
  const clearDraft = () => permission.setDraftMode(sdk().directory, undefined)
  createEffect(on(input.sessionID, clearDraft, { defer: true }))
  onCleanup(clearDraft)

  return createMemo<PromptInputPermissionModeControl>(() => {
    const supported = permission.modesSupported()
    const sessionID = input.sessionID()
    const directory = sdk().directory
    const info = sessionID ? sync().session.get(sessionID) : undefined
    const mode = sessionID
      ? resolveComposerMode({
          sessionID,
          pending: permission.pendingMode(sessionID),
          effective: permission.sessionMode(sessionID, directory),
          stored: info?.permissionMode,
        })
      : resolveComposerMode({
          draft: permission.draftMode(directory),
          folder: permission.folderMode(directory),
          config: permission.configMode(directory),
        })
    const current = mode.current
    return {
      supported,
      current,
      submit: supported ? mode.submit : undefined,
      options: permissionModeOptions(current),
      disabled: !supported || !!info?.parentID,
      select: (next) => void selector.select(next),
      cycle: () => void selector.cycle(current),
    }
  })
}

export function createPromptInputController(input: {
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  queryOptions: Pick<QueryOptionsApi, "agents" | "providers">
  model?: ModelSelection
}) {
  const layout = useLayout()
  const local = useLocal()
  const sdk = useSDK()
  const sync = useSync()
  const providers = useProviders(() => sdk().directory)
  const view = layout.view(input.sessionKey)
  const agentsQuery = createQuery(() => input.queryOptions.agents(pathKey(sdk().directory)))
  const globalProvidersQuery = createQuery(() => input.queryOptions.providers(null))
  const providersQuery = createQuery(() => input.queryOptions.providers(pathKey(sdk().directory)))
  const permissionMode = createPermissionModeControl({ sessionID: input.sessionID })

  return createMemo<PromptInputControls>(() => {
    const mode = permissionMode()
    return {
      agents: {
        available: sync().data.agent,
        // Plan is a permission mode on servers that support modes, not an agent to pick.
        options: local.agent
          .list()
          .filter((agent) => !(mode.supported && agent.name === "plan" && agent.native !== false))
          .map((agent) => agent.name),
        current: local.agent.current()?.name ?? "",
        loading: agentsQuery.isLoading,
        visible: local.agent.visible(),
        select: local.agent.set,
      },
      permissionMode: mode,
      model: {
        selection: input.model ?? local.model,
        paid: providers.paid().length > 0,
        loading:
          (local.agent.visible() && agentsQuery.isLoading) ||
          providersQuery.isLoading ||
          globalProvidersQuery.isLoading,
      },
      session: {
        id: input.sessionID(),
        tabs: layout.tabs(input.sessionKey),
        reviewPanel: view.reviewPanel,
      },
    }
  })
}

export function createPromptProjectControls() {
  const navigate = useNavigate()
  const layout = useLayout()
  const server = useServer()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const tabs = useTabs()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const [search] = useSearchParams<{ draftId?: string }>()
  const projectServer = () => serverSDK().server
  const projectServerCtx = createMemo(() => global.ensureServerCtx(projectServer()))
  const projects = createMemo(() => {
    if (server.list.length <= 1) {
      return search.draftId ? projectServerCtx().projects.list() : layout.projects.list()
    }
    return server.list.flatMap((conn) => {
      const item = { key: ServerConnection.key(conn), name: serverName(conn) }
      return global
        .ensureServerCtx(conn)
        .projects.list()
        .map((project) => ({ ...project, server: item }))
    })
  })
  const selectProject = (worktree: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (search.draftId) {
      if (!conn) return
      const target = global.ensureServerCtx(conn)
      target.projects.open(worktree)
      target.projects.touch(worktree)
      tabs.updateDraft(search.draftId, { server: ServerConnection.key(conn), directory: worktree })
      return
    }

    if (!serverKey) {
      layout.projects.open(worktree)
      server.projects.touch(worktree)
      navigate(`/${base64Encode(worktree)}/session`)
      return
    }

    if (!conn) return
    const target = global.ensureServerCtx(conn)
    target.projects.open(worktree)
    target.projects.touch(worktree)
    server.setActive(ServerConnection.key(conn))
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const addProject = (title: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (!conn) return
    pickDirectory({
      server: conn,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) selectProject(directory, serverKey)
      },
    })
  }

  return createMemo<PromptProjectControls>(() => ({
    available: projects(),
    directory: sdk().directory,
    server: server.list.length > 1 ? ServerConnection.key(projectServer()) : undefined,
    select: selectProject,
    add: addProject,
  }))
}
