import type { PermissionMode } from "@opencode-ai/sdk/v2/client"
import type { useLocal } from "@/context/local"
import type { Prompt, usePrompt } from "@/context/prompt"
import type { PromptInputHistory } from "./history-store"
import type { FollowupDraft } from "./submit"

export type PromptInputState = ReturnType<typeof usePrompt>

export type PromptInputSubmission = {
  abort: () => Promise<void> | void
  handleSubmit: (event: Event) => Promise<void> | void
}

export type PromptInputPermissionModeControl = {
  /** False on servers without permission modes; the pill is hidden and nothing is sent. */
  supported: boolean
  /** The mode the pill shows. */
  current: PermissionMode
  /**
   * The mode sent with submits: the draft mode for a new session, or the session's own stored mode when the client
   * knows it (undefined leaves the engine's stored mode untouched).
   */
  submit?: PermissionMode
  options: PermissionMode[]
  disabled: boolean
  select: (mode: PermissionMode) => void
  cycle: () => void
}

export type PromptInputControls = {
  agents: {
    available: { name: string; hidden?: boolean; mode: string }[]
    options: string[]
    current: string
    loading: boolean
    visible: boolean
    select: (name: string | undefined) => void
  }
  model: {
    selection: ReturnType<typeof useLocal>["model"]
    paid: boolean
    loading: boolean
  }
  permissionMode?: PromptInputPermissionModeControl
  session: {
    id?: string
    tabs: {
      active: () => string | undefined
      all: () => string[]
      open: (tab: string) => void | Promise<void>
      setActive: (tab: string) => void
    }
    reviewPanel: {
      opened: () => boolean
      open: () => void
    }
  }
}

export interface PromptInputProps {
  class?: string
  state?: PromptInputState
  history?: PromptInputHistory
  submission?: PromptInputSubmission
  controls: PromptInputControls
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  edit?: { id: string; prompt: Prompt; context: FollowupDraft["context"] }
  onEditLoaded?: () => void
  shouldQueue?: () => boolean
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
}
