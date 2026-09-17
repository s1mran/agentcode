import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { Snapshot } from "../../src/snapshot"
import { disposeAllInstances, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(LayerNode.compile(LayerNode.group([Snapshot.node, FSUtil.node])), testInstanceStoreLayer),
)

afterEach(async () => {
  await disposeAllInstances()
})

const fwd = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/")
const write = (file: string, content: string | Uint8Array) =>
  FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
const readText = (file: string) => FSUtil.Service.use((fs) => fs.readFileString(file))
const exists = (file: string) => FSUtil.Service.use((fs) => fs.existsSafe(file))
const rm = (file: string) =>
  FSUtil.Service.use((fs) => fs.remove(file, { recursive: true, force: true }).pipe(Effect.ignore))
const sleep = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))
const big = () => new Uint8Array(2 * 1024 * 1024 + 1)

// Point the test home at a folder for one test, restored when the test scope closes.
const homeAt = (target: (dir: string) => string) => (dir: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = target(dir)
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_TEST_HOME
        else process.env.OPENCODE_TEST_HOME = previous
      }),
  ).pipe(Effect.asVoid)

const setup = Effect.fn("FolderSnapshotTest.setup")(function* () {
  const dir = (yield* TestInstance).directory
  yield* write(`${dir}/a.txt`, "A0")
  yield* write(`${dir}/b.txt`, "B0")
  const snapshot = yield* Snapshot.Service
  const before = yield* snapshot.track()
  expect(before).toBeTruthy()
  return { dir, snapshot, before: before! }
})

it.instance("plain folder: tracks changes and reverts them", () =>
  Effect.gen(function* () {
    const { dir, snapshot, before } = yield* setup()
    expect(yield* snapshot.status()).toEqual({ mode: "folder", worktree: dir, reason: undefined })
    yield* write(`${dir}/a.txt`, "A1")
    yield* write(`${dir}/new.txt`, "NEW")
    const patch = yield* snapshot.patch(before, { touched: [path.join(dir, "new.txt")] })
    expect(patch.files).toContain(fwd(dir, "a.txt"))
    expect(patch.files).toContain(fwd(dir, "new.txt"))
    expect("skipped" in patch).toBe(false)
    yield* snapshot.revert([patch])
    expect(yield* readText(`${dir}/a.txt`)).toBe("A0")
    expect(yield* exists(`${dir}/new.txt`)).toBe(false)
    const marker = path.join(Global.Path.data, "snapshot", "global", Hash.fast(dir), "agentcode-worktree")
    expect((yield* Effect.promise(() => fs.readFile(marker, "utf8"))).trim()).toBe(dir)
  }),
)

it.instance("plain folder: restore brings back deleted and modified files", () =>
  Effect.gen(function* () {
    const { dir, snapshot, before } = yield* setup()
    yield* rm(`${dir}/a.txt`)
    yield* write(`${dir}/b.txt`, "B1")
    yield* snapshot.restore(before)
    expect(yield* readText(`${dir}/a.txt`)).toBe("A0")
    expect(yield* readText(`${dir}/b.txt`)).toBe("B0")
  }),
)

it.instance("plain folder: default excludes are never captured or reverted", () =>
  Effect.gen(function* () {
    const { dir, snapshot, before } = yield* setup()
    const excluded = [
      "node_modules/x/index.js",
      "dist/out.js",
      ".DS_Store",
      ".git/HEAD",
      "pkg/.git/config",
      ".opencode/settings.local.json",
    ]
    for (const file of excluded) yield* write(`${dir}/${file}`, "generated")
    yield* write(`${dir}/pkg/index.js`, "source")
    const patch = yield* snapshot.patch(before, {
      touched: [...excluded, "pkg/index.js"].map((file) => path.join(dir, file)),
    })
    expect(patch.files).toContain(fwd(dir, "pkg/index.js"))
    for (const file of excluded) expect(patch.files).not.toContain(fwd(dir, file))
    yield* snapshot.revert([patch])
    for (const file of excluded) expect(yield* exists(`${dir}/${file}`)).toBe(true)
    expect(yield* exists(`${dir}/pkg/index.js`)).toBe(false)
  }),
)

