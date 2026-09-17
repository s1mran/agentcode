export * as WorkspaceTrustStore from "./store"

import path from "path"
import { randomBytes } from "crypto"
import { readFileSync } from "fs"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "fs/promises"
import { Global } from "../global"
import { Flock } from "../util/flock"
import { covers, type Info as KeyInfo, type Kind } from "./key"

/**
 * Trust decisions, one file for every project, in the engine's global data directory: outside every repository, shared
 * by the desktop app, the TUI and the CLI, and on the protected-path floor so no tool can trust a folder for itself.
 * Setting `trusted: true` by hand counts as trust, like Claude Code's `hasTrustDialogAccepted`.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface McpChoices {
  /** Server name to the fingerprint the user approved. */
  approved: Record<string, string>
  rejected: string[]
}

export interface Entry {
  path: string
  kind: Kind
  trusted: boolean
  time: number
  mcp: McpChoices
}

export interface Data {
  version: 1
  workspaces: Record<string, Entry>
}

export class CorruptError extends Error {
  constructor(readonly file: string) {
    super(`workspace trust store ${file} could not be parsed; fix or delete it to record trust decisions`)
    this.name = "WorkspaceTrustCorruptError"
  }
}

export function dir() {
  return path.join(Global.Path.data, "trust")
}

export function file() {
  return path.join(dir(), "workspaces.json")
}

export function empty(): Data {
  return { version: 1, workspaces: {} }
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function entry(value: unknown): Entry | undefined {
  if (!isRecord(value) || typeof value.trusted !== "boolean") return
  const mcp = isRecord(value.mcp) ? value.mcp : {}
  const approved = isRecord(mcp.approved)
    ? Object.fromEntries(
        Object.entries(mcp.approved).filter((item): item is [string, string] => typeof item[1] === "string"),
      )
    : {}
  return {
    path: typeof value.path === "string" ? value.path : "",
    kind: value.kind === "directory" ? "directory" : "repository",
    trusted: value.trusted,
    time: typeof value.time === "number" ? value.time : 0,
    mcp: { approved, rejected: strings(mcp.rejected) },
  }
}

/** The store in `text`, or undefined when it is not a store. Entries that are not entries are dropped. */
export function parse(text: string): Data | undefined {
  if (!text.trim()) return empty()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return
  }
  if (!isRecord(data) || !isRecord(data.workspaces)) return
  const workspaces: Record<string, Entry> = {}
  for (const [key, value] of Object.entries(data.workspaces)) {
    const item = entry(value)
    if (item) workspaces[key] = { ...item, path: item.path || key }
  }
  return { version: 1, workspaces }
}

export class ReadError extends Error {
  constructor(
    readonly file: string,
    override readonly cause: unknown,
  ) {
    super(
      `workspace trust store ${file} could not be read (${cause instanceof Error ? cause.message : String(cause)}); nothing was changed`,
    )
    this.name = "WorkspaceTrustReadError"
  }
}

/**
 * `corrupt`: the file does not parse. `error`: the file exists but could not be read (EACCES, EMFILE, EIO...). Both read
 * as empty, so every folder falls back to restricted, and `update` refuses to write over either.
 */
export type ReadResult = { data: Data; corrupt: boolean; error?: ReadError }

function result(text: string | undefined): ReadResult {
  if (text === undefined) return { data: empty(), corrupt: false }
  const data = parse(text)
  return data ? { data, corrupt: false } : { data: empty(), corrupt: true }
}

function failed(target: string, error: unknown): ReadResult {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return result(undefined)
  return { data: empty(), corrupt: false, error: new ReadError(target, error) }
}

/** Reads the store; a missing file is empty, and a file that does not parse reads as empty with `corrupt` set. */
export async function read(target = file()): Promise<ReadResult> {
  return readFile(target, "utf8").then(result, (error: unknown) => failed(target, error))
}

/** The synchronous form of `read`, for the TUI process, which resolves its plugins before any effect runs. */
export function readSync(target = file()): ReadResult {
  let text: string
  try {
    text = readFileSync(target, "utf8")
  } catch (error) {
    return failed(target, error)
  }
  return result(text)
}

/**
 * Read, change and write the store under a cross-process lock, through a temp file and a rename, so the desktop
 * sidecar and a TUI worker never lose each other's writes and a reader never sees half a file. A corrupt store is
 * never overwritten (the update fails with CorruptError), and neither is one that could not be read (ReadError), so a
 * transient EMFILE or EACCES never replaces every stored decision with one.
 */
export async function update(fn: (data: Data) => void, target = file()): Promise<Data> {
  const folder = path.dirname(target)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await chmod(folder, 0o700).catch(() => undefined)
  return Flock.withLock(`workspace-trust:${target}`, async () => {
    const current = await read(target)
    if (current.error) throw current.error
    if (current.corrupt) throw new CorruptError(target)
    const data = current.data
    fn(data)
    const tmp = path.join(folder, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
      await chmod(tmp, 0o600)
      await rename(tmp, target)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
    return data
  })
}

export type Lookup = { key: string; entry: Entry; source: "stored" | "parent" }

/**
 * The decision for a folder. The exact key wins. A folder outside a repository is also covered by the nearest stored
 * directory above it, so a nearer `trusted: false` beats a farther `true`. A repository is never covered by a parent:
 * a clone inside a trusted folder needs its own trust.
 */
export function lookupIn(data: Data, info: Pick<KeyInfo, "key" | "kind">): Lookup | undefined {
  const exact = data.workspaces[info.key]
  if (exact) return { key: info.key, entry: exact, source: "stored" }
  if (info.kind !== "directory") return
  let best: Lookup | undefined
  for (const [key, item] of Object.entries(data.workspaces)) {
    if (item.kind !== "directory" || !covers(key, info.key)) continue
    if (best && best.key.length >= key.length) continue
    best = { key, entry: item, source: "parent" }
  }
  return best
}
