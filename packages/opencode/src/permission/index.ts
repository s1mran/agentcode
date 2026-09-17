import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Cause, Deferred, Effect, Layer, Context, Option } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { containsPath, type InstanceContext } from "@/project/instance-context"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { BashClassify } from "./bash-classify"
import { combine, decide, samePath, type Decision, type Target } from "./evaluate"
import { PermissionLocalStore } from "./local-store"
import { ModeError, PermissionMode } from "./mode"
import { ProtectedPath } from "./protected"

export const Event = PermissionV1.Event
export const Mode = PermissionV1.Mode
export type Mode = PermissionV1.Mode
export { ModeError }

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
  /** The effective permission mode of a session (inherited through its parents). */
  readonly mode: (sessionID: SessionID, agentName?: string) => Effect.Effect<Mode>
  /** The effective mode the root session had when it last entered plan mode. */
  readonly prePlan: (sessionID: SessionID) => Effect.Effect<Mode | undefined>
  /** Stores a session mode (null clears it) and re-checks the prompts already waiting in that session tree. */
  readonly setMode: (sessionID: SessionID, mode: Mode | null) => Effect.Effect<void, ModeError>
  /** Re-decides the pending requests of a root session's tree: newly allowed ones resolve, denied ones reject. */
  readonly recheck: (root: SessionID) => Effect.Effect<void>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.Error>
  input: PermissionV1.AskInput
  root: SessionID
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  /** Session-scoped "Allow always" answers, keyed by root session. */
  sessionApprovals: Map<string, PermissionV1.Rule[]>
}

