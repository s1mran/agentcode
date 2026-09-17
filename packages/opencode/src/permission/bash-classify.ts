import { BashArity } from "./arity"

// Pure classification of one shell sub-command for the permission engine. The caller splits the
// command with tree-sitter and passes each sub-command's pieces as source text (quotes intact):
// `words` are the command name and argument nodes, `assignments` the leading `NAME=value` nodes and
// `redirects` the redirect operators with their targets. Nothing here touches the filesystem;
// `~`, `$HOME` and `$PWD` stay literal for the caller to expand.

export type Redirect = { op: string; target: string }
export type SubcommandInput = { words: string[]; assignments: string[]; redirects: Redirect[]; raw: string }
/** `text`: the target as written, kept when it is only known at run time. `recursive`: chmod/chown -R. */
export type Write = { path?: string; kind: "redirect" | "arg"; text?: string; recursive?: boolean }
export type Read = { path?: string }
/** `within`: removes entries below `path` selected by name (find -name ... -delete), not `path` itself. */
export type Remove = { path?: string; recursive: boolean; glob: boolean; within?: boolean }
/** A link created by ln (or cp -s/-l): writes through `path` land in `target`. */
export type Link = { path?: string; target?: string; symbolic: boolean }
export type FsKind = "mkdir" | "touch" | "mv" | "cp"
/** `dirs`: git -C folders in order (undefined entries are only known at run time), set only when present. */
export type GitCommit = { all: boolean; include: boolean; paths: string[]; dirs?: (string | undefined)[] }
export type GitAdd = { paths: string[]; force?: boolean; dirs?: (string | undefined)[] }

export type Stripped = {
  /** Words after safe env and wrapper stripping, with shell quoting removed (dynamic words keep their source). */
  argv: string[]
  /** Unsafe assignments plus the stripped words as written. Allow rules and saved approvals match this. */
  strict: string
  /** All assignments, wrappers and sudo/doas stripped, quoting removed. Deny and ask rules also match this. */
  loose: string
  /** argv with sudo/doas also stripped, used for floor and guard detection. */
  floorArgv: string[]
  unsafeEnv: boolean
  /** Runs an arbitrary or unknown program (sudo, sh -c, eval, find -exec, an unstrippable wrapper, a dynamic name). */
  exec: boolean
  wrappers: string[]
  argsDynamic: boolean
}

export type Classified = Stripped & {
  name: string
  readOnly: boolean
  /** Static script strings run by sh -c, eval, env -S and similar, for recursive parsing. */
  nested: string[]
  cd?: string | "dynamic"
  writes: Write[]
  reads: Read[]
  removes: Remove[]
  links: Link[]
  fsKind?: FsKind
  fsSafeCandidate: boolean
  destructiveGit?: string
  gitCommit?: GitCommit
  gitAdd?: GitAdd
  always?: string
}

export const LIMITS = { maxChars: 10_000, maxSubcommands: 50, maxAlways: 5 }

type Word = { text: string; value?: string; glob: boolean }
/** `chdir`: the folder a wrapper (env -C, sudo -D) runs the command in; null when only known at run time. */
type Step = { next: number; assignments: string[]; dynamic: boolean; chdir?: string | null }

const SAFE_ENV = new Set(
  "LANG TZ NO_COLOR FORCE_COLOR CI TERM COLUMNS LINES NODE_ENV RAILS_ENV RUST_BACKTRACE PYTHONUNBUFFERED PYTHONDONTWRITEBYTECODE DEBUG VERBOSE".split(
    " ",
  ),
)
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"])
const EXEC = new Set([
  ...SHELLS,
  "sudo",
  "doas",
  "su",
  "watch",
  "setsid",
  "flock",
  "script",
  "unbuffer",
  "parallel",
  "nsenter",
  "chroot",
  "ssh",
  "eval",
  "exec",
  "source",
  ".",
  // Other programs that run their arguments as a command. Never read-only and never saved as a prefix rule.
  ...(
    "caffeinate chrt taskset strace ltrace valgrind unshare systemd-run runuser pkexec busybox toybox firejail " +
    "proxychains proxychains4 torsocks catchsegv rlwrap sg dbus-run-session sandbox-exec nocache cpulimit gtimeout " +
    "setarch arch linux32 linux64 prlimit numactl expect start-stop-daemon"
  ).split(" "),
])
const WRAPPER_NAMES = new Set("timeout time nice nohup stdbuf ionice noglob builtin command env xargs".split(" "))
// Shell builtins and programs whose arguments name files a caller must never skip over when unwrapping fails.
const EFFECT_NAMES = new Set(
  "tee cp mv ln install mkdir touch chmod chown chgrp truncate dd sed perl curl wget tar unzip rm rmdir rd del erase unlink shred find sort uniq xxd tree rsync scp copy xcopy robocopy move ren rename mklink git".split(
    " ",
  ),
)
// Commands with options that make them run other programs or write files. "Allow always" saves the exact command.
const EXACT_FAMILIES = new Set("sed find fd rg sort tar".split(" "))
const INTERPRETERS = new Set([
  ...SHELLS,
  "python",
  "python2",
  "python3",
  "pypy",
  "node",
  "bun",
  "bunx",
  "deno",
  "ruby",
  "perl",
  "php",
  "npx",
  "pnpx",
  "tsx",
  "ts-node",
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "lua",
  "pwsh",
  "powershell",
  "osascript",
])
const EXACT = new Set("rm rmdir unlink shred dd truncate chmod chown chgrp kill killall pkill mv".split(" "))
const TOOLCHAIN = new Set(
  "node npm npx bun pnpm yarn deno python python3 pip go cargo rustc git java ruby tsc".split(" "),
)
const DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"])
const FIND_DENY = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fls", "-fprintf"])
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"])
const FIND_NAME_TESTS = new Set(
  "-name -iname -path -ipath -wholename -iwholename -regex -iregex -lname -ilname -samefile -inum".split(" "),
)
const DURATION =
  /^(?:inf(?:inity)?|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|0x[0-9a-f]+(?:\.[0-9a-f]*)?(?:p[+-]?\d+)?)[smhd]?$/i
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const NUM = String.raw`(?:\d+|\$)`
const REGEX_ADDR = String.raw`(?:/(?:[^/\\\n]|\\.)*/I?)`
const ADDR = String.raw`(?:\d+~\d+|(?:${NUM}|${REGEX_ADDR})(?:\s*,\s*(?:${NUM}|${REGEX_ADDR}|[+~]\d+))?)`
const SED_COMMAND = String.raw`\s*(?:${ADDR})?\s*!?\s*[pP=lqQ]\s*`
const SED_PRINT = new RegExp(String.raw`^${SED_COMMAND}(?:[;\n]${SED_COMMAND})*;?\s*$`)
const GIT_SAFE_GLOBALS = new Set(
  "--no-pager -P -p --paginate --no-optional-locks --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-replace-objects --no-lazy-fetch --no-advice".split(
    " ",
  ),
)
const GIT_EXEC_KEYS = new Set(
  "core.hookspath core.pager core.editor core.sshcommand core.fsmonitor core.askpass core.gitproxy core.alternaterefscommand core.worktree diff.external sequence.editor gpg.program include.path uploadpack.packobjectshook ssh.variant init.templatedir protocol.allow web.browser".split(
    " ",
  ),
)

/** Parses one word's shell quoting. `value` is undefined when the word is only known at run time. */
function word(text: string): Word {
  if (/^[<>]\(/.test(text)) return { text, glob: false }
  // `~+`, `~-` and `~user` expand to the current folder, the previous folder or another user's home.
  if (/^~[^/\\]/.test(text)) return { text, glob: /[*?[]/.test(text) }
  // A Windows drive path (C:\Users) is written for PowerShell or cmd, where backslash is not an escape.
  const windows = /^["']?[A-Za-z]:\\/.test(text)
  let value = ""
  let quote = ""
  let dynamic = false
  let glob = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") {
      if (c === "'") quote = ""
      else value += c
      continue
    }
    if (c === "\\" && i + 1 < text.length) {
      if (windows || (quote && !'$`"\\\n'.includes(text[i + 1]))) {
        value += c
        continue
      }
      i++
      value += text[i]
      continue
    }
    if (c === '"') {
      quote = quote ? "" : '"'
      continue
    }
    if (c === "'" && !quote) {
      quote = "'"
      continue
    }
    if (c === "`") dynamic = true
    if (c === "$" && i + 1 < text.length) {
      const known = /^\$(?:HOME|PWD|\{HOME\}|\{PWD\})(?![A-Za-z0-9_])/.exec(text.slice(i))
      if (known) {
        value += known[0]
        i += known[0].length - 1
        continue
      }
      if (!/[\s"]/.test(text[i + 1])) dynamic = true
    }
    if (!quote && "*?[".includes(c)) glob = true
    if (!quote && c === "{" && /^\{[^}]*(?:,|\.\.)[^}]*\}/.test(text.slice(i))) dynamic = true
    value += c
  }
  if (quote || dynamic) return { text, glob }
  return { text, value, glob }
}

function literal(value: string): Word {
  return { text: value, value, glob: false }
}

function display(item: Word) {
  return item.value ?? item.text
}

/** Tail of a word from `from` (an offset into its value, or its source when dynamic). */
function tail(item: Word, from: number): Word {
  if (item.value === undefined) return { text: item.text.slice(from), glob: item.glob }
  return literal(item.value.slice(from))
}

function base(name: string) {
  return name.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "")
}

