import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Option } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { PartID, type SessionID } from "./schema"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import PLAN_SUBAGENT from "./prompt/plan-subagent.txt"

/** How a planning turn ends, depending on whether plan_exit is available to the session. */
export const EXIT_WITH_TOOL = "call plan_exit"
export const EXIT_IN_REPLY = "present the final plan in your reply and stop"

/** Marks the reminders that are persisted, so a later loop step never adds them twice. */
const REMINDER_KEY = "reminder"
type Kind = "plan-mode" | "build-switch"

const MAX_DEPTH = 16

function fill(template: string, values: Record<string, string>) {
  return template.replace(/\$\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** The most recent persisted reminder in a message: modes can switch mid-turn, so only the last one counts. */
function latest(message: SessionV1.WithParts): Kind | undefined {
  for (const part of message.parts.toReversed()) {
    if (part.type !== "text" || part.synthetic !== true) continue
    const kind = part.metadata?.[REMINDER_KEY]
    if (kind === "plan-mode" || kind === "build-switch") return kind
  }
}

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
  /** The effective permission mode for this turn; derived from the agent when omitted. */
  mode?: PermissionV1.Mode
  /** Whether plan_exit is offered to this session (defaults to true). */
  planExitAvailable?: boolean
}) {
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  const mode = input.mode ?? (input.agent.name === "plan" ? "plan" : "default")
  const assistant = input.messages.findLast((msg) => msg.info.role === "assistant")?.info
  const prevPlan =
    assistant?.role === "assistant" && (assistant.permissionMode === "plan" || assistant.agent === "plan")
  if (mode !== "plan" && !prevPlan) return input.messages

  const ctx = yield* InstanceState.context
  // Plan mode edits only the root session's plan file, so subagents point at the same file.
  const root = yield* Effect.gen(function* () {
    let info = input.session
    const seen = new Set<SessionID>([info.id])
    while (info.parentID && !seen.has(info.parentID) && seen.size < MAX_DEPTH) {
      seen.add(info.parentID)
      const parent: Option.Option<Session.Info> = yield* sessions.get(info.parentID).pipe(Effect.option)
      if (Option.isNone(parent)) break
      info = parent.value
    }
    return info
  })
  const plan = Session.plan(root, ctx)
  const exitInfo = input.planExitAvailable === false ? EXIT_IN_REPLY : EXIT_WITH_TOOL

  const persist = Effect.fnUntraced(function* (kind: Kind, text: string) {
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text,
      synthetic: true,
      metadata: { [REMINDER_KEY]: kind },
    } satisfies SessionV1.TextPart)
    userMessage.parts.push(part)
  })

  const current = latest(userMessage)
  const child = !!input.session.parentID

  if (mode !== "plan") {
    if (current === "build-switch") return input.messages
    // A subagent resumed after the plan was approved gets no plan pointer: implementing the plan is its parent's job.
    const exists = !child && (yield* fsys.existsSafe(plan))
    yield* persist(
      "build-switch",
      exists ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. Implement it.` : BUILD_SWITCH,
    )
    return input.messages
  }

  // The full reminder is persisted once, on the first planning turn of a root session. It already sits in the
  // user message on later steps of that turn; later turns get the short reminder in memory only, and so does a turn
  // that switched back to plan after a build-switch reminder.
  if (current === "plan-mode") return input.messages
  if (current === undefined && !prevPlan && !child) {
    const exists = yield* fsys.existsSafe(plan)
    if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
    yield* persist(
      "plan-mode",
      fill(PLAN_MODE, {
        planInfo: exists
          ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
          : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
        exitInfo,
      }),
    )
    return input.messages
  }

  userMessage.parts.push({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    // Subagents cannot edit, ask the user or call plan_exit, so they get their own read-only reminder.
    text: child ? PLAN_SUBAGENT : fill(PROMPT_PLAN, { planPath: plan, exitInfo }),
    synthetic: true,
  })
  return input.messages
})

export * as SessionReminders from "./reminders"
