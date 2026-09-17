import { describe, expect, spyOn, test } from "bun:test"
import { $ } from "bun"
import childProcess from "child_process"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { WorkspaceTrustKey } from "../../src/trust/key"
import { tmpdir } from "../fixture/fixture"

const caseInsensitive = process.platform === "darwin" || process.platform === "win32"
const norm = (value: string) => WorkspaceTrustKey.normalize(value)

describe("WorkspaceTrustKey.resolve", () => {
  test("a subdirectory of a git repository keys to the repository root", async () => {
    await using tmp = await tmpdir({ git: true })
    const sub = path.join(tmp.path, "src", "deep")
    await fs.mkdir(sub, { recursive: true })
    const info = WorkspaceTrustKey.resolve(sub)
    expect(info.kind).toBe("repository")
    expect(info.path).toBe(tmp.path)
    expect(info.key).toBe(norm(tmp.path))
    expect(info.sessionOnly).toBe(false)
  })

  test("a linked worktree keys to its main checkout", async () => {
    await using tmp = await tmpdir({ git: true })
    const worktree = path.join(tmp.path, "..", path.basename(tmp.path) + "-wt")
    await $`git worktree add ${worktree}`.cwd(tmp.path).quiet()
    try {
      const real = await fs.realpath(worktree)
      expect(await Bun.file(path.join(real, ".git")).text()).toContain("gitdir:")
      const info = WorkspaceTrustKey.resolve(real)
      expect(info.kind).toBe("repository")
      expect(info.key).toBe(norm(tmp.path))
    } finally {
      await $`git worktree remove --force ${worktree}`.cwd(tmp.path).quiet().nothrow()
      await fs.rm(worktree, { recursive: true, force: true })
    }
  })

  test("a forged .git file cannot borrow another repository's key", async () => {
    await using tmp = await tmpdir()
    const victim = path.join(tmp.path, "victim")
    const evil = path.join(tmp.path, "evil")
    await fs.mkdir(victim)
    await $`git init`.cwd(victim).quiet()
    await fs.mkdir(path.join(evil, "fakegit"), { recursive: true })
    await fs.writeFile(path.join(evil, ".git"), "gitdir: fakegit\n")
    // Absolute and relative commondir forms, with and without a back-reference that points somewhere else.
    for (const commondir of [path.join(victim, ".git"), "../../victim/.git"]) {
      await fs.writeFile(path.join(evil, "fakegit", "commondir"), commondir + "\n")
      expect(WorkspaceTrustKey.resolve(evil)).toMatchObject({ kind: "repository", key: norm(evil) })
      await fs.writeFile(path.join(evil, "fakegit", "gitdir"), path.join(victim, ".git") + "\n")
      expect(WorkspaceTrustKey.resolve(evil)).toMatchObject({ kind: "repository", key: norm(evil) })
      await fs.rm(path.join(evil, "fakegit", "gitdir"))
    }
    // A gitdir inside the victim's real worktrees folder still needs a back-reference to this folder.
    const worktree = path.join(tmp.path, "real-wt")
    await $`git -c user.name=t -c user.email=t@t commit --allow-empty -m init`.cwd(victim).quiet()
    await $`git worktree add ${worktree}`.cwd(victim).quiet()
    const gitdir = (await fs.readFile(path.join(worktree, ".git"), "utf8")).replace(/^gitdir:\s*/, "").trim()
    await fs.writeFile(path.join(evil, ".git"), `gitdir: ${gitdir}\n`)
    expect(WorkspaceTrustKey.resolve(evil).key).toBe(norm(evil))
    expect(WorkspaceTrustKey.resolve(await fs.realpath(worktree)).key).toBe(norm(await fs.realpath(victim)))
  })

  test("a folder below a repository at the home folder keys on itself, not on home", async () => {
    await using tmp = await tmpdir()
    const home = tmp.path
    await $`git init`.cwd(home).quiet()
    const child = path.join(home, "scratch", "tool")
    await fs.mkdir(child, { recursive: true })
    expect(WorkspaceTrustKey.resolve(child, { home })).toMatchObject({
      kind: "directory",
      key: norm(child),
      sessionOnly: false,
    })
    expect(WorkspaceTrustKey.resolve(home, { home }).sessionOnly).toBe(true)
    // A real repository under that home still keys on its own root.
    const repo = path.join(home, "code", "repo")
    await fs.mkdir(path.join(repo, "src"), { recursive: true })
    await $`git init`.cwd(repo).quiet()
    expect(WorkspaceTrustKey.resolve(path.join(repo, "src"), { home })).toMatchObject({
      kind: "repository",
      key: norm(repo),
    })
  })

  test("a submodule-style .git file without commondir keys to its own root", async () => {
    await using tmp = await tmpdir()
    const nested = path.join(tmp.path, "sub")
    await fs.mkdir(path.join(tmp.path, "modules", "sub"), { recursive: true })
    await fs.mkdir(nested, { recursive: true })
    await fs.writeFile(path.join(nested, ".git"), "gitdir: ../modules/sub\n")
    const info = WorkspaceTrustKey.resolve(nested)
    expect(info.kind).toBe("repository")
    expect(info.key).toBe(norm(nested))
  })

  test("a nested repository inside a plain folder gets its own repository key", async () => {
    await using tmp = await tmpdir()
    const nested = path.join(tmp.path, "clone")
    await fs.mkdir(nested)
    await $`git init`.cwd(nested).quiet()
    expect(WorkspaceTrustKey.resolve(tmp.path)).toMatchObject({ kind: "directory", key: norm(tmp.path) })
    expect(WorkspaceTrustKey.resolve(nested)).toMatchObject({ kind: "repository", key: norm(nested) })
  })

  test("a folder outside version control keys to itself", async () => {
    await using tmp = await tmpdir()
    const child = path.join(tmp.path, "a")
    await fs.mkdir(child)
    expect(WorkspaceTrustKey.resolve(child)).toMatchObject({ kind: "directory", path: child, sessionOnly: false })
  })

  test("the home directory and the filesystem root are session only", () => {
    expect(WorkspaceTrustKey.resolve(Global.Path.home).sessionOnly).toBe(true)
    expect(WorkspaceTrustKey.resolve(path.parse(process.cwd()).root).sessionOnly).toBe(true)
  })

  test("a symlinked directory resolves through its real path", async () => {
    await using tmp = await tmpdir({ git: true })
    await using links = await tmpdir()
    const link = path.join(links.path, "link")
    await fs.symlink(tmp.path, link)
    expect(WorkspaceTrustKey.resolve(link).key).toBe(norm(tmp.path))
  })

  test.skipIf(!caseInsensitive)("keys are case-normalized on case-insensitive platforms", async () => {
    await using tmp = await tmpdir()
    const info = WorkspaceTrustKey.resolve(tmp.path)
    expect(info.key).toBe(tmp.path.normalize("NFC").toLowerCase())
    expect(info.path).toBe(tmp.path)
  })

  test("resolving a key never spawns a process", async () => {
    await using tmp = await tmpdir({ git: true })
    const spawn = spyOn(childProcess, "spawn")
    const spawnSync = spyOn(childProcess, "spawnSync")
    const bunSpawn = spyOn(Bun, "spawn")
    const bunSpawnSync = spyOn(Bun, "spawnSync")
    try {
      WorkspaceTrustKey.resolve(path.join(tmp.path, "missing", "child"))
      WorkspaceTrustKey.resolve(tmp.path)
      expect(spawn).not.toHaveBeenCalled()
      expect(spawnSync).not.toHaveBeenCalled()
      expect(bunSpawn).not.toHaveBeenCalled()
      expect(bunSpawnSync).not.toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
      spawnSync.mockRestore()
      bunSpawn.mockRestore()
      bunSpawnSync.mockRestore()
    }
  })

  test("covers matches the key itself and paths below it only", () => {
    expect(WorkspaceTrustKey.covers("/a/b", "/a/b")).toBe(true)
    expect(WorkspaceTrustKey.covers("/a/b", "/a/b/c")).toBe(true)
    expect(WorkspaceTrustKey.covers("/a/b", "/a/bc")).toBe(false)
  })
})
