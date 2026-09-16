import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import { mkdir, symlink } from "fs/promises"
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

import { Instruction } from "../../src/session/instruction"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Global } from "@opencode-ai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Config } from "@/config/config"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../../src/permission"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const instructionLayer = (
  global: Partial<Global.Interface>,
  flags: Partial<RuntimeFlags.Info> = {},
  config: Partial<Config.Interface> = {},
) =>
  AppNodeBuilder.build(LayerNode.group([Instruction.node, Permission.node]), [
    [Config.node, Layer.succeed(Config.Service, TestConfig.make(config))],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>, config?: Partial<Config.Interface>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags, config)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const withFiles = <A, E, R>(files: Record<string, string>, self: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      yield* writeFiles(dir, files)
      return yield* self(dir).pipe(provideInstruction({ home: dir, config: dir }))
    }),
  )

const tmpWithFiles = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    yield* writeFiles(dir, files)
    return dir
  })

const header = "Instructions from: "

// Source files of system rules inside the given fixture directories; the walk also checks every directory above them.
const sources = (rules: string[], ...dirs: string[]) =>
  rules
    .map((rule) => rule.slice(header.length).split("\n")[0])
    .filter((item) => dirs.some((dir) => item.startsWith(dir + path.sep)))

const ruleFor = (rules: string[], filepath: string) => rules.find((rule) => rule.startsWith(`${header}${filepath}\n`))

