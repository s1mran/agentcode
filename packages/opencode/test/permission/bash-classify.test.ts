import { describe, expect, test } from "bun:test"
import { BashClassify } from "../../src/permission/bash-classify"

// Splits a simple command the way the shell tool hands sub-commands over: words keep their quotes,
// leading NAME=value words are assignments and redirects are separated from the words.
function input(raw: string): BashClassify.SubcommandInput {
  const tokens: string[] = []
  const state = { current: "", quote: "" }
  for (const c of raw) {
    if (state.quote) {
      state.current += c
      if (c === state.quote) state.quote = ""
      continue
    }
    if (c === "'" || c === '"') state.quote = c
    if (/\s/.test(c)) {
      if (state.current) tokens.push(state.current)
      state.current = ""
      continue
    }
    state.current += c
  }
  if (state.current) tokens.push(state.current)
  const words: string[] = []
  const assignments: string[] = []
  const redirects: BashClassify.Redirect[] = []
  for (let i = 0; i < tokens.length; i++) {
    const redirect = /^(\d*|&)(>>|>\||>&|>|<)(.*)$/.exec(tokens[i])
    if (redirect) {
      redirects.push({ op: redirect[1] + redirect[2], target: redirect[3] || tokens[++i] })
      continue
    }
    if (words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      assignments.push(tokens[i])
      continue
    }
    words.push(tokens[i])
  }
  return { words, assignments, redirects, raw }
}

const classify = (raw: string) => BashClassify.classify(input(raw))

describe("wrapper and env stripping", () => {
  test("timeout and nice are stripped before matching", () => {
    const result = classify("timeout 30 nice -n 5 npm test")
    expect(result.strict).toBe("npm test")
    expect(result.loose).toBe("npm test")
    expect(result.wrappers).toEqual(["timeout", "nice"])
    expect(result.always).toBe("npm test *")
    expect(result.readOnly).toBe(false)
    expect(result.exec).toBe(false)
  })

  test("safe env is stripped, unsafe env stays in strict", () => {
    const safe = classify("LANG=C ls -la")
    expect(safe.readOnly).toBe(true)
    expect(safe.strict).toBe("ls -la")

    const unsafe = classify("LD_PRELOAD=x ls")
    expect(unsafe.readOnly).toBe(false)
    expect(unsafe.unsafeEnv).toBe(true)
    expect(unsafe.strict).toBe("LD_PRELOAD=x ls")
    expect(unsafe.loose).toBe("ls")
    expect(unsafe.always).toBeUndefined()
  })

  test("more wrappers reach a fixpoint", () => {
    expect(classify("nohup stdbuf -oL time -p npm run build").strict).toBe("npm run build")
    expect(classify("env NODE_ENV=test CI=1 bun test").strict).toBe("bun test")
    expect(classify("env FOO=1 npm test").strict).toBe("FOO=1 npm test")
    expect(classify("env FOO=1 npm test").unsafeEnv).toBe(true)
    expect(classify("nice -10 make build").strict).toBe("make build")
    expect(classify("builtin command ls").readOnly).toBe(true)
  })

  test("strip exposes floor argv without sudo", () => {
    const result = BashClassify.strip(["sudo", "-u", "root", "timeout", "5", "rm", "-rf", "/"], [])
    expect(result.argv).toEqual(["sudo", "-u", "root", "timeout", "5", "rm", "-rf", "/"])
    expect(result.floorArgv).toEqual(["rm", "-rf", "/"])
    expect(result.loose).toBe("rm -rf /")
    expect(result.exec).toBe(true)
  })

  test("unstrippable wrappers are exec", () => {
    expect(classify("env -S 'rm -rf /'").exec).toBe(true)
    expect(classify("env -S 'rm -rf /'").nested).toEqual(["rm -rf /"])
    expect(classify("nice --weird rm -rf x").exec).toBe(true)
    expect(classify("nice --weird rm -rf x").always).toBeUndefined()
    expect(classify("xargs -I{} rm {}").exec).toBe(true)
  })

  test("quoted arguments with spaces keep their source in strict and lose quotes in loose", () => {
    const result = classify(`git commit -m "fix the thing"`)
    expect(result.strict).toBe(`git commit -m "fix the thing"`)
    expect(result.loose).toBe("git commit -m fix the thing")
    expect(result.argv).toEqual(["git", "commit", "-m", "fix the thing"])
    expect(result.always).toBe("git commit *")
  })
})

