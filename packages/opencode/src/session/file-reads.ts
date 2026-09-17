/**
 * Per-session file read ledger.
 *
 * Edit, write and apply_patch refuse to change an existing file the agent has not read in this session, the way Claude
 * Code does. This works the same for every model: it lives in the engine and never looks at the provider.
 *
 * What counts as a read ("a view"): a read tool call (whole file or a line range), an attached file, a shell command
 * that printed the file (cat, head, tail, sed -n, grep -n / rg -n on one file), and the agent's own successful edits
 * and writes. Each view names the file version it saw (mtime, size and, up to 4 MiB, a sha256 of the bytes) and the
 * lines it covered.
 *
 * Where views live: every tool result carries its views in `metadata.ledger` (a synthetic attachment TextPart carries
 * them in its own metadata), so session history is the source of truth. Results that were compacted away, reverted or
 * pruned stop counting because they are no longer in `ctx.messages`; forks and restarts keep what the model can still
 * see. Pruned tool results (`state.time.compacted`) stop counting too, except writes, whose full content is still in
 * the tool input. An in-memory overlay covers calls from the current step that are not persisted yet; an overlay entry
 * only counts while its message is the current one. After that, history alone decides, so a long-lived process and a
 * restarted one give the same answer (a pruned read stops counting in both).
 *
 * Subagents: a child session never shares its parent's ledger and the parent never inherits the child's. Each session
 * reads for itself, because a child's context does not contain the parent's read output (and the reverse). Views are
 * keyed by session and validated against that session's own messages, so this falls out of the design; a resumed task
 * keeps its own reads through its own history.
 *
 * Escape hatch: OPENCODE_DISABLE_FILE_READ_CHECK=true skips the unread, partial and changed failures. Views are still
 * recorded and the changed/format notes still appear.
 */
import path from "path"
import { createHash } from "crypto"
import { realpathSync } from "fs"
import { diffLines } from "diff"
import { Context, Effect, Layer, Semaphore } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Format } from "@/format"
import * as Bom from "@/util/bom"

/** Files up to this size are hashed, so `touch` or a no-op formatter run is not mistaken for a change. */
export const HASH_MAX_BYTES = 4 * 1024 * 1024
const MAX_ENTRIES = 500
const MAX_SESSIONS = 200

/** 1-indexed, inclusive line range. */
export type Range = readonly [number, number]

export type Source = "read" | "shell" | "edit" | "write" | "apply_patch"

export type View = {
  /** key(path) of the file. */
  file: string
  mtimeMs: number
  size: number
  /** sha256 hex of the raw bytes, only for files up to HASH_MAX_BYTES. */
  hash?: string
  /** Total line count, when known. */
  lines?: number
  ranges: Range[]
  full: boolean
  source: Source
  /** When the view was recorded (ms), to order views from history and the overlay. */
  time: number
}

export type Entry = View & { messageID: string }

export type Status = { kind: "unread" } | { kind: "fresh"; entry: View } | { kind: "changed"; entry: View }

export type Version = { mtimeMs: number; size: number; hash?: string }

export type Snapshot = Version & {
  lines: number
  bytes: Uint8Array
  text: string
  bom: boolean
}

// Pure helpers ---------------------------------------------------------------

/** Canonical path used as the ledger and lock key: native realpath (canonical case on macOS), even for new files. */
export function key(p: string): string {
  const resolved = path.resolve(FSUtil.windowsPath(p))
  const rest: string[] = []
  for (let dir = resolved; ; dir = path.dirname(dir)) {
    try {
      const real = path.join(realpathSync.native(dir), ...rest)
      return process.platform === "win32" ? FSUtil.normalizePath(real) : real
    } catch {
      if (path.dirname(dir) === dir) return process.platform === "win32" ? FSUtil.normalizePath(resolved) : resolved
      rest.unshift(path.basename(dir))
    }
  }
}

/** Line count as the read tool counts it (Stream.splitLines): \r\n, \r and \n end a line; a final terminator adds none. */
export function countLines(text: string): number {
  if (!text) return 0
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 10) count++
    else if (code === 13) {
      count++
      if (text.charCodeAt(i + 1) === 10) i++
    }
  }
  const last = text.charCodeAt(text.length - 1)
  return last === 10 || last === 13 ? count : count + 1
}