it.instance("plain folder: a .gitignore negation re-includes build output", () =>
  Effect.gen(function* () {
    const dir = (yield* TestInstance).directory
    yield* write(`${dir}/.gitignore`, "!build/\n")
    const { snapshot, before } = yield* setup()
    yield* write(`${dir}/build/app.js`, "built")
    yield* write(`${dir}/dist/app.js`, "built")
    const patch = yield* snapshot.patch(before, { touched: [path.join(dir, "build/app.js")] })
    expect(patch.files).toContain(fwd(dir, "build/app.js"))
    expect(patch.files).not.toContain(fwd(dir, "dist/app.js"))
  }),
)

it.instance("plain folder: large files created during the step are reported, not captured", () =>
  Effect.gen(function* () {
    const { dir, snapshot, before } = yield* setup()
    yield* write(`${dir}/old.bin`, big())
    const past = new Date(Date.now() - 60 * 60 * 1000)
    yield* Effect.promise(() => fs.utimes(`${dir}/old.bin`, past, past))
    const since = Date.now()
    yield* sleep(20)
    yield* write(`${dir}/big.bin`, big())
    const patch = yield* snapshot.patch(before, { since })
    expect(patch.skipped).toEqual([{ file: fwd(dir, "big.bin"), reason: "large" }])
    expect(patch.files).not.toContain(fwd(dir, "big.bin"))
    expect(patch.files).not.toContain(fwd(dir, "old.bin"))
    yield* snapshot.revert([patch])
    expect(yield* exists(`${dir}/big.bin`)).toBe(true)
  }),
)

it.instance("plain folder: touched files are classified", () =>
  Effect.gen(function* () {
    const { dir, snapshot, before } = yield* setup()
    const outside = path.join(os.tmpdir(), `agentcode-outside-${Math.random().toString(36).slice(2)}`, "y.txt")
    yield* write(`${dir}/node_modules/x.js`, "x")
    yield* write(`${dir}/big.bin`, big())
    yield* write(`${dir}/a.txt`, "A1")
    const patch = yield* snapshot.patch(before, {
      touched: [
        path.join(dir, "node_modules/x.js"),
        outside,
        path.join(dir, "big.bin"),
        path.join(dir, "a.txt"),
        // Unchanged and captured: nothing to report.
        path.join(dir, "b.txt"),
      ],
    })
    expect(patch.files).toEqual([fwd(dir, "a.txt")])
    expect(patch.skipped).toEqual([
      { file: fwd(dir, "node_modules/x.js"), reason: "ignored" },
      { file: outside.replaceAll("\\", "/"), reason: "outside" },
      { file: fwd(dir, "big.bin"), reason: "large" },
    ])
  }),
)

it.instance(
  "git repo: touched ignored files are reported and the patch shape is unchanged",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* write(`${dir}/.gitignore`, "ignored/\n")
      const { snapshot, before } = yield* setup()
      expect((yield* snapshot.status()).mode).toBe("git")
      yield* write(`${dir}/ignored/x.txt`, "x")
      yield* write(`${dir}/a.txt`, "A1")
      const plain = yield* snapshot.patch(before)
      expect(plain).toEqual({ hash: before, files: [fwd(dir, "a.txt")] })
      const patch = yield* snapshot.patch(before, { touched: [path.join(dir, "ignored/x.txt")] })
      expect(patch.skipped).toEqual([{ file: fwd(dir, "ignored/x.txt"), reason: "ignored" }])
    }),
  { git: true },
)

it.instance(
  "home folder: checkpoints are off and nothing is written",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const snapshot = yield* Snapshot.Service
      expect(yield* snapshot.status()).toEqual({ mode: "off", worktree: dir, reason: "home" })
      expect(yield* snapshot.track()).toBeUndefined()
      expect(yield* exists(path.join(Global.Path.data, "snapshot", "global", Hash.fast(dir)))).toBe(false)
    }),
  { init: homeAt((dir) => dir) },
)