describe("read-only allowlist", () => {
  const readOnly = [
    "git status",
    "git log --oneline -5",
    "git -C sub log",
    "git diff -- src/a.ts",
    "git branch -a",
    "git branch --list 'feat*'",
    "git tag",
    "git remote -v",
    "git stash list",
    "git config --get user.email",
    "rg foo src",
    "rg -n 'a b' src",
    "grep -rn TODO src",
    "find . -name '*.ts'",
    "fd ts src",
    "sed -n '1,80p' f",
    "sed -n -e '/start/,/end/p' f",
    "node --version",
    "git --version",
    "ls 2>/dev/null",
    "git status 2>&1",
    "cat package.json",
    "head -n 20 README.md",
    "wc -l src/a.ts",
    "command -v git",
    "echo $HOME",
    "echo $SOME_VAR",
    "sort -k 2 data.txt",
    "uniq -c in.txt",
    "jq .name package.json",
    "date +%s",
    "cd src",
    "popd",
  ]
  for (const command of readOnly) {
    test(`read-only: ${command}`, () => {
      expect(classify(command).readOnly).toBe(true)
    })
  }

  const notReadOnly = [
    "find . -delete",
    "find . -exec rm {} ;",
    "rg --pre cat x",
    "sort -o out in",
    "sed -i s/a/b/ f",
    "sed 's/a/b/' f",
    "sed -n 'w out' f",
    "env",
    "printenv",
    "git -c core.pager=x log",
    "git branch -D x",
    "git branch new-feature",
    "git tag v1",
    "git stash",
    "git log --output=x",
    "git diff --ext-diff",
    "git grep -Ovim foo",
    "git config user.email x",
    "./x --version",
    "node script.js",
    "cat $FILE",
    "cat ~/.ssh/id_rsa > out.txt",
    "ls > out.txt",
    "tree -o out.txt",
    "date -s 2020-01-01",
    "uniq a b",
    "xxd -r dump bin",
    "yq -i '.a = 1' f.yaml",
    "cd $DIR",
    "sudo ls",
    "xargs cat",
    "npm test",
  ]
  for (const command of notReadOnly) {
    test(`not read-only: ${command}`, () => {
      expect(classify(command).readOnly).toBe(false)
    })
  }

  test("read paths are reported for the caller's outside-project check", () => {
    expect(classify("cat /etc/hosts ../x").reads).toEqual([{ path: "/etc/hosts" }, { path: "../x" }])
    expect(classify("rg foo src ../other").reads).toEqual([{ path: "src" }, { path: "../other" }])
    expect(classify("grep -e foo -f patterns.txt a").reads).toEqual([{ path: "patterns.txt" }, { path: "a" }])
    expect(classify("find ~/x -name '*.md'").reads).toEqual([{ path: "~/x" }])
    expect(classify("git -C ../other diff -- a.ts").reads).toEqual([{ path: "../other" }, { path: "../other/a.ts" }])
    expect(classify("wc -l < ../in.txt").reads).toEqual([{ path: "../in.txt" }])
    expect(classify("cd ..").cd).toBe("..")
  })

  test("cd targets", () => {
    expect(classify("cd").cd).toBe("~")
    expect(classify("cd -").cd).toBe("dynamic")
    expect(classify("cd $X").cd).toBe("dynamic")
    expect(classify("pushd lib").cd).toBe("lib")
    expect(classify("ls").cd).toBeUndefined()
  })
})