export function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Same file version: equal hashes when both are known, otherwise equal mtime and size. */
export function sameVersion(a: Version, b: Version) {
  if (a.hash !== undefined && b.hash !== undefined) return a.hash === b.hash
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/** Sorted, merged ranges (adjacent ranges join). */
export function normalize(ranges: ReadonlyArray<Range>): Range[] {
  const sorted = ranges
    .filter((item) => item[0] <= item[1])
    .map((item) => [item[0], item[1]] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const result: [number, number][] = []
  for (const item of sorted) {
    const last = result[result.length - 1]
    if (last && item[0] <= last[1] + 1) last[1] = Math.max(last[1], item[1])
    else result.push(item)
  }
  return result
}

/** True when the ranges cover every line of a file with `lines` lines. */
export function coversAll(ranges: ReadonlyArray<Range>, lines: number) {
  if (lines === 0) return true
  const merged = normalize(ranges)
  return merged.length > 0 && merged[0][0] <= 1 && merged[0][1] >= lines
}

/** Folds a newer view into an older one: the same version unions the lines, a different version replaces it. */
export function merge(prev: View, next: View): View {
  if (!sameVersion(prev, next)) return next
  const lines = next.lines ?? prev.lines
  const ranges = normalize([...prev.ranges, ...next.ranges])
  return {
    ...next,
    hash: next.hash ?? prev.hash,
    lines,
    ranges,
    full: prev.full || next.full || (lines !== undefined && coversAll(ranges, lines)),
  }
}

function inRanges(ranges: ReadonlyArray<Range>, line: number) {
  return ranges.some((item) => line >= item[0] && line <= item[1])
}

export function covers(view: Pick<View, "full" | "ranges">, lines: ReadonlyArray<number>) {
  return view.full || lines.every((line) => inRanges(view.ranges, line))
}

function diffText(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n")
  return normalized && !normalized.endsWith("\n") ? normalized + "\n" : normalized
}

type Hunk =
  | { same: true; old: number; next: number; count: number }
  | { same: false; old: number; next: number; removed: number; added: number }

/** Line hunks between two texts, with 1-indexed start lines in the old and new text. */
function hunks(before: string, after: string): Hunk[] {
  const result: Hunk[] = []
  const pos = { old: 1, next: 1 }
  const size = (value: string) => value.split("\n").length - 1
  for (const change of diffLines(diffText(before), diffText(after))) {
    const count = size(change.value)
    if (!change.added && !change.removed) {
      result.push({ same: true, old: pos.old, next: pos.next, count })
      pos.old += count
      pos.next += count
      continue
    }
    const last = result[result.length - 1]
    const hunk =
      last && !last.same ? last : { same: false as const, old: pos.old, next: pos.next, removed: 0, added: 0 }
    if (hunk !== last) result.push(hunk)
    if (change.removed) {
      hunk.removed += count
      pos.old += count
    } else {
      hunk.added += count
      pos.next += count
    }
  }
  return result
}

/**
 * Old line numbers a change touches. A pure insertion sits between two lines and needs only one of them: the line
 * below it when `seen` covers that one, otherwise the line above it (or line 1).
 */
export function touched(before: string, after: string, seen?: Pick<View, "full" | "ranges">): number[] {
  const result: number[] = []
  for (const hunk of hunks(before, after)) {
    if (hunk.same) continue
    if (hunk.removed === 0) {
      result.push(seen && covers(seen, [hunk.old]) ? hunk.old : Math.max(hunk.old - 1, 1))
      continue
    }
    for (let line = hunk.old; line < hunk.old + hunk.removed; line++) result.push(line)
  }
  return result
}

/**
 * Maps the lines a view has seen from `before` to `after`. Unchanged lines keep their state. Lines added by a hunk are
 * seen when the agent wrote them (`authored`), or when a line the hunk replaced (for a pure insertion, a neighbour) was
 * seen. A full view stays full.
 */
export function remap<V extends View>(view: V, before: string, after: string, authored: boolean): V {
  const lines = countLines(after)
  if (view.full) return { ...view, ranges: [], lines, full: true }
  const ranges: Range[] = []
  for (const hunk of hunks(before, after)) {
    if (hunk.same) {
      const end = hunk.old + hunk.count - 1
      const shift = hunk.next - hunk.old
      for (const item of view.ranges) {
        const lo = Math.max(item[0], hunk.old)
        const hi = Math.min(item[1], end)
        if (lo <= hi) ranges.push([lo + shift, hi + shift])
      }
      continue
    }
    if (hunk.added === 0) continue
    const seen =
      authored ||
      (hunk.removed === 0
        ? inRanges(view.ranges, Math.max(hunk.old - 1, 1)) || inRanges(view.ranges, hunk.old)
        : view.ranges.some((item) => item[0] <= hunk.old + hunk.removed - 1 && item[1] >= hunk.old))
    if (seen) ranges.push([hunk.next, hunk.next + hunk.added - 1])
  }
  const merged = normalize(ranges)
  return { ...view, ranges: merged, lines, full: coversAll(merged, lines) }
}

/** Formats ranges as "1-100, 250". */
export function formatRanges(ranges: ReadonlyArray<Range>) {
  return normalize(ranges)
    .map((item) => (item[0] === item[1] ? `${item[0]}` : `${item[0]}-${item[1]}`))
    .join(", ")
}

function collapse(lines: ReadonlyArray<number>): Range[] {
  return normalize(lines.map((line) => [line, line] as const))
}

type Flags = { flags: string[]; values: Map<string, string>; positionals: string[] }

/** Minimal option parser: short clusters, --long=value, known valued options, `--` ends options. */
function parseFlags(args: ReadonlyArray<string>, short: string, long: ReadonlyArray<string>): Flags | undefined {
  const result: Flags = { flags: [], values: new Map(), positionals: [] }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--") {
      result.positionals.push(...args.slice(i + 1))
      break
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=")
      const name = eq === -1 ? arg : arg.slice(0, eq)
      result.flags.push(name)
      if (eq !== -1) result.values.set(name, arg.slice(eq + 1))
      else if (long.includes(name)) {
        if (i + 1 >= args.length) return
        result.values.set(name, args[++i])
      }
      continue
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const name = `-${arg[j]}`
        result.flags.push(name)
        if (!short.includes(arg[j])) continue
        const rest = arg.slice(j + 1)
        if (rest) result.values.set(name, rest)
        else {
          if (i + 1 >= args.length) return
          result.values.set(name, args[++i])
        }
        break
      }
      continue
    }
    result.positionals.push(arg)
  }
  return result
}

