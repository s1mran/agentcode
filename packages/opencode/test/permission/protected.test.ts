import { describe, expect, test } from "bun:test"
import { ProtectedPath } from "../../src/permission/protected"

const ctx: ProtectedPath.PathContext = {
  worktree: "/work/code/proj",
  directory: "/work/code/proj",
  home: "/home/users/me",
  configDirs: ["/home/users/me/.config/opencode", "/opt/agentcode/config"],
  caseInsensitive: false,
}
const inProject = (rel: string) => `${ctx.worktree}/${rel}`

describe("protectedWrite", () => {
  const protectedPaths = [
    inProject(".git/hooks/pre-commit"),
    inProject(".git"),
    inProject("sub/.git/config"),
    inProject(".opencode/opencode.json"),
    inProject(".opencode/settings.local.json"),
    inProject(".opencode/plans/sub/x.md"),
    inProject(".opencode/plans/notes.txt"),
    inProject(".agentcode/agent/build.md"),
    inProject(".claude/settings.json"),
    inProject(".vscode/settings.json"),
    inProject("packages/app/.idea/workspace.xml"),
    inProject(".husky/pre-push"),
    inProject(".devcontainer/devcontainer.json"),
    inProject("opencode.jsonc"),
    inProject("opencode.json"),
    inProject("agentcode.json"),
    inProject(".npmrc"),
    inProject("web/.envrc"),
    inProject(".mcp.json"),
    inProject(".gitmodules"),
    "/home/users/me/.zshrc",
    "/home/users/me/.bash_profile",
    "/home/users/me/.gitconfig",
    "/home/users/me/.ssh/authorized_keys",
    "/home/users/me/.aws/config",
    "/home/users/me/.gnupg/pubring.kbx",
    "/home/users/me/.config/fish/config.fish",
    "/home/users/me/.config/agentcode/agentcode.json",
    "/home/users/me/.config/opencode/opencode.json",
    "/home/users/me/Library/LaunchAgents/evil.plist",
    "/home/users/me/.claude/settings.json",
    "/opt/agentcode/config/x.json",
    "/etc/hosts",
    "/private/etc/sudoers",
  ]
  for (const file of protectedPaths) {
    test(`protected: ${file}`, () => {
      expect(ProtectedPath.protectedWrite(file, ctx)?.reason).toBeString()
    })
  }

  const allowed = [
    inProject(".opencode/plans/1-slug.md"),
    inProject("src/.gitkeep"),
    inProject(".github/workflows/ci.yml"),
    inProject(".gitignore"),
    inProject("docs/git.md"),
    inProject("src/opencode.json"),
    inProject("docs/.claude-notes.md"),
    inProject("src/index.ts"),
    "/home/users/me/notes.txt",
    "/home/users/me/.config/other/x",
    "/tmp/out.txt",
  ]
  for (const file of allowed) {
    test(`not protected: ${file}`, () => {
      expect(ProtectedPath.protectedWrite(file, ctx)).toBeUndefined()
    })
  }

  test("case-insensitive filesystems match any case", () => {
    const ci = { ...ctx, caseInsensitive: true }
    expect(ProtectedPath.protectedWrite(inProject(".GIT/HOOKS/x"), ci)?.reason).toBe(
      "writes inside .git (.GIT/HOOKS/x)",
    )
    expect(ProtectedPath.protectedWrite(inProject(".OpenCode/opencode.json"), ci)).toBeDefined()
    expect(ProtectedPath.protectedWrite("/HOME/users/me/.ZSHRC", ci)).toBeDefined()
    expect(ProtectedPath.protectedWrite(inProject(".GIT/HOOKS/x"), ctx)).toBeUndefined()
  })

  test("reasons name the path relative to the project or home", () => {
    expect(ProtectedPath.protectedWrite(inProject(".git/hooks/pre-commit"), ctx)?.reason).toBe(
      "writes inside .git (.git/hooks/pre-commit)",
    )
    expect(ProtectedPath.protectedWrite("/home/users/me/.ssh/authorized_keys", ctx)?.reason).toBe(
      "writes inside ~/.ssh (~/.ssh/authorized_keys)",
    )
  })

  test("paths are normalized before matching", () => {
    expect(ProtectedPath.protectedWrite(inProject("src/../.git/config"), ctx)).toBeDefined()
    expect(ProtectedPath.protectedWrite(inProject("./.vscode//settings.json"), ctx)).toBeDefined()
  })

  test("agent config between the worktree and a nested directory is protected", () => {
    const nested = { ...ctx, directory: inProject("packages/app") }
    expect(ProtectedPath.protectedWrite(inProject("packages/.opencode/agent/x.md"), nested)).toBeDefined()
    expect(ProtectedPath.protectedWrite(inProject("packages/app/.claude/settings.json"), nested)).toBeDefined()
    expect(ProtectedPath.protectedWrite(inProject("packages/app/opencode.json"), nested)).toBeDefined()
    expect(ProtectedPath.protectedWrite(inProject("packages/other/.claude/settings.json"), nested)).toBeUndefined()
  })

  test("non-git projects (worktree '/') still protect the directory config", () => {
    const loose = { ...ctx, worktree: "/", directory: "/work/scratch" }
    expect(ProtectedPath.protectedWrite("/work/scratch/.opencode/opencode.json", loose)).toBeDefined()
    expect(ProtectedPath.protectedWrite("/work/scratch/opencode.json", loose)).toBeDefined()
    expect(ProtectedPath.protectedWrite("/work/scratch/src/a.ts", loose)).toBeUndefined()
  })

  test("windows paths", () => {
    const win = {
      worktree: "C:\\code\\proj",
      directory: "C:\\code\\proj",
      home: "C:\\Users\\me",
      configDirs: [],
      caseInsensitive: true,
    }
    expect(ProtectedPath.protectedWrite("C:\\code\\proj\\.git\\config", win)).toBeDefined()
    expect(ProtectedPath.protectedWrite("C:\\Users\\Me\\.ssh\\id_rsa", win)).toBeDefined()
    expect(ProtectedPath.protectedWrite("C:\\code\\proj\\src\\a.ts", win)).toBeUndefined()
  })
})

