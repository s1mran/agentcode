import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { InstanceState } from "@/effect/instance-state"
import { MessageID, PartID, type SessionID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

export const Parameters = Schema.Struct({})

/** Longest plan text copied into tool metadata and into the implementation handoff message. */
export const PLAN_TEXT_LIMIT = 20_000

export const Choice = {
  bypass: "Yes, and bypass permissions",
  acceptEdits: "Yes, and accept edits",
  manual: "Yes, manually approve edits",
  keepPlanning: "No, keep planning",
} as const

type Metadata = {
  planPath?: string
  plan?: string
  approved?: boolean
  mode?: Permission.Mode
  /** The agent that implements an approved plan. */
  agent?: string
  feedback?: string
}

/** A session title taken from a plan: its first `# ` heading, otherwise its first non-empty line. */
export function planTitle(plan: string) {
  const lines = plan.split(/\r?\n/)
  const line = lines.find((item) => item.startsWith("# ")) ?? lines.find((item) => item.trim() !== "")
  return (line ?? "")
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 80)
}

export const PlanExitTool = Tool.define<
  typeof Parameters,
  Metadata,
  Session.Service | Question.Service | Provider.Service | Agent.Service | Permission.Service | FSUtil.Service
>(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service
    const permission = yield* Permission.Service
    const fsys = yield* FSUtil.Service

    const rootOf = Effect.fnUntraced(function* (sessionID: SessionID) {
      let info = yield* session.get(sessionID)
      const seen = new Set<string>([info.id])
      while (info.parentID && !seen.has(info.parentID)) {
        seen.add(info.parentID)
        info = yield* session.get(info.parentID)
      }
      return info
    })

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const root = yield* rootOf(ctx.sessionID)
          const planPath = Session.plan(root, instance)
          // Relative to the working directory so the read, write and edit tools resolve it; absolute otherwise.
          const rel = FSUtil.contains(instance.directory, planPath)
            ? path.relative(instance.directory, planPath)
            : planPath
          const plan = yield* fsys.readFileStringSafe(planPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (plan === undefined || plan.trim() === "")
            return yield* Effect.fail(new Error(`No plan found at ${rel}. Write the plan there, then call plan_exit.`))
          if ((yield* permission.mode(ctx.sessionID, ctx.agent)) !== "plan")
            return yield* Effect.fail(new Error("plan_exit is only available in plan mode"))

          // The mode before plan is kept in memory; after a restart it is read back from the last turn outside plan.
          const prev =
            (yield* permission.prePlan(root.id)) ??
            (yield* session.messages({ sessionID: root.id }))
              .flatMap((item) => (item.info.role === "assistant" ? [item.info.permissionMode] : []))
              .findLast((mode) => mode !== undefined && mode !== "plan")
          yield* ctx.metadata({ metadata: { planPath: rel, plan: plan.slice(0, PLAN_TEXT_LIMIT) } })

          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                header: "Plan ready",
                question: `Plan at ${rel} is ready. How do you want to proceed?`,
                custom: true,
                multiple: false,
                options: [
                  ...(prev === "bypassPermissions"
                    ? [
                        {
                          label: Choice.bypass,
                          description: "Implement without asking; protected paths and critical deletes still ask",
                        },
                      ]
                    : []),
                  {
                    label: Choice.acceptEdits,
                    description: "Implement; edits in the project are approved, commands still ask",
                  },
                  { label: Choice.manual, description: "Implement; every edit and command asks" },
                  { label: Choice.keepPlanning, description: "Stay in plan mode; type what to change" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const answer = answers[0]?.[0]
          if (answer === undefined || answer.trim() === "" || answer === Choice.keepPlanning)
            return yield* new Question.RejectedError()

          const next: Permission.Mode | undefined =
            answer === Choice.acceptEdits
              ? "acceptEdits"
              : answer === Choice.manual
                ? "default"
                : answer === Choice.bypass && prev === "bypassPermissions"
                  ? "bypassPermissions"
                  : undefined

          // Anything other than an offered approval label is feedback, and planning continues.
          if (!next) {
            return {
              title: "Keep planning",
              output: `The user did not approve the plan and gave this feedback:\n${answer}\nStay in plan mode, revise ${rel}, then call plan_exit again.`,
              metadata: { approved: false, planPath: rel, feedback: answer },
            }
          }

          const applied = yield* permission.setMode(root.id, next).pipe(
            Effect.as({ mode: next, note: "" }),
            Effect.catchTag("PermissionModeError", (error) =>
              permission.setMode(root.id, "default").pipe(
                Effect.as({
                  mode: "default" as Permission.Mode,
                  note: ` ${next} could not be enabled (${error.reason}), so the default mode is used instead.`,
                }),
              ),
            ),
          )

          const messages = yield* session.messages({ sessionID: root.id })
          const last = messages.findLast((item) => item.info.role === "user")?.info
          const lastUser = last?.role === "user" ? last : undefined
          const targetName =
            lastUser && lastUser.agent !== "plan"
              ? lastUser.agent
              : yield* agents.defaultAgent().pipe(Effect.map((name) => (name === "plan" ? "build" : name)))
          const target: Agent.Info | undefined = yield* agents.get(targetName)
          // Staying on the agent the user prompted keeps the model the user picked; a switch from the plan agent takes
          // the target agent's configured model.
          const switched = !lastUser || lastUser.agent !== targetName
          const base = (switched ? target?.model : undefined) ?? lastUser?.model ?? (yield* provider.defaultModel())
          // A variant belongs to its model: keep the last user's variant only when that model is reused.
          const variant = switched
            ? target?.model
              ? target.variant
              : (target?.variant ?? lastUser?.model.variant)
            : lastUser?.model.variant

          const body =
            plan.length > PLAN_TEXT_LIMIT
              ? `${plan.slice(0, PLAN_TEXT_LIMIT)}\n\n(truncated; read ${rel} for the rest)`
              : plan
          const msg: SessionV1.User = {
            id: MessageID.ascending(),
            sessionID: root.id,
            role: "user",
            time: { created: Date.now() },
            agent: targetName,
            model: {
              providerID: base.providerID,
              modelID: base.modelID,
              ...(variant ? { variant } : {}),
            },
          }
          yield* session.updateMessage(msg)
          // The session's agent is what background task results and clients resume with; it must not stay on plan.
          yield* session.setAgentModel({
            sessionID: root.id,
            agent: targetName,
            model: { id: base.modelID, providerID: base.providerID, variant: variant ?? "default" },
            time: msg.time.created,
          })
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: root.id,
            type: "text",
            text: `The user approved the plan at ${rel} (permission mode: ${applied.mode}). Implement it now.\n\n${body}`,
            synthetic: true,
          } satisfies SessionV1.TextPart)

          const title = planTitle(plan)
          if (title && Session.isDefaultTitle((yield* session.get(root.id)).title))
            yield* session.setTitle({ sessionID: root.id, title })

          return {
            title: "Plan approved",
            output: `Plan approved. The ${targetName} agent will implement it in ${applied.mode} mode; end this turn now.${applied.note}`,
            metadata: { approved: true, mode: applied.mode, agent: targetName, planPath: rel },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
