import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@opencode-ai/core/global"
import fsNode from "fs/promises"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify, parse as parseJsonc, type ParseError as JsoncParseError } from "jsonc-parser"
import { InstallationLocal, InstallationVersion } from "@opencode-ai/core/installation/version"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { RemoteAuthError } from "@opencode-ai/core/v1/config/error"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { ConfigPluginV1 } from "@opencode-ai/core/v1/config/plugin"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { PermissionLaunchMode } from "@opencode-ai/core/permission/launch-mode"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { Npm } from "@opencode-ai/core/npm"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Glob } from "@opencode-ai/core/util/glob"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { WorkspaceTrust } from "@/trust"
import { WorkspaceTrustRestrict } from "@/trust/restrict"
import { CredentialEnv } from "@/trust/credential-env"

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

// The MCP entries of a loaded config as written, before {env:} and {file:} substitution, by the object loadConfig
// returned. Approval fingerprints are computed from these, so a server's identity is the same in every trust mode
// (which substitute differently) and never includes a secret value.
const writtenMcp = new WeakMap<object, Record<string, unknown>>()

function writtenMcpEntries(text: string) {
  if (!text.includes("{env:") && !text.includes("{file:")) return
  const errors: JsoncParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length || !isRecord(data) || !isRecord(data.mcp)) return
  return data.mcp
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

// Warn about legacy `tools: { x: true }` entries once per process, not on every instance load.
let warnedLegacyToolsEnabled = false

