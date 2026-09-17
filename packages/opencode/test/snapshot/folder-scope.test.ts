import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { LIMITS, SKIP_DIRS, probe, prober, refuse, resolveScope } from "../../src/snapshot/folder"

const home = path.join(path.sep, "Users", "someone")
const data = path.join(home, ".local", "share", "agentcode")
const base = { home, data }

describe("resolveScope", () => {
  test("keeps git mode for a normal repo", () => {
    const repo = path.join(home, "code", "app")
    expect(resolveScope({ ...base, vcs: "git", worktree: repo, directory: path.join(repo, "src") })).toEqual({
      mode: "git",
      worktree: repo,
    })
  })

  test("uses folder mode on the opened directory for a plain folder", () => {
    const dir = path.join(home, "notes")
    expect(resolveScope({ ...base, vcs: undefined, worktree: "/", directory: dir })).toEqual({
      mode: "folder",
      worktree: dir,
    })
  })

  test("uses folder mode when a fake git vcs reports the filesystem root", () => {
    const dir = path.join(home, "notes")
    expect(resolveScope({ ...base, vcs: "git", worktree: path.parse(dir).root, directory: dir })).toEqual({
      mode: "folder",
      worktree: dir,
    })
  })

  test("uses folder mode on a child folder of a dotfiles repo at home", () => {
    const dir = path.join(home, "proj")
    expect(resolveScope({ ...base, vcs: "git", worktree: home, directory: dir })).toEqual({
      mode: "folder",
      worktree: dir,
    })
  })

  test("turns checkpoints off when the opened directory is home", () => {
    expect(resolveScope({ ...base, vcs: undefined, worktree: "/", directory: home })).toEqual({
      mode: "off",
      worktree: home,
      reason: "home",
    })
    expect(resolveScope({ ...base, vcs: "git", worktree: home, directory: home })).toEqual({
      mode: "off",
      worktree: home,
      reason: "home",
    })
  })
})

describe("refuse", () => {
  test("refuses a filesystem root", () => {
    expect(refuse(path.parse(process.cwd()).root, base)).toBe("root")
  })

  test.skipIf(process.platform !== "win32")("refuses a windows drive root", () => {
    expect(refuse("C:\\", base)).toBe("root")
  })

  test("refuses home and its ancestors but not its children", () => {
    expect(refuse(home, base)).toBe("home")
    expect(refuse(path.dirname(home), base)).toBe("home")
    expect(refuse(path.join(home, "code"), base)).toBeUndefined()
  })

  test("refuses folders containing or inside the data dir", () => {
    expect(refuse(path.join(home, ".local"), base)).toBe("data-dir")
    expect(refuse(data, base)).toBe("data-dir")
    expect(refuse(path.join(data, "snapshot"), base)).toBe("data-dir")
    expect(refuse(path.join(home, ".local", "state"), base)).toBeUndefined()
  })
})

describe("probe", () => {
  let dir = ""
  let outside = ""

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentcode-probe-"))
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "agentcode-probe-outside-"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  const write = async (file: string, content: string | Uint8Array) => {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await fs.writeFile(path.join(dir, file), content)
  }

  test("skip list covers dependency and build directories", () => {
    expect(SKIP_DIRS.has("node_modules")).toBe(true)
    expect(SKIP_DIRS.has(".git")).toBe(true)
    expect(SKIP_DIRS.has(".yarn/cache")).toBe(true)
    expect(SKIP_DIRS.has("*.pyc")).toBe(false)
  })

  test("reports too many files", async () => {
    for (let i = 0; i < 6; i++) await write(`f${i}.txt`, "x")
    const result = await probe(dir, { ...LIMITS, maxFiles: 5 })
    expect(result.over).toBe("too-many-files")
  })

  test("does not count files inside skipped directories", async () => {
    for (let i = 0; i < 3; i++) await write(`f${i}.txt`, "x")
    for (let i = 0; i < 10; i++) await write(`node_modules/pkg/f${i}.js`, "x")
    for (let i = 0; i < 10; i++) await write(`.yarn/cache/f${i}.zip`, "x")
    const result = await probe(dir, { ...LIMITS, maxFiles: 5 })
    expect(result).toEqual({ files: 3, bytes: 3 })
  })

  test("large files add no bytes", async () => {
    await write("big.bin", new Uint8Array(3 * 1024 * 1024))
    await write("small.txt", "hello")
    const result = await probe(dir)
    expect(result).toEqual({ files: 2, bytes: 5 })
  })

  test("reports too large", async () => {
    await write("a.txt", "0123456789")
    await write("b.txt", "0123456789")
    const result = await probe(dir, { ...LIMITS, maxBytes: 10 })
    expect(result.over).toBe("too-large")
  })

  test("does not follow a symlink to a directory outside", async () => {
    for (let i = 0; i < 10; i++) await fs.writeFile(path.join(outside, `f${i}.txt`), "x")
    await write("a.txt", "x")
    await fs.symlink(outside, path.join(dir, "linked"), "dir")
    const result = await probe(dir, { ...LIMITS, maxFiles: 5 })
    expect(result).toEqual({ files: 1, bytes: 1 })
  })

  test("a walk past its time budget reports slow, not too many files", async () => {
    for (let i = 0; i < 3; i++) await write(`f${i}.txt`, "x")
    const result = await probe(dir, { ...LIMITS, probeMs: -1 })
    expect(result.over).toBe("slow")
  })
})

describe("prober", () => {
  test("a walk that never settles resolves as slow instead of hanging", async () => {
    const run = prober("/nowhere", { ...LIMITS, probeMs: 10, probeGraceMs: 0 }, () => new Promise(() => {}))
    expect(await run()).toEqual({ files: 0, bytes: 0, over: "slow" })
  })

  test("caches a finished walk but walks again after a slow one", async () => {
    const results = [
      { files: 0, bytes: 0, over: "slow" as const },
      { files: 2, bytes: 4 },
    ]
    let calls = 0
    const run = prober("/nowhere", { ...LIMITS, retryMs: 0 }, async () => results[calls++]!)
    expect((await run()).over).toBe("slow")
    expect(await run()).toEqual({ files: 2, bytes: 4 })
    expect(await run()).toEqual({ files: 2, bytes: 4 })
    expect(calls).toBe(2)
  })
})