describe("candidates", () => {
  test("a symlinked parent that resolves into .git is protected", () => {
    const list = ProtectedPath.candidates(inProject("hooks-link/pre-commit"), inProject(".git/hooks"), ["pre-commit"])
    expect(list).toEqual([inProject("hooks-link/pre-commit"), inProject(".git/hooks/pre-commit")])
    expect(list.some((file) => ProtectedPath.protectedWrite(file, ctx))).toBe(true)
  })

  test("returns only the lexical path when nothing resolves elsewhere", () => {
    expect(ProtectedPath.candidates(inProject("src/a.ts"))).toEqual([inProject("src/a.ts")])
    expect(ProtectedPath.candidates(inProject("src/a.ts"), inProject("src"), ["a.ts"])).toEqual([inProject("src/a.ts")])
  })
})

describe("criticalRemoval", () => {
  const remove = (target: string | undefined, recursive = true, glob = false, cwd = ctx.worktree) =>
    ProtectedPath.criticalRemoval(target, { recursive, glob, cwd, ctx })

  test("critical targets", () => {
    expect(remove("/")?.reason).toBe("removes the filesystem root (/)")
    expect(remove("/usr")?.reason).toBe("removes the top-level folder /usr")
    expect(remove("/home/users/me")).toBeDefined()
    expect(remove("~")).toBeDefined()
    expect(remove("$HOME")).toBeDefined()
    expect(remove("/home/users")).toBeDefined()
    expect(remove(ctx.worktree)).toBeDefined()
    expect(remove(".")).toBeDefined()
    expect(remove("..")).toBeDefined()
    expect(remove("/work/code")).toBeDefined()
    expect(remove("*", true, true)).toBeDefined()
    expect(remove(".*", true, true)).toBeDefined()
    expect(remove("./*", false, true)).toBeDefined()
    expect(remove("~/*", true, true)?.reason).toBe("removes everything inside /home/users/me (/home/users/me/*)")
    expect(remove("/*", true, true)).toBeDefined()
    expect(remove("src/../..")).toBeDefined()
    expect(remove(undefined, true)).toBeDefined()
    expect(remove(undefined, false, true)).toBeDefined()
    expect(remove("*", true, true, ctx.home)).toBeDefined()
  })

  test("ordinary targets", () => {
    expect(remove("src")).toBeUndefined()
    expect(remove("build/*", true, true)).toBeUndefined()
    expect(remove("*.log", false, true)).toBeUndefined()
    expect(remove("~/Downloads/old")).toBeUndefined()
    expect(remove("/tmp/build")).toBeUndefined()
    expect(remove(undefined, false)).toBeUndefined()
    expect(remove("*", true, true, inProject("dist"))).toBeUndefined()
  })

  test("windows drive roots and top-level folders", () => {
    const win = {
      worktree: "C:\\code\\proj",
      directory: "C:\\code\\proj",
      home: "C:\\Users\\me",
      configDirs: [],
      caseInsensitive: true,
    }
    const check = (target: string) =>
      ProtectedPath.criticalRemoval(target, { recursive: true, glob: false, cwd: win.worktree, ctx: win })
    expect(check("C:\\")).toBeDefined()
    expect(check("C:")).toBeDefined()
    expect(check("D:\\Windows")).toBeDefined()
    expect(check("C:\\users")).toBeDefined()
    expect(check("..")).toBeDefined()
    expect(check("src")).toBeUndefined()
    expect(check("C:\\code\\proj\\dist")).toBeUndefined()
  })
})