// Separate global and project directories, so project .claude/CLAUDE.md is never also ~/.claude/CLAUDE.md.
const withProject = <A, E, R>(
  input: {
    global?: Record<string, string>
    project: Record<string, string>
    cwd?: string
    config?: (dirs: { global: string; project: string }) => Partial<Config.Interface>
  },
  self: (dirs: { global: string; project: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const globalTmp = yield* tmpWithFiles(input.global ?? {})
    const projectTmp = yield* tmpWithFiles(input.project)
    const dirs = { global: globalTmp, project: projectTmp }
    return yield* self(dirs).pipe(
      provideInstance(input.cwd ? path.join(projectTmp, input.cwd) : projectTmp),
      provideInstruction({ home: globalTmp, config: globalTmp }, {}, input.config?.(dirs)),
    )
  })

const sessionA = SessionID.make("ses_import-a")
const sessionB = SessionID.make("ses_import-b")

// Rules like the build agent's: files inside the project load, while files outside it and .env files ask first.
const build = Permission.fromConfig({ external_directory: "ask", read: { "*": "allow", "*.env": "ask" } })

const asker = (
  prompt?: Instruction.Ask["prompt"],
  input: { sessionID?: SessionID; ruleset?: PermissionV1.Ruleset } = {},
): Instruction.Ask => ({
  sessionID: input.sessionID ?? sessionA,
  ruleset: Effect.succeed(input.ruleset ?? build),
  prompt,
})

// Allows every import: the rules allow files inside the project, and the prompt allows the rest.
const allow = asker(() => Effect.succeed(true))

const counter = (answer: boolean | undefined, input?: { sessionID?: SessionID; ruleset?: PermissionV1.Ruleset }) => {
  const calls: string[] = []
  const ask = asker(
    (filepath) =>
      Effect.sync(() => {
        calls.push(filepath)
        return answer
      }),
    input,
  )
  return { calls, ask }
}

function loaded(filepath: string): SessionV1.WithParts[] {
  const sessionID = SessionID.make("session-loaded-1")
  const messageID = MessageID.make("msg_message-loaded-1")

  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("anthropic"),
          modelID: ModelV2.ID.make("claude-sonnet-4-20250514"),
        },
      },
      parts: [
        {
          id: PartID.make("prt_part-loaded-1"),
          messageID,
          sessionID,
          type: "tool",
          callID: "call-loaded-1",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: "Read",
            metadata: { loaded: [filepath] },
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

describe("Instruction.resolve", () => {
  it.live("returns empty when AGENTS.md is at project root (already in systemPaths)", () =>
    withFiles({ "AGENTS.md": "# Root Instructions", "src/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "AGENTS.md"))).toBe(true)

        const results = yield* svc.resolve([], path.join(dir, "src", "file.ts"), MessageID.make("msg_message-test-1"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("returns AGENTS.md from subdirectory (not in systemPaths)", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const system = yield* svc.systemPaths()
        expect(system.has(path.join(dir, "subdir", "AGENTS.md"))).toBe(false)

        const results = yield* svc.resolve(
          [],
          path.join(dir, "subdir", "nested", "file.ts"),
          MessageID.make("msg_message-test-2"),
        )
        expect(results.length).toBe(1)
        expect(results[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("doesn't reload AGENTS.md when reading it directly", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "AGENTS.md")
        const system = yield* svc.systemPaths()
        expect(system.has(filepath)).toBe(false)

        const results = yield* svc.resolve([], filepath, MessageID.make("msg_message-test-3"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("does not reattach the same nearby instructions twice for one message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-1")

        const first = yield* svc.resolve([], filepath, id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(first[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
        expect(second).toEqual([])
      }),
    ),
  )

  it.live("clear allows nearby instructions to be attached again for the same message", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-2")

        const first = yield* svc.resolve([], filepath, id)
        yield* svc.clear(id)
        const second = yield* svc.resolve([], filepath, id)

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(second[0].filepath).toBe(path.join(dir, "subdir", "AGENTS.md"))
      }),
    ),
  )

  it.live("skips instructions already reported by prior read metadata", () =>
    withFiles({ "subdir/AGENTS.md": "# Subdir Instructions", "subdir/nested/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const agents = path.join(dir, "subdir", "AGENTS.md")
        const filepath = path.join(dir, "subdir", "nested", "file.ts")
        const id = MessageID.make("msg_message-claim-3")

        const results = yield* svc.resolve(loaded(agents), filepath, id)
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("attaches CLAUDE.md and CLAUDE.local.md next to AGENTS.md", () =>
    withFiles(
      {
        "subdir/AGENTS.md": "# Subdir Agents",
        "subdir/CLAUDE.md": "# Subdir Claude",
        "subdir/CLAUDE.local.md": "# Subdir Local",
        "subdir/nested/file.ts": "const x = 1",
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const results = yield* svc.resolve(
            [],
            path.join(dir, "subdir", "nested", "file.ts"),
            MessageID.make("msg_message-claude-1"),
          )
          expect(results.map((item) => item.filepath)).toEqual([
            path.join(dir, "subdir", "AGENTS.md"),
            path.join(dir, "subdir", "CLAUDE.md"),
            path.join(dir, "subdir", "CLAUDE.local.md"),
          ])
        }),
    ),
  )

  it.live("orders nested instructions outermost first", () =>
    withFiles({ "a/CLAUDE.md": "# A", "a/b/CLAUDE.md": "# B", "a/b/file.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const results = yield* svc.resolve(
          [],
          path.join(dir, "a", "b", "file.ts"),
          MessageID.make("msg_message-order-1"),
        )
        expect(results.map((item) => item.filepath)).toEqual([
          path.join(dir, "a", "CLAUDE.md"),
          path.join(dir, "a", "b", "CLAUDE.md"),
        ])
      }),
    ),
  )

  it.live("expands imports in nested files and claims them", () =>
    withFiles({ "sub/CLAUDE.md": "@notes.md", "sub/notes.md": "n", "sub/x.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dir, "sub", "x.ts")
        const id = MessageID.make("msg_message-import-1")

        const first = yield* svc.resolve([], filepath, id, allow)
        expect(first.map((item) => item.filepath)).toEqual([
          path.join(dir, "sub", "notes.md"),
          path.join(dir, "sub", "CLAUDE.md"),
        ])
        expect(first[0].content).toBe(`Instructions from: ${path.join(dir, "sub", "notes.md")}\nn`)
        expect(yield* svc.resolve([], filepath, id, allow)).toEqual([])
      }),
    ),
  )

  it.live("does not reattach a nested file already imported at system level", () =>
    withFiles({ "CLAUDE.md": "@sub/CLAUDE.md", "sub/CLAUDE.md": "s", "sub/x.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        yield* svc.system(allow)
        const results = yield* svc.resolve([], path.join(dir, "sub", "x.ts"), MessageID.make("msg_message-import-2"))
        expect(results).toEqual([])
      }),
    ),
  )

  it.live("attaches each file once across parallel reads in one message", () =>
    withFiles(
      {
        "sub/CLAUDE.md": "@notes.md\nsub",
        "sub/notes.md": "n",
        "sub/a.ts": "a",
        "sub/b.ts": "b",
        "s1/CLAUDE.md": "@../shared.md",
        "s2/CLAUDE.md": "@../shared.md",
        "shared.md": "shared",
        "s1/x.ts": "x",
        "s2/y.ts": "y",
      },
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const read = (id: string, ...files: string[]) =>
            Effect.all(
              files.map((file) => svc.resolve([], path.join(dir, file), MessageID.make(id), allow)),
              { concurrency: "unbounded" },
            ).pipe(
              Effect.map((all) =>
                all
                  .flat()
                  .map((item) => item.filepath)
                  .sort(),
              ),
            )

          expect(yield* read("msg_message-race-1", "sub/a.ts", "sub/b.ts")).toEqual(
            [path.join(dir, "sub", "CLAUDE.md"), path.join(dir, "sub", "notes.md")].sort(),
          )
          const shared = yield* read("msg_message-race-2", "s1/x.ts", "s2/y.ts")
          expect(shared.filter((item) => item === path.join(dir, "shared.md"))).toHaveLength(1)
        }),
    ),
  )

  it.live("gives claims back when resolve fails", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      yield* withFiles({ "sub/CLAUDE.md": `@${path.join(external, "notes.md")}\nsub`, "sub/x.ts": "x" }, (dir) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const filepath = path.join(dir, "sub", "x.ts")
          const id = MessageID.make("msg_message-release-1")
          const feedback = asker(() => Effect.die(new PermissionV1.CorrectedError({ feedback: "no" })))
          expect(Exit.isFailure(yield* svc.resolve([], filepath, id, feedback).pipe(Effect.exit))).toBe(true)
          const results = yield* svc.resolve([], filepath, id, feedback)
          expect(results.map((item) => item.filepath)).toEqual([path.join(dir, "sub", "CLAUDE.md")])
        }),
      )
    }),
  )

  test.todo("fetches remote instructions from config URLs via HttpClient", () => {})
})