function safeAssignment(text: string) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\+?=(.*)$/s.exec(text)
  if (!match || /\$\(|`|<\(|>\(/.test(match[2])) return false
  return SAFE_ENV.has(match[1]) || match[1].startsWith("LC_")
}

type Parsed = { positionals: Word[]; options: string[]; values: Map<string, Word[]> }

/** Generic option parser: short bundles, attached and separate values for `valued` options, `--`. */
function parseArgs(args: Word[], valued: string[] = []): Parsed {
  const positionals: Word[] = []
  const options: string[] = []
  const values = new Map<string, Word[]>()
  const add = (key: string, item: Word | undefined) => {
    if (item) values.set(key, [...(values.get(key) ?? []), item])
  }
  for (let i = 0; i < args.length; i++) {
    const text = display(args[i])
    if (!text.startsWith("-") || text === "-") {
      positionals.push(args[i])
      continue
    }
    if (text === "--") {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (text.startsWith("--")) {
      const eq = text.indexOf("=")
      const key = eq === -1 ? text : text.slice(0, eq)
      options.push(key)
      if (eq !== -1) add(key, tail(args[i], eq + 1))
      else if (valued.includes(key)) add(key, args[++i])
      continue
    }
    for (let j = 1; j < text.length; j++) {
      const key = "-" + text[j]
      options.push(key)
      if (!valued.includes(key)) continue
      if (j + 1 < text.length) add(key, tail(args[i], j + 1))
      else add(key, args[++i])
      break
    }
  }
  return { positionals, options, values }
}

function valuesOf(parsed: Parsed, keys: string[]) {
  return keys.flatMap((key) => parsed.values.get(key) ?? [])
}

function reads(items: Word[]): Read[] {
  return items.filter((item) => item.value !== "-").map((item) => ({ path: item.value }))
}

// Wrapper stripping (D10)

/** Walks wrapper options; returns the index of the wrapped command or undefined for unknown/dynamic options. */
function skip(words: Word[], start: number, flags: string[], valued: string[]) {
  for (let i = start; i < words.length; i++) {
    const text = words[i].value
    if (text === undefined) return
    if (text === "--") return i + 1 < words.length ? i + 1 : undefined
    if (!text.startsWith("-") || text === "-") return i
    const key = text.startsWith("--") ? text.split("=")[0] : text.slice(0, 2)
    if (flags.includes(text) || (text.startsWith("--") && flags.includes(key))) continue
    if (!valued.includes(key)) return
    if (text === key) i++
  }
}

function step(next: number | undefined, words: Word[], dynamic = false): Step | undefined {
  if (next === undefined || next >= words.length) return
  return { next, assignments: [], dynamic }
}

/** Static folder of a `-C dir`/`--chdir=dir` style value, or null when it is only known at run time. */
function folder(item: Word | undefined): string | null {
  return item?.value ?? null
}

function envStep(words: Word[], start: number): Step | undefined {
  const assignments: string[] = []
  const state: { chdir?: string | null } = {}
  const done = (next: number): Step | undefined =>
    next < words.length
      ? { next, assignments, dynamic: false, ...("chdir" in state ? { chdir: state.chdir } : {}) }
      : undefined
  for (let i = start; i < words.length; i++) {
    const text = words[i].value
    if (text === undefined) return
    if (["-i", "-", "--ignore-environment", "-v", "--debug", "-0", "--null"].includes(text)) continue
    if (/^--(?:default|ignore|block)-signal(?:=|$)/.test(text) || text === "--list-signal-handling") continue
    if (text === "-u" || text === "--unset" || text === "-P") {
      i++
      continue
    }
    if (text.startsWith("-u") || text.startsWith("--unset=") || (text.startsWith("-P") && text.length > 2)) continue
    if (text === "-C" || text === "--chdir") {
      state.chdir = folder(words[++i])
      continue
    }
    if (text.startsWith("--chdir=") || (text.startsWith("-C") && text.length > 2)) {
      state.chdir = folder(tail(words[i], text.startsWith("-C") ? 2 : "--chdir=".length))
      continue
    }
    if (text === "--") return done(i + 1)
    if (ASSIGNMENT.test(text)) {
      assignments.push(words[i].text)
      continue
    }
    if (text.startsWith("-")) return
    return done(i)
  }
}

const SUDO_FLAGS =
  "-A -b -E -H -n -P -S -s -i -k --askpass --background --preserve-env --set-home --non-interactive --preserve-groups --stdin --shell --login --reset-timestamp".split(
    " ",
  )
const SUDO_VALUED =
  "-u -g -h -p -C -D -r -t -T -U --user --group --host --prompt --close-from --chdir --role --type --command-timeout --other-user".split(
    " ",
  )

function elevateStep(words: Word[], start: number, flags: string[], valued: string[]): Step | undefined {
  const at = skip(words, start, flags, valued)
  if (at === undefined) return
  const assignments = words
    .slice(at)
    .map((item) => item.value ?? "")
    .findIndex((text) => !ASSIGNMENT.test(text))
  const next = assignments === -1 ? words.length : at + assignments
  if (next >= words.length) return
  // sudo -D dir / --chdir=dir runs the command in another folder.
  const chdir = words.slice(start, at).reduce<string | null | undefined>((found, item, index, all) => {
    const text = item.value ?? ""
    if (text === "-D" || text === "--chdir") return folder(all[index + 1])
    if (text.startsWith("--chdir=")) return folder(tail(item, "--chdir=".length))
    if (/^-D./.test(text)) return folder(tail(item, 2))
    return found
  }, undefined)
  return {
    next,
    assignments: words.slice(at, next).map((item) => item.text),
    dynamic: false,
    ...(chdir !== undefined ? { chdir } : {}),
  }
}

const WRAPPERS = new Map<string, (words: Word[], start: number) => Step | undefined>([
  [
    "timeout",
    (words, start) => {
      const at = skip(
        words,
        start,
        ["--foreground", "--preserve-status", "-v", "--verbose"],
        ["-s", "--signal", "-k", "--kill-after"],
      )
      if (at === undefined || !DURATION.test(words[at]?.value ?? "")) return
      return step(at + 1, words)
    },
  ],
  ["time", (words, start) => step(skip(words, start, ["-p"], []), words)],
  [
    "nice",
    (words, start) =>
      step(
        skip(words, /^--?\d+$/.test(words[start]?.value ?? "") ? start + 1 : start, [], ["-n", "--adjustment"]),
        words,
      ),
  ],
  ["nohup", (words, start) => step(skip(words, start, [], []), words)],
  [
    "stdbuf",
    (words, start) => step(skip(words, start, [], ["-i", "-o", "-e", "--input", "--output", "--error"]), words),
  ],
  [
    "ionice",
    (words, start) => step(skip(words, start, ["-t", "--ignore"], ["-c", "-n", "--class", "--classdata"]), words),
  ],
  ["noglob", (words, start) => step(skip(words, start, [], []), words)],
  ["builtin", (words, start) => step(skip(words, start, [], []), words)],
  [
    "command",
    (words, start) =>
      ["-v", "-V"].includes(words[start]?.value ?? "") ? undefined : step(skip(words, start, ["-p"], []), words),
  ],
  ["env", envStep],
])

// Runners that are exec (never read-only, no Allow always) but are unwrapped for floor and guard detection.
// xargs is only unwrapped here: it appends run-time arguments, so saved rules must never match the command it runs.
const ELEVATE = new Map<string, (words: Word[], start: number) => Step | undefined>([
  [
    "watch",
    (words, start) => {
      const at = skip(
        words,
        start,
        "-d -t -b -e -g -c -x -p -w -r --differences --no-title --beep --errexit --chgexit --color --no-color --exec --precise --no-wrap --no-rerun".split(
          " ",
        ),
        ["-n", "-q", "--interval", "--equexit"],
      )
      // A single quoted script (`watch 'rm -rf ~'`) runs through sh -c: nestedScripts parses it instead.
      if (at === undefined || (at === words.length - 1 && /[\s;&|<>()$`]/.test(words[at].value ?? ""))) return
      return step(at, words)
    },
  ],
  [
    "chroot",
    (words, start) => {
      const at = skip(words, start, ["--skip-chdir"], ["--userspec", "--groups"])
      return at === undefined ? undefined : step(at + 1, words)
    },
  ],
  [
    "script",
    (words, start) => {
      const options = words.slice(start).map((item) => item.value ?? "")
      if (options.some((text) => text === "--command" || text.startsWith("--command=") || /^-[a-zA-Z]*c/.test(text)))
        return
      const at = skip(words, start, "-a -e -F -k -q -r -f -d -p".split(" "), "-t -T -I -O -B -m -E".split(" "))
      return at === undefined ? undefined : step(at + 1, words)
    },
  ],
  ["sudo", (words, start) => elevateStep(words, start, SUDO_FLAGS, SUDO_VALUED)],
  ["doas", (words, start) => elevateStep(words, start, ["-n", "-s", "-L"], ["-u", "-C"])],
  ["exec", (words, start) => step(skip(words, start, ["-c", "-l"], ["-a"]), words)],
  ["setsid", (words, start) => step(skip(words, start, ["-c", "-f", "-w", "--ctty", "--fork", "--wait"], []), words)],
  ["unbuffer", (words, start) => step(skip(words, start, ["-p"], []), words)],
  [
    "flock",
    (words, start) => {
      const at = skip(
        words,
        start,
        "-s -x -u -n -o -F -e --shared --exclusive --unlock --nonblock --close --no-fork".split(" "),
        ["-w", "-E", "--timeout", "--conflict-exit-code"],
      )
      if (at === undefined || ["-c", "--command"].includes(words[at + 1]?.value ?? "")) return
      return step(at + 1, words)
    },
  ],
  [
    "xargs",
    (words, start) =>
      step(
        skip(
          words,
          start,
          "-0 --null -r --no-run-if-empty -t --verbose -p --interactive -x --exit -o --open-tty -i -l -e".split(" "),
          "-n -P -L -l -I -i -E -e -d -a -s --max-args --max-procs --max-lines --replace --eof --delimiter --arg-file --max-chars --process-slot-var".split(
            " ",
          ),
        ),
        words,
        true,
      ),
  ],
])

/** Lowercased program name without its folder or .exe, as PATH lookup on a case-insensitive filesystem finds it. */
function program(item: Word | undefined) {
  return item?.value === undefined ? undefined : base(item.value).toLowerCase()
}

function unwrap(words: Word[], elevated: boolean) {
  const wrappers: string[] = []
  const assignments: string[] = []
  const state: { index: number; dynamic: boolean; chdir?: string | null } = { index: 0, dynamic: false }
  for (let pass = 0; pass < 8 && state.index < words.length; pass++) {
    const name = program(words[state.index])
    if (name === undefined) break
    const next =
      WRAPPERS.get(name)?.(words, state.index + 1) ??
      (elevated ? ELEVATE.get(name)?.(words, state.index + 1) : undefined)
    if (!next) break
    wrappers.push(name)
    assignments.push(...next.assignments)
    state.dynamic = state.dynamic || next.dynamic
    if (next.chdir !== undefined)
      state.chdir =
        next.chdir === null || state.chdir === null
          ? null
          : state.chdir === undefined || /^[/~]/.test(next.chdir)
            ? next.chdir
            : `${state.chdir}/${next.chdir}`
    state.index = next.next
  }
  return { index: state.index, wrappers, assignments, dynamic: state.dynamic, chdir: state.chdir }
}

function execs(rest: Word[]) {
  if (rest.length === 0) return false
  if (rest[0].value === undefined) return true
  const name = base(rest[0].value).toLowerCase()
  const args = rest.slice(1).map(display)
  if (EXEC.has(name)) return true
  if (name === "sed") return sedEffects(rest.slice(1)).exec
  if (name === "rsync") return args.some((arg) => /^(?:-[a-zA-Z]*e.*|--(?:rsh|rsync-path)(?:=.*)?)$/.test(arg))
  if (WRAPPER_NAMES.has(name)) return args.length > 0 && !(name === "command" && ["-v", "-V"].includes(args[0]))
  if (name === "find") return args.some((arg) => FIND_EXEC.has(arg))
  if (name === "fd") return args.some((arg) => /^(?:-[a-zA-Z]*[xX][a-zA-Z]*|--exec(?:-batch)?(?:=.*)?)$/.test(arg))
  if (name === "rg") return args.some((arg) => /^--(?:pre|pre-glob|hostname-bin)(?:=|$)/.test(arg))
  if (name === "sort") return args.some((arg) => arg.startsWith("--compress-program"))
  if (name === "tar")
    return args.some(
      (arg) =>
        arg === "-I" ||
        arg === "-F" ||
        /^--(?:to-command|use-compress-program|checkpoint-action|info-script|new-volume-script|rsh-command|rmt-command)(?:=|$)/.test(
          arg,
        ),
    )
  return false
}

