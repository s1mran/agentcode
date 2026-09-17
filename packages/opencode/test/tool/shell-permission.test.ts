import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "@opencode-ai/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

type AskInput = Parameters<Tool.Context["ask"]>[0]

Shell.acceptable.reset()

// The shell tool reports metadata right before it spawns the command. Failing there means these tests only ever
// inspect permission requests: none of the (sometimes destructive) commands below can run.
const stop = new Error("stop before running the command")

const inspect = Effect.fn("ShellPermissionTest.inspect")(function* (command: string) {
  const requests: AskInput[] = []
  const info = yield* ShellTool
  const tool = yield* info.init()
  const exit = yield* tool
    .execute(
      { command },
      {
        sessionID: SessionID.make("ses_test"),
        messageID: MessageID.make("msg_test"),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () =>
          Effect.sync(() => {
            throw stop
          }),
        ask: (input: AskInput) =>
          Effect.sync(() => {
            requests.push(input)
          }),
      },
    )
    .pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(stop)
  const bash = requests.find((item) => item.permission === "bash")
  const external = requests.find((item) => item.permission === "external_directory")
  return { requests, bash, external }
})

const inProject = <A, E, R>(self: (dir: string) => Effect.Effect<A, E, R>, options?: { git?: boolean }) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped(options)
    return yield* self(dir).pipe(provideInstance(dir))
  })

const hint = (request: AskInput | undefined, pattern: string) =>
  request?.hints?.find((item) => item.pattern === pattern)

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })

/** Runs `use` with SHELL pointing at an empty file of that name, so the matching parser is selected. */
const withFakeShell = <A, E, R>(dir: string, name: string, use: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const fake = path.join(dir, name)
      fs.writeFileSync(fake, "")
      const prev = process.env.SHELL
      process.env.SHELL = fake
      Shell.acceptable.reset()
      return prev
    }),
    () => use,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
      }),
  )

// Bash semantics: on Windows the default shell may be PowerShell, which parses these commands differently.
const windows = process.platform === "win32"

