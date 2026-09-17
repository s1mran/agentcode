import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionTools } from "@/session/tools"
import { Permission } from "../../src/permission"
import { TestConfig } from "../fixture/config"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Agent.node))

const withSessions = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Agent.node,
      Permission.node,
      Session.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [Config.node, TestConfig.layer()],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

function testAgent(input: {
  name: string
  mode: Agent.Info["mode"]
  permission: Parameters<typeof Permission.fromConfig>[0]
}) {
  return {
    name: input.name,
    mode: input.mode,
    permission: Permission.fromConfig(input.permission),
    options: {},
  } satisfies Agent.Info
}

// `deriveSubagentSessionPermission` is imported from production. The test
// exercises the actual helper that task.ts uses to build the subagent's
// session permission, so any regression in that helper trips this test.

it.instance("subagent permissions take precedence over parent agent restrictions", () =>
  Effect.gen(function* () {
    const planAgent = yield* Agent.use.get("plan")
    const generalAgent = yield* Agent.use.get("general")

    expect(planAgent).toBeDefined()
    expect(generalAgent).toBeDefined()
    // Sanity: the plan agent itself blocks edit. (Note: `write` and
    // `apply_patch` route through the `edit` permission at the runtime
    // tool layer — see Permission.disabled / EDIT_TOOLS.)
    expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")

    const parentSessionPermission: PermissionV1.Ruleset = []

    const subagentSessionPermission = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent: generalAgent!,
    })

    // Mirror the runtime evaluation in session/prompt.ts (~line 410, 639):
    //   ruleset: Permission.merge(agent.permission, session.permission ?? [])
    const effective = Permission.merge(generalAgent!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/some/file.ts", effective).action).not.toBe("deny")
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
  }),
)

it.instance("subagent's own read-only restriction remains effective", () =>
  Effect.gen(function* () {
    const explore = yield* Agent.use.get("explore")
    expect(explore).toBeDefined()

    const parentSessionPermission: PermissionV1.Ruleset = []
    const subagentSessionPermission = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent: explore!,
    })
    const effective = Permission.merge(explore!.permission, subagentSessionPermission)

    expect(Permission.evaluate("edit", "/x.ts", effective).action).toBe("deny")
  }),
)

it.instance(
  "custom subagent can explicitly enable edits denied to its parent agent",
  () =>
    Effect.gen(function* () {
      const planAgent = yield* Agent.use.get("plan")
      const my = yield* Agent.use.get("my_subagent")
      expect(planAgent).toBeDefined()
      expect(my).toBeDefined()

      const parentSessionPermission: PermissionV1.Ruleset = []
      const subagentSessionPermission = deriveSubagentSessionPermission({
        parentSessionPermission,
        subagent: my!,
      })
      const effective = Permission.merge(my!.permission, subagentSessionPermission)

      expect(Permission.evaluate("edit", "/some/file.ts", planAgent!.permission).action).toBe("deny")
      expect(Permission.evaluate("edit", "/some/file.ts", effective).action).toBe("allow")
      expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
    }),
  {
    config: {
      agent: {
        my_subagent: {
          description: "A user-defined subagent",
          mode: "subagent",
          permission: {
            edit: "allow",
          },
        },
      },
    },
  },
)

it.effect("subagent self permissions are preserved", () =>
  Effect.sync(() => {
    // A tool-level deny is an explicit deny that no specific allow can refine, so the task allowlist relies on the
    // catch-all deny for every other subagent.
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        "*": "deny",
        read: "allow",
        bash: "allow",
        task: {
          worker: "allow",
        },
        edit: "allow",
      },
    })

    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: [],
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("read", "README.md", effective).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "worker", effective).action).toBe("allow")
    expect(Permission.evaluate("task", "other", effective).action).toBe("deny")
    expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(new Set())
  }),
)