function analyze(parsed: Word[], assignments: string[]) {
  const strict = unwrap(parsed, false)
  const loose = unwrap(parsed, true)
  const unsafe = [...assignments, ...strict.assignments].filter((item) => !safeAssignment(item))
  const rest = parsed.slice(strict.index)
  const floor = parsed.slice(loose.index)
  const stripped: Stripped = {
    argv: rest.map(display),
    strict: [...unsafe, ...rest.map((item) => item.text)].join(" "),
    loose: floor.map(display).join(" "),
    floorArgv: floor.map(display),
    unsafeEnv: unsafe.length > 0,
    exec: execs(rest),
    wrappers: strict.wrappers,
    argsDynamic: strict.dynamic || rest.some((item) => item.value === undefined),
  }
  return { stripped, rest, floor, floorXargs: loose.dynamic, chdir: loose.chdir }
}

/** Strips safe env assignments and command wrappers (timeout, nice, env, xargs, ...) to a fixpoint. */
export function strip(words: string[], assignments: string[]): Stripped {
  return analyze(words.map(word), assignments).stripped
}

// Read-only allowlist (D9)

type Validator = (args: Word[]) => Read[] | undefined

function plain(valued: string[] = [], deny: string[] = []): Validator {
  return (args) => {
    const parsed = parseArgs(args, valued)
    if (parsed.options.some((option) => deny.includes(option))) return
    return reads(parsed.positionals)
  }
}

const none: Validator = () => []