describe("writes, removes and file commands", () => {
  test("redirect targets count as writes", () => {
    const result = classify("echo hi > out.txt")
    expect(result.writes).toEqual([{ path: "out.txt", kind: "redirect" }])
    expect(result.fsSafeCandidate).toBe(true)
    expect(result.readOnly).toBe(false)
    expect(classify("npm test >> log.txt 2>&1").writes).toEqual([{ path: "log.txt", kind: "redirect" }])
    expect(classify("echo x &> all.log").writes).toEqual([{ path: "all.log", kind: "redirect" }])
    expect(classify("echo x > $OUT").writes).toEqual([{ path: undefined, kind: "redirect", text: "$OUT" }])
  })

  test("filesystem commands report kind, writes and reads", () => {
    const mkdir = classify("mkdir -p a/b")
    expect(mkdir.fsKind).toBe("mkdir")
    expect(mkdir.writes).toEqual([{ path: "a/b", kind: "arg" }])
    expect(mkdir.fsSafeCandidate).toBe(true)

    const cp = classify("cp -r a b")
    expect(cp.fsKind).toBe("cp")
    expect(cp.writes).toEqual([{ path: "b", kind: "arg" }])
    expect(cp.reads).toEqual([{ path: "a" }])

    expect(classify("cp -t dest a b").writes).toEqual([{ path: "dest", kind: "arg" }])
    const mv = classify("mv old.txt new.txt")
    expect(mv.writes).toEqual([{ path: "new.txt", kind: "arg" }])
    expect(mv.removes).toEqual([{ path: "old.txt", recursive: false, glob: false }])
    expect(classify("touch a b").writes.map((item) => item.path)).toEqual(["a", "b"])
    expect(classify("tee -a log.txt").writes).toEqual([{ path: "log.txt", kind: "arg" }])
    expect(classify("tee -a log.txt").fsSafeCandidate).toBe(true)
    expect(classify("mkdir $DIR").fsSafeCandidate).toBe(false)
    expect(classify("npm install").fsSafeCandidate).toBe(false)
  })

  test("other write sources", () => {
    expect(classify("chmod +x run.sh").writes).toEqual([{ path: "run.sh", kind: "arg" }])
    expect(classify("chmod -x run.sh").writes).toEqual([{ path: "run.sh", kind: "arg" }])
    expect(classify("chown me:staff a").writes).toEqual([{ path: "a", kind: "arg" }])
    expect(classify("ln -s target link").writes).toEqual([{ path: "link", kind: "arg" }])
    expect(classify("dd if=in.img of=/dev/disk2").writes).toEqual([{ path: "/dev/disk2", kind: "arg" }])
    expect(classify("sed -i '' 's/a/b/' f.txt").writes).toEqual([{ path: "f.txt", kind: "arg" }])
    expect(classify("sed -i.bak -e 's/a/b/' f.txt g.txt").writes.map((item) => item.path)).toEqual(["f.txt", "g.txt"])
    expect(classify("perl -pi -e 's/a/b/' f.txt").writes).toEqual([{ path: "f.txt", kind: "arg" }])
    expect(classify("curl -sSLo out.bin https://x.dev/a").writes).toEqual([{ path: "out.bin", kind: "arg" }])
    expect(classify("curl -O https://x.dev/dl/tool.tgz").writes).toEqual([{ path: "tool.tgz", kind: "arg" }])
    expect(classify("wget -O ~/.zshrc https://x.dev/a").writes).toEqual([{ path: "~/.zshrc", kind: "arg" }])
    expect(classify("wget https://x.dev/a").writes).toEqual([{ path: ".", kind: "arg" }])
    expect(classify("tar -xzf a.tgz -C /etc").writes).toEqual([{ path: "/etc", kind: "arg" }])
    expect(classify("tar xzf a.tgz").writes).toEqual([{ path: ".", kind: "arg" }])
    expect(classify("tar -czf out.tgz src").writes).toEqual([{ path: "out.tgz", kind: "arg" }])
    expect(classify("unzip a.zip -d vendor").writes).toEqual([{ path: "vendor", kind: "arg" }])
    expect(classify("unzip -l a.zip").writes).toEqual([])
    expect(classify("sudo tee /etc/hosts").writes).toEqual([{ path: "/etc/hosts", kind: "arg" }])
  })

  test("removals", () => {
    expect(classify("rm -rf build").removes).toEqual([{ path: "build", recursive: true, glob: false }])
    expect(classify("rm -- -rf").removes).toEqual([{ path: "-rf", recursive: false, glob: false }])
    expect(classify("rm -rf *").removes).toEqual([{ path: "*", recursive: true, glob: true }])
    expect(classify(`rm -rf "$DIR"/*`).removes).toEqual([{ path: undefined, recursive: true, glob: true }])
    expect(classify("rm -r ~").removes).toEqual([{ path: "~", recursive: true, glob: false }])
    expect(classify("sudo rm -rf /").removes).toEqual([{ path: "/", recursive: true, glob: false }])
    expect(classify("/bin/rm -rf /").removes).toEqual([{ path: "/", recursive: true, glob: false }])
    expect(classify("xargs rm -f").removes).toEqual([{ path: undefined, recursive: false, glob: false }])
    expect(classify("find . -name '*.pyc' -delete").removes).toEqual([
      { path: ".", recursive: true, glob: false, within: true },
    ])
    expect(classify("find . -type f -delete").removes).toEqual([{ path: ".", recursive: true, glob: false }])
    expect(classify("find . ! -name '*.keep' -delete").removes).toEqual([{ path: ".", recursive: true, glob: false }])
    expect(classify("find / -name x -exec rm -rf {} ;").removes).toEqual([
      { path: "/", recursive: true, glob: false, within: true },
    ])
    expect(classify("exec rm -rf /").removes).toEqual([{ path: "/", recursive: true, glob: false }])
    expect(classify("setsid rm -rf ~").removes).toEqual([{ path: "~", recursive: true, glob: false }])
    expect(classify("flock /tmp/lock rm -rf /").removes).toEqual([{ path: "/", recursive: true, glob: false }])
    expect(classify("xargs -I{} rm -rf {}").removes).toEqual([
      { path: "{}", recursive: true, glob: false },
      { path: undefined, recursive: true, glob: false },
    ])
    expect(classify("xargs -I{} rm -rf {}").exec).toBe(true)
    expect(classify("exec rm -rf /").always).toBeUndefined()
    expect(classify("rmdir empty").removes).toEqual([{ path: "empty", recursive: false, glob: false }])
    expect(classify("rd /s /q C:\\").removes).toEqual([{ path: "C:\\", recursive: true, glob: false }])
    expect(classify("Remove-Item -Recurse -Force C:\\Users").removes).toEqual([
      { path: "C:\\Users", recursive: true, glob: false },
    ])
  })

  test("nested scripts and critical rm fallback", () => {
    expect(classify("sh -c 'rm -rf ~'").nested).toEqual(["rm -rf ~"])
    expect(classify("bash -lc 'git push -f'").nested).toEqual(["git push -f"])
    expect(classify("sudo bash -c 'rm -rf /'").nested).toEqual(["rm -rf /"])
    expect(classify(`eval "echo hi"`).nested).toEqual(["echo hi"])
    expect(classify(`bash -c "$SCRIPT"`).nested).toEqual([])
    expect(BashClassify.fallbackCriticalRm("rm -rf $DIR/*")).toBe(true)
    expect(BashClassify.fallbackCriticalRm("cd x && rm -rf .")).toBe(true)
    expect(BashClassify.fallbackCriticalRm("rm -r ~/")).toBe(true)
    expect(BashClassify.fallbackCriticalRm("rm -rf build")).toBe(false)
    expect(BashClassify.fallbackCriticalRm("rm /tmp/x")).toBe(false)
  })
})