describe.skipIf(windows)("tool.shell permission classification", () => {
  it.live("read-only commands carry readOnly hints and narrow Allow always rules for a user's own ask rule", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { bash } = yield* inspect("ls -la && git status")
        expect(bash?.patterns).toEqual(["ls -la", "git status"])
        expect(bash?.hints?.map((item) => item.readOnly)).toEqual([true, true])
        // The engine runs them silently by default; under `bash: "ask"` the prompt can still save these rules.
        expect(bash?.always).toEqual(["ls *", "git status *"])
      }),
    ),
  )

  it.live("wrappers are stripped for rules and Allow always", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { bash } = yield* inspect("timeout 30 npm test")
        expect(bash?.patterns).toEqual(["timeout 30 npm test"])
        expect(hint(bash, "timeout 30 npm test")).toMatchObject({
          readOnly: false,
          strict: "npm test",
          withholdAlways: false,
        })
        expect(bash?.always).toEqual(["npm test *"])
      }),
    ),
  )

  it.live("destructive git is a guard with no Allow always", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { bash } = yield* inspect("FOO=1 git push --force")
        expect(hint(bash, "FOO=1 git push --force")?.guard).toMatchObject({
          level: "guard",
          category: "destructive_git",
        })
        expect(bash?.always).toEqual([])
      }),
    ),
  )

  it.live("redirects into protected paths hit the floor, following cd but not subshells", () =>
    inProject(() =>
      Effect.gen(function* () {
        const direct = yield* inspect("echo x > .git/hooks/pre-commit")
        expect(hint(direct.bash, "echo x > .git/hooks/pre-commit")?.guard).toMatchObject({
          level: "floor",
          category: "protected_path",
        })
        expect(direct.bash?.always).toEqual([])
        expect(direct.bash?.metadata.writes).toEqual([".git/hooks/pre-commit"])

        const moved = yield* inspect("cd .git && echo x > hooks/pre-commit")
        expect(moved.bash?.patterns).toEqual(["echo x > hooks/pre-commit"])
        expect(hint(moved.bash, "echo x > hooks/pre-commit")?.guard).toMatchObject({
          level: "floor",
          category: "protected_path",
        })

        const subshell = yield* inspect("(cd .git) && echo x > hooks/pre-commit")
        expect(subshell.bash?.hints?.some((item) => item.guard)).toBe(false)
        expect(subshell.bash?.metadata.writes).toEqual(["hooks/pre-commit"])
      }),
    ),
  )

  it.live("redirects into the workspace trust store hit the floor", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { Global } = yield* Effect.promise(() => import("@opencode-ai/core/global"))
        const target = path.join(Global.Path.data, "trust", "workspaces.json")
        const command = `echo {} > ${target}`
        const { bash } = yield* inspect(command)
        expect(hint(bash, command)?.guard).toMatchObject({ level: "floor", category: "protected_path" })
        expect(bash?.always).toEqual([])
      }),
    ),
  )

  it.live("critical removals hit the floor", () =>
    inProject(() =>
      Effect.gen(function* () {
        for (const command of [
          "rm -rf .",
          "rm -rf ~",
          'rm -rf "$HOME"',
          "rm -rf $DIR/*",
          "sudo rm -rf /",
          "bash -c 'rm -rf /'",
          "find / -delete",
        ]) {
          const { bash } = yield* inspect(command)
          expect({ command, guard: hint(bash, command)?.guard }).toMatchObject({
            command,
            guard: { level: "floor", category: "critical_rm" },
          })
          expect(bash?.always).toEqual([])
        }

        const build = yield* inspect("rm -rf build")
        expect(hint(build.bash, "rm -rf build")?.guard).toBeUndefined()
        expect(build.bash?.always).toEqual(["rm -rf build"])
      }),
    ),
  )

  it.live("redirects on pipelines, heredocs and cd-only commands still count as writes", () =>
    inProject(() =>
      Effect.gen(function* () {
        const piped = yield* inspect("git log --oneline | head -3 > .git/info/exclude")
        expect(piped.bash?.patterns).toEqual(["git log --oneline", "head -3 > .git/info/exclude"])
        expect(hint(piped.bash, "git log --oneline")).toMatchObject({ readOnly: true })
        expect(hint(piped.bash, "head -3 > .git/info/exclude")?.guard).toMatchObject({ category: "protected_path" })

        const heredoc = yield* inspect("cat <<EOF > .bashrc\nhi\nEOF")
        expect(heredoc.bash?.hints?.[0]?.guard).toMatchObject({ category: "protected_path" })

        const cd = yield* inspect("cd . > .zshrc")
        expect(cd.bash?.patterns).toEqual(["cd . > .zshrc"])
        expect(hint(cd.bash, "cd . > .zshrc")?.guard).toMatchObject({ category: "protected_path" })

        const group = yield* inspect("{ cd src; echo; } > opencode.json")
        expect(group.bash?.hints?.some((item) => item.guard?.category === "protected_path")).toBe(true)
      }),
    ),
  )

  it.live("a command that redirects into a file never offers Allow always", () =>
    inProject(() =>
      Effect.gen(function* () {
        const file = yield* inspect('echo x > "out.txt"')
        expect(hint(file.bash, 'echo x > "out.txt"')).toMatchObject({ readOnly: false, withholdAlways: true })
        expect(file.bash?.always).toEqual([])

        const both = yield* inspect("npm test > out.log && npm run build")
        expect(both.bash?.always).toEqual([])

        // Redirects to devices and file descriptors are not writes.
        const quiet = yield* inspect("npm test > /dev/null 2>&1")
        expect(quiet.bash?.always).toEqual(["npm test *"])
      }),
    ),
  )

  it.live("an Allow always rule is never saved with a wildcard in the middle", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { bash } = yield* inspect("rm -rf src/*")
        expect(hint(bash, "rm -rf src/*")).toMatchObject({ withholdAlways: true })
        expect(bash?.always).toEqual([])
      }),
    ),
  )

  it.live("nested scripts beyond the parse depth still fall back to the critical rm check", () =>
    inProject(() =>
      Effect.gen(function* () {
        const command = `bash -c "bash -c 'bash -c \\"rm -rf /\\"'"`
        const { bash } = yield* inspect(command)
        expect(hint(bash, command)).toMatchObject({ readOnly: false, guard: { category: "critical_rm" } })
      }),
    ),
  )

  it.live("a removal after a cd to an unknown folder is critical", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { bash } = yield* inspect('cd "$TARGET" && rm -rf build')
        expect(hint(bash, "rm -rf build")?.guard).toMatchObject({ level: "floor", category: "critical_rm" })
      }),
    ),
  )

  it.live("file commands inside the project are project writes", () =>
    inProject((dir) =>
      Effect.gen(function* () {
        const made = yield* inspect("mkdir -p src/new && touch src/new/a.ts")
        expect(made.external).toBeUndefined()
        expect(made.bash?.hints?.map((item) => item.projectWrite)).toEqual([true, true])
        expect(made.bash?.metadata.writes).toEqual(["src/new", "src/new/a.ts"])

        const outside = yield* inspect("cp a.ts ../outside.ts")
        expect(outside.external?.patterns).toEqual([path.join(path.dirname(dir), "*")])
        expect(hint(outside.bash, "cp a.ts ../outside.ts")?.projectWrite).toBe(false)

        const editor = yield* inspect("cp a .vscode/settings.json")
        expect(hint(editor.bash, "cp a .vscode/settings.json")).toMatchObject({
          projectWrite: false,
          guard: { level: "floor", category: "protected_path" },
        })

        const glob = yield* inspect("cp a .vs*/settings.json")
        expect(hint(glob.bash, "cp a .vs*/settings.json")?.guard).toMatchObject({ level: "floor" })
      }),
    ),
  )

  it.live("read paths outside the project ask for the external directory", () =>
    inProject(() =>
      Effect.gen(function* () {
        const ssh = path.join(os.homedir(), ".ssh")
        const want = fs.existsSync(ssh) && fs.statSync(ssh).isDirectory() ? ssh : os.homedir()
        const { external, bash } = yield* inspect("rg secret ~/.ssh")
        expect(external?.metadata.directories).toEqual([want])
        expect(external?.patterns).toEqual([path.join(want, "*")])
        expect(hint(bash, "rg secret ~/.ssh")?.readOnly).toBe(true)
      }),
    ),
  )

  it.live("a protected write outside the project marks its external directory with the floor", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { external } = yield* inspect("echo x >> ~/.zshrc")
        expect(external?.patterns).toEqual([path.join(os.homedir(), "*")])
        expect(external?.hints).toEqual([
          { pattern: path.join(os.homedir(), "*"), guard: expect.objectContaining({ level: "floor" }) },
        ])
      }),
    ),
  )

  it.live("an unparseable command is never read-only and falls back to the critical rm check", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { bash } = yield* inspect('echo "unbalanced rm -rf /')
        expect(bash?.patterns.length).toBeGreaterThan(0)
        for (const item of bash?.hints ?? []) {
          expect(item.readOnly).toBe(false)
          expect(item.withholdAlways).toBe(true)
          expect(item.guard).toMatchObject({ level: "floor", category: "critical_rm" })
        }
        expect(bash?.always).toEqual([])
      }),
    ),
  )

  it.live("too many distinct rules withhold Allow always", () =>
    inProject(() =>
      Effect.gen(function* () {
        const five = yield* inspect("npm test && npm run build && make lint && cargo build && go build")
        expect(five.bash?.always).toHaveLength(5)
        const six = yield* inspect("npm test && npm run build && make lint && cargo build && go build && pip install x")
        expect(six.bash?.patterns).toHaveLength(6)
        expect(six.bash?.always).toEqual([])
      }),
    ),
  )
})