it.effect("subagent inherits parent session deny rules as hard runtime ceilings", () =>
  Effect.sync(() => {
    const executor = testAgent({
      name: "executor",
      mode: "subagent",
      permission: {
        bash: "allow",
      },
    })
    const effective = Permission.merge(
      executor.permission,
      deriveSubagentSessionPermission({
        parentSessionPermission: Permission.fromConfig({ bash: "deny" }),
        subagent: executor,
      }),
    )

    expect(Permission.evaluate("bash", "git status", effective).action).toBe("deny")
  }),
)

it.instance("plan mode rules offer plan_exit to any primary agent but never override an explicit deny", () =>
  Effect.gen(function* () {
    const build = yield* Agent.use.get("build")
    expect(build).toBeDefined()
    const planRoot = SessionTools.modeRules({ mode: "plan", child: false })

    // The build agent's own defaults deny plan_exit; plan mode on a root session makes it visible.
    expect(Permission.disabled(["plan_exit"], build!.permission)).toEqual(new Set(["plan_exit"]))
    expect(Permission.disabled(["plan_exit", "question"], Permission.merge(build!.permission, planRoot))).toEqual(
      new Set(),
    )
    // Non-interactive runs deny plan_exit and question on the session; that deny still wins in plan mode.
    const denied = Permission.merge(build!.permission, [
      { permission: "plan_exit", pattern: "*", action: "deny" },
      { permission: "question", pattern: "*", action: "deny" },
      ...planRoot,
    ])
    expect(Permission.disabled(["plan_exit", "question"], denied)).toEqual(new Set(["plan_exit", "question"]))
    // Other modes add nothing.
    for (const mode of ["default", "acceptEdits", "bypassPermissions", "dontAsk"] as const) {
      expect(SessionTools.modeRules({ mode, child: false })).toEqual([])
      expect(SessionTools.modeRules({ mode, child: true })).toEqual([])
    }
  }),
)

withSessions.instance(
  "a subagent session whose parent is in plan mode cannot edit",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const sessions = yield* Session.Service
      const permission = yield* Permission.Service
      const general = yield* Agent.use.get("general")
      expect(general).toBeDefined()

      const parent = yield* sessions.create({ title: "parent" })
      yield* permission.setMode(parent.id, "plan")
      const child = yield* sessions.create({
        parentID: parent.id,
        title: "child",
        permission: deriveSubagentSessionPermission({ parentSessionPermission: [], subagent: general! }),
      })

      // The mode is inherited through the parent chain, and SessionTools adds the subagent edit deny for it.
      const mode = yield* permission.mode(child.id, general!.name)
      expect(mode).toBe("plan")
      const effective = Permission.merge(general!.permission, [
        ...(child.permission ?? []),
        ...SessionTools.modeRules({ mode, child: true }),
      ])
      expect(Permission.disabled(["edit", "write", "apply_patch"], effective)).toEqual(
        new Set(["edit", "write", "apply_patch"]),
      )
      // Outside plan mode the same subagent keeps its edit tools.
      expect(
        Permission.disabled(
          ["edit", "write", "apply_patch"],
          Permission.merge(general!.permission, [
            ...(child.permission ?? []),
            ...SessionTools.modeRules({ mode: "default", child: true }),
          ]),
        ),
      ).toEqual(new Set())

      // Even the root session's plan file, which the plan-mode root may edit, is denied to the subagent.
      const instance = yield* InstanceState.context
      const planFile = Session.plan(parent, instance)
      for (const file of [path.join(directory, "src", "a.ts"), planFile]) {
        const exit = yield* permission
          .ask({
            sessionID: child.id,
            permission: "edit",
            patterns: [path.relative(instance.worktree, file)],
            always: ["*"],
            metadata: { filepath: file },
            ruleset: effective,
          })
          .pipe(
            Effect.timeoutOrElse({
              duration: "2 seconds",
              orElse: () => Effect.die(new Error("expected the edit to be denied without prompting")),
            }),
            Effect.exit,
          )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.DeniedError)
      }
    }),
  { git: true },
)