describe("destructive git", () => {
  const destructive = [
    "git push --force",
    "git push -f origin main",
    "git push --force-with-lease",
    "git push origin +main",
    "git push origin :old",
    "git push --delete origin old",
    "git -C sub push -f",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    "git branch -D x",
    "git branch -d -f x",
    "git checkout -- .",
    "git checkout .",
    "git checkout -- src/a.ts",
    "git checkout -f main",
    "git restore src/a.ts",
    "git restore --staged --worktree a",
    "git switch --discard-changes main",
    "git stash clear",
    "git stash drop",
    "git rebase main",
    "git rebase -i HEAD~3",
    "git tag -d v1",
    "git update-ref -d refs/heads/x",
    "git reflog expire --expire=now --all",
    "git gc --prune=now",
    "git filter-branch --tree-filter x",
    "git worktree remove --force ../wt",
    "git config user.email x",
    "git config --global core.editor vim",
    "git -c core.hooksPath=x status",
    "git -c alias.st=!sh status",
    "git --git-dir=/tmp/x status",
    "sudo git push --force",
    "xargs -I{} git push -f origin {}",
    "git $SUB",
  ]
  for (const command of destructive) {
    test(`guard: ${command}`, () => {
      const result = classify(command)
      expect(result.destructiveGit).toBeString()
      expect(result.always).toBeUndefined()
    })
  }

  const safe = [
    "git push",
    "git push origin main",
    "git rebase --continue",
    "git restore --staged a",
    "git config --get user.email",
    "git commit --amend",
    "git -c user.name=x commit -m y",
    "git checkout -b feature",
    "git branch -d merged",
    "git stash pop",
    "git reset --soft HEAD~1",
    "git clean -n",
    "git worktree remove ../wt",
    "git status",
  ]
  for (const command of safe) {
    test(`no guard: ${command}`, () => {
      expect(classify(command).destructiveGit).toBeUndefined()
    })
  }
})