const count = (text: string | undefined) => (text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined)

function clamp(ranges: ReadonlyArray<Range>, lines: number | undefined): Range[] {
  if (lines === undefined) return normalize(ranges)
  return normalize(ranges.map((item) => [item[0], Math.min(item[1], lines)] as const))
}

const SED_ADDRESS = String.raw`(\d+|\$)`
const SED_SCRIPT = new RegExp(String.raw`^(?:${SED_ADDRESS}(?:,${SED_ADDRESS})?)?p$`)

/**
 * The lines a shell viewer printed from its one file: "full", ranges, or undefined when that cannot be told exactly.
 * `argv` is the classifier's stripped argv (argv[0] is the program); `lines` resolves tail and `$`.
 */
export function shellView(
  name: string,
  argv: ReadonlyArray<string>,
  output: string,
  lines?: number,
): Range[] | "full" | undefined {
  const program = path.basename(name).toLowerCase()
  const args = argv.slice(1)
  switch (program) {
    case "cat": {
      const parsed = parseFlags(args, "", [])
      if (!parsed || parsed.positionals.length !== 1) return
      if (!parsed.flags.every((flag) => ["-n", "-b", "-u", "--number", "--number-nonblank"].includes(flag))) return
      return "full"
    }
    case "head": {
      const numeric = args.map((arg) => (/^-\d+$/.test(arg) ? `-n${arg.slice(1)}` : arg))
      const parsed = parseFlags(numeric, "nc", ["--lines", "--bytes"])
      if (!parsed || parsed.positionals.length !== 1) return
      if (
        !parsed.flags.every((flag) => ["-n", "--lines", "-q", "-v", "--quiet", "--silent", "--verbose"].includes(flag))
      )
        return
      const text = parsed.values.get("-n") ?? parsed.values.get("--lines")
      const n = text === undefined ? 10 : count(text)
      if (n === undefined) return
      if (n === 0) return []
      if (lines !== undefined && n >= lines) return "full"
      return clamp([[1, n]], lines)
    }
    case "tail": {
      if (lines === undefined) return
      const numeric = args.map((arg) => (/^-\d+$/.test(arg) ? `-n${arg.slice(1)}` : arg))
      const parsed = parseFlags(numeric, "nc", ["--lines", "--bytes"])
      if (!parsed || parsed.positionals.length !== 1) return
      if (
        !parsed.flags.every((flag) => ["-n", "--lines", "-q", "-v", "--quiet", "--silent", "--verbose"].includes(flag))
      )
        return
      const text = parsed.values.get("-n") ?? parsed.values.get("--lines") ?? "10"
      if (text.startsWith("+")) {
        const start = count(text.slice(1))
        if (start === undefined) return
        const from = Math.max(start, 1)
        if (from <= 1) return "full"
        return from > lines ? [] : [[from, lines]]
      }
      const n = count(text)
      if (n === undefined) return
      if (n >= lines) return "full"
      return n === 0 ? [] : [[lines - n + 1, lines]]
    }
    case "sed": {
      const scripts: string[] = []
      const positionals: string[] = []
      const state = { quiet: false }
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === "--") {
          positionals.push(...args.slice(i + 1))
          break
        }
        if (arg === "--quiet" || arg === "--silent") state.quiet = true
        else if (arg === "--expression") {
          if (i + 1 >= args.length) return
          scripts.push(args[++i])
        } else if (arg.startsWith("--expression=")) scripts.push(arg.slice("--expression=".length))
        else if (arg === "--regexp-extended" || arg === "--unbuffered") continue
        // A cluster of -n, -E, -r, -u, optionally ending in -e SCRIPT.
        else if (/^-[nEru]*e?$/.test(arg) && arg.length > 1) {
          if (arg.includes("n")) state.quiet = true
          if (!arg.endsWith("e")) continue
          if (i + 1 >= args.length) return
          scripts.push(args[++i])
        } else if (arg.startsWith("-") && arg.length > 1) return
        else positionals.push(arg)
      }
      if (scripts.length === 0) {
        const first = positionals.shift()
        if (first === undefined) return
        scripts.push(first)
      }
      if (!state.quiet || positionals.length !== 1) return
      const commands = scripts.flatMap((script) => script.split(/[;\n]/)).map((item) => item.trim())
      const result: Range[] = []
      for (const command of commands.filter(Boolean)) {
        const match = SED_SCRIPT.exec(command)
        if (!match) return
        if (match[1] === undefined) return "full"
        const address = (text: string) => (text === "$" ? lines : Number(text))
        const start = address(match[1])
        const end = match[2] === undefined ? start : address(match[2])
        if (start === undefined || end === undefined) return
        if (start <= 0) return
        result.push([start, Math.max(start, end)])
      }
      const ranges = clamp(result, lines)
      if (lines !== undefined && coversAll(ranges, lines)) return "full"
      return ranges
    }
    case "grep":
    case "egrep":
    case "fgrep":
    case "rg": {
      const rg = program === "rg"
      const parsed = rg
        ? parseFlags(args, "efgtTmABCjMdEr", [
            "--regexp",
            "--file",
            "--glob",
            "--iglob",
            "--type",
            "--type-not",
            "--max-count",
            "--after-context",
            "--before-context",
            "--context",
            "--threads",
            "--max-columns",
            "--max-depth",
            "--encoding",
            "--engine",
            "--replace",
            "--sort",
            "--sortr",
          ])
        : parseFlags(args, "efmABCdD", [
            "--regexp",
            "--file",
            "--max-count",
            "--after-context",
            "--before-context",
            "--context",
            "--label",
            "--binary-files",
            "--devices",
            "--directories",
          ])
      if (!parsed) return
      if (!parsed.flags.some((flag) => flag === "-n" || flag === "--line-number")) return
      const deny = [
        "-c",
        "-l",
        "-L",
        "-o",
        "-q",
        "-H",
        "-Z",
        "-z",
        "--count",
        "--count-matches",
        "--files",
        "--files-with-matches",
        "--files-without-match",
        "--only-matching",
        "--quiet",
        "--silent",
        "--with-filename",
        "--null",
        "--null-data",
        "--json",
        "--vimgrep",
        "--heading",
        "--passthru",
        "--column",
        // Colour codes hide the line number, and recursion can prefix file names; both then record nothing or are refused.
        ...(rg
          ? ["-N", "--no-line-number", "-r", "--replace", "-M", "--max-columns", "-p", "--pretty"]
          : ["-T", "-r", "-R", "--recursive", "--dereference-recursive"]),
      ]
      if (parsed.flags.some((flag) => deny.includes(flag) || flag.startsWith("--files"))) return
      const found: number[] = []
      for (const line of output.split(/\r?\n/)) {
        const match = /^(\d+)[:-]/.exec(line)
        if (match) found.push(Number(match[1]))
      }
      return clamp(collapse(found), lines)
    }
  }
}

