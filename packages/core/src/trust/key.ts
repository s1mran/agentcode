export * as WorkspaceTrustKey from "./key"

import path from "path"
import { readFileSync, realpathSync, statSync } from "fs"
import { Global } from "../global"

/**
 * Which folder a trust decision belongs to, from the filesystem alone. No git process ever runs here: in a folder
 * nobody has trusted yet, `.git/config` could name an fsmonitor or other hook that executes on any git command.
 *
 * - Inside a repository the key is the repo root, and a linked worktree keys to its main checkout, so every worktree of
 *   a trusted repo is trusted. A nested repository (a submodule or a clone inside another folder) has its own key.
 * - Outside a repository the key is the directory itself; a stored decision on a parent directory covers it.
 * - The home directory and the filesystem root are trusted for the session only and never stored. A repository rooted at
 *   either (a dotfiles repo in home) does not capture the folders below it: they key on themselves.
 *
 * The project id is never used: every clone of a repo shares its root-commit id, so a fork would inherit trust.
 */

export type Kind = "repository" | "directory"

export interface Info {
  /** Normalized: NFC, and lower case on case-insensitive platforms. */
  readonly key: string
  /** The display form of the same path. */
  readonly path: string
  readonly kind: Kind
  readonly sessionOnly: boolean
}

const caseInsensitive = process.platform === "darwin" || process.platform === "win32"

export function normalize(input: string) {
  const value = input.normalize("NFC")
  return caseInsensitive ? value.toLowerCase() : value
}

function real(input: string) {
  try {
    return realpathSync.native(input)
  } catch {
    return path.resolve(input)
  }
}

function stat(input: string) {
  try {
    return statSync(input)
  } catch {
    return undefined
  }
}

function read(input: string) {
  try {
    return readFileSync(input, "utf8")
  } catch {
    return undefined
  }
}

/**
 * The main checkout of a linked worktree whose `.git` file is `dotgit`, or undefined when it is not one. Every file read
 * here ships with the folder, so the link only counts when git's own structure confirms it: the gitdir is
 * `<main>/.git/worktrees/<name>`, and that folder's `gitdir` file points back at this `.git` file. A folder cannot write
 * that back-reference into another repository, so a forged `.git` or `commondir` never borrows another repo's trust.
 */
function mainCheckout(root: string, dotgit: string) {
  const text = read(dotgit)
  const match = text?.match(/^gitdir:\s*(.+?)\s*$/m)
  if (!match) return
  const gitdir = real(path.resolve(root, match[1]))
  const commondir = read(path.join(gitdir, "commondir"))?.trim()
  // A submodule's gitdir has no commondir: it is a nested repository keyed on its own root.
  if (!commondir) return
  const common = real(path.resolve(gitdir, commondir))
  if (path.basename(common) !== ".git") return
  if (!stat(common)?.isDirectory()) return
  if (normalize(path.dirname(gitdir)) !== normalize(path.join(common, "worktrees"))) return
  const back = read(path.join(gitdir, "gitdir"))?.trim()
  if (!back) return
  if (normalize(real(path.resolve(gitdir, back))) !== normalize(real(dotgit))) return
  const main = path.dirname(common)
  if (!stat(main)?.isDirectory()) return
  return main
}

function isRoot(input: string) {
  return path.parse(input).root === input
}

export function resolve(directory: string, options: { home?: string } = {}): Info {
  const start = real(directory)
  const home = normalize(real(options.home ?? Global.Path.home))
  const make = (target: string, kind: Kind): Info => {
    const key = normalize(target)
    return { key, path: target, kind, sessionOnly: key === home || isRoot(target) }
  }

  // A repository at the home folder or the filesystem root (a dotfiles repo) would make every folder under it
  // session-only; a folder below one keys on itself instead, like a folder outside version control.
  const broad = (target: string) => normalize(target) === home || isRoot(target)
  const repository = (target: string) =>
    broad(target) && normalize(target) !== normalize(start) ? make(start, "directory") : make(target, "repository")

  let current = start
  for (let i = 0; i < 256; i++) {
    const dotgit = path.join(current, ".git")
    const info = stat(dotgit)
    if (info?.isDirectory()) return repository(current)
    if (info?.isFile()) {
      const main = mainCheckout(current, dotgit)
      return repository(main && !broad(main) ? main : current)
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return make(start, "directory")
}

/** Whether `child` is `parent` or inside it, both already normalized keys. */
export function covers(parent: string, child: string) {
  if (parent === child) return true
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep
  return child.startsWith(prefix)
}
