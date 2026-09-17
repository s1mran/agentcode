import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { createSimpleContext } from "./helper"

export interface Args {
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
  auto?: boolean
  /** The launch --permission-mode, stored on the session opened from --session, --continue or --fork. */
  permissionMode?: PermissionV1.Mode
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => props,
})