/**
 * True when every line in `ranges` of `text` appears in `output`, in file order. A viewer's claimed lines only count
 * when the model really got them: output redirected away, captured by a substitution or never produced fails this.
 * Line prefixes (cat -n, grep -n) and interleaved stderr are fine; lines are matched as substrings.
 */
export function printed(output: string, text: string, ranges: ReadonlyArray<Range>) {
  const lines = text.split(/\r\n|\r|\n/)
  const state = { at: 0 }
  for (const [start, end] of normalize(ranges)) {
    for (let line = start; line <= end && line <= lines.length; line++) {
      const value = lines[line - 1]
      if (!value) continue
      const found = output.indexOf(value, state.at)
      if (found === -1) return false
      state.at = found + value.length
    }
  }
  return true
}

// Messages -----------------------------------------------------------------------

export function unreadError(file: string, verb: "edit" | "overwrite") {
  return `You must read ${file} with the read tool before you ${verb} it. The file exists and has not been read in this session, or its read is no longer in your context (compacted or pruned).`
}

/** `need` is the lines an edit replaces; undefined for an overwrite, which needs the whole file. */
export function partialError(file: string, view: Pick<View, "ranges">, need?: ReadonlyArray<number>) {
  const seen = view.ranges.length ? `only read lines ${formatRanges(view.ranges)}` : "not read any lines"
  if (need === undefined) return `You have ${seen} of ${file}; you must read the whole file before overwriting it.`
  const missing = collapse(need.filter((line) => !inRanges(view.ranges, line)))
  return `You have ${seen} of ${file}. Read lines ${formatRanges(missing)} (or the whole file) before editing those lines.`
}

