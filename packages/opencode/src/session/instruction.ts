import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Deferred, Effect, Exit, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { ConfigParse } from "@/config/parse"
import { ConfigPaths } from "@/config/paths"
import { ConfigVariable } from "@/config/variable"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstructionFile } from "@opencode-ai/core/instruction-file"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import type * as Tool from "@/tool/tool"
import type { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"

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

/** How imports in project instruction files are checked: like a Read of the imported file by the asking agent. */
export interface Ask {
  readonly sessionID: SessionID
  // The asking agent's permission rules followed by the session's, as the Read tool applies them.
  readonly ruleset: Effect.Effect<PermissionV1.Ruleset>
  // Prompts for an import the rules leave to the user: true to load, false when declined, undefined when the rules
  // deny it after all. Without it, such an import only loads when the user already allowed it in this instance.
  readonly prompt?: (filepath: string) => Effect.Effect<boolean | undefined>
}

type Request = Omit<PermissionV1.Request, "id" | "sessionID" | "tool">

// The Read tool's permission requests for a file: external_directory outside the project, then read, so files like
// .env ask first.
const requests = Effect.fnUntraced(function* (filepath: string) {
  const instance = yield* InstanceState.context
  const result: Request[] = []
  yield* assertExternalDirectoryEffect(
    {
      ask: (req) =>
        Effect.sync(() => {
          result.push(req)
        }),
    },
    filepath,
  )
  result.push({
    permission: "read",
    patterns: [path.relative(instance.worktree, filepath)],
    always: ["*"],
    metadata: {},
  })
  return result
})

/**
 * Asks through `ctx.ask` for the Read tool's permission checks on an import. True once allowed, false when declined,
 * undefined when the rules deny it. A reject with feedback fails so the feedback reaches the model.
 */
export const check = Effect.fnUntraced(function* (ctx: Pick<Tool.Context, "ask">, filepath: string) {
  return yield* Effect.gen(function* () {
    for (const req of yield* requests(filepath)) yield* ctx.ask(req)
    return true as boolean | undefined
  }).pipe(
    Effect.catchDefect((defect) => {
      if (defect instanceof PermissionV1.DeniedError) return Effect.succeed(undefined)
      if (defect instanceof PermissionV1.CorrectedError) return Effect.die(defect)
      return Effect.succeed(false)
    }),
  )
})

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
  FSUtil.Service | Config.Service | Global.Service | HttpClient.HttpClient | RuntimeFlags.Service | Permission.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const permission = yield* Permission.Service
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
          // Realpaths of the instruction files attached for a given assistant message, shared by its parallel reads.
          claims: new Map<MessageID, Set<string>>(),
          // The user's answers on imports by realpath, shared by every session and agent in the instance like Claude
          // Code's per-project approval, so new sessions and subagents are not asked again.
          imports: new Map<string, boolean>(),
          // Import prompts in flight by session and realpath, so parallel loads in a session wait for one prompt.
          asking: new Map<string, Deferred.Deferred<void>>(),
          // Realpaths loaded by the last system() call, including imports, so nested reads don't attach them again.
          system: new Set<string>(),
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

    // Whether an "always" answer allows the pattern. Permission.ask checks those answers after the ruleset it is given,
    // so asking with a ruleset that denies everything else never prompts.
    const approved = (sessionID: SessionID, name: string, pattern: string) =>
      permission
        .ask({
          sessionID,
          permission: name,
          patterns: [pattern],
          always: [],
          metadata: {},
          ruleset: [{ permission: "*", pattern: "*", action: "deny" }],
        })
        .pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        )

    // What the asking agent's rules and the user's "always" answers say about importing `filepath`, without prompting.
    const verdict = Effect.fnUntraced(function* (ask: Ask, filepath: string) {
      const ruleset = yield* ask.ruleset
      let result: "allow" | "ask" = "allow"
      for (const req of yield* requests(filepath)) {
        for (const pattern of req.patterns) {
          const action = Permission.evaluate(req.permission, pattern, ruleset).action
          if (action === "allow" || (yield* approved(ask.sessionID, req.permission, pattern))) continue
          if (action === "deny") return "deny" as const
          result = "ask"
        }
      }
      return result
    })

    // The user's answer on an import. Only answers are remembered, since rules differ between agents. Parallel loads in
    // one session wait for its prompt; another session asks for itself rather than wait on a prompt the user may never
    // see there, and the latest answer wins. The prompt is registered and cleaned up with interruption masked, so an
    // abort can't leave a pending entry behind.
    const answer = (ask: Ask, filepath: string): Effect.Effect<boolean> =>
      InstanceState.useEffect(state, (s) =>
        Effect.uninterruptibleMask((restore) => {
          const decided = s.imports.get(filepath)
          if (decided !== undefined) return Effect.succeed(decided)
          if (!ask.prompt) return Effect.succeed(false)
          const key = `${ask.sessionID}\0${filepath}`
          const pending = s.asking.get(key)
          if (pending) return restore(Deferred.await(pending).pipe(Effect.andThen(answer(ask, filepath))))
          const done = Deferred.makeUnsafe<void>()
          s.asking.set(key, done)
          return restore(ask.prompt(filepath)).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                // A reject with feedback fails the asker but is still a reject; an interrupted prompt decides nothing.
                if (Exit.isSuccess(exit) && exit.value !== undefined) s.imports.set(filepath, exit.value)
                if (Exit.isFailure(exit) && !Exit.hasInterrupts(exit)) s.imports.set(filepath, false)
                s.asking.delete(key)
                Deferred.doneUnsafe(done, Exit.void)
              }),
            ),
            Effect.map((ok) => ok === true),
          )
        }),
      )

    // Whether a project instruction file may import `filepath`, a realpath: the asking agent's rules first, then the
    // user for what they leave open. Without an asking agent there are no rules to check it against.
    const decide = (ask: Ask | undefined, filepath: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (!ask) return false
        const rule = yield* verdict(ask, filepath)
        if (rule !== "ask") return rule === "allow"
        return yield* answer(ask, filepath)
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

    // The instructions entries in a config source, after the {env:} and {file:} substitution Config applies. A source
    // that can't be read or parsed adds nothing, which only leaves its entries untrusted.
    const declared = (
      text: string,
      source: { type: "path"; path: string } | { type: "virtual"; source: string; dir: string },
    ) =>
      Effect.tryPromise(async () => {
        const data = ConfigParse.jsonc(
          await ConfigVariable.substitute({ ...source, text }),
          source.type === "path" ? source.path : source.source,
        )
        const list = data && typeof data === "object" ? (data as { instructions?: unknown }).instructions : undefined
        return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []
      }).pipe(Effect.catch(() => Effect.succeed([] as string[])))

    // Instructions entries from config the user controls: the global config, OPENCODE_CONFIG, OPENCODE_CONFIG_DIR,
    // ~/.opencode, OPENCODE_CONFIG_CONTENT and the managed config directory. Project config files are left out, since a
    // cloned repo controls them, and so are remote configs, which can't be read here; their entries only lose trust.
    const userInstructions = Effect.fnUntraced(function* () {
      const ctx = yield* InstanceState.context
      const result = new Set((yield* cfg.getGlobal()).instructions ?? [])
      const dirs = [path.join(global.home, ".opencode"), Flag.OPENCODE_CONFIG_DIR, ConfigManaged.managedConfigDir()]
      const files = [
        ...(Flag.OPENCODE_CONFIG ? [Flag.OPENCODE_CONFIG] : []),
        ...dirs.flatMap((dir) => (dir ? ConfigPaths.fileInDirectory(dir, "opencode") : [])),
      ]
      for (const file of files) {
        const text = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.void))
        if (!text) continue
        for (const item of yield* declared(text, { type: "path", path: file })) result.add(item)
      }
      const content = process.env.OPENCODE_CONFIG_CONTENT
      if (content) {
        const source = { type: "virtual" as const, source: "OPENCODE_CONFIG_CONTENT", dir: ctx.directory }
        for (const item of yield* declared(content, source)) result.add(item)
      }
      return result
    })

    // Local instruction files in load order. Global files and absolute or ~/ entries from config the user controls are
    // user scope and import freely; project files and entries a project config declares check their imports.
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
        // A cloned repo's config can name any absolute path, so only entries the user declared are trusted.
        let user: Set<string> | undefined
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const absolute = path.isAbsolute(instruction)
          const trusted = absolute && (user ??= yield* userInstructions()).has(raw)
          const matches = yield* (
            absolute
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
        authorize: (filepath) => decide(ask, filepath),
      })
      s.system = seen

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
          // System roots below the working directory and claimed files are skipped by expand() through `seen`.
          if (found === target || already.has(found)) continue
          roots.push({ path: found, trusted: false })
        }
      }
      if (roots.length === 0) return []

      const known = new Set([
        ...s.system,
        ...(yield* Effect.forEach(already, (item) => InstructionFile.realpath(fs, item))),
      ])
      // expand() claims each file, imports included, in the message's shared set before its next yield, so parallel
      // reads attach it once. A resolve that fails gives its claims back for a later read in the message.
      const mine: string[] = []
      const seen = {
        has: (key: string) => known.has(key) || claimed.has(key),
        add: (key: string) => {
          mine.push(key)
          return claimed.add(key)
        },
      }
      const entries = yield* InstructionFile.expand(fs, {
        roots,
        home: global.home,
        seen,
        authorize: (item) => decide(ask, item),
      }).pipe(Effect.onError(() => Effect.sync(() => mine.forEach((key) => claimed.delete(key)))))

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
  deps: [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, Permission.node, httpClient],
})

export * as Instruction from "./instruction"