describe.skipIf(windows)("tool.shell permission regressions", () => {
  const floor = (request: AskInput | undefined, pattern: string) => hint(request, pattern)?.guard

  it.live("wrappers called by path, unknown options and runners still reach the critical rm floor", () =>
    inProject(() =>
      Effect.gen(function* () {
        for (const command of [
          "/usr/bin/env rm -rf /",
          "/usr/bin/sudo rm -rf ~",
          "timeout infinity rm -rf ~",
          "env -v rm -rf ~",
          "env -C / rm -rf .",
          "nice --5 rm -rf ~",
          "watch rm -rf ~",
          "watch 'rm -rf ~'",
          "nice nice nice nice nice nice nice nice nice rm -rf ~",
          "script -qc 'rm -rf ~' /dev/null",
          "chroot / rm -rf /",
          "caffeinate rm -rf ~",
          "bash -c -- 'rm -rf ~'",
          "rm -rf ~+",
          "rm -rf ~root",
          "rm -rf /Us*",
          "rm -rf ~/[a-z]*",
        ]) {
          const { bash } = yield* inspect(command)
          expect({ command, guard: floor(bash, command) }).toMatchObject({
            command,
            guard: { level: "floor", category: "critical_rm" },
          })
          expect({ command, always: bash?.always }).toEqual({ command, always: [] })
        }
        const push = yield* inspect("sudo sh -c -- 'git push -f'")
        expect(floor(push.bash, "sudo sh -c -- 'git push -f'")).toMatchObject({ category: "destructive_git" })
      }),
    ),
  )

  it.live("abbreviated destructive git options are guards", () =>
    inProject(() =>
      Effect.gen(function* () {
        for (const command of ["git reset --har", "git push --force-w origin main", "git clean --forc"]) {
          const { bash } = yield* inspect(command)
          expect({ command, guard: floor(bash, command) }).toMatchObject({ guard: { category: "destructive_git" } })
        }
      }),
    ),
  )

  it.live("filtered find deletes inside the project are not critical, unfiltered ones are", () =>
    inProject(() =>
      Effect.gen(function* () {
        const pyc = yield* inspect("find . -name '*.pyc' -delete")
        expect(floor(pyc.bash, "find . -name '*.pyc' -delete")).toBeUndefined()
        const all = yield* inspect("find . -type f -delete")
        expect(floor(all.bash, "find . -type f -delete")).toMatchObject({ category: "critical_rm" })
      }),
    ),
  )

  it.live("xargs stays in the rule form, so a saved exact rule never matches its dynamic arguments", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { bash } = yield* inspect("git ls-files | xargs rm -f build.log")
        expect(hint(bash, "xargs rm -f build.log")?.strict).toBe("xargs rm -f build.log")
        expect(bash?.always).toEqual([])
      }),
    ),
  )

  it.live("writers named in arguments reach the protected-path floor", () =>
    inProject(() =>
      Effect.gen(function* () {
        for (const command of [
          "sort -o .git/hooks/pre-commit f",
          "sort -o ~/.zshrc input",
          "rsync evil ~/.zshrc",
          "sed -n 's/a/b/w .git/hooks/pre-commit' f",
          "find . -fprint .git/hooks/pre-commit",
          "uniq in .git/hooks/x",
          "curl --output-dir .git/hooks -o pre-commit https://x.dev/y",
          "chmod -w,+x .git/hooks/x",
          "git diff --output=.git/hooks/pre-commit",
          "echo '{}' > ~/.claude.json",
        ]) {
          const { bash } = yield* inspect(command)
          expect({ command, guard: floor(bash, command) }).toMatchObject({
            guard: { level: "floor", category: "protected_path" },
          })
        }
      }),
    ),
  )

  it.live("recursive chmod of the root is critical", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { bash } = yield* inspect("chmod -R 777 /")
        expect(floor(bash, "chmod -R 777 /")).toMatchObject({ level: "floor", category: "critical_rm" })
      }),
    ),
  )

  it.live("a link created earlier in the command is followed by later writes", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { bash } = yield* inspect("ln -sf ~/.zshrc ./l && echo pwned >> ./l")
        expect(floor(bash, "echo pwned >> ./l")).toMatchObject({ level: "floor", category: "protected_path" })
        // Creating the link itself does not write its target.
        expect(floor(bash, "ln -sf ~/.zshrc ./l")).toBeUndefined()
      }),
    ),
  )

  it.live("writes whose target is only known at run time hit the floor when they name the git directory", () =>
    inProject(() =>
      Effect.gen(function* () {
        for (const [command, pattern] of [
          [
            'echo x > "$(git rev-parse --git-dir)/hooks/pre-commit"',
            'echo x > "$(git rev-parse --git-dir)/hooks/pre-commit"',
          ],
          [
            "cp hook $(git rev-parse --git-path hooks)/pre-commit",
            "cp hook $(git rev-parse --git-path hooks)/pre-commit",
          ],
          ['cp x "$GIT_DIR/hooks/pre-commit"', 'cp x "$GIT_DIR/hooks/pre-commit"'],
          ['cd "$(git rev-parse --git-dir)" && echo x > hooks/pre-commit', "echo x > hooks/pre-commit"],
        ]) {
          const { bash } = yield* inspect(command)
          expect({ command, guard: floor(bash, pattern) }).toMatchObject({
            guard: { level: "floor", category: "protected_path" },
          })
        }
        const plain = yield* inspect('npm test > "$LOG"')
        expect(floor(plain.bash, 'npm test > "$LOG"')).toBeUndefined()
      }),
    ),
  )

  it.live("bash reads of .env files are not read-only, like the read tool", () =>
    inProject(() =>
      Effect.gen(function* () {
        for (const command of ["cat .env", "grep SECRET .env", "head .env.production", "cat sub/../.env"]) {
          const { bash } = yield* inspect(command)
          expect({ command, readOnly: hint(bash, command)?.readOnly }).toEqual({ command, readOnly: false })
          expect(bash?.always).toEqual([])
        }
        const example = yield* inspect("cat .env.example")
        expect(hint(example.bash, "cat .env.example")?.readOnly).toBe(true)
      }),
    ),
  )

  it.live("commands that write files named in their arguments save the exact command", () =>
    inProject(() =>
      Effect.gen(function* () {
        const tee = yield* inspect("npm test 2>&1 | tee log.txt")
        expect(tee.bash?.always).toEqual(["npm test *", "tee log.txt"])
        const sed = yield* inspect("sed -i s/a/b/ src/x.ts")
        expect(sed.bash?.always).toEqual(["sed -i s/a/b/ src/x.ts"])
        const exec = yield* inspect("sed '1e rm -rf ~' f")
        expect(exec.bash?.always).toEqual([])
        const make = yield* inspect("make && make test")
        expect(make.bash?.always).toEqual(["make", "make test *"])
      }),
    ),
  )

  it.live("a write to the project root shows as '.' in the metadata", () =>
    inProject(() =>
      Effect.gen(function* () {
        const { bash } = yield* inspect("cp -r template/. .")
        expect(bash?.metadata.writes).toEqual(["."])
      }),
    ),
  )

  it.live("cmd.exe paths are read with backslashes and %VAR% expansion", () =>
    inProject((dir) =>
      withFakeShell(
        dir,
        "cmd",
        Effect.gen(function* () {
          for (const command of ["echo x > .git\\hooks\\pre-commit", "copy x .git\\hooks\\pre-commit"]) {
            const { bash } = yield* inspect(command)
            expect({ command, guard: floor(bash, command) }).toMatchObject({ guard: { category: "protected_path" } })
            expect(hint(bash, command)?.projectWrite).toBe(false)
          }
          const home = yield* inspect("rd /s /q %USERPROFILE%")
          expect(floor(home.bash, "rd /s /q %USERPROFILE%")).toMatchObject({ category: "critical_rm" })
        }),
      ),
    ),
  )
})