export function changedError(file: string, verb: "edit" | "overwrite") {
  return `${file} has been modified since you last read it (by the user, a formatter or another process). Read it again before ${verb === "edit" ? "editing" : "overwriting"} it.`
}

export function changedNote(file: string) {
  return `Note: ${file} had changed on disk since you last read it. oldString matched the current content exactly, so the edit was applied, but you have not seen the other changes; read the file again before relying on its contents.`
}

export function raceError(file: string) {
  return `${file} changed while waiting for approval; nothing was written. Read it again and retry.`
}

export function formatNote(file: string, names: ReadonlyArray<string>, added: number, removed: number) {
  return `Note: the formatter (${names.join(", ")}) rewrote ${file} after this change (+${added}/-${removed} lines). The file now differs from the text you sent; read the reformatted lines before editing them again.`
}

export function formatFailedNote(name: string, code?: number) {
  return code === undefined
    ? `Note: formatter ${name} could not be started.`
    : `Note: formatter ${name} exited with code ${code}.`
}

/** Added and removed line counts between two texts, as the format note reports them. */
export function lineDelta(before: string, after: string) {
  const result = { added: 0, removed: 0 }
  for (const hunk of hunks(before, after)) {
    if (hunk.same) continue
    result.added += hunk.added
    result.removed += hunk.removed
  }
  return result
}

// Files and locks -----------------------------------------------------------------