// Config lint for permission shapes whose meaning changed with deny > ask > allow precedence and ask-by-default
// built-ins. Log only; the config still loads as written.
function lintPermission(permission: ConfigPermissionV1.Info | undefined, prefix = "permission") {
  const warnings: { message: string; permission: string; patterns?: string[] }[] = []
  const infos: { message: string; permission: string }[] = []
  for (const [key, value] of Object.entries(permission ?? {})) {
    if (key === "*") continue
    if (typeof value === "string") {
      if (value === "ask" && (key === "edit" || key === "bash")) {
        infos.push({
          permission: key,
          message: `${prefix}.${key} "ask" is now the built-in default; as an explicit rule it keeps asking in Accept edits mode and for read-only commands`,
        })
      }
      continue
    }
    if (value["*"] !== "deny") continue
    const allows = Object.entries(value)
      .filter(([pattern, action]) => pattern !== "*" && action === "allow")
      .map(([pattern]) => pattern)
    if (!allows.length) continue
    warnings.push({
      permission: key,
      patterns: allows,
      message: `${prefix}.${key} has "*": "deny"; denies are absolute, so its "allow" patterns never apply`,
    })
  }
  return { warnings, infos }
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPluginV1.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

type Info = ConfigV1.Info & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

export type McpOrigin = { source: string; project: boolean }

export type Trust = {
  state: WorkspaceTrust.TrustState
  /** Project configuration that did not apply because of the trust state. */
  held: WorkspaceTrustRestrict.HeldItem[]
  /** Which config source defined each MCP server that applies; project servers get a credential-free environment. */
  mcpOrigins: Record<string, McpOrigin>
}

type State = {
  config: Info
  directories: string[]
  /** `directories` without the project folders whose code is held (custom tools are imported only from these). */
  trustedDirectories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
  trust: Trust
}

type LoadOptions = {
  redact?: (name: string) => boolean
  fileRoot?: string
  onRedact?: (token: string) => void
  /** False skips writing `$schema` back into the file. */
  writeSchema?: boolean
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
  /** The workspace trust state this instance loaded with, and what it held. */
  readonly trust: () => Effect.Effect<Trust>
  /** The source of an MCP server entry that applies, or undefined for servers config does not define. */
  readonly mcpOrigin: (name: string) => Effect.Effect<McpOrigin | undefined>
  readonly trustedDirectories: () => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  const candidates = ["opencode.jsonc", "opencode.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient
    const trustSvc = yield* WorkspaceTrust.Service

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
      load: LoadOptions = {},
    ) {
      const source = "path" in options ? options.path : options.source
      const substitution = { env, redact: load.redact, fileRoot: load.fileRoot, onRedact: load.onRedact }
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, ...substitution }
            : { text, type: "virtual", ...options, ...substitution },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(ConfigV1.Info, normalizeLoadedConfig(parsed), source)
      const written = writtenMcpEntries(text)
      if (written) writtenMcp.set(data, written)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      if (!data.$schema && load.writeSchema !== false) {
        data.$schema = "https://opencode.ai/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://opencode.ai/config.json",')
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>, load?: LoadOptions) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env, load)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.OPENCODE_CONFIG && !Flag.OPENCODE_CONFIG_DIR && !Flag.OPENCODE_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "opencode.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "opencode.jsonc"), env))

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result["$schema"] = "https://opencode.ai/config.json"
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      yield* fs.ensureDir(dir)
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore", "settings.local.json"].join(
              "\n",
            ),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const trustState = yield* trustSvc.state(ctx)
        const effective = trustState.effective
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "OPENCODE_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPluginV1.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        // disable_bypass_permissions is sticky: once any scope (managed and MDM included) sets it, a later scope
        // cannot turn it back off through the deep merge.
        let bypassDisabled = false

        // A source the opened project can ship: a config file inside the worktree/directory, a project config found
        // walking up from the directory, or an ancestor .opencode folder of a non-git directory. Global, remote,
        // managed and OPENCODE_CONFIG_CONTENT sources are not project sources.
        const isProjectSource = (source: string, kind?: ConfigPlugin.Scope) => {
          if (kind === "global") return false
          if (source === "OPENCODE_CONFIG_CONTENT") return false
          if (source.startsWith("http://") || source.startsWith("https://")) return false
          const file = path.resolve(source)
          const dir = path.dirname(file)
          // The user's own config folders stay global even when the opened directory contains them (for example
          // when the home folder itself is opened).
          if (dir === path.join(Global.Path.home, ".opencode")) return false
          if (Flag.OPENCODE_CONFIG_DIR && dir === path.resolve(Flag.OPENCODE_CONFIG_DIR)) return false
          if (FSUtil.contains(Global.Path.config, file)) return false
          if (kind === "local") return true
          if (containsPath(file, ctx)) return true
          return path.basename(dir) === ".opencode"
        }

        // Workspace trust (see src/trust). Unless the folder is fully trusted, project sources pass through
        // restrictSource before they merge, and what it removes is recorded in `held` for clients to show.
        const held: WorkspaceTrustRestrict.HeldItem[] = []
        const trustScope: WorkspaceTrustRestrict.Scope = {
          roots: [trustState.path, ctx.directory, ...(ctx.worktree === "/" ? [] : [ctx.worktree])],
          directory: ctx.directory,
          home: Global.Path.home,
          worktree: ctx.worktree,
        }
        const redactions: { source: string; name: string }[] = []
        // Substitution rules for a config file the project ships. In restricted mode every credential-like variable
        // and every file outside the trust root reads as empty. A trusted folder or a headless run can already run the
        // project's own code, so its config substitutes like the user's (Claude Code expands variables in project
        // server config and only strips credentials from the server's process environment).
        const loadOptions = (source: string, project: boolean): LoadOptions | undefined => {
          if (!project) return undefined
          if (effective !== "restricted") return { writeSchema: effective === "full" }
          return {
            redact: (name) => {
              const hit = CredentialEnv.isCovered(name) || CredentialEnv.isCredentialName(name)
              if (hit) redactions.push({ source, name: `{env:${name}}` })
              return hit
            },
            fileRoot: trustState.path,
            onRedact: (token) => redactions.push({ source, name: token }),
            writeSchema: false,
          }
        }
        const logRedactions = Effect.fnUntraced(function* () {
          for (const item of redactions.splice(0)) {
            yield* Effect.logWarning("project config substitution read as empty", {
              source: item.source,
              reference: item.name,
            })
          }
        })

        // MCP bookkeeping across every source, before restriction: `shadowMcp` is what cfg.mcp would be with the
        // folder trusted, `lastOrigin` which source wrote each name last, `userMcp` what non-project sources alone
        // define, and `mergedOrigins` the source of each entry that actually merged.
        const shadowMcp: Record<string, unknown> = {}
        // The same merge from the entries as written (see writtenMcp), for fingerprints and what clients display.
        const identityMcp: Record<string, unknown> = {}
        const lastOrigin: Record<string, McpOrigin> = {}
        const userMcp: Record<string, unknown> = {}
        const userOrigins: Record<string, McpOrigin> = {}
        const mergedOrigins: Record<string, McpOrigin> = {}
        const trackMcp = (
          source: string,
          entries: Info["mcp"],
          project: boolean,
          written?: Record<string, unknown>,
        ) => {
          for (const [name, entry] of Object.entries(entries ?? {})) {
            shadowMcp[name] = mergeDeep((shadowMcp[name] ?? {}) as object, entry)
            const literal = written?.[name]
            identityMcp[name] = mergeDeep((identityMcp[name] ?? {}) as object, isRecord(literal) ? literal : entry)
            lastOrigin[name] = { source, project }
            if (project) continue
            userMcp[name] = mergeDeep((userMcp[name] ?? {}) as object, entry)
            userOrigins[name] = { source, project }
          }
        }

        const merge = Effect.fnUntraced(function* (source: string, loaded: Info, kind?: ConfigPlugin.Scope) {
          let next = loaded
          const project = isProjectSource(source, kind)
          bypassDisabled ||= next.disable_bypass_permissions === true
          // A repository must not be able to start sessions with every permission check switched off.
          if (next.default_permission_mode === "bypassPermissions" && project) {
            next = { ...next }
            delete next.default_permission_mode
            yield* Effect.logWarning("default_permission_mode bypassPermissions ignored from project config", {
              source,
            })
          }
          trackMcp(source, next.mcp, project, writtenMcp.get(loaded))
          if (project && effective !== "full") {
            const restricted = WorkspaceTrustRestrict.restrictSource(next, effective, source, trustScope)
            next = restricted.info
            // MCP servers are decided after every source has merged, from their final shape.
            held.push(...restricted.held.filter((item) => item.kind !== "mcp"))
          }
          for (const name of Object.keys(next.mcp ?? {})) mergedOrigins[name] = { source, project }
          result = mergeConfigConcatArrays(result, next)
          yield* mergePluginOrigins(source, next.plugin, kind)
        })

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/opencode`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, ConfigV1.WellKnown, url)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://opencode.ai/config.json"
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.OPENCODE_CONFIG) {
          const options = loadOptions(Flag.OPENCODE_CONFIG, isProjectSource(Flag.OPENCODE_CONFIG))
          yield* merge(Flag.OPENCODE_CONFIG, yield* loadFile(Flag.OPENCODE_CONFIG, authEnv, options))
          yield* logRedactions()
          yield* Effect.logDebug("loaded custom config", { path: Flag.OPENCODE_CONFIG })
        }

        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("opencode", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            const options = loadOptions(file, isProjectSource(file, "local"))
            yield* merge(file, yield* loadFile(file, authEnv, options), "local")
            yield* logRedactions()
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.OPENCODE_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from OPENCODE_CONFIG_DIR", { path: Flag.OPENCODE_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []
        const trustedDirectories: string[] = []

        for (const dir of directories) {
          // A project `.opencode` folder: its code (plugins, custom tools, the dependency install) waits for trust.
          const projectDir = isProjectSource(path.join(dir, "opencode.json"))
          const restrictedDir = projectDir && effective === "restricted"
          if (dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {
            for (const file of ["opencode.json", "opencode.jsonc"]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv, loadOptions(source, projectDir)))
              yield* logRedactions()
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          if (restrictedDir) {
            let commands = yield* Effect.promise(() => ConfigCommand.load(dir))
            const restrictedCommands = WorkspaceTrustRestrict.restrictCommands(commands, dir)
            commands = restrictedCommands.commands
            const agents = WorkspaceTrustRestrict.restrictAgents(
              yield* Effect.promise(() => ConfigAgent.load(dir)),
              dir,
            )
            const modes = WorkspaceTrustRestrict.restrictAgents(
              yield* Effect.promise(() => ConfigAgent.loadMode(dir)),
              dir,
            )
            held.push(...restrictedCommands.held, ...agents.held, ...modes.held)
            result.command = mergeDeep(result.command ?? {}, commands)
            result.agent = mergeDeep(result.agent ?? {}, agents.agents)
            result.agent = mergeDeep(result.agent ?? {}, modes.agents)
            for (const spec of yield* Effect.promise(() => ConfigPlugin.load(dir))) {
              held.push({ kind: "plugin", spec: ConfigPlugin.pluginSpecifier(spec), source: dir })
            }
            const tools = yield* Effect.promise(() =>
              Glob.scan("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
            )
            for (const file of tools) held.push({ kind: "tool", file })
            continue
          }
          trustedDirectories.push(dir)

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          const dep = yield* npmSvc
            .install(dir, {
              add: [
                {
                  name: "@opencode-ai/plugin",
                  version: InstallationLocal ? undefined : InstallationVersion,
                },
              ],
            })
            .pipe(
              Effect.exit,
              Effect.tap((exit) =>
                Exit.isFailure(exit)
                  ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                  : Effect.void,
              ),
              Effect.asVoid,
              Effect.forkDetach,
            )
          deps.push(dep)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          if (projectDir && effective === "headless") {
            // Claude Code -p parity: project agents load, their allow rules do not.
            const agents = WorkspaceTrustRestrict.restrictAgents(
              yield* Effect.promise(() => ConfigAgent.load(dir)),
              dir,
            )
            const modes = WorkspaceTrustRestrict.restrictAgents(
              yield* Effect.promise(() => ConfigAgent.loadMode(dir)),
              dir,
            )
            held.push(...agents.held, ...modes.held)
            result.agent = mergeDeep(result.agent ?? {}, agents.agents)
            result.agent = mergeDeep(result.agent ?? {}, modes.agents)
          } else {
            result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
            result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          }
          // Auto-discovered plugins under `.opencode/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        if (process.env.OPENCODE_CONFIG_CONTENT) {
          const source = "OPENCODE_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.OPENCODE_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from OPENCODE_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["OPENCODE_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("OPENCODE_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) =>
              Effect.logDebug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        }

        // Global-scope default mode from the environment (the TUI's --permission-mode sets it). bypassPermissions is
        // allowed here; the bypass gate still applies when the mode is resolved. Applied before managed config, so an
        // administrator's default_permission_mode wins over the variable. The worker moves the variable out of its
        // environment at startup (PermissionLaunchMode.claim) so child processes cannot inherit it; read() still has it.
        const envMode = PermissionLaunchMode.read()
        if (envMode) {
          if (Schema.is(PermissionV1.Mode)(envMode)) result.default_permission_mode = envMode
          else
            yield* Effect.logWarning("OPENCODE_PERMISSION_MODE is not a permission mode, skipping", { value: envMode })
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["opencode.json", "opencode.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          const next = yield* loadConfig(managed.text, {
            dir: path.dirname(managed.source),
            source: managed.source,
          })
          bypassDisabled ||= next.disable_bypass_permissions === true
          trackMcp(managed.source, next.mcp, false)
          for (const name of Object.keys(next.mcp ?? {}))
            mergedOrigins[name] = { source: managed.source, project: false }
          result = mergeConfigConcatArrays(result, next)
        }

        // Project MCP servers, decided from their final merged shape. Restricted: held (they never merged). Trusted:
        // a server applies when the user approved this exact command or url; a new one waits as pending, a changed one
        // as changed, a rejected one stays rejected. A headless run (in a trusted folder too, so trusting a folder never
        // loads less) and a launch-trusted run connect every server the user has not rejected. A held name falls back to
        // the user's own definition of it, if any. Fingerprints come from the entries as written, not substituted.
        const mcpOrigins: Record<string, McpOrigin> = { ...mergedOrigins }
        for (const [name, origin] of Object.entries(lastOrigin)) {
          if (!origin.project) continue
          if (!WorkspaceTrustRestrict.isMcpConfigured(shadowMcp[name])) continue
          const identity = identityMcp[name]
          const entry = WorkspaceTrustRestrict.isMcpConfigured(identity) ? identity : shadowMcp[name]
          const fingerprint = WorkspaceTrustRestrict.mcpFingerprint(entry as ConfigMCPV1.Info)
          const approved = trustState.mcp.approved[name]
          const reason: WorkspaceTrustRestrict.McpReason | undefined =
            effective === "restricted"
              ? "untrusted"
              : trustState.mcp.rejected.includes(name)
                ? "rejected"
                : trustState.policy === "headless" || trustState.source === "launch"
                  ? undefined
                  : approved === undefined
                    ? "pending"
                    : approved === fingerprint
                      ? undefined
                      : "changed"
          if (!reason) continue
          held.push(WorkspaceTrustRestrict.heldMcp(name, entry as ConfigMCPV1.Info, origin.source, reason))
          if (effective === "restricted") continue
          if (userMcp[name] !== undefined) {
            result.mcp = { ...result.mcp, [name]: userMcp[name] as NonNullable<Info["mcp"]>[string] }
            mcpOrigins[name] = userOrigins[name]
            continue
          }
          if (result.mcp) delete result.mcp[name]
          delete mcpOrigins[name]
        }
        if (held.length) {
          yield* Effect.logInfo("workspace trust held project configuration", {
            path: trustState.path,
            effective,
            held: WorkspaceTrustRestrict.summarize(held),
          })
        }
        if (bypassDisabled) result.disable_bypass_permissions = true
        else delete result.disable_bypass_permissions

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.OPENCODE_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.OPENCODE_PERMISSION))
          } catch (err) {
            yield* Effect.logWarning("OPENCODE_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermissionV1.Action> = {}
          const enabled: string[] = []
          for (const [tool, on] of Object.entries(result.tools)) {
            // Enabling a tool is not an approval: true only means "not disabled", so the built-in asks still apply.
            if (on) {
              enabled.push(tool)
              continue
            }
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = "deny"
              continue
            }
            perms[tool] = "deny"
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
          if (enabled.length && !warnedLegacyToolsEnabled) {
            warnedLegacyToolsEnabled = true
            yield* Effect.logWarning(
              "legacy tools entries set to true no longer approve those tools; use permission rules to allow them",
              { tools: enabled },
            )
          }
        }

        // Per-agent permissions (config and markdown agent files alike) are read with the same precedence.
        const lints = [
          lintPermission(result.permission),
          ...Object.entries(result.agent ?? {}).map(([name, agent]) =>
            lintPermission(agent?.permission, `agent.${name}.permission`),
          ),
        ]
        for (const lint of lints) {
          for (const { message, ...item } of lint.warnings) yield* Effect.logWarning(message, item)
          for (const { message, ...item } of lint.infos) yield* Effect.logInfo(message, item)
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.OPENCODE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          directories,
          trustedDirectories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
          trust: { state: trustState, held, mcpOrigins },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const trust = Effect.fn("Config.trust")(function* () {
      return yield* InstanceState.use(state, (s) => s.trust)
    })

    const mcpOrigin = Effect.fn("Config.mcpOrigin")(function* (name: string) {
      return yield* InstanceState.use(state, (s) => s.trust.mcpOrigins[name])
    })

    const trustedDirectories = Effect.fn("Config.trustedDirectories")(function* () {
      return yield* InstanceState.use(state, (s) => s.trustedDirectories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      yield* fs
        .writeFileString(file, JSON.stringify(mergeDeep(writable(existing), writable(config)), null, 2))
        .pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(before, file), file)
        const merged = mergeDeep(writable(existing), patch)
        const serialized = JSON.stringify(merged, null, 2)
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
        next = merged
      } else {
        const updated = patchJsonc(before, patch)
        next = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(updated, file), file)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
      trust,
      mcpOrigin,
      trustedDirectories,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Account.node, Env.node, Npm.node, httpClient, WorkspaceTrust.node],
})

export * as Config from "./config"