function sedParse(args: Word[]) {
  const scripts: (string | undefined)[] = []
  const positionals: Word[] = []
  const state = { quiet: false, inplace: false, other: false, file: false, sandbox: false }
  for (let i = 0; i < args.length; i++) {
    const text = args[i].value
    if (text === undefined || !text.startsWith("-") || text === "-") {
      positionals.push(args[i])
      continue
    }
    if (text === "--") {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (text.startsWith("--")) {
      const eq = text.indexOf("=")
      const key = eq === -1 ? text : text.slice(0, eq)
      if (key === "--quiet" || key === "--silent") state.quiet = true
      else if (key === "--sandbox") state.sandbox = true
      else if (key === "--in-place") state.inplace = true
      else if (key === "--expression") scripts.push(eq === -1 ? args[++i]?.value : text.slice(eq + 1))
      else if (key === "--file" || key === "--line-length") {
        if (key === "--file") state.file = true
        if (eq === -1) i++
      } else if (
        !["--regexp-extended", "--separate", "--unbuffered", "--null-data", "--posix", "--debug", "--sandbox"].includes(
          key,
        )
      )
        state.other = true
      continue
    }
    for (let j = 1; j < text.length; j++) {
      const c = text[j]
      if (c === "n") {
        state.quiet = true
        continue
      }
      if (c === "i" || c === "I") {
        state.inplace = true
        break
      }
      if (c === "e" || c === "f" || c === "l") {
        const value = j + 1 < text.length ? text.slice(j + 1) : args[++i]?.value
        if (c === "e") scripts.push(value)
        if (c === "f") state.file = true
        break
      }
      if (!"Ersuz".includes(c)) state.other = true
    }
  }
  const explicit = scripts.length > 0 || state.file
  const operands = state.inplace && !explicit && positionals[0]?.value === "" ? positionals.slice(1) : positionals
  return {
    ...state,
    scripts: explicit ? scripts : [operands[0]?.value],
    files: explicit ? operands : operands.slice(1),
  }
}

type SedEffects = { writes: string[]; reads: string[]; exec: boolean }

/**
 * What a sed script does beyond printing: `w`/`W` commands and the `s///w` flag write files, `r`/`R` read them and
 * GNU `e` (command or `s///e` flag) runs a shell command. A script this parser cannot follow counts as exec.
 */
function sedScript(script: string): SedEffects {
  const out: SedEffects = { writes: [], reads: [], exec: false }
  const state = { i: 0 }
  const peek = () => script[state.i]
  const spaces = () => {
    while (state.i < script.length && /[ \t]/.test(script[state.i])) state.i++
  }
  const rest = () => {
    const end = script.indexOf("\n", state.i)
    const text = script.slice(state.i, end === -1 ? script.length : end)
    state.i = end === -1 ? script.length : end
    return text
  }
  const label = () => {
    while (state.i < script.length && !";\n".includes(script[state.i])) state.i++
  }
  // Text up to an unescaped delimiter; false when the script ends first.
  const delimited = (delim: string) => {
    while (state.i < script.length) {
      const c = script[state.i++]
      if (c === "\\") state.i++
      else if (c === delim) return true
      else if (c === "\n" && delim !== "\n") return false
    }
    return false
  }
  const file = (kind: "write" | "read") => {
    spaces()
    const name = rest().trim()
    if (!name) return false
    if (kind === "read") out.reads.push(name)
    else if (!["/dev/stdout", "/dev/stderr"].includes(name)) out.writes.push(name)
    return true
  }
  const address = () => {
    const c = peek()
    if (c === undefined) return true
    if (/\d/.test(c)) {
      while (/[\d~]/.test(peek() ?? "")) state.i++
      return true
    }
    if (c === "$") {
      state.i++
      return true
    }
    if (c === "/" || c === "\\") {
      state.i++
      const delim = c === "/" ? "/" : script[state.i++]
      if (delim === undefined || !delimited(delim)) return false
      while (/[IM]/.test(peek() ?? "")) state.i++
      return true
    }
    if (c === "+" || c === "~") {
      state.i++
      while (/\d/.test(peek() ?? "")) state.i++
    }
    return true
  }
  const unknown = () => {
    out.exec = true
    return out
  }
  while (state.i < script.length) {
    while (state.i < script.length && /[\s;]/.test(script[state.i])) state.i++
    if (state.i >= script.length) break
    if (!address()) return unknown()
    spaces()
    if (peek() === ",") {
      state.i++
      spaces()
      if (!address()) return unknown()
    }
    spaces()
    while (peek() === "!") {
      state.i++
      spaces()
    }
    const command = script[state.i++]
    if (command === undefined) break
    if ("{}=dDgGhHnNpPxzF".includes(command)) continue
    if (command === "#" || "aic".includes(command)) {
      // One-line text; a trailing backslash continues it on the next line.
      for (let line = rest(); line.endsWith("\\") && state.i < script.length; line = rest()) state.i++
      continue
    }
    if (":btTv".includes(command)) {
      label()
      continue
    }
    if ("qQlL".includes(command)) {
      spaces()
      while (/\d/.test(peek() ?? "")) state.i++
      continue
    }
    if (command === "r" || command === "R") {
      if (!file("read")) return unknown()
      continue
    }
    if (command === "w" || command === "W") {
      if (!file("write")) return unknown()
      continue
    }
    if (command === "e") {
      out.exec = true
      rest()
      continue
    }
    if (command === "y") {
      const delim = script[state.i++]
      if (!delim || delim === "\\" || delim === "\n" || !delimited(delim) || !delimited(delim)) return unknown()
      continue
    }
    if (command !== "s") return unknown()
    const delim = script[state.i++]
    if (!delim || delim === "\\" || delim === "\n" || !delimited(delim) || !delimited(delim)) return unknown()
    while (state.i < script.length) {
      const flag = script[state.i]
      if (/[gpiImM0-9]/.test(flag)) {
        state.i++
        continue
      }
      if (flag === "e") {
        out.exec = true
        state.i++
        continue
      }
      if (flag === "w") {
        state.i++
        if (!file("write")) return unknown()
      }
      break
    }
  }
  return out
}

/** Effects of every sed script in a command. Dynamic scripts and script files (-f) are unknown, so exec. */
function sedEffects(args: Word[]): SedEffects & { unknownWrite: boolean } {
  const parsed = sedParse(args)
  const scripts = parsed.scripts.map((script) => (script === undefined ? undefined : sedScript(script)))
  const unknown = parsed.file || scripts.some((item) => item === undefined)
  const found = scripts.filter((item): item is SedEffects => item !== undefined)
  if (parsed.sandbox) return { writes: [], reads: [], exec: false, unknownWrite: false }
  return {
    writes: found.flatMap((item) => item.writes),
    reads: found.flatMap((item) => item.reads),
    exec: unknown || found.some((item) => item.exec),
    unknownWrite: unknown || found.some((item) => item.exec),
  }
}

function findRoots(args: Word[]) {
  let i = 0
  while (i < args.length && /^-(?:[HLP]|O\d|D)$/.test(args[i].value ?? "")) i += args[i].value === "-D" ? 2 : 1
  const start = i
  while (i < args.length && !/^[-(!),]/.test(args[i].value ?? "")) i++
  return { roots: args.slice(start, i), expression: args.slice(i) }
}

const GREP_VALUED =
  "-e -f -m -A -B -C -d -D --regexp --file --max-count --after-context --before-context --context --label --binary-files --devices --directories --include --exclude --exclude-dir --exclude-from --group-separator".split(
    " ",
  )
const RG_VALUED =
  "-e -f -g -t -T -m -A -B -C -j -M -d -E -r --regexp --file --glob --iglob --type --type-not --type-add --type-clear --max-count --after-context --before-context --context --threads --max-columns --max-depth --maxdepth --max-filesize --sort --sortr --color --colors --encoding --engine --path-separator --ignore-file --context-separator --field-context-separator --field-match-separator --replace --dfa-size-limit --regex-size-limit --pre --pre-glob --hostname-bin --hyperlink-format --generate".split(
    " ",
  )
const FD_VALUED =
  "-e -t -d -E -S -o -c -j -x -X --extension --type --max-depth --min-depth --exact-depth --exclude --size --changed-within --changed-before --change-newer-than --change-older-than --newer --older --owner --color --threads --max-results --path-separator --format --base-directory --search-path --ignore-file --and --batch-size --exec --exec-batch".split(
    " ",
  )

const READ_ONLY = new Map<string, Validator>([
  ["ls", plain(["-I", "--ignore", "-w", "--width", "-T", "--tabsize", "--hide", "--block-size"])],
  ["cat", plain()],
  ["head", plain(["-n", "-c", "--lines", "--bytes"])],
  ["tail", plain(["-n", "-c", "--lines", "--bytes", "-s", "--sleep-interval", "--pid"])],
  ["wc", plain()],
  ["file", plain(["-m", "-e", "-F", "-P", "--magic-file", "--exclude", "--separator", "--parameter"])],
  ["stat", plain(["-f", "-c", "-t", "--format", "--printf"])],
  ["du", plain(["-d", "-B", "-t", "--max-depth", "--block-size", "--threshold", "--exclude"])],
  ["df", plain(["-t", "-x", "-B", "--type", "--exclude-type", "--block-size"])],
  [
    "tree",
    plain(["-L", "-I", "-P", "-o", "-H", "-T", "--charset", "--filelimit", "--timefmt", "--sort"], ["-o", "-R"]),
  ],
  ["column", plain(["-s", "-c", "-o", "-N", "-R", "-E", "-H", "-W", "-J"])],
  ["nl", plain(["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"])],
  ["cut", plain(["-d", "-f", "-c", "-b", "--delimiter", "--fields", "--characters", "--bytes", "--output-delimiter"])],
  ["diff", plain("-U -C -L -x -X -I -F --label --exclude --exclude-from --ignore-matching-lines".split(" "))],
  ["cmp", plain(["-i", "-n", "--ignore-initial", "--bytes"])],
  ["comm", plain(["--output-delimiter"])],
  [
    "od",
    plain(["-A", "-t", "-j", "-N", "-w", "--address-radix", "--format", "--skip-bytes", "--read-bytes", "--width"]),
  ],
  ["hexdump", plain(["-n", "-s", "-e", "-f"])],
  ["strings", plain(["-n", "-t", "-e", "--bytes", "--radix", "--encoding"])],
  ["md5sum", plain()],
  ["shasum", plain(["-a", "--algorithm"])],
  ["sha256sum", plain()],
  ["realpath", plain(["--relative-to", "--relative-base"])],
  ["readlink", plain()],
  ...["pwd", "which", "whereis", "type", "echo", "printf", "uname", "whoami", "id", "basename", "dirname"].map(
    (name) => [name, none] as const,
  ),
  ...["test", "[", "true", "false", "sleep", "seq", "tr"].map((name) => [name, none] as const),
  [
    "date",
    (args) => {
      const parsed = parseArgs(args, ["-d", "-r", "-f", "-v", "--date", "--reference", "--file"])
      if (parsed.options.some((option) => option === "-s" || option === "--set")) return
      if (!parsed.options.includes("-j") && parsed.positionals.some((item) => !display(item).startsWith("+"))) return
      return []
    },
  ],
  [
    "sort",
    plain(
      "-k -t -S -T -o --key --field-separator --buffer-size --temporary-directory --output --parallel --batch-size".split(
        " ",
      ),
      ["-o", "--output", "--compress-program"],
    ),
  ],
  [
    "uniq",
    (args) => {
      const parsed = parseArgs(args, ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"])
      return parsed.positionals.length <= 1 ? reads(parsed.positionals) : undefined
    },
  ],
  [
    "xxd",
    (args) => {
      const valued = ["-c", "-g", "-l", "-o", "-s", "-n", "-cols", "-len", "-seek", "-groupsize", "-offset", "-name"]
      const positionals: Word[] = []
      for (let i = 0; i < args.length; i++) {
        const text = display(args[i])
        if (text === "-r" || text === "-revert") return
        if (valued.includes(text)) i++
        else if (!text.startsWith("-") || text === "-") positionals.push(args[i])
      }
      return positionals.length <= 1 ? reads(positionals) : undefined
    },
  ],
  [
    "jq",
    (args) => {
      const files: Read[] = []
      const positionals: Word[] = []
      const state = { fromFile: false }
      for (let i = 0; i < args.length; i++) {
        const text = display(args[i])
        if (text === "--args" || text === "--jsonargs") break
        if (text === "--arg" || text === "--argjson") i += 2
        else if (text === "--slurpfile" || text === "--rawfile") {
          files.push({ path: args[i + 2]?.value })
          i += 2
        } else if (text === "-f" || text === "--from-file") {
          state.fromFile = true
          files.push({ path: args[i + 1]?.value })
          i++
        } else if (text === "-L" || text === "--indent") i++
        else if (!text.startsWith("-") || text === "-") positionals.push(args[i])
      }
      return [...files, ...reads(state.fromFile ? positionals : positionals.slice(1))]
    },
  ],
  [
    "yq",
    (args) => {
      const parsed = parseArgs(
        args,
        "-o -p -I -s --output-format --input-format --indent --split-exp --expression --front-matter --from-file".split(
          " ",
        ),
      )
      if (parsed.options.some((option) => ["-i", "--inplace", "-s", "--split-exp"].includes(option))) return
      const operands = ["e", "eval", "ea", "eval-all"].includes(parsed.positionals[0]?.value ?? "")
        ? parsed.positionals.slice(1)
        : parsed.positionals
      const explicit = parsed.options.includes("--expression") || parsed.options.includes("--from-file")
      return [...reads(valuesOf(parsed, ["--from-file"])), ...reads(explicit ? operands : operands.slice(1))]
    },
  ],
  [
    "sed",
    (args) => {
      const parsed = sedParse(args)
      if (!parsed.quiet || parsed.inplace || parsed.other || parsed.file) return
      if (!parsed.scripts.every((script) => script !== undefined && SED_PRINT.test(script))) return
      return reads(parsed.files)
    },
  ],
  ...["grep", "egrep", "fgrep"].map(
    (name) =>
      [
        name,
        (args: Word[]) => {
          const parsed = parseArgs(args, GREP_VALUED)
          const explicit = parsed.options.some((option) => ["-e", "-f", "--regexp", "--file"].includes(option))
          return [
            ...reads(valuesOf(parsed, ["-f", "--file", "--exclude-from"])),
            ...reads(explicit ? parsed.positionals : parsed.positionals.slice(1)),
          ]
        },
      ] as const,
  ),
  [
    "rg",
    (args) => {
      const parsed = parseArgs(args, RG_VALUED)
      if (parsed.options.some((option) => ["--pre", "--pre-glob", "--hostname-bin"].includes(option))) return
      const explicit = parsed.options.some((option) =>
        ["-e", "-f", "--regexp", "--file", "--files", "--type-list"].includes(option),
      )
      return [
        ...reads(valuesOf(parsed, ["-f", "--file", "--ignore-file"])),
        ...reads(explicit ? parsed.positionals : parsed.positionals.slice(1)),
      ]
    },
  ],
  [
    "fd",
    (args) => {
      const parsed = parseArgs(args, FD_VALUED)
      if (parsed.options.some((option) => ["-x", "-X", "--exec", "--exec-batch"].includes(option))) return
      return [
        ...reads(valuesOf(parsed, ["--base-directory", "--search-path", "--ignore-file"])),
        ...reads(parsed.positionals.slice(1)),
      ]
    },
  ],
  [
    "find",
    (args) => {
      const parsed = findRoots(args)
      if (parsed.expression.some((item) => FIND_DENY.has(item.value ?? ""))) return
      return parsed.roots.length ? reads(parsed.roots) : [{ path: "." }]
    },
  ],
])

// Commands whose arguments are never paths or options that change behaviour, so dynamic arguments are harmless.
const DYNAMIC_OK = new Set(
  "echo printf test [ true false sleep seq basename dirname which type whoami id uname pwd".split(" "),
)
const CD = new Set(["cd", "chdir", "pushd", "popd", "set-location", "sl", "push-location", "pop-location"])

function cdTarget(rest: Word[]): string | "dynamic" | undefined {
  const name = rest[0]?.value?.toLowerCase()
  if (!name || !CD.has(name)) return
  if (name === "popd" || name === "pop-location") return "dynamic"
  const target = rest.slice(1).find((item) => item.value === undefined || !/^-./.test(item.value))
  if (!target) return name === "pushd" || name === "push-location" ? "dynamic" : "~"
  if (target.value === undefined || target.value === "-" || /^[+-]\d+$/.test(target.value)) return "dynamic"
  return target.value
}

// Git (D6, D9)

type GitCall = {
  index: number
  sub?: Word
  args: Word[]
  dirs: Word[]
  configs: (string | undefined)[]
  override?: string
  plain: boolean
}

/** Parses git's global options. `words` excludes the `git` word itself. */
function gitCall(words: Word[]): GitCall {
  const dirs: Word[] = []
  const configs: (string | undefined)[] = []
  const state: { override?: string; plain: boolean } = { plain: true }
  const key = (item: Word | undefined) => item?.value?.split("=")[0]
  for (let i = 0; i < words.length; i++) {
    const text = words[i].value
    if (text === undefined || !text.startsWith("-"))
      return { index: i, sub: words[i], args: words.slice(i + 1), dirs, configs, ...state }
    if (text === "-C") {
      if (words[i + 1]) dirs.push(words[i + 1])
      i++
      continue
    }
    if (text === "-c" || text === "--config-env") {
      configs.push(key(words[i + 1]))
      i++
      continue
    }
    if (text.startsWith("--config-env=")) {
      configs.push(key(literal(text.slice("--config-env=".length))))
      continue
    }
    const override = /^--(git-dir|work-tree|exec-path)=/.exec(text)
    if (override || text === "--git-dir" || text === "--work-tree") {
      state.override = state.override ?? (override ? `--${override[1]}` : text)
      if (!override) i++
      continue
    }
    if (["--namespace", "--super-prefix", "--attr-source"].includes(text)) i++
    if (!GIT_SAFE_GLOBALS.has(text)) state.plain = false
  }
  return { index: words.length, args: [], dirs, configs, ...state }
}

function gitExecKey(key: string) {
  const lower = key.toLowerCase()
  return (
    GIT_EXEC_KEYS.has(lower) ||
    /^(?:alias|filter|credential|pager|sendemail)\./.test(lower) ||
    /\.command$/.test(lower) ||
    /^diff\..+\.textconv$/.test(lower) ||
    /^protocol\..+\.allow$/.test(lower) ||
    /^gpg\..+\.program$/.test(lower) ||
    /^merge\..+\.driver$/.test(lower) ||
    /^(?:diff|merge)tool\..+\.(?:cmd|path)$/.test(lower) ||
    /^(?:browser|man)\..+\.(?:cmd|path)$/.test(lower) ||
    /^remote\..+\.(?:uploadpack|receivepack|proxy|vcs)$/.test(lower) ||
    /^includeif\..+\.path$/.test(lower)
  )
}

function gitConfigWrites(args: Word[]) {
  const parsed = parseArgs(args, ["-f", "--file", "--blob", "--type", "--default", "--comment", "--value"])
  const first = parsed.positionals[0]?.value
  if (first && ["set", "unset", "rename-section", "remove-section", "edit"].includes(first)) return true
  if (first && ["get", "list"].includes(first)) return false
  const writes = "--add --replace-all --unset --unset-all --rename-section --remove-section -e --edit".split(" ")
  if (parsed.options.some((option) => writes.includes(option))) return true
  if (parsed.options.some((option) => option.startsWith("--get") || option === "--list" || option === "-l"))
    return false
  return parsed.positionals.length >= 2
}

function gitFlags(args: Word[]) {
  const values = args.map(display)
  return {
    values,
    short: new Set(values.filter((value) => /^-[A-Za-z]+$/.test(value)).flatMap((value) => [...value.slice(1)])),
    long: new Set(values.filter((value) => value.startsWith("--")).map((value) => value.split("=")[0])),
    positional: values.filter((value) => !value.startsWith("-")),
  }
}

function gitDanger(call: GitCall): string | undefined {
  if (call.override) return `git ${call.override} points git at another repository or program`
  if (call.configs.some((key) => key === undefined)) return "git -c with a setting that is only known at run time"
  const risky = call.configs.find((key) => key !== undefined && gitExecKey(key))
  if (risky) return `git -c ${risky} can make git run another program`
  if (!call.sub) return
  const sub = call.sub.value
  if (sub === undefined) return "the git subcommand is only known at run time"
  const flags = gitFlags(call.args)
  // git accepts any unambiguous prefix of a long option (`--har` is --hard), so a prefix counts as the option.
  const long = (name: string) =>
    [...flags.long].some((given) => given.length >= 3 && !given.startsWith("--no-") && name.startsWith(given))
  const has = (letter: string, ...names: string[]) => flags.short.has(letter) || names.some(long)
  switch (sub) {
    case "push": {
      if (flags.short.has("f") || flags.short.has("d")) return "git push -f/-d can overwrite or delete remote branches"
      const flag = ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "--prune"].find(
        long,
      )
      if (flag) return `git push ${flag} can overwrite or delete remote branches`
      if (flags.positional.some((value) => value.startsWith("+") || value.startsWith(":")))
        return "git push with a +ref or :ref refspec overwrites or deletes a remote branch"
      return
    }
    case "reset": {
      const flag = ["--hard", "--merge", "--keep"].find(long)
      return flag && `git reset ${flag} discards uncommitted changes`
    }
    case "clean":
      if (call.configs.some((key) => key?.toLowerCase() === "clean.requireforce"))
        return "git clean with clean.requireForce overridden deletes untracked files"
      return has("f", "--force") ? "git clean -f deletes untracked files" : undefined
    case "branch": {
      const force = has("f", "--force") && (has("d", "--delete") || has("m", "--move") || has("c", "--copy"))
      return force || flags.short.has("D") || flags.short.has("M") || flags.short.has("C")
        ? "git branch -D/-M/-C force-deletes or overwrites a branch"
        : undefined
    }
    case "checkout": {
      if (has("f", "--force")) return "git checkout -f discards local changes"
      const sep = flags.values.indexOf("--")
      if (sep !== -1 && sep < flags.values.length - 1)
        return "git checkout -- <paths> discards local changes to those files"
      return flags.positional.includes(".") ? "git checkout . discards local changes" : undefined
    }
    case "restore":
      return has("S", "--staged") && !has("W", "--worktree") ? undefined : "git restore discards working-tree changes"
    case "switch":
      return has("f", "--force", "--discard-changes")
        ? "git switch --discard-changes discards local changes"
        : undefined
    case "stash":
      return ["drop", "clear"].includes(flags.positional[0])
        ? `git stash ${flags.positional[0]} deletes stashed changes`
        : undefined
    case "rebase":
      return flags.values.some((value) =>
        ["--continue", "--abort", "--skip", "--quit", "--show-current-patch"].includes(value),
      )
        ? undefined
        : "git rebase rewrites commit history"
    case "tag":
      return has("d", "--delete") ? "git tag -d deletes a tag" : undefined
    case "update-ref":
      return flags.short.has("d") ? "git update-ref -d deletes a ref" : undefined
    case "reflog":
      return ["expire", "delete"].includes(flags.positional[0])
        ? "git reflog expire/delete removes recovery history"
        : undefined
    case "gc":
      return flags.values.some(
        (value, i) =>
          /^--prune=(?:now|all)$/.test(value) || (value === "--prune" && ["now", "all"].includes(flags.values[i + 1])),
      )
        ? "git gc --prune=now deletes unreachable commits immediately"
        : undefined
    case "filter-branch":
    case "filter-repo":
      return `git ${sub} rewrites the whole history`
    case "worktree":
      return flags.positional[0] === "remove" && has("f", "--force")
        ? "git worktree remove --force deletes a worktree with local changes"
        : undefined
    case "config":
      return gitConfigWrites(call.args)
        ? "git config changes git settings, which can make git run other programs"
        : undefined
  }
}

function gitListForm(values: string[], letters: RegExp, long: string[], listing: string[]) {
  const state = { listing: false }
  for (const value of values) {
    if (value.startsWith("--")) {
      const key = value.split("=")[0]
      if (!long.includes(key)) return false
      if (listing.includes(key)) state.listing = true
      continue
    }
    if (value.startsWith("-")) {
      if (!letters.test(value)) return false
      if (value.includes("l")) state.listing = true
      continue
    }
    if (!state.listing) return false
  }
  return true
}

const BRANCH_LONG =
  "--all --remotes --list --verbose --show-current --contains --no-contains --merged --no-merged --sort --format --points-at --color --no-color --column --no-column --ignore-case --abbrev --no-abbrev --quiet --omit-empty".split(
    " ",
  )
const TAG_LONG =
  "--list --contains --no-contains --merged --no-merged --points-at --sort --format --column --no-column --color --ignore-case --omit-empty".split(
    " ",
  )
// Options that put git branch/tag in list mode. --sort and --format do not: `git branch --sort=x new` creates a branch.
const LISTING = "--list --contains --no-contains --merged --no-merged --points-at".split(" ")

function gitRead(call: GitCall): Read[] | undefined {
  const sub = call.sub?.value
  if (!sub || !call.plain || call.configs.length > 0 || call.override) return
  const dir = call.dirs.at(-1)?.value
  const sep = call.args.findIndex((item) => item.value === "--")
  const head = sep === -1 ? call.args : call.args.slice(0, sep)
  const flags = gitFlags(head)
  const join = (item: Word): Read => {
    if (item.value === undefined || !dir || /^[/~]/.test(item.value)) return { path: item.value }
    return { path: `${dir}/${item.value}` }
  }
  const found = [
    ...call.dirs.map((item) => ({ path: item.value })),
    ...(sep === -1 ? [] : call.args.slice(sep + 1).map(join)),
  ]
  switch (sub) {
    case "status":
    case "blame":
    case "shortlog":
    case "describe":
    case "rev-parse":
    case "ls-files":
    case "ls-tree":
    case "cat-file":
    case "merge-base":
    case "name-rev":
    case "count-objects":
      return found
    case "diff":
    case "log":
    case "show":
      if (flags.long.has("--output") || flags.long.has("--ext-diff")) return
      if (sub === "diff" && flags.long.has("--no-index"))
        return [...found, ...head.filter((item) => !display(item).startsWith("-")).map(join)]
      return found
    case "grep":
      return flags.values.some((value) => value.startsWith("-O") || value.startsWith("--open-files-in-pager"))
        ? undefined
        : found
    case "branch":
      return gitListForm(flags.values, /^-[arlvqi]+$/, BRANCH_LONG, LISTING) ? found : undefined
    case "tag":
      return gitListForm(flags.values, /^-[lni0-9]+$/, TAG_LONG, LISTING) ? found : undefined
    case "remote":
      if (flags.positional.length === 0)
        return flags.values.every((value) => value === "-v" || value === "--verbose") ? found : undefined
      return ["show", "get-url"].includes(flags.positional[0]) ? found : undefined
    case "stash":
    case "worktree":
      return flags.positional[0] === "list" ? found : undefined
    case "reflog":
      return ["expire", "delete", "drop"].includes(flags.positional[0]) ? undefined : found
    case "config":
      return gitConfigWrites(call.args) ? undefined : found
  }
}

function dirsOf(call: GitCall) {
  return call.dirs.length ? { dirs: call.dirs.map((item) => item.value) } : {}
}

function commitPlan(call: GitCall): GitCommit | undefined {
  const args = call.args
  const paths: string[] = []
  const state = { all: false, include: false, ended: false }
  const valued =
    "--message --file --reuse-message --reedit-message --author --date --fixup --squash --template --trailer --cleanup".split(
      " ",
    )
  for (let i = 0; i < args.length; i++) {
    const text = args[i].value
    if (text === undefined) {
      state.all = true
      continue
    }
    if (state.ended || !text.startsWith("-") || text === "-") {
      paths.push(text)
      continue
    }
    if (text === "--") {
      state.ended = true
      continue
    }
    if (text === "--dry-run") return
    if (text.startsWith("--")) {
      const key = text.split("=")[0]
      if (key === "--all") state.all = true
      if (key === "--include") state.include = true
      if (key === "--pathspec-from-file") state.all = true
      if ((valued.includes(key) || key === "--pathspec-from-file") && !text.includes("=")) i++
      continue
    }
    for (let j = 1; j < text.length; j++) {
      const c = text[j]
      if (c === "a") state.all = true
      if (c === "i") state.include = true
      if ("mFCct".includes(c)) {
        if (j + 1 === text.length) i++
        break
      }
      if (c === "S" || c === "u") break
    }
  }
  return { all: state.all, include: state.include, paths, ...dirsOf(call) }
}

function addPlan(call: GitCall): GitAdd {
  const args = call.args
  const paths: string[] = []
  const state = { everything: false, ended: false, force: false }
  for (let i = 0; i < args.length; i++) {
    const text = args[i].value
    if (text === undefined) {
      paths.push(":/")
      continue
    }
    if (state.ended || !text.startsWith("-") || text === "-") {
      paths.push(text)
      continue
    }
    if (text === "--") {
      state.ended = true
      continue
    }
    if (text.startsWith("--")) {
      const key = text.split("=")[0]
      if (["--all", "--update", "--no-ignore-removal"].includes(key)) state.everything = true
      if (key === "--force") state.force = true
      if (key === "--pathspec-from-file") paths.push(":/")
      if ((key === "--pathspec-from-file" || key === "--chmod") && !text.includes("=")) i++
      continue
    }
    if (/[Au]/.test(text)) state.everything = true
    if (text.includes("f")) state.force = true
  }
  return {
    paths: paths.length === 0 && state.everything ? [":/"] : [...new Set(paths)],
    ...(state.force ? { force: true } : {}),
    ...dirsOf(call),
  }
}

// Writes, removes and reads of file commands (D11, D5)

function effects(words: Word[], xargs: boolean) {
  const writes: Write[] = []
  const found: Read[] = []
  const removes: Remove[] = []
  const name = words[0]?.value === undefined ? "" : base(words[0].value).toLowerCase()
  const args = words.slice(1)
  const links: Link[] = []
  const write = (item: Word | undefined, recursive = false) => {
    if (item?.value === "-") return
    writes.push({
      path: item?.value,
      kind: "arg",
      ...(item && item.value === undefined ? { text: item.text } : {}),
      ...(recursive ? { recursive } : {}),
    })
  }
  const remove = (item: Word, recursive: boolean) => removes.push({ path: item.value, recursive, glob: item.glob })

  switch (name) {
    case "tee":
      parseArgs(args).positionals.forEach((item) => write(item))
      break
    case "cp":
    case "mv":
    case "ln":
    case "install": {
      const parsed = parseArgs(args, "-t --target-directory -S --suffix -m --mode -o --owner -g --group".split(" "))
      const target = valuesOf(parsed, ["-t", "--target-directory"])
      if (name === "install" && parsed.options.includes("-d")) {
        parsed.positionals.forEach((item) => write(item))
        break
      }
      const sources = target.length ? parsed.positionals : parsed.positionals.slice(0, -1)
      if (target.length) target.forEach((item) => write(item))
      else if (name === "ln" && parsed.positionals.length === 1) {
        const only = parsed.positionals[0]
        write(only.value === undefined ? only : literal(base(only.value)))
      } else parsed.positionals.slice(-1).forEach((item) => write(item))
      if (name === "mv") sources.forEach((item) => remove(item, false))
      if (name !== "ln") found.push(...reads(sources))
      const symbolic = parsed.options.some((option) => option === "-s" || option === "--symbolic")
      const hard = parsed.options.some((option) => option === "-l" || option === "--link")
      if (name === "ln" || (name === "cp" && (symbolic || hard))) {
        const linkSources =
          name === "ln" && !target.length && parsed.positionals.length === 1 ? parsed.positionals : sources
        const dest =
          target[0] ?? (name === "ln" && parsed.positionals.length === 1 ? undefined : parsed.positionals.at(-1))
        for (const source of linkSources) {
          const leaf = source.value === undefined ? undefined : base(source.value)
          const inside =
            dest === undefined
              ? leaf
              : dest.value === undefined || leaf === undefined
                ? undefined
                : `${dest.value}/${leaf}`
          const link = { target: source.value, symbolic: name === "ln" ? symbolic : symbolic }
          if (dest && !target.length) links.push({ ...link, path: dest.value })
          links.push({ ...link, path: inside })
        }
      }
      break
    }
    case "mkdir":
      parseArgs(args, ["-m", "--mode"]).positionals.forEach((item) => write(item))
      break
    case "touch": {
      const parsed = parseArgs(args, ["-d", "-t", "-r", "-A", "--date", "--reference"])
      parsed.positionals.forEach((item) => write(item))
      found.push(...reads(valuesOf(parsed, ["-r", "--reference"])))
      break
    }
    case "chmod": {
      // A symbolic mode may start with "-" (`-w`, `-w,+x`, `-rwx,g+s`): it is the mode, not an option.
      const mode = args.findIndex(
        (item) =>
          /^-[rwxXstugoa]*(?:,[ugoa]*[-+=][rwxXstugo]*)*$/.test(item.value ?? "") && /[rwxXst]/.test(item.value ?? ""),
      )
      const parsed = parseArgs(mode === -1 ? args : args.filter((_, i) => i !== mode), ["--reference"])
      const reference = parsed.options.some((option) => option.startsWith("--reference"))
      const recursive = parsed.options.some((option) => option === "-R" || option === "--recursive")
      ;(mode !== -1 || reference ? parsed.positionals : parsed.positionals.slice(1)).forEach((item) =>
        write(item, recursive),
      )
      break
    }
    case "chown":
    case "chgrp": {
      const parsed = parseArgs(args, [])
      const recursive = parsed.options.some((option) => option === "-R" || option === "--recursive")
      ;(parsed.options.some((option) => option.startsWith("--reference"))
        ? parsed.positionals
        : parsed.positionals.slice(1)
      ).forEach((item) => write(item, recursive))
      break
    }
    case "sort": {
      const parsed = parseArgs(
        args,
        "-k -t -S -T -o --key --field-separator --buffer-size --temporary-directory --output --parallel --batch-size --files0-from --compress-program --random-source".split(
          " ",
        ),
      )
      valuesOf(parsed, ["-o", "--output"]).forEach((item) => write(item))
      found.push(...reads([...parsed.positionals, ...valuesOf(parsed, ["--files0-from", "--random-source"])]))
      break
    }
    case "uniq": {
      const parsed = parseArgs(args, ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"])
      found.push(...reads(parsed.positionals.slice(0, 1)))
      parsed.positionals.slice(1, 2).forEach((item) => write(item))
      break
    }
    case "xxd": {
      const valued = ["-c", "-g", "-l", "-o", "-s", "-n", "-cols", "-len", "-seek", "-groupsize", "-offset", "-name"]
      const positionals: Word[] = []
      for (let i = 0; i < args.length; i++) {
        const text = display(args[i])
        if (valued.includes(text)) i++
        else if (!text.startsWith("-") || text === "-") positionals.push(args[i])
      }
      found.push(...reads(positionals.slice(0, 1)))
      positionals.slice(1, 2).forEach((item) => write(item))
      break
    }
    case "tree": {
      const parsed = parseArgs(args, [
        "-L",
        "-I",
        "-P",
        "-o",
        "-H",
        "-T",
        "--charset",
        "--filelimit",
        "--timefmt",
        "--sort",
        "--fromfile",
      ])
      valuesOf(parsed, ["-o"]).forEach((item) => write(item))
      break
    }
    case "git": {
      // Output files of diff/log/show/format-patch. git owns .git, but these are ordinary files it writes for you.
      for (let i = 0; i < args.length; i++) {
        const text = display(args[i])
        if (text === "--output" || text === "--output-directory" || text === "-o") write(args[i + 1])
        else if (text.startsWith("--output=")) write(tail(args[i], "--output=".length))
        else if (text.startsWith("--output-directory=")) write(tail(args[i], "--output-directory=".length))
      }
      break
    }
    case "rsync":
    case "scp": {
      const valued =
        name === "rsync"
          ? "-e -f -B -T -M --rsh --rsync-path --filter --exclude --include --exclude-from --include-from --files-from --temp-dir --partial-dir --backup-dir --suffix --chmod --chown --usermap --groupmap --compare-dest --copy-dest --link-dest --log-file --log-file-format --out-format --password-file --port --sockopts --timeout --contimeout --bwlimit --max-size --min-size --max-delete --modify-window --block-size --info --debug --outbuf --remote-option --address --protocol --iconv --checksum-choice --compress-choice --compress-level --skip-compress --stop-after --stop-at --write-batch --only-write-batch --read-batch".split(
              " ",
            )
          : "-c -F -i -J -l -o -P -S -D -X".split(" ")
      const parsed = parseArgs(args, valued)
      const operands = parsed.positionals
      if (operands.length < 2) break
      const dest = operands.at(-1)!
      found.push(...reads(operands.slice(0, -1).filter((item) => !/^[^/]*:/.test(item.value ?? ""))))
      if (/^[^/]*:/.test(dest.value ?? "")) break
      write(dest)
      const deletes = parsed.options.some((option) => /^--(?:delete|del$|remove-source-files)/.test(option))
      if (deletes) removes.push({ path: dest.value, recursive: true, glob: dest.glob, within: true })
      break
    }
    case "copy":
    case "xcopy":
    case "robocopy":
    case "move":
    case "ren":
    case "rename":
    case "mklink": {
      // cmd.exe: options are /x, /x:value; everything else is a path.
      const operands = args.filter((item) => item.value === undefined || !/^\/[a-z?]{1,4}(?::.*)?$/i.test(item.value))
      if (name === "mklink") {
        operands.slice(0, 1).forEach((item) => write(item))
        if (operands[0]) links.push({ path: operands[0].value, target: operands[1]?.value, symbolic: true })
        break
      }
      if (name === "ren" || name === "rename") {
        const [from, to] = operands
        if (to)
          write(
            to.value === undefined || from?.value === undefined || /[\\/]/.test(to.value)
              ? to
              : literal(from.value.replace(/[^\\/]*$/, to.value)),
          )
        if (from) remove(from, false)
        break
      }
      const dest = name === "robocopy" ? operands[1] : operands.length > 1 ? operands.at(-1) : literal(".")
      write(dest)
      found.push(...reads(name === "robocopy" ? operands.slice(0, 1) : operands.slice(0, -1)))
      if (name === "move") operands.slice(0, -1).forEach((item) => remove(item, false))
      if (name === "robocopy" && dest && args.some((item) => /^\/(?:mir|purge)$/i.test(item.value ?? "")))
        removes.push({ path: dest.value, recursive: true, glob: dest.glob, within: true })
      break
    }
    case "truncate": {
      const parsed = parseArgs(args, ["-s", "--size", "-r", "--reference"])
      parsed.positionals.forEach((item) => write(item))
      found.push(...reads(valuesOf(parsed, ["-r", "--reference"])))
      break
    }
    case "dd":
      args.forEach((item) => {
        const text = display(item)
        if (text.startsWith("of=")) write(tail(item, 3))
        if (text.startsWith("if=")) found.push({ path: tail(item, 3).value })
      })
      break
    case "sed": {
      const parsed = sedParse(args)
      if (parsed.inplace) parsed.files.forEach((item) => write(item))
      else found.push(...reads(parsed.files))
      const script = sedEffects(args)
      script.writes.forEach((file) => write(literal(file)))
      script.reads.forEach((file) => found.push({ path: file }))
      if (script.unknownWrite) writes.push({ kind: "arg" })
      break
    }
    case "perl": {
      const state = { inplace: false, script: false }
      const operands: Word[] = []
      for (let i = 0; i < args.length; i++) {
        const text = args[i].value
        if (text === undefined || !text.startsWith("-") || text === "-") {
          operands.push(...args.slice(i))
          break
        }
        if (text === "--") {
          operands.push(...args.slice(i + 1))
          break
        }
        for (let j = 1; j < text.length; j++) {
          const c = text[j]
          if (c === "i") {
            state.inplace = true
            break
          }
          if (c === "e" || c === "E") {
            state.script = true
            if (j + 1 === text.length) i++
            break
          }
          if ("IMmlx0dDC".includes(c)) break
        }
      }
      if (state.inplace) (state.script ? operands : operands.slice(1)).forEach((item) => write(item))
      break
    }
    case "curl": {
      const valued = new Set(
        "--output --dump-header --cookie-jar --cookie --trace --trace-ascii --stderr --output-dir --config --upload-file --data --data-raw --data-binary --data-urlencode --form --header --request --user --user-agent --referer --max-time --connect-timeout --proxy --retry --url --write-out --range --cacert --cert --key --etag-save --etag-compare --hsts --alt-svc --json --variable --libcurl".split(
          " ",
        ),
      )
      const writesTo =
        "--dump-header --cookie-jar --trace --trace-ascii --stderr --etag-save --hsts --alt-svc --libcurl".split(" ")
      const state: { remote: number; dir?: Word } = { remote: 0 }
      const urls: Word[] = []
      const outputs: (Word | undefined)[] = []
      for (let i = 0; i < args.length; i++) {
        const text = display(args[i])
        if (text.startsWith("--")) {
          const eq = text.indexOf("=")
          const key = eq === -1 ? text : text.slice(0, eq)
          if (key === "--remote-name" || key === "--remote-name-all") state.remote++
          if (!valued.has(key)) continue
          const value = eq === -1 ? args[++i] : tail(args[i], eq + 1)
          if (writesTo.includes(key)) write(value)
          if (key === "--output") outputs.push(value)
          if (key === "--output-dir") state.dir = value
          if (key === "--config" || key === "--upload-file") found.push({ path: value?.value })
          if (key === "--url" && value) urls.push(value)
          continue
        }
        if (!text.startsWith("-") || text === "-") {
          urls.push(args[i])
          continue
        }
        for (let j = 1; j < text.length; j++) {
          const c = text[j]
          if (c === "O") state.remote++
          if (!"AbcCdDeEFHKmoPQrTtuUwxXyYz".includes(c)) continue
          const value = j + 1 < text.length ? tail(args[i], j + 1) : args[++i]
          if (c === "o") outputs.push(value)
          if ("Dc".includes(c)) write(value)
          if ("KT".includes(c)) found.push({ path: value?.value })
          break
        }
      }
      // --output-dir applies to every -o and -O file whose name is relative.
      for (const output of outputs) {
        const value = output?.value
        if (!state.dir || value === undefined || value === "-" || /^[/~]/.test(value)) write(output)
        else write(state.dir.value === undefined ? state.dir : literal(`${state.dir.value}/${value}`))
      }
      if (state.remote > 0) {
        const dir = state.dir ? state.dir.value : "."
        const named = urls
          .map((item) => item.value && /^[a-z]+:\/\/[^/]+\/(?:[^?#]*\/)?([^/?#]+)/i.exec(item.value)?.[1])
          .filter((item): item is string => Boolean(item))
        if (dir === undefined) writes.push({ kind: "arg" })
        else if (named.length)
          named.forEach((file) => writes.push({ path: dir === "." ? file : `${dir}/${file}`, kind: "arg" }))
        else writes.push({ path: dir, kind: "arg" })
      }
      break
    }
    case "wget": {
      const parsed = parseArgs(
        args,
        "-O -o -a -P -e -i -B -T -t -w -Q -U -l -A -R -D --output-document --output-file --append-output --directory-prefix --execute --input-file --base --timeout --tries --wait --quota --user-agent --level --accept --reject --domains --header --post-data --post-file --user --password".split(
          " ",
        ),
      )
      valuesOf(parsed, ["-o", "-a", "--output-file", "--append-output"]).forEach((item) => write(item))
      found.push(...reads(valuesOf(parsed, ["-i", "--input-file", "--post-file"])))
      const document = valuesOf(parsed, ["-O", "--output-document"])
      if (document.length) document.forEach((item) => write(item))
      else {
        const prefix = valuesOf(parsed, ["-P", "--directory-prefix"])
        if (prefix.length) prefix.forEach((item) => write(item))
        else write(literal("."))
      }
      break
    }
    case "tar": {
      const state: { mode: string; archive?: Word; dir?: Word } = { mode: "" }
      const operands: Word[] = []
      const first = args[0]?.value
      const bundle = first !== undefined && /^[A-Za-z]+$/.test(first)
      const pending: string[] = bundle ? [...first] : []
      let i = bundle ? 1 : 0
      for (const c of pending) {
        if ("cxtruAd".includes(c) && !state.mode) state.mode = c
        if (c === "f") state.archive = args[i++]
        if (c === "C") state.dir = args[i++]
        if ("bLNVgTXK".includes(c)) i++
      }
      const modes = new Map([
        ["--extract", "x"],
        ["--get", "x"],
        ["--create", "c"],
        ["--append", "r"],
        ["--update", "u"],
        ["--concatenate", "A"],
        ["--catenate", "A"],
        ["--list", "t"],
        ["--diff", "d"],
        ["--compare", "d"],
      ])
      const longValued =
        "--file --directory --files-from --exclude-from --transform --owner --group --mode --exclude --label --format".split(
          " ",
        )
      for (; i < args.length; i++) {
        const text = display(args[i])
        if (text.startsWith("--")) {
          const eq = text.indexOf("=")
          const key = eq === -1 ? text : text.slice(0, eq)
          const mode = modes.get(key)
          if (mode && !state.mode) state.mode = mode
          if (!longValued.includes(key)) continue
          const value = eq === -1 ? args[++i] : tail(args[i], eq + 1)
          if (key === "--file") state.archive = value
          if (key === "--directory") state.dir = value
          continue
        }
        if (!text.startsWith("-") || text === "-") {
          operands.push(args[i])
          continue
        }
        for (let j = 1; j < text.length; j++) {
          const c = text[j]
          if ("cxtruAd".includes(c) && !state.mode) state.mode = c
          if (!"fCbLNVgTXK".includes(c)) continue
          const value = j + 1 < text.length ? tail(args[i], j + 1) : args[++i]
          if (c === "f") state.archive = value
          if (c === "C") state.dir = value
          break
        }
      }
      if (state.mode === "x") {
        write(state.dir ?? literal("."))
        if (state.archive) found.push(...reads([state.archive]))
      } else if ("cruA".includes(state.mode) && state.mode) {
        if (state.archive) write(state.archive)
        found.push(...reads(operands))
      } else if (state.archive) found.push(...reads([state.archive]))
      break
    }
    case "unzip": {
      const parsed = parseArgs(args, ["-d"])
      if (parsed.positionals[0]) found.push(...reads([parsed.positionals[0]]))
      if (parsed.options.some((option) => ["-l", "-t", "-Z", "-p", "-c", "-z"].includes(option))) break
      const dir = valuesOf(parsed, ["-d"])
      if (dir.length) dir.forEach((item) => write(item))
      else write(literal("."))
      break
    }
    case "rm": {
      const state = { recursive: false, ended: false }
      const targets: Word[] = []
      for (const item of args) {
        const text = item.value
        if (!state.ended && text === "--") {
          state.ended = true
          continue
        }
        if (!state.ended && text !== undefined && text.startsWith("-") && text !== "-") {
          if (text === "--recursive" || (!text.startsWith("--") && /[rR]/.test(text))) state.recursive = true
          continue
        }
        targets.push(item)
      }
      targets.forEach((item) => remove(item, state.recursive))
      if (xargs) removes.push({ recursive: state.recursive, glob: false })
      break
    }
    case "rmdir":
    case "rd":
    case "del":
    case "erase": {
      const recursive = args.some((item) => /^\/s$/i.test(item.value ?? ""))
      args
        .filter(
          (item) =>
            item.value === undefined ||
            (!/^\/[a-z]$/i.test(item.value) && !(name === "rmdir" && /^-/.test(item.value))),
        )
        .forEach((item) => remove(item, recursive))
      if (xargs) removes.push({ recursive, glob: false })
      break
    }
    case "unlink":
      args.filter((item) => item.value !== "--").forEach((item) => remove(item, false))
      if (xargs) removes.push({ recursive: false, glob: false })
      break
    case "shred":
      parseArgs(args, ["-n", "-s", "--iterations", "--size", "--random-source"]).positionals.forEach((item) =>
        remove(item, false),
      )
      if (xargs) removes.push({ recursive: false, glob: false })
      break
    case "find": {
      const parsed = findRoots(args)
      parsed.expression.forEach((item, i) => {
        if (["-fprint", "-fprint0", "-fls", "-fprintf"].includes(item.value ?? "")) write(parsed.expression[i + 1])
      })
      const removal = parsed.expression.some(
        (item, i) =>
          item.value === "-delete" ||
          (FIND_EXEC.has(item.value ?? "") &&
            ["rm", "rmdir", "unlink", "shred"].includes(base(parsed.expression[i + 1]?.value ?? ""))),
      )
      if (!removal) break
      // Deleting only entries selected by name (`-name '*.pyc'`) never removes the start folder itself. Negations and
      // alternatives can select everything, and a dynamic expression is unknown.
      const values = parsed.expression.map((item) => item.value)
      const within =
        values.every((value) => value !== undefined && !["!", "-not", "-o", "-or", ","].includes(value)) &&
        values.some((value) => FIND_NAME_TESTS.has(value ?? ""))
      ;(parsed.roots.length ? parsed.roots : [literal(".")]).forEach((item) =>
        removes.push({ path: item.value, recursive: true, glob: item.glob, ...(within ? { within } : {}) }),
      )
      break
    }
    case "remove-item":
    case "ri": {
      const state = { recursive: false }
      const targets: Word[] = []
      for (let i = 0; i < args.length; i++) {
        const text = display(args[i]).toLowerCase()
        if (!text.startsWith("-")) {
          const value = args[i].value
          if (value?.includes(","))
            targets.push(...value.split(",").map((part) => ({ ...literal(part), glob: /[*?[]/.test(part) })))
          else targets.push(args[i])
          continue
        }
        if (text.length >= 2 && "-recurse".startsWith(text)) state.recursive = true
        if (["-path", "-literalpath", "-lp", "-pspath"].includes(text) && args[i + 1]) {
          targets.push(text === "-path" ? args[i + 1] : { ...args[i + 1], glob: false })
          i++
        }
        if (["-include", "-exclude", "-filter", "-stream", "-credential"].includes(text)) i++
      }
      targets.forEach((item) => remove(item, state.recursive))
      break
    }
  }

  if (
    xargs &&
    ["tee", "cp", "mv", "ln", "install", "mkdir", "touch", "chmod", "chown", "chgrp", "truncate"].includes(name)
  )
    writes.push({ kind: "arg" })
  return { writes, reads: found, removes, links }
}

function redirectKind(redirect: Redirect) {
  const op = redirect.op.replace(/^\d+/, "")
  if (op === "<<" || op === "<<-" || op === "<<<" || op === "<&") return
  if (op === "<") return "read"
  const target = word(redirect.target)
  const value = target.value ?? ""
  if (op === ">&" && /^(?:\d+|-)$/.test(value)) return
  if (/^&(?:\d+|-)$/.test(value)) return
  if (target.value !== undefined && (DEVICES.has(value) || /^\/dev\/fd\/\d+$/.test(value))) return
  return "write"
}

/**
 * The "Allow always" rule for a command. `exact` saves the command as written instead of a prefix (commands that
 * write files named in their arguments), so the rule never approves later writes to other files.
 */
function alwaysOf(rest: Word[], blocked: boolean, exact: boolean) {
  if (blocked) return
  const name = rest[0]?.value
  if (name === undefined) return
  const bare = base(name).toLowerCase()
  if (INTERPRETERS.has(bare) || WRAPPER_NAMES.has(bare) || EXEC.has(bare)) return
  const whole = rest.map((item) => item.text).join(" ")
  if (exact || EXACT.has(bare) || EXACT_FAMILIES.has(bare)) return whole
  const globals = bare === "git" ? gitCall(rest.slice(1)).index : 0
  const tokens = [name, ...rest.slice(1 + globals).map(display)]
  const size = BashArity.prefix(tokens).length
  if (size === 0) return
  // A bare invocation shorter than its arity (`make`, `docker compose`) saves the exact command.
  if (BashArity.prefix([...tokens, "\u0000", "\u0000"]).length > tokens.length) return whole
  if (tokens.slice(1, size).some((token) => token.startsWith("-"))) return
  return (
    [...rest.slice(0, 1 + globals), ...rest.slice(1 + globals, globals + size)].map((item) => item.text).join(" ") +
    " *"
  )
}

/** Read paths when the command (sudo/doas already stripped) is on the read-only allowlist, else undefined. */
function validate(head: string | undefined, args: Word[], cd: string | undefined, git: GitCall | undefined) {
  if (head === undefined || head.includes("/")) return
  if (TOOLCHAIN.has(head) && args.length === 1 && ["--version", "-v", "-V", "--help"].includes(args[0].value ?? ""))
    return []
  if (head === "command" && ["-v", "-V"].includes(args[0]?.value ?? "")) return []
  if (cd === "dynamic") return /^pop/i.test(head) ? [] : undefined
  if (cd !== undefined) return [{ path: cd }]
  if (git) return gitRead(git)
  return READ_ONLY.get(head)?.(args)
}

/** Classifies one sub-command for permission decisions (read-only, writes, floor and guard hints, Allow always). */
export function classify(input: SubcommandInput): Classified {
  const analyzed = analyze(input.words.map(word), input.assignments)
  const stripped = analyzed.stripped
  const rest = analyzed.rest
  const floorWords = analyzed.floor
  const floorXargs = analyzed.floorXargs
  const name = rest.length ? display(rest[0]) : ""
  const head = floorWords[0]?.value
  const floorName = head === undefined ? "" : base(head).toLowerCase()
  const floorArgs = floorWords.slice(1)

  const redirectWrites = input.redirects
    .filter((redirect) => redirectKind(redirect) === "write")
    .map((redirect): Write => {
      const target = word(redirect.target)
      return { path: target.value, kind: "redirect", ...(target.value === undefined ? { text: target.text } : {}) }
    })
  const redirectReads = input.redirects
    .filter((redirect) => redirectKind(redirect) === "read")
    .map((redirect): Read => ({ path: word(redirect.target).value }))

  const cd = cdTarget(floorWords)
  const git = floorName === "git" ? gitCall(floorArgs) : undefined
  const validated = validate(head, floorArgs, cd, git)
  const argsStatic = floorArgs.every((item) => item.value !== undefined) || DYNAMIC_OK.has(head ?? "")
  const baseReadOnly =
    validated !== undefined &&
    validated.every((item) => item.path !== undefined) &&
    !stripped.exec &&
    !stripped.unsafeEnv &&
    !floorXargs &&
    argsStatic &&
    input.raw.length <= LIMITS.maxChars
  const readOnly = baseReadOnly && redirectWrites.length === 0 && redirectReads.every((item) => item.path !== undefined)

  const extracted = effects(floorWords, floorXargs)
  const scan = {
    destructiveGit: git ? gitDanger(git) : undefined,
    gitCommit: git?.sub?.value === "commit" ? commitPlan(git) : undefined,
    gitAdd: git?.sub?.value === "add" ? addPlan(git) : undefined,
  }
  const nested = nestedScripts(floorWords)

  // A known wrapper or runner that could not be unwrapped (an unknown option, a runner like watch or nsenter, too
  // many layers) still runs the command after it. Fail closed: every later word that names a file command is read
  // as the start of that command, so a hidden `rm -rf ~` or `git push -f` still reaches the floor and guards.
  const runner = program(floorWords[0])
  if (
    runner !== undefined &&
    floorWords.length > 1 &&
    (WRAPPERS.has(runner) || ELEVATE.has(runner) || EXEC.has(runner))
  ) {
    for (let i = 1; i < floorWords.length; i++) {
      const sub = floorWords.slice(i)
      const next = program(sub[0])
      if (next === undefined) continue
      if (SHELLS.has(next) || ["eval", "env", "su", "flock", "script", "watch"].includes(next))
        nested.push(...nestedScripts(sub).filter((script) => !nested.includes(script)))
      if (!EFFECT_NAMES.has(next)) continue
      const more = effects(sub, floorXargs || runner === "xargs")
      extracted.writes.push(...more.writes)
      extracted.reads.push(...more.reads)
      extracted.removes.push(...more.removes)
      extracted.links.push(...more.links)
      if (next !== "git") continue
      const call = gitCall(sub.slice(1))
      scan.destructiveGit = scan.destructiveGit ?? gitDanger(call)
      if (call.sub?.value === "commit") scan.gitCommit = scan.gitCommit ?? commitPlan(call)
      if (call.sub?.value === "add") scan.gitAdd = scan.gitAdd ?? addPlan(call)
    }
  }

  // env -C / sudo -D run the command in another folder: its relative paths start there (redirects do not).
  const chdir = analyzed.chdir
  const moved = <T extends { path?: string }>(item: T): T => {
    if (chdir === undefined || item.path === undefined || /^(?:[/~]|[A-Za-z]:[\\/])/.test(item.path)) return item
    return { ...item, path: chdir === null ? undefined : `${chdir.replace(/[/\\]+$/, "")}/${item.path}` }
  }
  const writes = [...redirectWrites, ...extracted.writes.map(moved)]
  const allReads = [...(validated ?? []).map(moved), ...extracted.reads.map(moved), ...redirectReads]
  const removes = extracted.removes.map(moved)
  const links = extracted.links.map(moved)
  const destructiveGit = scan.destructiveGit
  const fsKind = (["mkdir", "touch", "mv", "cp"] as const).find((kind) => kind === name)
  const fsSafeCandidate =
    !stripped.exec &&
    !stripped.unsafeEnv &&
    !stripped.argsDynamic &&
    input.raw.length <= LIMITS.maxChars &&
    (fsKind !== undefined || name === "tee" || baseReadOnly) &&
    writes.every((item) => item.path !== undefined) &&
    removes.every((item) => item.path !== undefined) &&
    allReads.every((item) => item.path !== undefined)
  // Writing files named in the arguments (cp, tee, sed -i, curl -o): a prefix rule would approve any later file.
  const argWrites = writes.some((item) => item.kind === "arg") && !["mkdir", "touch"].includes(floorName)

  return {
    ...stripped,
    name,
    readOnly,
    nested,
    cd,
    writes,
    reads: allReads,
    removes,
    links,
    fsKind,
    fsSafeCandidate,
    destructiveGit,
    gitCommit: scan.gitCommit,
    gitAdd: scan.gitAdd,
    always: alwaysOf(
      rest,
      stripped.exec || stripped.unsafeEnv || stripped.argsDynamic || destructiveGit !== undefined || nested.length > 0,
      argWrites,
    ),
  }
}

function nestedScripts(words: Word[]) {
  const name = program(words[0]) ?? ""
  const args = words.slice(1)
  const valueAfter = (i: number) => {
    const value = args[i + 1]?.value
    return value === undefined ? [] : [value]
  }
  if (SHELLS.has(name)) {
    // With -c the script is the first argument that is not an option (bash, sh and zsh keep parsing options after
    // -c, and accept `--` before the script).
    const state = { command: false }
    for (let i = 0; i < args.length; i++) {
      const text = args[i].value
      if (text === undefined) return []
      if (text === "--") return state.command ? valueAfter(i) : []
      if (!/^[-+]./.test(text)) return state.command ? [text] : []
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(text)) state.command = true
      if (/^[-+][oO]$/.test(text)) i++
    }
    return []
  }
  if (name === "watch" && !args.some((item) => ["-x", "--exec"].includes(item.value ?? ""))) {
    // watch without -x joins its arguments and runs them with sh -c.
    const at = args.findIndex((item, i) => {
      const text = item.value ?? ""
      return !text.startsWith("-") && !["-n", "-q", "--interval", "--equexit"].includes(args[i - 1]?.value ?? "")
    })
    const script = at === -1 ? [] : args.slice(at)
    return script.length > 0 && script.every((item) => item.value !== undefined) ? [script.map(display).join(" ")] : []
  }
  if (name === "script") {
    for (let i = 0; i < args.length; i++) {
      const text = args[i].value
      if (text === undefined) continue
      if (text === "--command" || /^-[a-zA-Z]*c$/.test(text)) return valueAfter(i)
      if (text.startsWith("--command=")) return [text.slice("--command=".length)]
      if (/^-[a-zA-Z]*c./.test(text)) return [text.slice(text.indexOf("c") + 1)]
    }
    return []
  }
  if (name === "eval")
    return args.length > 0 && args.every((item) => item.value !== undefined) ? [args.map(display).join(" ")] : []
  if (name === "env" || name === "su" || name === "flock") {
    const short = name === "env" ? "-S" : "-c"
    const long = name === "env" ? "--split-string" : "--command"
    for (let i = 0; i < args.length; i++) {
      const text = args[i].value
      if (text === undefined) continue
      if (text === short || text === long) return valueAfter(i)
      if (text.startsWith(long + "=")) return [text.slice(long.length + 1)]
      if (text.startsWith(short) && text.length > 2) return [text.slice(2)]
    }
  }
  return []
}

/** Conservative regex check for a critical recursive rm when no parsed hints are available. */
export function fallbackCriticalRm(raw: string) {
  return raw.split(/[;&|\n()`]+/).some((segment) => {
    const tokens = segment.trim().split(/\s+/)
    const at = tokens.findIndex((token) => /^(?:.*\/)?rm$/.test(token.replace(/^["']+|["']+$/g, "")))
    if (at === -1) return false
    const args = tokens.slice(at + 1)
    if (!args.some((arg) => arg === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg))) return false
    return args
      .filter((arg) => !arg.startsWith("-"))
      .map((arg) => arg.replace(/^["']+|["']+$/g, ""))
      .some(
        (arg) => /^[/~]/.test(arg) || arg.includes("$") || arg.includes("*") || [".", "./", "..", "../"].includes(arg),
      )
  })
}

export * as BashClassify from "./bash-classify"