/** Reads a file once: its version (stat taken first), bytes, BOM-stripped text and line count. */
export const read = Effect.fn("FileReads.read")(function* (fs: FSUtil.Interface, file: string) {
  const info = yield* fs.stat(file)
  const bytes = yield* fs.readFile(file)
  const source = Bom.split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes))
  return {
    mtimeMs: info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0,
    size: Number(info.size),
    hash: bytes.byteLength <= HASH_MAX_BYTES ? hashBytes(bytes) : undefined,
    lines: countLines(source.text),
    bytes,
    text: source.text,
    bom: source.bom,
  } satisfies Snapshot
})

/**
 * True when the file no longer matches `snap` (changed, created or deleted). Used right after a permission prompt, so
 * a change made while the prompt was open is never overwritten.
 */
export const changedSince = Effect.fn("FileReads.changedSince")(function* (
  fs: FSUtil.Interface,
  file: string,
  snap: { mtimeMs: number; size: number; bytes: Uint8Array } | undefined,
) {
  const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!snap || !info) return !!snap !== !!info
  const mtimeMs = info.mtime._tag === "Some" ? info.mtime.value.getTime() : 0
  const size = Number(info.size)
  if (size !== snap.bytes.byteLength) return true
  if (mtimeMs === snap.mtimeMs && size === snap.size && size > HASH_MAX_BYTES) return false
  const bytes = yield* fs.readFile(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
  return !bytes || !Buffer.from(bytes).equals(Buffer.from(snap.bytes))
})

/**
 * Runs the configured formatters after a tool wrote `written` to `file`, restores its BOM, and returns the final text
 * with notes for a real rewrite (the text changed) and for formatters that failed.
 */
export const formatWritten = Effect.fn("FileReads.formatWritten")(function* (
  format: Format.Interface,
  fs: FSUtil.Interface,
  file: string,
  bom: boolean,
  written: string,
) {
  const out = yield* format.apply(file)
  const notes: string[] = []
  const text = out.ran.length > 0 ? yield* Bom.syncFile(fs, file, bom) : written
  if (text !== written) {
    const delta = lineDelta(written, text)
    const names = out.ran.filter((name) => !out.failed.some((item) => item.name === name && item.code === undefined))
    notes.push(formatNote(file, names, delta.added, delta.removed))
  }
  for (const item of out.failed) notes.push(formatFailedNote(item.name, item.code))
  return { text, notes }
})

/** The view a tool records for its own write: `base` mapped through the agent's change, then the formatter's. */
export const recordWrite = Effect.fn("FileReads.recordWrite")(function* (
  fs: FSUtil.Interface,
  file: string,
  input: { base: View | undefined; before: string; written: string; final: string; source: Source },
) {
  const empty: View = { file: key(file), mtimeMs: 0, size: 0, ranges: [], full: false, source: input.source, time: 0 }
  const authored = remap(input.base ?? empty, input.before, input.written, true)
  const view = input.final === input.written ? authored : remap(authored, input.written, input.final, false)
  const snap = yield* read(fs, file).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!snap) return
  return {
    ...view,
    file: key(file),
    mtimeMs: snap.mtimeMs,
    size: snap.size,
    hash: snap.hash,
    lines: snap.lines,
    full: view.full || snap.lines === 0,
    source: input.source,
    time: Date.now(),
  } satisfies View
})

const locks = new Map<string, Semaphore.Semaphore>()

function semaphore(file: string) {
  const hit = locks.get(file)
  if (hit) return hit
  const next = Semaphore.makeUnsafe(1)
  locks.set(file, next)
  return next
}

/**
 * Runs `effect` holding the per-file lock of every file, shared by edit, write and apply_patch. Keys are taken in
 * sorted order so a multi-file patch cannot deadlock against another tool call.
 */
export function withLock<A, E, R>(
  files: ReadonlyArray<string | undefined>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const keys = [...new Set(files.filter((file): file is string => !!file).map(key))].sort()
    return keys.reduceRight((inner, file) => semaphore(file).withPermits(1)(inner), effect)
  })
}

// Service -----------------------------------------------------------------------

export type RecordContext = { sessionID: string; messageID: string }
export type StatusContext = RecordContext & { messages?: ReadonlyArray<SessionV1.WithParts> }

