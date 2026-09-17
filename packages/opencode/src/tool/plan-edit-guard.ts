import path from "path"
import { Effect, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { containsPath } from "../project/instance-context"
import type * as Tool from "./tool"

/**
 * Plan mode denies every edit except the plan file, but the edit tools ask for external_directory before they ask to
 * edit. Without this guard an edit outside the project would first prompt for the folder and be denied as plan only
 * after the user approved that prompt.
 *
 * In plan mode an edit ask never prompts: it is allowed for the plan file and denied otherwise. So when a target lies
 * outside the project, the guard asks for the edit up front and a denial ends the call before any external_directory
 * prompt. Other modes, and edits that stay inside the project, keep the usual order. The permission service is
 * optional so the tools still run where it is not provided (isolated tool tests); the edit ask then still enforces
 * plan mode, only later.
 */
export const make = Effect.gen(function* () {
  const permission = yield* Effect.serviceOption(Permission.Service)

  return Effect.fn("Tool.denyPlanModeEdits")(function* (
    ctx: Pick<Tool.Context, "ask" | "sessionID" | "agent">,
    targets: ReadonlyArray<string | undefined>,
  ) {
    if (Option.isNone(permission)) return
    const files = targets.filter((item): item is string => !!item)
    if (files.length === 0) return
    const instance = yield* InstanceState.context
    const outside = files.some(
      (file) => !containsPath(process.platform === "win32" ? FSUtil.normalizePath(file) : file, instance),
    )
    if (!outside) return
    if ((yield* permission.value.mode(ctx.sessionID, ctx.agent)) !== "plan") return

    const patterns = [...new Set(files.map((file) => path.relative(instance.worktree, file).replaceAll("\\", "/")))]
    yield* ctx.ask({
      permission: "edit",
      patterns,
      always: [],
      metadata: { filepath: files.length === 1 ? files[0] : patterns.join(", ") },
    })
  })
})

export * as PlanEditGuard from "./plan-edit-guard"
