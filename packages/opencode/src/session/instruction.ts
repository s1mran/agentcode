import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { containsPath } from "@/project/instance-context"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstructionFile } from "@opencode-ai/core/instruction-file"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@opencode-ai/core/global"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

function extract(messages: SessionV1.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  return paths
}

/** Decides whether a project instruction file may import a file outside the project. */
export interface Ask {
  // Decisions are remembered per scope (a session and its agent), never across sessions or agents.
  readonly scope: string
  readonly ask: (filepath: string) => Effect.Effect<boolean>
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  readonly system: (ask?: Ask) => Effect.Effect<string[], FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string[], FSUtil.Error>
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
    ask?: Ask,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

const layer: Layer.Layer<
  Service,
  never,
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const globals = new Set(globalFiles.map((file) => path.resolve(file)))
    const instructionFiles = InstructionFile.names({ claude: !flags.disableClaudeCodePrompt })
    const legacy = "CONTEXT.md" // deprecated

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
          // Decisions on imports that point outside the project, keyed by Ask scope and realpath, so each one is
          // asked about once per session and agent.
          external: new Map<string, boolean>(),
          // Realpaths loaded by the last system() call per Ask scope, including imports, so nested reads don't
          // attach them again.
          system: new Map<string, Set<string>>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const present = Effect.fnUntraced(function* (dir: string, files: ReadonlyArray<string>) {
      const result: string[] = []
      for (const file of files) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) result.push(filepath)
      }
      return result
    })

    const gate = (ask?: Ask) =>
      Effect.fnUntraced(function* (filepath: string) {
        if (containsPath(filepath, yield* InstanceState.context)) return true
        // Without a way to ask, skip the import but leave it undecided so a later call can still prompt.
        if (!ask) return false
        const s = yield* InstanceState.get(state)
        const key = `${ask.scope}\0${filepath}`
        const decided = s.external.get(key)
        if (decided !== undefined) return decided
        const ok = yield* ask.ask(filepath)
        s.external.set(key, ok)
        return ok
      })

    const fetch = Effect.fnUntraced(function* (url: string) {
      const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
        Effect.timeout(5000),
        Effect.catch(() => Effect.succeed(null)),
      )
      if (!res) return ""
      const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
      return new TextDecoder().decode(body)
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    // Local instruction files in load order. Global files and absolute or ~/ config entries are user scope and
    // import freely; files from the project tree ask before importing from outside the project.
    const roots = Effect.fnUntraced(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const result: InstructionFile.Root[] = []

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) result.push({ path: path.resolve(file), trusted: true })
      }

      // Claude Code loads instruction files from every directory between the filesystem root and the working
      // directory, root first; files add up and never hide each other.
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        // Global files already load as user scope; in $HOME, ~/.claude/CLAUDE.md would also match .claude/CLAUDE.md.
        const found = (yield* Effect.forEach(InstructionFile.ancestors(ctx.directory), (dir) =>
          present(dir, instructionFiles),
        ))
          .flat()
          .filter((item) => !globals.has(item))
        // The legacy CONTEXT.md only yields to instruction files inside the project, the old findUp boundary.
        const project = found.some((item) => FSUtil.contains(ctx.worktree, item))
          ? found
          : [
              ...found,
              ...(yield* fs
                .findUp(legacy, ctx.directory, ctx.worktree)
                .pipe(Effect.catch(() => Effect.succeed([] as string[])))),
            ]
        project.forEach((item) => result.push({ path: path.resolve(item), trusted: false }))
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const trusted = path.isAbsolute(instruction)
          const matches = yield* (
            trusted
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
              : relative(instruction)
          ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
          matches.forEach((item) => result.push({ path: path.resolve(item), trusted }))
        }
      }

      return result
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      return new Set((yield* roots()).map((item) => item.path))
    })

    const system = Effect.fn("Instruction.system")(function* (ask?: Ask) {
      const config = yield* cfg.get()
      const s = yield* InstanceState.get(state)
      const seen = new Set<string>()
      const entries = yield* InstructionFile.expand(fs, {
        roots: yield* roots(),
        home: global.home,
        seen,
        authorize: gate(ask),
      })
      s.system.set(ask?.scope ?? "", seen)

      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })

      return [
        ...entries.flatMap((item) => (item.content ? [`Instructions from: ${item.path}\n${item.content}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      const found = yield* present(dir, instructionFiles)
      return found.length > 0 ? found : yield* present(dir, [legacy])
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
      ask?: Ask,
    ) {
      const already = extract(messages)
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let set = s.claims.get(messageID)
      if (!set) {
        set = new Set()
        s.claims.set(messageID, set)
      }
      const claimed = set

      // Walk upward from the file being read, then attach nearby instruction files outermost first so the ones
      // closest to the file come last, once per message.
      const dirs: string[] = []
      let current = path.dirname(target)
      while (current.startsWith(root) && current !== root) {
        dirs.unshift(current)
        current = path.dirname(current)
      }

      const roots: InstructionFile.Root[] = []
      for (const dir of dirs) {
        for (const found of yield* find(dir)) {
          // System roots below the working directory are skipped by expand() through the realpaths in `seen`.
          if (found === target || already.has(found) || claimed.has(found)) continue
          roots.push({ path: found, trusted: false })
        }
      }
      if (roots.length === 0) return []

      const seen = new Set([
        ...(s.system.get(ask?.scope ?? "") ?? []),
        ...(yield* Effect.forEach([...already, ...claimed], (item) => InstructionFile.realpath(fs, item))),
      ])
      const entries = yield* InstructionFile.expand(fs, { roots, home: global.home, seen, authorize: gate(ask) })
      // Imports are claimed too, so later reads in this message don't attach them again.
      entries.forEach((item) => claimed.add(item.path))

      return entries.flatMap((item) =>
        item.content ? [{ filepath: item.path, content: `Instructions from: ${item.path}\n${item.content}` }] : [],
      )
    })

    return Service.of({ clear, systemPaths, system, find, resolve })
  }),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient],
})

export * as Instruction from "./instruction"