type Evaluation = {
  decision: Decision
  decisions: Array<{ pattern: string; hint?: PermissionV1.Hint; decision: Decision }>
  mode: Mode
  rootID: SessionID
  targets: Target[]
  rules: PermissionV1.Rule[]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const caseInsensitive = process.platform === "darwin" || process.platform === "win32"

// Permission keys whose "Allow always" lasts for the session only. bash, webfetch, websearch, external_directory
// and every other key (MCP, code mode, plugins) are saved for the project.
const SESSION_SCOPED = new Set([
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "lsp",
  "task",
  "skill",
  "todowrite",
  "question",
  "doom_loop",
  "workflow_tool_approval",
  "plan_enter",
  "plan_exit",
])

const CRITICAL_RM_FALLBACK = "recursively removes a critical or unknown location"

/**
 * Where an "Always" answer is stored. Edits switch the session to acceptEdits only when that mode would actually
 * approve them, that is when every ask came from a built-in default (or no rule); an explicit or catch-all ask keeps
 * asking in acceptEdits, so those edits are remembered for the session as exact patterns instead.
 */
function scopeFor(
  permission: string,
  mode: Mode,
  targets: Target[],
  decisions: ReadonlyArray<Decision>,
): PermissionV1.AlwaysScope {
  if (permission === "edit") {
    const loosenable = decisions.every((item) => item.action !== "ask" || item.via === "builtin" || item.via === "none")
    return mode === "default" &&
      loosenable &&
      targets.length > 0 &&
      targets.every((item) => item.inProject && !item.floor)
      ? "acceptEdits"
      : "session"
  }
  return SESSION_SCOPED.has(permission) ? "session" : "project"
}

/** An external_directory glob too broad to remember: /, a top-level folder, home or a folder that contains home. */
export function broadFolder(glob: string) {
  const dir = glob.replace(/[\\/]\*+$/, "") || "/"
  const normalized = ProtectedPath.normalize(dir, caseInsensitive)
  const parts = normalized.split("/").filter(Boolean)
  const depth = parts.length - (/^[a-zA-Z]:$/.test(parts[0] ?? "") ? 1 : 0)
  if (depth <= 1) return true
  return [os.homedir(), Global.Path.home].some((home) => {
    const value = ProtectedPath.normalize(home, caseInsensitive)
    return value === normalized || value.startsWith(normalized + "/")
  })
}

function hintFor(input: PermissionV1.AskInput, pattern: string): PermissionV1.Hint | undefined {
  const hint = input.hints?.find((item) => item.pattern === pattern)
  if (hint) return hint
  if (input.permission !== "bash" || !BashClassify.fallbackCriticalRm(pattern)) return
  return { pattern, guard: { level: "floor", category: "critical_rm", reason: CRITICAL_RM_FALLBACK } }
}

function toRules(permission: string, patterns: ReadonlyArray<string>): PermissionV1.Rule[] {
  return [...new Set(patterns)].map((pattern) => ({ permission, pattern, action: "allow" as const }))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessions = yield* Session.Service
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const spawner = yield* ChildProcessSpawner
    const modes = yield* PermissionMode.make({ sessions, config })
    const local = yield* PermissionLocalStore.make({ fs, spawner })
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state: State = {
          pending: new Map(),
          sessionApprovals: new Map(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    /** The path, its realpath when it exists, and the path rebuilt on the realpath of its nearest existing parent. */
    const candidates = Effect.fnUntraced(function* (abs: string) {
      const result = new Set([abs])
      const self = yield* fs.realPath(abs).pipe(Effect.option)
      if (Option.isSome(self)) result.add(self.value)
      let parent = path.dirname(abs)
      const rest = [path.basename(abs)]
      for (let i = 0; i < 128; i++) {
        const real = yield* fs.realPath(parent).pipe(Effect.option)
        if (Option.isSome(real)) {
          for (const item of ProtectedPath.candidates(abs, real.value, rest)) result.add(item)
          break
        }
        const up = path.dirname(parent)
        if (up === parent) break
        rest.unshift(path.basename(parent))
        parent = up
      }
      return [...result]
    })

    /** Inside the project lexically and, through symlinks, for real: a link to a folder elsewhere is not in it. */
    const insideProject = Effect.fnUntraced(function* (abs: string, paths: string[], instance: InstanceContext) {
      if (!containsPath(abs, instance)) return false
      const roots = [instance.directory, ...(instance.worktree === "/" ? [] : [instance.worktree])]
      const realRoots = [...roots]
      for (const root of roots) {
        const real = yield* fs.realPath(root).pipe(Effect.option)
        if (Option.isSome(real)) realRoots.push(real.value)
      }
      return paths.every((item) => realRoots.some((root) => FSUtil.contains(root, item)))
    })

    const target = Effect.fnUntraced(function* (abs: string, instance: InstanceContext, floor: boolean) {
      const home = os.homedir()
      const ctx: ProtectedPath.PathContext = {
        worktree: instance.worktree,
        directory: instance.directory,
        home,
        configDirs: [
          Global.Path.config,
          path.join(home, ".config", "opencode"),
          path.join(home, ".config", "agentcode"),
          // Approvals of directories outside version control live here; writing them must never be silent.
          path.join(Global.Path.data, "permission"),
        ],
        caseInsensitive,
      }
      const paths = yield* candidates(abs)
      const hit = floor
        ? paths.map((item) => ProtectedPath.protectedWrite(item, ctx)).find((item) => !!item)
        : undefined
      return {
        abs,
        inProject: yield* insideProject(abs, paths, instance),
        ...(hit ? { floor: { reason: hit.reason, category: "protected_path" as const } } : {}),
      } satisfies Target
    })

    /** Per-pattern targets of edit and external_directory requests, plus edit targets named only in metadata. */
    const resolveTargets = Effect.fnUntraced(function* (input: PermissionV1.AskInput, instance: InstanceContext) {
      const byPattern = new Map<string, Target>()
      const extra: Array<{ pattern: string; target: Target }> = []
      const metadata = input.metadata ?? {}
      if (input.permission === "edit") {
        for (const pattern of input.patterns)
          byPattern.set(pattern, yield* target(path.resolve(instance.worktree, pattern), instance, true))
        // apply_patch joins several paths into metadata.filepath, so it only names a target for single-path asks.
        const named: string[] = []
        if (input.patterns.length <= 1 && typeof metadata.filepath === "string") named.push(metadata.filepath)
        if (Array.isArray(metadata.files))
          for (const file of metadata.files) {
            if (!file || typeof file !== "object") continue
            const item = file as Record<string, unknown>
            if (typeof item.filePath === "string") named.push(item.filePath)
            if (typeof item.movePath === "string") named.push(item.movePath)
          }
        const known = [...byPattern.values()]
        for (const file of named) {
          const abs = path.resolve(instance.worktree, file)
          if (known.some((item) => samePath(item.abs, abs))) continue
          const resolved = yield* target(abs, instance, true)
          known.push(resolved)
          extra.push({ pattern: path.relative(instance.worktree, abs).replaceAll("\\", "/"), target: resolved })
        }
      }
      if (input.permission === "external_directory" && typeof metadata.filepath === "string") {
        // Reading a protected file outside the project is not a write; read-only tools mark it with access: "read".
        const resolved = yield* target(
          path.resolve(instance.directory, metadata.filepath),
          instance,
          metadata.access !== "read",
        )
        for (const pattern of input.patterns) byPattern.set(pattern, resolved)
      }
      return { byPattern, extra }
    })

    const evaluateRequest = Effect.fnUntraced(function* (input: PermissionV1.AskInput) {
      const instance = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const details = yield* modes.details(input.sessionID, { agentName: input.agent })
      const planFile = details.mode === "plan" && details.root ? Session.plan(details.root, instance) : undefined
      const rules = [...input.ruleset, ...(yield* local.rules()), ...(s.sessionApprovals.get(details.rootID) ?? [])]
      const { byPattern, extra } = yield* resolveTargets(input, instance)
      const entries = [...input.patterns.map((pattern) => ({ pattern, target: byPattern.get(pattern) })), ...extra]
      const decisions = entries.map(({ pattern, target }) => {
        const hint = hintFor(input, pattern)
        return {
          pattern,
          hint,
          decision: decide({
            permission: input.permission,
            pattern,
            hint,
            rules,
            mode: details.mode,
            planFile,
            edit: target,
          }),
        }
      })
      return {
        decision: combine(decisions.map((item) => item.decision)),
        decisions,
        mode: details.mode,
        rootID: details.rootID,
        targets: [...byPattern.values(), ...extra.map((item) => item.target)],
        rules,
      } satisfies Evaluation
    })

    const denied = (input: PermissionV1.AskInput, evaluation: Evaluation) =>
      new PermissionV1.DeniedError({
        ruleset: evaluation.rules.filter((rule) => Wildcard.match(input.permission, rule.permission)),
        reason: evaluation.decision.reason,
      })

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { pending } = yield* InstanceState.get(state)
      const evaluation = yield* evaluateRequest(input)
      const { decision } = evaluation
      yield* Effect.logInfo("evaluated", {
        permission: input.permission,
        patterns: input.patterns,
        action: decision.action,
        via: decision.via,
        mode: evaluation.mode,
      })
      if (decision.action === "deny") return yield* denied(input, evaluation)
      if (decision.action === "allow") return

      const withhold =
        !!decision.guard ||
        !!decision.withholdAlways ||
        evaluation.decisions.some((item) => item.decision.action === "ask" && item.hint?.withholdAlways)
      const offered = withhold
        ? []
        : input.permission === "external_directory"
          ? input.always.filter((pattern) => !broadFolder(pattern))
          : [...input.always]
      const scope = offered.length
        ? scopeFor(
            input.permission,
            evaluation.mode,
            evaluation.targets,
            evaluation.decisions.map((item) => item.decision),
          )
        : undefined
      // A saved "*" is a tool-level allow, which never beats a tool-level ask: offering it would save a rule that
      // can never answer this prompt.
      const saved = scope === "project" ? offered : scope === "session" ? input.patterns : []
      const futile =
        evaluation.decisions.some((item) => item.decision.action === "ask" && item.decision.via === "tool-ask") &&
        saved.length > 0 &&
        saved.every((pattern) => pattern === "*")
      const always = futile ? [] : offered
      const alwaysScope = futile ? undefined : scope

      const id = input.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: input.sessionID,
        permission: input.permission,
        patterns: input.patterns,
        metadata: input.metadata,
        always,
        tool: input.tool,
        ...(decision.guard ? { guard: decision.guard } : {}),
        ...(alwaysScope ? { alwaysScope } : {}),
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.Error>()
      pending.set(id, { info, deferred, input, root: evaluation.rootID })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const recheck = Effect.fn("Permission.recheck")(function* (root: SessionID) {
      const { pending } = yield* InstanceState.get(state)
      for (const [id, entry] of [...pending.entries()]) {
        if (entry.root !== root) continue
        const exit = yield* evaluateRequest(entry.input).pipe(Effect.exit)
        if (exit._tag === "Failure") {
          yield* Effect.logWarning("permission recheck failed", { id, cause: Cause.pretty(exit.cause) })
          continue
        }
        const evaluation = exit.value
        // A reply may have resolved the request while it was being re-decided.
        if (evaluation.decision.action === "ask" || pending.get(id) !== entry) continue
        pending.delete(id)
        if (evaluation.decision.action === "allow") {
          yield* events.publish(Event.Replied, { sessionID: entry.info.sessionID, requestID: id, reply: "once" })
          yield* Deferred.succeed(entry.deferred, undefined)
          continue
        }
        yield* events.publish(Event.Replied, { sessionID: entry.info.sessionID, requestID: id, reply: "reject" })
        yield* Deferred.fail(entry.deferred, denied(entry.input, evaluation))
      }
    })

    /** Stores an "always" answer at the scope the request advertised. */
    const remember = Effect.fnUntraced(function* (entry: PendingEntry) {
      const { info, root } = entry
      const s = yield* InstanceState.get(state)
      const session = (rules: PermissionV1.Rule[]) => {
        if (rules.length === 0) return
        s.sessionApprovals.set(root, [...(s.sessionApprovals.get(root) ?? []), ...rules])
      }
      const scope = info.alwaysScope ?? "session"
      if (scope === "project") {
        const patterns =
          info.permission === "external_directory"
            ? info.always.filter((pattern) => !broadFolder(pattern))
            : info.always
        const rules = toRules(info.permission, patterns)
        if (rules.length === 0) return
        if (yield* local.add(rules)) return
        return session(rules)
      }
      if (scope === "acceptEdits" && (yield* modes.resolve(root)) === "default") {
        const switched = yield* modes.set(root, "acceptEdits").pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        )
        if (switched) return
      }
      session(toRules(info.permission, info.patterns))
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      // Floor and guard requests, and requests without an "always" offer, can only be approved once.
      const answer =
        input.reply === "always" && (existing.info.guard || existing.info.always.length === 0) ? "once" : input.reply
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: answer,
      })

      if (answer === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (answer === "once") return

      yield* remember(existing)
      yield* recheck(existing.root)
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    const mode: Interface["mode"] = (sessionID, agentName) => modes.resolve(sessionID, agentName)

    const prePlan: Interface["prePlan"] = (sessionID) => modes.prePlan(sessionID)

    const setMode: Interface["setMode"] = Effect.fn("Permission.setModeAndRecheck")(function* (sessionID, next) {
      yield* modes.set(sessionID, next)
      yield* recheck((yield* modes.details(sessionID)).rootID)
    })

    return Service.of({ ask, reply, list, mode, prePlan, setMode, recheck })
  }),
)

export { combine, decide, disabled, evaluate, fromConfig, visibleTools } from "./evaluate"

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Session.node, Config.node, FSUtil.node, CrossSpawnSpawner.node],
})

export * as Permission from "."