describe("git commit and add plans", () => {
  test("commit flags", () => {
    expect(classify("git commit -am msg").gitCommit).toEqual({ all: true, include: false, paths: [] })
    expect(classify("git commit -m 'x' -- a.ts").gitCommit).toEqual({ all: false, include: false, paths: ["a.ts"] })
    expect(classify("git commit -m 'a message' b.ts").gitCommit).toEqual({
      all: false,
      include: false,
      paths: ["b.ts"],
    })
    expect(classify("git commit -i -m x c.ts").gitCommit).toEqual({ all: false, include: true, paths: ["c.ts"] })
    expect(classify("git commit --author 'A <a@b>' -m x").gitCommit).toEqual({ all: false, include: false, paths: [] })
    expect(classify("git commit --dry-run").gitCommit).toBeUndefined()
    expect(classify("git -C sub commit -m x").gitCommit).toEqual({
      all: false,
      include: false,
      paths: [],
      dirs: ["sub"],
    })
    expect(classify("git status").gitCommit).toBeUndefined()
  })

  test("add paths", () => {
    expect(classify("git add k.env").gitAdd).toEqual({ paths: ["k.env"] })
    expect(classify("git add -- a b").gitAdd).toEqual({ paths: ["a", "b"] })
    expect(classify("git add -A").gitAdd).toEqual({ paths: [":/"] })
    expect(classify("git add $FILES").gitAdd).toEqual({ paths: [":/"] })
  })
})

describe("allow always", () => {
  test("withheld for exec, interpreters, sudo, xargs and dynamic names", () => {
    for (const command of [
      "bash -c 'x'",
      "python script.py",
      "sudo apt install",
      "xargs rm",
      "$CMD arg",
      "node -e 'x'",
      "npx vite",
      "git push -f",
      "rm -rf $DIR",
      "npm -g install x",
    ]) {
      expect({ command, always: classify(command).always }).toEqual({ command, always: undefined })
    }
  })

  test("narrow prefixes and exact forms", () => {
    expect(classify("rm -rf build").always).toBe("rm -rf build")
    expect(classify("chmod +x run.sh").always).toBe("chmod +x run.sh")
    expect(classify("kill 1234").always).toBe("kill 1234")
    expect(classify("find . -name '*.pyc' -delete").always).toBe("find . -name '*.pyc' -delete")
    expect(classify("npm run dev -- --port 3000").always).toBe("npm run dev *")
    expect(classify("gh pr view 12").always).toBe("gh pr view *")
    expect(classify("docker compose up -d").always).toBe("docker compose up *")
    expect(classify("git -C sub commit -m x").always).toBe("git -C sub commit *")
    expect(classify("cargo build --release").always).toBe("cargo build *")
    expect(classify("mkdir -p a/b").always).toBe("mkdir *")
    expect(classify("./gradlew build").always).toBe("./gradlew *")
    expect(classify("constructor x").always).toBe("constructor *")
  })

  test("limits", () => {
    expect(BashClassify.LIMITS).toEqual({ maxChars: 10_000, maxSubcommands: 50, maxAlways: 5 })
    expect(classify("cat " + "a".repeat(10_001)).readOnly).toBe(false)
  })
})

