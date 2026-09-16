import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import path from "path"
import { mkdir, symlink } from "fs/promises"
import { Effect, FileSystem, Layer } from "effect"
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

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem, InstanceStore.node]), [
    [
      InstanceBootstrap.node,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ]),
)

const configLayer = Layer.succeed(Config.Service, TestConfig.make())

const instructionLayer = (global: Partial<Global.Interface>, flags: Partial<RuntimeFlags.Info> = {}) =>
  AppNodeBuilder.build(Instruction.node, [
    [Config.node, configLayer],
    [Global.node, Global.layerWith(global)],
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags)))

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
  input: { global?: Record<string, string>; project: Record<string, string>; cwd?: string },
  self: (dirs: { global: string; project: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const globalTmp = yield* tmpWithFiles(input.global ?? {})
    const projectTmp = yield* tmpWithFiles(input.project)
    return yield* self({ global: globalTmp, project: projectTmp }).pipe(
      provideInstance(input.cwd ? path.join(projectTmp, input.cwd) : projectTmp),
      provideInstruction({ home: globalTmp, config: globalTmp }),
    )
  })

const counter = (answer: boolean, scope = "ses_test\0build") => {
  const calls: string[] = []
  const ask: Instruction.Ask = {
    scope,
    ask: (filepath) =>
      Effect.sync(() => {
        calls.push(filepath)
        return answer
      }),
  }
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

        const first = yield* svc.resolve([], filepath, id)
        expect(first.map((item) => item.filepath)).toEqual([
          path.join(dir, "sub", "notes.md"),
          path.join(dir, "sub", "CLAUDE.md"),
        ])
        expect(first[0].content).toBe(`Instructions from: ${path.join(dir, "sub", "notes.md")}\nn`)
        expect(yield* svc.resolve([], filepath, id)).toEqual([])
      }),
    ),
  )

  it.live("does not reattach a nested file already imported at system level", () =>
    withFiles({ "CLAUDE.md": "@sub/CLAUDE.md", "sub/CLAUDE.md": "s", "sub/x.ts": "const x = 1" }, (dir) =>
      Effect.gen(function* () {
        const svc = yield* Instruction.Service
        yield* svc.system()
        const results = yield* svc.resolve([], path.join(dir, "sub", "x.ts"), MessageID.make("msg_message-import-2"))
        expect(results).toEqual([])
      }),
    ),
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
        const rules = yield* svc.system()
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
          const rules = yield* svc.system()
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
          expect(sources(yield* svc.system(), dirs.project)).toEqual([
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
        expect(sources(yield* svc.system(), dirs.project)).toEqual([
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
          expect(sources(yield* svc.system(), dirs.project)).toEqual([
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

  it.live("remembers external import decisions per session and agent, not per instance", () =>
    Effect.gen(function* () {
      const external = yield* tmpWithFiles({ "notes.md": "external notes" })
      const imported = path.join(external, "notes.md")

      yield* withProject({ project: { "CLAUDE.md": `@${imported}\nproject` } }, () =>
        Effect.gen(function* () {
          const svc = yield* Instruction.Service
          const once = counter(true, "ses_a\0build")
          expect(sources(yield* svc.system(once.ask), external)).toEqual([imported])

          // Another session, or another agent in the same session, is asked again with its own rules.
          const other = counter(false, "ses_b\0build")
          expect(sources(yield* svc.system(other.ask), external)).toEqual([])
          const plan = counter(false, "ses_a\0plan")
          expect(sources(yield* svc.system(plan.ask), external)).toEqual([])
          expect(other.calls).toEqual([imported])
          expect(plan.calls).toEqual([imported])

          // A reject in one scope does not block the import elsewhere.
          const later = counter(true, "ses_c\0build")
          expect(sources(yield* svc.system(later.ask), external)).toEqual([imported])
          expect(later.calls).toEqual([imported])
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
          expect(sources(yield* svc.system(), dirs.project)).toEqual([path.join(dirs.project, "CLAUDE.md")])
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