describe("Instruction.system", () => {
  it.live("loads both project and global AGENTS.md when both exist", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(projectTmp, "AGENTS.md"))).toBe(true)
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)

        const rules = yield* svc.system()
        expect(rules).toHaveLength(2)
        expect(rules[0]).toBe(`Instructions from: ${path.join(globalTmp, "AGENTS.md")}\n# Global Instructions`)
        expect(rules[1]).toBe(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}\n# Project Instructions`)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )

  it.live("skips project and global CLAUDE.md when Claude Code prompt is disabled", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ ".claude/CLAUDE.md": "# Global Claude" })
      const projectTmp = yield* tmpWithFiles({
        "CLAUDE.md": "# Project Claude",
        "CLAUDE.local.md": "# Project Local",
        ".claude/CLAUDE.md": "# Project Dot Claude",
      })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, "CLAUDE.local.md"))).toBe(false)
        expect(paths.has(path.join(projectTmp, ".claude", "CLAUDE.md"))).toBe(false)
        expect(yield* svc.system()).toEqual([])
      }).pipe(
        provideInstance(projectTmp),
        provideInstruction({ home: globalTmp, config: globalTmp }, { disableClaudeCodePrompt: true }),
      )
    }),
  )

  it.live("loads CLAUDE.md and AGENTS.md from the same directory", () =>
    withProject({ project: { "AGENTS.md": "agents", "CLAUDE.md": "claude" } }, (dirs) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rules = yield* svc.system()
        expect(sources(rules, dirs.project)).toEqual([
          path.join(dirs.project, "AGENTS.md"),
          path.join(dirs.project, "CLAUDE.md"),
        ])
        expect(ruleFor(rules, path.join(dirs.project, "AGENTS.md"))).toBe(
          `${header}${path.join(dirs.project, "AGENTS.md")}\nagents`,
        )
        expect(ruleFor(rules, path.join(dirs.project, "CLAUDE.md"))).toBe(
          `${header}${path.join(dirs.project, "CLAUDE.md")}\nclaude`,
        )
      }),
    ),
  )

  it.live("orders ancestors root-first with CLAUDE.local.md after CLAUDE.md", () =>
    withProject(
      {
        project: {
          "CLAUDE.md": "root",
          "CLAUDE.local.md": "root local",
          "packages/app/AGENTS.md": "app agents",
          "packages/app/CLAUDE.md": "app",
        },
        cwd: path.join("packages", "app"),
      },
      (dirs) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const app = path.join(dirs.project, "packages", "app")
          expect(sources(yield* svc.system(), dirs.project)).toEqual([
            path.join(dirs.project, "CLAUDE.md"),
            path.join(dirs.project, "CLAUDE.local.md"),
            path.join(app, "AGENTS.md"),
            path.join(app, "CLAUDE.md"),
          ])
        }),
    ),
  )

  it.live("recognises .claude/CLAUDE.md", () =>
    withProject({ project: { ".claude/CLAUDE.md": "dot" } }, (dirs) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const filepath = path.join(dirs.project, ".claude", "CLAUDE.md")
        const rules = yield* svc.system()
        expect(sources(rules, dirs.project)).toEqual([filepath])
        expect(ruleFor(rules, filepath)).toBe(`${header}${filepath}\ndot`)
      }),
    ),
  )

  it.live("loads ~/.claude/CLAUDE.md alongside the global AGENTS.md", () =>
    withProject({ global: { "AGENTS.md": "g", ".claude/CLAUDE.md": "gc" }, project: {} }, (dirs) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        expect(sources(yield* svc.system(), dirs.global)).toEqual([
          path.join(dirs.global, "AGENTS.md"),
          path.join(dirs.global, ".claude", "CLAUDE.md"),
        ])
      }),
    ),
  )

  it.live("expands a relative import before the importing file", () =>
    withProject({ project: { "CLAUDE.md": "@docs/guide.md\nroot", "docs/guide.md": "guide" } }, (dirs) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const guide = path.join(dirs.project, "docs", "guide.md")
        const claude = path.join(dirs.project, "CLAUDE.md")
        const rules = yield* svc.system(allow)
        expect(sources(rules, dirs.project)).toEqual([guide, claude])
        expect(ruleFor(rules, guide)).toBe(`${header}${guide}\nguide`)
        expect(ruleFor(rules, claude)).toBe(`${header}${claude}\n@docs/guide.md\nroot`)
      }),
    ),
  )

  it.live("resolves nested imports relative to the importing file", () =>
    withProject(
      { project: { "CLAUDE.md": "@docs/a.md", "docs/a.md": "@b.md", "docs/b.md": "b", "b.md": "WRONG" } },
      (dirs) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const rules = yield* svc.system(allow)
          expect(sources(rules, dirs.project)).toEqual([
            path.join(dirs.project, "docs", "b.md"),
            path.join(dirs.project, "docs", "a.md"),
            path.join(dirs.project, "CLAUDE.md"),
          ])
          expect(rules.some((rule) => rule.includes("WRONG"))).toBe(false)
        }),
    ),
  )

  it.live("stops following imports after four hops", () =>
    withProject(
      {
        project: {
          "CLAUDE.md": "@h1.md",
          "h1.md": "@h2.md",
          "h2.md": "@h3.md",
          "h3.md": "@h4.md",
          "h4.md": "@h5.md",
          "h5.md": "h5",
        },
      },
      (dirs) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          expect(sources(yield* svc.system(allow), dirs.project)).toEqual([
            path.join(dirs.project, "h4.md"),
            path.join(dirs.project, "h3.md"),
            path.join(dirs.project, "h2.md"),
            path.join(dirs.project, "h1.md"),
            path.join(dirs.project, "CLAUDE.md"),
          ])
        }),
    ),
  )

  it.live("survives import cycles", () =>
    withProject({ project: { "CLAUDE.md": "@a.md\nroot", "a.md": "@CLAUDE.md\na" } }, (dirs) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        expect(sources(yield* svc.system(allow), dirs.project)).toEqual([
          path.join(dirs.project, "a.md"),
          path.join(dirs.project, "CLAUDE.md"),
        ])
      }),
    ),
  )

  it.live("skips imports inside code fences and code spans", () =>
    withProject(
      {
        project: {
          "CLAUDE.md": "```\n@fenced.md\n```\n`@span.md`\n@real.md",
          "fenced.md": "fenced",
          "span.md": "span",
          "real.md": "real",
        },
      },
      (dirs) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          expect(sources(yield* svc.system(allow), dirs.project)).toEqual([
            path.join(dirs.project, "real.md"),
            path.join(dirs.project, "CLAUDE.md"),
          ])
        }),
    ),
  )

  it.live("@AGENTS.md bridge does not duplicate AGENTS.md", () =>
    withProject({ project: { "AGENTS.md": "agents", "CLAUDE.md": "@AGENTS.md\nclaude" } }, (dirs) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        expect(sources(yield* svc.system(), dirs.project)).toEqual([
          path.join(dirs.project, "AGENTS.md"),
          path.join(dirs.project, "CLAUDE.md"),
        ])
      }),
    ),
  )

  it.live("gates external imports from project files", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      const imported = path.join(external, "notes.md")
      const project = { "CLAUDE.md": `@${imported}\nproject` }

      yield* withProject({ project }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          expect(sources(yield* svc.system(), external)).toEqual([])

          const allow = counter(true)
          expect(sources(yield* svc.system(allow.ask), external)).toEqual([imported])
          expect(sources(yield* svc.system(allow.ask), external)).toEqual([imported])
          expect(allow.calls).toEqual([imported])
          // A caller that can't prompt, like a read of a file the user attached, still follows the answer.
          expect(sources(yield* svc.system(asker()), external)).toEqual([imported])
        }),
      )

      yield* withProject({ project }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const reject = counter(false)
          expect(sources(yield* svc.system(reject.ask), external)).toEqual([])
          expect(sources(yield* svc.system(reject.ask), external)).toEqual([])
          expect(reject.calls).toEqual([imported])
        }),
      )
    }),
  )

  it.live("remembers import decisions for the whole instance, including rejections", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      const imported = path.join(external, "notes.md")

      yield* withProject({ project: { "CLAUDE.md": `@${imported}\nproject` } }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const reject = counter(false)
          expect(sources(yield* svc.system(reject.ask), external)).toEqual([])
          // A new session, a subagent or another agent is not asked again.
          const later = counter(true, { sessionID: sessionB })
          expect(sources(yield* svc.system(later.ask), external)).toEqual([])
          expect(later.calls).toEqual([])
          expect(reject.calls).toEqual([imported])
        }),
      )
    }),
  )

  it.live("does not remember an import the asking agent's rules deny", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      const imported = path.join(external, "notes.md")

      yield* withProject({ project: { "CLAUDE.md": `@${imported}\nproject` } }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const denied = counter(true, { ruleset: Permission.fromConfig({ external_directory: "deny" }) })
          expect(sources(yield* svc.system(denied.ask), external)).toEqual([])
          const other = counter(true)
          expect(sources(yield* svc.system(other.ask), external)).toEqual([imported])
          expect(denied.calls).toEqual([])
          expect(other.calls).toEqual([imported])
        }),
      )
    }),
  )

  it.live("checks each agent's own rules before remembered answers, and remembers only answers", () =>
    withProject({ project: { "CLAUDE.md": "@.env\nproject", ".env": "ENVSECRET" } }, () =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const secret = (rules: string[]) => rules.some((rule) => rule.includes("ENVSECRET"))

        // Like the explore subagent, whose read: allow covers .env: it loads without a prompt, and that is no answer.
        const explore = counter(false, { ruleset: Permission.fromConfig({ external_directory: "ask", read: "allow" }) })
        expect(secret(yield* svc.system(explore.ask))).toBe(true)
        expect(explore.calls).toEqual([])

        // The build agent's rules ask about .env, so it still prompts and a reject keeps the secret out.
        const reject = counter(false, { sessionID: sessionB })
        expect(secret(yield* svc.system(reject.ask))).toBe(false)
        expect(reject.calls).toHaveLength(1)

        // Rules that allow still load after that reject, and rules that deny never do.
        expect(secret(yield* svc.system(explore.ask))).toBe(true)
        const denied = counter(true, { ruleset: Permission.fromConfig({ read: { "*": "allow", "*.env": "deny" } }) })
        expect(secret(yield* svc.system(denied.ask))).toBe(false)
        expect(denied.calls).toEqual([])
      }),
    ),
  )

  it.live("a remembered allow does not override an agent whose rules deny the import", () =>
    withProject({ project: { "CLAUDE.md": "@.env\nproject", ".env": "ENVSECRET" } }, () =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const secret = (rules: string[]) => rules.some((rule) => rule.includes("ENVSECRET"))
        const approve = counter(true)
        expect(secret(yield* svc.system(approve.ask))).toBe(true)
        expect(approve.calls).toHaveLength(1)

        const denied = counter(true, { ruleset: Permission.fromConfig({ read: { "*": "allow", "*.env": "deny" } }) })
        expect(secret(yield* svc.system(denied.ask))).toBe(false)
        // Another session with the same rules follows the answer without asking again.
        const later = counter(false, { sessionID: sessionB })
        expect(secret(yield* svc.system(later.ask))).toBe(true)
        expect(later.calls).toEqual([])
      }),
    ),
  )

  it.live("an always answer lifts a remembered reject", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      const imported = path.join(external, "notes.md")

      yield* withProject({ project: { "CLAUDE.md": `@${imported}\nproject` } }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const permission = yield* Permission.Service
          const reject = counter(false)
          expect(sources(yield* svc.system(reject.ask), external)).toEqual([])

          // In another session the user answers "always" for the folder, as when a Read there asks.
          const folder = path.join(external, "*")
          const read = yield* permission
            .ask({
              sessionID: sessionB,
              permission: "external_directory",
              patterns: [folder],
              always: [folder],
              metadata: {},
              ruleset: [],
            })
            .pipe(Effect.forkChild)
          let pending = yield* permission.list()
          while (pending.length === 0) {
            yield* Effect.sleep("5 millis")
            pending = yield* permission.list()
          }
          yield* permission.reply({ requestID: pending[0].id, reply: "always" })
          yield* Fiber.join(read)

          const later = counter(false)
          expect(sources(yield* svc.system(later.ask), external)).toEqual([imported])
          expect(later.calls).toEqual([])
        }),
      )
    }),
  )

  it.live("asks once when parallel loads reach the same import", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      const imported = path.join(external, "notes.md")

      yield* withProject({ project: { "CLAUDE.md": `@${imported}\nproject` } }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const answer = yield* Deferred.make<boolean>()
          const calls: string[] = []
          const slow = asker((filepath) =>
            Effect.sync(() => calls.push(filepath)).pipe(Effect.andThen(Deferred.await(answer))),
          )
          const fiber = Effect.all([svc.system(slow), svc.system(slow)], { concurrency: "unbounded" })
          const [both] = yield* Effect.all(
            [fiber, Effect.sleep("20 millis").pipe(Effect.andThen(Deferred.succeed(answer, true)))],
            {
              concurrency: "unbounded",
            },
          )
          expect(both.map((rules) => sources(rules, external))).toEqual([[imported], [imported]])
          expect(calls).toEqual([imported])
        }),
      )
    }),
  )

  it.live("asks again after an interrupted prompt", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      const imported = path.join(external, "notes.md")

      yield* withProject({ project: { "CLAUDE.md": `@${imported}\nproject` } }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const hang = asker(() => Effect.never)
          expect(Exit.isFailure(yield* svc.system(hang).pipe(Effect.timeout("20 millis"), Effect.exit))).toBe(true)
          const later = counter(true)
          expect(sources(yield* svc.system(later.ask), external)).toEqual([imported])
          expect(later.calls).toEqual([imported])
        }),
      )
    }),
  )

  it.live("another session prompts for itself while a prompt is unanswered", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      const imported = path.join(external, "notes.md")

      yield* withProject({ project: { "CLAUDE.md": `@${imported}\nproject` } }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const shown = yield* Deferred.make<void>()
          const unanswered = asker(() => Deferred.succeed(shown, undefined).pipe(Effect.andThen(Effect.never)))
          const first = yield* svc.system(unanswered).pipe(Effect.forkChild)
          yield* Deferred.await(shown)

          const other = counter(true, { sessionID: sessionB })
          const rules = yield* svc.system(other.ask).pipe(Effect.timeout("2 seconds"))
          expect(sources(rules, external)).toEqual([imported])
          expect(other.calls).toEqual([imported])
          yield* Fiber.interrupt(first)
        }),
      )
    }),
  )

  it.live("an interrupt that lands as the prompt starts leaves nothing pending", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      const imported = path.join(external, "notes.md")

      yield* withProject({ project: { "CLAUDE.md": `@${imported}\nproject` } }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          // Interrupts the asking fiber before the prompt effect runs.
          const abort = asker(() => {
            Fiber.getCurrent()?.interruptUnsafe()
            return Effect.never
          })
          const exit = yield* svc.system(abort).pipe(Effect.forkChild, Effect.flatMap(Fiber.await))
          expect(Exit.hasInterrupts(exit)).toBe(true)

          const later = counter(true)
          const rules = yield* svc.system(later.ask).pipe(Effect.timeout("2 seconds"))
          expect(sources(rules, external)).toEqual([imported])
          expect(later.calls).toEqual([imported])
        }),
      )
    }),
  )

  it.live("checks in-project imports with the read rules, so .env asks first", () =>
    withProject(
      { project: { "CLAUDE.md": "@.env\n@docs/a.md\nproject", ".env": "ENVSECRET", "docs/a.md": "a" } },
      (dirs) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const asked: string[] = []
          const ctx = {
            ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
              Effect.sync(() => asked.push(`${req.permission} ${req.patterns.join(",")}`)).pipe(
                Effect.andThen(
                  req.patterns.some((item) => item.endsWith(".env"))
                    ? Effect.die(new PermissionV1.RejectedError())
                    : Effect.void,
                ),
              ),
          }
          const rules = yield* svc.system(asker((filepath) => Instruction.check(ctx, filepath)))
          expect(rules.some((rule) => rule.includes("ENVSECRET"))).toBe(false)
          expect(sources(rules, dirs.project)).toEqual([
            path.join(dirs.project, "docs", "a.md"),
            path.join(dirs.project, "CLAUDE.md"),
          ])
          // Only .env is left to the user; the rules allow docs/a.md without asking.
          expect(asked).toHaveLength(1)
          expect(asked[0]).toStartWith("read ")
          expect(asked[0]).toEndWith(".env")
        }),
    ),
  )

  it.live("trusts imports only from instructions entries in the global config", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      const imported = path.join(external, "notes.md")
      const team = path.join(external, "team.md")
      yield* write(team, `@${imported}\nteam`)
      const declared = { get: () => Effect.succeed({ instructions: [team] }) }

      yield* withProject({ project: {}, config: () => declared }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const spy = counter(false)
          const rules = yield* svc.system(spy.ask)
          expect(sources(rules, external)).toEqual([team])
          expect(spy.calls).toEqual([imported])
        }),
      )

      yield* withProject({ project: {}, config: () => ({ ...declared, getGlobal: declared.get }) }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const spy = counter(false)
          expect(sources(yield* svc.system(spy.ask), external)).toEqual([imported, team])
          expect(spy.calls).toEqual([])
        }),
      )
    }),
  )

  it.live("trusts instructions entries from OPENCODE_CONFIG_CONTENT and ~/.opencode, but not the project's", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      const imported = path.join(external, "notes.md")
      const team = path.join(external, "team.md")
      const home = path.join(external, "home.md")
      yield* write(team, `@${imported}\nteam`)
      yield* write(home, `@${imported}\nhome`)
      const declared = { get: () => Effect.succeed({ instructions: [team, home] }) }
      const content = (value: string | undefined) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.OPENCODE_CONFIG_CONTENT
            if (value === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
            else process.env.OPENCODE_CONFIG_CONTENT = value
            return previous
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
              else process.env.OPENCODE_CONFIG_CONTENT = previous
            }),
        )

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* content(JSON.stringify({ instructions: [team] }))
          yield* withProject(
            {
              global: { ".opencode/opencode.jsonc": `// user config\n{ "instructions": [${JSON.stringify(home)}] }` },
              project: { "opencode.json": JSON.stringify({ instructions: [team, home] }) },
              config: () => declared,
            },
            () =>
              Effect.gen(function* () {
                const svc = yield* Instruction.Service
                const spy = counter(false)
                expect(sources(yield* svc.system(spy.ask), external)).toEqual([imported, team, home])
                expect(spy.calls).toEqual([])
              }),
          )
        }),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* content(undefined)
          yield* withProject(
            { project: { "opencode.json": JSON.stringify({ instructions: [team, home] }) }, config: () => declared },
            () =>
              Effect.gen(function* () {
                const svc = yield* Instruction.Service
                const spy = counter(false)
                expect(sources(yield* svc.system(spy.ask), external)).toEqual([team, home])
                expect(spy.calls).toEqual([imported])
              }),
          )
        }),
      )
    }),
  )

  it.live("gates an import through an in-project symlink that points outside the project", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "secret.md": "TOP-SECRET-VALUE" })
      const secret = path.join(external, "secret.md")
      const link = (project: string) =>
        Effect.promise(async () => {
          await mkdir(path.join(project, "docs"), { recursive: true })
          await symlink(secret, path.join(project, "docs", "link.md"))
        })

      yield* withProject({ project: { "CLAUDE.md": "@docs/link.md\nproject" } }, (dirs) =>
        Effect.gen(function* () {
          yield* link(dirs.project)
          const svc = yield* Instruction.Service
          expect((yield* svc.system()).some((rule) => rule.includes("TOP-SECRET-VALUE"))).toBe(false)

          const reject = counter(false)
          expect((yield* svc.system(reject.ask)).some((rule) => rule.includes("TOP-SECRET-VALUE"))).toBe(false)
          expect(reject.calls).toEqual([secret])
        }),
      )

      yield* withProject({ project: { "CLAUDE.md": "@docs/link.md\nproject" } }, (dirs) =>
        Effect.gen(function* () {
          yield* link(dirs.project)
          const svc = yield* Instruction.Service
          const allow = counter(true)
          expect((yield* svc.system(allow.ask)).some((rule) => rule.includes("TOP-SECRET-VALUE"))).toBe(true)
          expect(allow.calls).toEqual([secret])
        }),
      )
    }),
  )

  it.live("loads CONTEXT.md when the only instruction file above it is the global one", () =>
    Effect.gen(function* () {
      const home = yield* tmpWithFiles({ ".claude/CLAUDE.md": "global claude", "proj/CONTEXT.md": "legacy" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rules = yield* svc.system()
        expect(sources(rules, home)).toEqual([
          path.join(home, ".claude", "CLAUDE.md"),
          path.join(home, "proj", "CONTEXT.md"),
        ])
      }).pipe(provideInstance(path.join(home, "proj")), provideInstruction({ home, config: home }))
    }),
  )

  it.live("trusts imports from user-scope files", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "shared.md": "shared" })
      const shared = path.join(external, "shared.md")

      yield* withProject(
        { global: { ".claude/CLAUDE.md": `@~/notes.md\n@${shared}\nuser`, "notes.md": "notes" }, project: {} },
        (dirs) =>
          Effect.gen(function* () {
            const svc = yield* Instruction.Service
            const spy = counter(false)
            expect(sources(yield* svc.system(spy.ask), dirs.global, external)).toEqual([
              path.join(dirs.global, "notes.md"),
              shared,
              path.join(dirs.global, ".claude", "CLAUDE.md"),
            ])
            expect(spy.calls).toEqual([])
          }),
      )
    }),
  )

  it.live("strips block-level HTML comments", () =>
    withProject(
      { project: { "CLAUDE.md": "<!-- hidden -->\nkeep\n<!--\nmulti\n-->\n```\n<!-- fenced -->\n```" } },
      (dirs) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const filepath = path.join(dirs.project, "CLAUDE.md")
          const rule = ruleFor(yield* svc.system(), filepath)
          expect(rule).toBe(`${header}${filepath}\nkeep\n\`\`\`\n<!-- fenced -->\n\`\`\``)
          expect(rule).not.toContain("hidden")
          expect(rule).not.toContain("multi")
        }),
    ),
  )

  it.live("skips instruction files and imports over 4 MiB", () =>
    Effect.gen(function* () {
      const big = "a".repeat(4 * 1024 * 1024 + 1)

      yield* withProject({ project: { "CLAUDE.md": big } }, (dirs) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          expect(sources(yield* svc.system(), dirs.project)).toEqual([])
        }),
      )

      yield* withProject({ project: { "CLAUDE.md": "@big.md\nsmall", "big.md": big } }, (dirs) =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          expect(sources(yield* svc.system(allow), dirs.project)).toEqual([path.join(dirs.project, "CLAUDE.md")])
        }),
      )
    }),
  )
})

describe("Instruction.systemPaths global config", () => {
  it.live("uses Global.Service config AGENTS.md", () =>
    Effect.gen(function* () {
      const globalTmp = yield* tmpWithFiles({ "AGENTS.md": "# Global Instructions" })
      const projectTmp = yield* tmpdirScoped()

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const paths = yield* svc.systemPaths()
        expect(paths.has(path.join(globalTmp, "AGENTS.md"))).toBe(true)
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: globalTmp, config: globalTmp }))
    }),
  )
})