export interface Interface {
  /** False when OPENCODE_DISABLE_FILE_READ_CHECK is set: views are still recorded but never fail a tool. */
  readonly enforce: boolean
  readonly record: (ctx: RecordContext, views: ReadonlyArray<View>) => Effect.Effect<void>
  readonly status: (
    ctx: StatusContext,
    file: string,
    current: Version & { bytes?: Uint8Array },
  ) => Effect.Effect<Status>
  readonly snapshot: (file: string) => Effect.Effect<Snapshot, FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileReads") {}

export function isView(value: unknown): value is View {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return (
    typeof item.file === "string" &&
    typeof item.mtimeMs === "number" &&
    typeof item.size === "number" &&
    typeof item.full === "boolean" &&
    Array.isArray(item.ranges) &&
    item.ranges.every((range) => Array.isArray(range) && typeof range[0] === "number" && typeof range[1] === "number")
  )
}

type Scan = { views: Map<string, View[]> }

const scans = new WeakMap<object, Scan>()

/** Views the model can still see in `messages`, per file key. */
export function scan(messages: ReadonlyArray<SessionV1.WithParts>): Scan {
  const hit = scans.get(messages)
  if (hit) return hit
  const result: Scan = { views: new Map() }
  const add = (value: unknown, created: number, compacted: boolean) => {
    if (!Array.isArray(value)) return
    for (const item of value) {
      if (!isView(item)) continue
      if (compacted && item.source !== "write") continue
      const view = { ...item, time: typeof item.time === "number" ? item.time : created }
      const list = result.views.get(view.file) ?? []
      list.push(view)
      result.views.set(view.file, list)
    }
  }
  for (const msg of messages) {
    const created = msg.info.time.created
    for (const part of msg.parts) {
      if (part.type === "tool" && part.state.status === "completed")
        add(part.state.metadata?.ledger, created, !!part.state.time.compacted)
      if (part.type === "text" && part.synthetic) add(part.metadata?.ledger, created, false)
    }
  }
  scans.set(messages, result)
  return result
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const flags = yield* RuntimeFlags.Service
    const overlay = new Map<string, Entry[]>()

    const record = (ctx: RecordContext, views: ReadonlyArray<View>) =>
      Effect.sync(() => {
        if (views.length === 0) return
        const entries = overlay.get(ctx.sessionID) ?? []
        entries.push(...views.map((view) => ({ ...view, messageID: ctx.messageID })))
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
        overlay.delete(ctx.sessionID)
        overlay.set(ctx.sessionID, entries)
        while (overlay.size > MAX_SESSIONS) {
          const oldest = overlay.keys().next().value
          if (oldest === undefined) break
          overlay.delete(oldest)
        }
      })

    const status = (ctx: StatusContext, file: string, current: Version & { bytes?: Uint8Array }) =>
      Effect.sync((): Status => {
        const target = key(file)
        const history = scan(ctx.messages ?? [])
        const entries = overlay.get(ctx.sessionID)
        // Later steps see the persisted tool results in history, with their pruned state.
        const valid = entries?.filter((entry) => entry.messageID === ctx.messageID)
        if (entries && valid && valid.length !== entries.length) overlay.set(ctx.sessionID, valid)
        const candidates = [
          ...(history.views.get(target) ?? []),
          ...(valid ?? []).filter((entry) => entry.file === target),
        ]
          .map((view, index) => ({ view, index }))
          .sort((a, b) => a.view.time - b.view.time || a.index - b.index)
        if (candidates.length === 0) return { kind: "unread" }
        const folded = candidates.slice(1).reduce((prev, item) => merge(prev, item.view), candidates[0].view)
        const { messageID: _, ...entry } = folded as Entry
        if (sameVersion(entry, current)) return { kind: "fresh", entry }
        const hash =
          current.hash ??
          (current.bytes && current.bytes.byteLength <= HASH_MAX_BYTES ? hashBytes(current.bytes) : undefined)
        if (entry.hash !== undefined && entry.hash === hash) return { kind: "fresh", entry }
        return { kind: "changed", entry }
      })

    return Service.of({
      enforce: !flags.disableFileReadCheck,
      record,
      status,
      snapshot: (file) => read(fs, file),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node, RuntimeFlags.node] })

export * as FileReads from "./file-reads"
