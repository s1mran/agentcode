export * as CommandPlugin from "./command"

import { define } from "./internal"
import { Effect } from "effect"
import { Location } from "../location"
import PROMPT_INITIALIZE from "./command/initialize.txt"
import PROMPT_REVIEW from "./command/review.txt"

export const Plugin = define({
  id: "command",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    // NOTE(agentcode): ./command/initialize.txt must stay byte-identical to the live v1 template at
    // packages/opencode/src/command/template/initialize.txt (guarded by
    // packages/opencode/test/command/init-template-sync.test.ts), so edit both files together.
    // v2 has no OPENCODE_DISABLE_CLAUDE_CODE(_PROMPT) switch to pick the AGENTS.md variant, and the v2
    // InstructionContext still loads only AGENTS.md (see the NOTE(agentcode) in ../instruction-context.ts).
    // Port both before the v2 command registry serves /init, or a v2 /init writes a CLAUDE.md v2 never loads.
    yield* ctx.command.transform((draft) => {
      draft.update("init", (command) => {
        command.template = PROMPT_INITIALIZE.replace("${path}", location.project.directory)
        command.description = "initialize project with a CLAUDE.md guide"
      })
      draft.update("review", (command) => {
        command.template = PROMPT_REVIEW.replace("${path}", location.project.directory)
        command.description = "review changes [commit|branch|pr], defaults to uncommitted"
        command.subtask = true
      })
    })
  }),
})