describe("review regressions", () => {
  const removes = (command: string) => classify(command).removes

  test("wrappers called by their full path are unwrapped for the floor and deny rules", () => {
    expect(removes("/usr/bin/env rm -rf /")).toEqual([{ path: "/", recursive: true, glob: false }])
    expect(classify("/usr/bin/env rm -rf /").loose).toBe("rm -rf /")
    expect(removes("/usr/bin/sudo rm -rf ~")).toEqual([{ path: "~", recursive: true, glob: false }])
    expect(removes("/usr/bin/xargs rm -rf")).toEqual([{ path: undefined, recursive: true, glob: false }])
  })

  test("wrappers and runners that cannot be unwrapped fail closed", () => {
    for (const command of [
      "timeout infinity rm -rf ~",
      "env -v rm -rf ~",
      "nice --5 rm -rf ~",
      "watch rm -rf ~",
      "nice nice nice nice nice nice nice nice nice rm -rf ~",
      "chroot / rm -rf ~",
      "nsenter -t 1 -m rm -rf ~",
      "caffeinate -i rm -rf ~",
    ]) {
      expect({ command, removes: removes(command) }).toEqual({
        command,
        removes: expect.arrayContaining([{ path: "~", recursive: true, glob: false }]),
      })
    }
    expect(classify("script -qc 'rm -rf ~' /dev/null").nested).toEqual(["rm -rf ~"])
    expect(classify("watch 'rm -rf ~'").nested).toEqual(["rm -rf ~"])
    expect(classify("nsenter -t 1 -m git push -f").destructiveGit).toBeString()
    expect(classify("caffeinate npm test").always).toBeUndefined()
  })

  test("env -C and sudo -D move the command's relative paths", () => {
    expect(removes("env -C / rm -rf .")).toEqual([{ path: "/.", recursive: true, glob: false }])
    expect(classify("env -C .git/hooks tee pre-commit").writes).toEqual([
      { path: ".git/hooks/pre-commit", kind: "arg" },
    ])
    expect(removes("sudo -D $DIR rm -rf x")).toEqual([{ path: undefined, recursive: true, glob: false }])
  })

  test("sh -c accepts -- and later options before the script", () => {
    expect(classify("bash -c -- 'rm -rf ~'").nested).toEqual(["rm -rf ~"])
    expect(classify("sudo sh -c -- 'git push -f'").nested).toEqual(["git push -f"])
    expect(classify("bash -c -e 'rm -rf ~'").nested).toEqual(["rm -rf ~"])
  })

  test("other tilde forms are only known at run time", () => {
    expect(removes("rm -rf ~+")).toEqual([{ path: undefined, recursive: true, glob: false }])
    expect(removes("rm -rf ~dev1")).toEqual([{ path: undefined, recursive: true, glob: false }])
    expect(classify("rm -rf ~+").always).toBeUndefined()
  })

  test("abbreviated long options of destructive git commands are guards", () => {
    for (const command of [
      "git reset --har",
      "git push --force-w origin main",
      "git clean --forc",
      "git branch --delete --forc x",
      "git switch --discard main",
      "git -c clean.requireForce=false clean -dx",
    ])
      expect({ command, guard: classify(command).destructiveGit }).toEqual({ command, guard: expect.any(String) })
    expect(classify("git push --dry-run").destructiveGit).toBeUndefined()
  })

  test("--sort and --format do not make git branch or tag list", () => {
    expect(classify("git branch --sort=refname newb").readOnly).toBe(false)
    expect(classify("git tag --sort=refname v9").readOnly).toBe(false)
    expect(classify("git branch --sort=-committerdate").readOnly).toBe(true)
  })

  test("xargs stays in the strict form", () => {
    expect(classify("xargs rm -f build.log").strict).toBe("xargs rm -f build.log")
    expect(classify("xargs rm -f build.log").loose).toBe("rm -f build.log")
    expect(classify("xargs rm -f build.log").always).toBeUndefined()
  })

  test("sed scripts that run commands are exec, and w commands are writes", () => {
    expect(classify("sed '1e rm -rf ~' f").exec).toBe(true)
    expect(classify("sed 's/a/b/e' f").exec).toBe(true)
    expect(classify("sed -f script.sed f").exec).toBe(true)
    expect(classify("sed 's/a/b/' f").exec).toBe(false)
    expect(classify("sed 's/two/three/g' f").writes).toEqual([])
    expect(classify("sed -n 's/a/b/w .git/hooks/pre-commit' f").writes).toEqual([
      { path: ".git/hooks/pre-commit", kind: "arg" },
    ])
    expect(classify("sed 'w out.txt' f").writes).toEqual([{ path: "out.txt", kind: "arg" }])
    expect(classify("sed '1e x' f").writes).toEqual([{ path: undefined, kind: "arg" }])
  })

  test("more commands write the files named in their arguments", () => {
    const paths = (command: string) => classify(command).writes.map((item) => item.path)
    expect(paths("sort -o .git/hooks/pre-commit f")).toEqual([".git/hooks/pre-commit"])
    expect(paths("uniq in .git/hooks/x")).toEqual([".git/hooks/x"])
    expect(paths("xxd in out")).toEqual(["out"])
    expect(paths("tree -o out.txt")).toEqual(["out.txt"])
    expect(paths("find . -fprint .git/hooks/pre-commit")).toEqual([".git/hooks/pre-commit"])
    expect(paths("git diff --output=patch.diff")).toEqual(["patch.diff"])
    expect(paths("curl --libcurl x.c https://a.dev")).toEqual(["x.c"])
    expect(paths("curl --output-dir .git/hooks -o pre-commit https://x.dev/y")).toEqual([".git/hooks/pre-commit"])
    expect(paths("chmod -w,+x .git/hooks/x")).toEqual([".git/hooks/x"])
    expect(paths("rsync -a src/ ~/.zshrc")).toEqual(["~/.zshrc"])
    expect(paths("rsync -a src/ host:dir")).toEqual([])
    expect(classify("chmod -R 777 /").writes).toEqual([{ path: "/", kind: "arg", recursive: true }])
    expect(classify("rsync -a --delete empty/ ~/").removes).toEqual([
      { path: "~/", recursive: true, glob: false, within: true },
    ])
  })

  test("links record where later writes land", () => {
    expect(classify("ln -sf ~/.zshrc ./l").links).toEqual([
      { path: "./l", target: "~/.zshrc", symbolic: true },
      { path: "./l/.zshrc", target: "~/.zshrc", symbolic: true },
    ])
    expect(classify("ln ~/.zshrc").links).toEqual([{ path: ".zshrc", target: "~/.zshrc", symbolic: false }])
  })

  test("allow always: exact for argument writers and exec-capable families, bare invocations are exact", () => {
    expect(classify("tee log.txt").always).toBe("tee log.txt")
    expect(classify("cp a b").always).toBe("cp a b")
    expect(classify("sed 's/a/b/' f").always).toBe("sed 's/a/b/' f")
    expect(classify("find . -name x").always).toBe("find . -name x")
    expect(classify("sort data.txt").always).toBe("sort data.txt")
    expect(classify("mkdir -p a/b").always).toBe("mkdir *")
    expect(classify("touch a").always).toBe("touch *")
    expect(classify("make").always).toBe("make")
    expect(classify("docker compose").always).toBe("docker compose")
    expect(classify("ls -la").always).toBe("ls *")
  })

  test("git plans carry -C folders and forced adds", () => {
    expect(classify("git -C a -C b commit -am x").gitCommit).toEqual({
      all: true,
      include: false,
      paths: [],
      dirs: ["a", "b"],
    })
    expect(classify("git add -f .env").gitAdd).toEqual({ paths: [".env"], force: true })
    expect(classify("git add --force x").gitAdd).toEqual({ paths: ["x"], force: true })
    expect(classify("timeout 5 git -C o commit -m x").gitCommit).toEqual({
      all: false,
      include: false,
      paths: [],
      dirs: ["o"],
    })
  })
})