it.instance(
  "ancestor of home: checkpoints are off",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const snapshot = yield* Snapshot.Service
      expect(yield* snapshot.status()).toEqual({ mode: "off", worktree: dir, reason: "home" })
      expect(yield* snapshot.track()).toBeUndefined()
      expect(yield* exists(path.join(Global.Path.data, "snapshot", "global", Hash.fast(dir)))).toBe(false)
    }),
  { init: homeAt((dir) => path.join(dir, "me")) },
)

for (const git of [false, true]) {
  it.instance(
    `${git ? "git repo" : "plain folder"}: revert never deletes a file when the snapshot hash is missing`,
    () =>
      Effect.gen(function* () {
        const { dir, snapshot } = yield* setup()
        yield* write(`${dir}/a.txt`, "A1")
        yield* snapshot.revert([{ hash: "0".repeat(40), files: [fwd(dir, "a.txt")] }])
        expect(yield* readText(`${dir}/a.txt`)).toBe("A1")
        yield* snapshot.revert([{ hash: "", files: [fwd(dir, "a.txt")] }])
        expect(yield* readText(`${dir}/a.txt`)).toBe("A1")
      }),
    { git },
  )
}

it.instance(
  "plain folder: snapshot false disables checkpoints",
  () =>
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      expect(yield* snapshot.track()).toBeUndefined()
      expect((yield* snapshot.status()).reason).toBe("disabled")
    }),
  { config: { snapshot: false } },
)

const gitIn = (cwd: string, ...args: string[]) =>
  Effect.promise(() =>
    $`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${args}`.cwd(cwd).quiet().nothrow(),
  )
const sparse = (file: string, size: number) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "")
    await fs.truncate(file, size)
  })

for (const git of [false, true]) {
  it.instance(
    `${git ? "git repo" : "plain folder"}: a large file that shrinks during the step is reported and never deleted`,
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        yield* write(`${dir}/data.csv`, new Uint8Array(3 * 1024 * 1024))
        const { snapshot, before } = yield* setup()
        const since = Date.now()
        yield* write(`${dir}/data.csv`, "a,b\n")
        yield* write(`${dir}/a.txt`, "A1")
        const patch = yield* snapshot.patch(before, {
          since,
          touched: [path.join(dir, "data.csv"), path.join(dir, "a.txt")],
        })
        expect(patch.files).toEqual([fwd(dir, "a.txt")])
        expect(patch.skipped).toEqual([{ file: fwd(dir, "data.csv"), reason: "large" }])
        yield* snapshot.revert([patch])
        expect(yield* readText(`${dir}/data.csv`)).toBe("a,b\n")
        expect(yield* readText(`${dir}/a.txt`)).toBe("A0")
        // A patch that still lists the file (written before this fix) must not delete it either.
        yield* snapshot.revert([{ hash: patch.hash, files: [fwd(dir, "data.csv")] }])
        expect(yield* readText(`${dir}/data.csv`)).toBe("a,b\n")
      }),
    { git },
  )
}

if (process.platform === "darwin") {
  it.instance("plain folder: a cloud placeholder downloaded during the step is reported and never deleted", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      // A sparse file has a size but no allocated blocks, like an evicted iCloud file.
      yield* sparse(`${dir}/Report.pages`, 64 * 1024)
      const { snapshot, before } = yield* setup()
      yield* write(`${dir}/Report.pages`, "downloaded and edited")
      const patch = yield* snapshot.patch(before, { since: Date.now(), touched: [path.join(dir, "Report.pages")] })
      expect(patch.files).toEqual([])
      expect(patch.skipped).toEqual([{ file: fwd(dir, "Report.pages"), reason: "offline" }])
      yield* snapshot.revert([patch])
      expect(yield* readText(`${dir}/Report.pages`)).toBe("downloaded and edited")
    }),
  )
}

it.instance(
  "git repo: a large untracked file rewritten by another process is not reported",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      yield* write(`${dir}/dev.db`, big())
      const { snapshot, before } = yield* setup()
      const since = Date.now()
      yield* sleep(20)
      yield* write(`${dir}/dev.db`, new Uint8Array(3 * 1024 * 1024))
      yield* write(`${dir}/created.bin`, big())
      const patch = yield* snapshot.patch(before, { since })
      expect(patch.skipped).toEqual([{ file: fwd(dir, "created.bin"), reason: "large" }])
    }),
  { git: true },
)