describe("review regressions", () => {
  const remove = (target: string | undefined, opts: { recursive?: boolean; glob?: boolean; within?: boolean } = {}) =>
    ProtectedPath.criticalRemoval(target, {
      recursive: opts.recursive ?? true,
      glob: opts.glob ?? false,
      within: opts.within,
      cwd: ctx.worktree,
      ctx,
    })

  test("~+ is the current folder, ~- and ~user are only known at run time", () => {
    expect(remove("~+")?.reason).toContain("project folder")
    expect(remove("~-")?.reason).toBe("removes a path that is only known when the command runs")
    expect(remove("~root")?.reason).toBe("removes a path that is only known when the command runs")
    expect(remove("~root/x", { recursive: false })).toBeUndefined()
  })

  test("partial globs that can expand to top-level folders, home or the project are critical", () => {
    expect(remove("/ho*", { glob: true })).toBeDefined()
    expect(remove("/home/us*", { glob: true })).toBeDefined()
    expect(remove("/home/users/m?", { glob: true })).toBeDefined()
    expect(remove("~/[a-z]*", { glob: true })).toBeDefined()
    expect(remove("/work/code/pr*", { glob: true })).toBeDefined()
    expect(remove("/home/[[:alpha:]]*/me", { glob: true })).toBeDefined()
    expect(remove("/work/other*", { glob: true })).toBeUndefined()
    expect(remove("src/[a-z]*", { glob: true })).toBeUndefined()
  })

  test("removing entries inside the project is not critical, inside home or a parent still is", () => {
    expect(remove(".", { within: true })).toBeUndefined()
    expect(remove("src", { within: true })).toBeUndefined()
    expect(remove("..", { within: true })).toBeDefined()
    expect(remove("~", { within: true })).toBeDefined()
    expect(remove("/", { within: true })).toBeDefined()
  })

  test(".claude.json is a protected startup file", () => {
    expect(ProtectedPath.protectedWrite("/home/users/me/.claude.json", ctx)).toBeDefined()
  })
})