describe("tool.shell PowerShell permission classification", () => {
  // A file named pwsh selects the PowerShell parser on any platform; the command itself never runs (see `stop`).
  it.live("PowerShell writes, removals and backslash paths are classified", () =>
    inProject((dir) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const fake = path.join(dir, "pwsh")
          fs.writeFileSync(fake, "")
          const prev = process.env.SHELL
          process.env.SHELL = fake
          Shell.acceptable.reset()
          return prev
        }),
        () =>
          Effect.gen(function* () {
            const conditional = yield* inspect("Write-Host foo; if ($?) { Write-Host bar }")
            expect(conditional.bash?.patterns).toEqual(["Write-Host foo", "Write-Host bar"])
            expect(conditional.bash?.always).toEqual(["Write-Host *"])

            const parent = yield* inspect("Remove-Item -Recurse -Force ..\\..")
            expect(hint(parent.bash, "Remove-Item -Recurse -Force ..\\..")?.guard).toMatchObject({
              category: "critical_rm",
            })

            const redirect = yield* inspect("Get-Content foo > .git\\x")
            expect(hint(redirect.bash, "Get-Content foo > .git\\x")?.guard).toMatchObject({
              category: "protected_path",
            })

            for (const command of [
              "cpi x .git\\hooks\\pre-commit",
              "ni .vscode\\settings.json",
              "sc .git\\hooks\\x y",
            ]) {
              const alias = yield* inspect(command)
              expect({ command, guard: hint(alias.bash, command)?.guard }).toMatchObject({
                guard: { level: "floor", category: "protected_path" },
              })
              expect(alias.bash?.always).toEqual([])
            }
            const rc = yield* inspect("Set-Content -Path ~\\.bashrc -Value x")
            expect(rc.bash?.metadata.writes).toEqual([path.join(os.homedir(), ".bashrc")])

            const moved = yield* inspect("Set-Location .git; Set-Content hooks\\pre-commit x")
            expect(moved.bash?.patterns).toEqual(["Set-Content hooks\\pre-commit x"])
            expect(hint(moved.bash, "Set-Content hooks\\pre-commit x")?.guard).toMatchObject({
              category: "protected_path",
            })
          }),
        (prev) =>
          Effect.sync(() => {
            if (prev === undefined) delete process.env.SHELL
            else process.env.SHELL = prev
            Shell.acceptable.reset()
          }),
      ),
    ),
  )
})