it.instance("plain folder: files inside a nested git repository are captured and reverted", () =>
  Effect.gen(function* () {
    const dir = (yield* TestInstance).directory
    yield* write(`${dir}/sub/f.ts`, "F0")
    yield* write(`${dir}/sub/node_modules/dep.js`, "dep")
    yield* gitIn(`${dir}/sub`, "init", "-q")
    yield* gitIn(`${dir}/sub`, "add", "f.ts")
    yield* gitIn(`${dir}/sub`, "commit", "-qm", "init")
    const { snapshot, before } = yield* setup()
    expect((yield* snapshot.status()).mode).toBe("folder")
    yield* write(`${dir}/sub/f.ts`, "F1")
    yield* write(`${dir}/sub/new.ts`, "NEW")
    const patch = yield* snapshot.patch(before, {
      touched: [path.join(dir, "sub/f.ts"), path.join(dir, "sub/new.ts")],
    })
    expect(patch.files.toSorted()).toEqual([fwd(dir, "sub/f.ts"), fwd(dir, "sub/new.ts")])
    expect("skipped" in patch).toBe(false)
    yield* snapshot.revert([patch])
    expect(yield* readText(`${dir}/sub/f.ts`)).toBe("F0")
    expect(yield* exists(`${dir}/sub/new.ts`)).toBe(false)
    expect(yield* exists(`${dir}/sub/node_modules/dep.js`)).toBe(true)
    expect(yield* exists(`${dir}/sub/.git/HEAD`)).toBe(true)
  }),
)

it.instance("plain folder: an edit behind a symlinked folder is reported as outside", () =>
  Effect.gen(function* () {
    const dir = (yield* TestInstance).directory
    const target = path.join(os.tmpdir(), `agentcode-linked-${Math.random().toString(36).slice(2)}`)
    yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdir(target, { recursive: true })),
      () => Effect.promise(() => fs.rm(target, { recursive: true, force: true })),
    )
    yield* write(path.join(target, "x.ts"), "X0")
    yield* Effect.promise(() => fs.symlink(target, path.join(dir, "linked"), "dir"))
    const { snapshot, before } = yield* setup()
    yield* write(`${dir}/linked/x.ts`, "X1")
    const patch = yield* snapshot.patch(before, { touched: [path.join(dir, "linked/x.ts")] })
    expect(patch.skipped).toEqual([{ file: fwd(dir, "linked/x.ts"), reason: "outside" }])
  }),
)

it.instance("plain folder: revert never deletes a file created outside the agent's file tools", () =>
  Effect.gen(function* () {
    const { dir, snapshot, before } = yield* setup()
    yield* write(`${dir}/budget.xlsx`, "user file")
    yield* write(`${dir}/tool.txt`, "from the write tool")
    yield* write(`${dir}/a.txt`, "A1")
    const patch = yield* snapshot.patch(before, { touched: [path.join(dir, "tool.txt")] })
    expect(patch.files.toSorted()).toEqual([fwd(dir, "a.txt"), fwd(dir, "tool.txt")])
    yield* snapshot.revert([patch])
    expect(yield* readText(`${dir}/budget.xlsx`)).toBe("user file")
    expect(yield* exists(`${dir}/tool.txt`)).toBe(false)
    expect(yield* readText(`${dir}/a.txt`)).toBe("A0")
  }),
)

it.instance(
  "plain folder: checkpoints are off without a git binary and git is never run",
  () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const snapshot = yield* Snapshot.Service
      expect(yield* snapshot.status()).toEqual({ mode: "off", worktree: dir, reason: "no-git" })
      expect(yield* snapshot.track()).toBeUndefined()
      expect(yield* exists(path.join(Global.Path.data, "snapshot", "global", Hash.fast(dir)))).toBe(false)
    }),
  {
    init: (dir: string) =>
      Effect.acquireRelease(
        Effect.promise(async () => {
          const previous = process.env.PATH
          const empty = path.join(dir, ".empty-bin")
          await fs.mkdir(empty, { recursive: true })
          process.env.PATH = empty
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            process.env.PATH = previous
          }),
      ).pipe(Effect.asVoid),
  },
)