describe.skipIf(windows)("tool.shell commit secret scan", () => {
  const key = "AKIA" + "Q4ZJ7NCRTWXB2MHW"

  it.live("staged credentials make git commit a guard with masked findings", () =>
    inProject(
      (dir) =>
        Effect.gen(function* () {
          fs.writeFileSync(path.join(dir, "config.ts"), `export const id = "${key}"\n`)
          git(dir, "add", "config.ts")
          const { bash } = yield* inspect("git commit -m x")
          expect(hint(bash, "git commit -m x")?.guard).toMatchObject({
            level: "guard",
            category: "secret",
            reason: "possible secret in config.ts:1 (aws-access-key-id)",
          })
          expect(bash?.always).toEqual([])
          expect(bash?.metadata.secrets).toEqual([
            { file: "config.ts", line: 1, rule: "aws-access-key-id", preview: "AKIA…" },
          ])
          expect(JSON.stringify(bash)).not.toContain(key)
        }),
      { git: true },
    ),
  )

  it.live("a clean staged change is not a guard", () =>
    inProject(
      (dir) =>
        Effect.gen(function* () {
          fs.writeFileSync(path.join(dir, "readme.md"), "hello\n")
          git(dir, "add", "readme.md")
          const { bash } = yield* inspect("git commit -m x")
          expect(hint(bash, "git commit -m x")?.guard).toBeUndefined()
          expect(bash?.metadata.secrets).toBeUndefined()
          expect(bash?.always).toEqual(["git commit *"])
        }),
      { git: true },
    ),
  )

  it.live("files added earlier in the same command are scanned", () =>
    inProject(
      (dir) =>
        Effect.gen(function* () {
          fs.writeFileSync(path.join(dir, "k.env"), "NAME=value\n")
          const { bash } = yield* inspect("git add k.env && git commit -m x")
          expect(hint(bash, "git add k.env")?.guard).toBeUndefined()
          expect(hint(bash, "git commit -m x")?.guard).toMatchObject({
            level: "guard",
            category: "secret",
            reason: "possible secret in k.env (sensitive-file)",
          })
        }),
      { git: true },
    ),
  )

  it.live("git -C commits and adds from another folder are scanned where git runs", () =>
    inProject(
      (dir) =>
        Effect.gen(function* () {
          const other = path.join(dir, "other")
          fs.mkdirSync(other)
          git(other, "init", "-q")
          fs.writeFileSync(path.join(other, "config.ts"), `export const id = "${key}"\n`)
          git(other, "add", "config.ts")
          const { bash } = yield* inspect("git -C other commit -m x")
          expect(hint(bash, "git -C other commit -m x")?.guard).toMatchObject({ category: "secret" })

          fs.mkdirSync(path.join(dir, "sub"))
          fs.writeFileSync(path.join(dir, "sub", "k.env"), "NAME=value\n")
          const moved = yield* inspect("git add sub/k.env && cd sub && git commit -m x")
          expect(hint(moved.bash, "git commit -m x")?.guard).toMatchObject({
            category: "secret",
            reason: "possible secret in k.env (sensitive-file)",
          })

          const unknown = yield* inspect('git -C "$REPO" commit -m x')
          expect(hint(unknown.bash, 'git -C "$REPO" commit -m x')?.guard).toMatchObject({
            reason: "secret scan could not complete",
          })
        }),
      { git: true },
    ),
  )

  it.live("force-adding a gitignored secret file is scanned", () =>
    inProject(
      (dir) =>
        Effect.gen(function* () {
          fs.writeFileSync(path.join(dir, ".gitignore"), "secret.txt\n.env\n")
          fs.writeFileSync(path.join(dir, "secret.txt"), `token = "${key}"\n`)
          fs.writeFileSync(path.join(dir, ".env"), "NAME=value\n")
          const forced = yield* inspect("git add -f secret.txt && git commit -m x")
          expect(hint(forced.bash, "git commit -m x")?.guard).toMatchObject({
            category: "secret",
            reason: "possible secret in secret.txt:1 (aws-access-key-id)",
          })
          const env = yield* inspect("git add -f .env && git commit -m x")
          expect(hint(env.bash, "git commit -m x")?.guard).toMatchObject({ category: "secret" })
        }),
      { git: true },
    ),
  )

  it.live("a -diff attribute does not hide staged secrets", () =>
    inProject(
      (dir) =>
        Effect.gen(function* () {
          fs.writeFileSync(path.join(dir, ".gitattributes"), "secret.txt -diff\n")
          fs.writeFileSync(path.join(dir, "secret.txt"), `token = "${key}"\n`)
          git(dir, "add", ".gitattributes", "secret.txt")
          const { bash } = yield* inspect("git commit -m x")
          expect(hint(bash, "git commit -m x")?.guard).toMatchObject({
            category: "secret",
            reason: "possible secret in secret.txt:1 (aws-access-key-id)",
          })
        }),
      { git: true },
    ),
  )

  it.live(
    "a scan that hangs becomes an incomplete guard within the time limit",
    () =>
      inProject(
        (dir) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const bin = path.join(dir, "fake-bin")
              fs.mkdirSync(bin)
              fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 })
              const prev = process.env.PATH
              process.env.PATH = `${bin}${path.delimiter}${prev ?? ""}`
              return prev
            }),
            () =>
              Effect.gen(function* () {
                const started = Date.now()
                const { bash } = yield* inspect("git commit -m x")
                const elapsed = Date.now() - started
                expect(hint(bash, "git commit -m x")?.guard).toMatchObject({
                  level: "guard",
                  category: "secret",
                  reason: "secret scan could not complete",
                })
                expect(elapsed).toBeGreaterThanOrEqual(4_000)
                expect(elapsed).toBeLessThan(9_000)
              }),
            (prev) =>
              Effect.sync(() => {
                process.env.PATH = prev
              }),
          ),
        { git: true },
      ),
    20_000,
  )
})
