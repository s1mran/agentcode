// Commit secret scan (D7). Pure: git is reached only through the injected runner and untracked
// files through the injected reader, so the shell tool owns process spawning, cwd and kill-on-timeout.

export type Finding = { file: string; line: number; rule: string; preview: string }
export type GitRunner = (args: string[]) => Promise<{ code: number; stdout: string }>
/** `forcePaths`: paths an earlier `git add -f` stages, so gitignored files among them are committed too. */
export type CommitPlan = { all: boolean; include: boolean; paths: string[]; addPaths: string[]; forcePaths?: string[] }
export type Limits = { maxBytes: number; timeoutMs?: number }

export const LIMITS = { maxBytes: 2_000_000, timeoutMs: 5_000 }

const NUL = String.fromCharCode(0)
const FILE_CAP = 256 * 1024
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "-U0"]
const NAMES = ["--no-ext-diff", "--name-only", "-z", "--diff-filter=ACMRT"]
const LOCKFILES = new Set(
  "package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lock bun.lockb cargo.lock poetry.lock pipfile.lock composer.lock gemfile.lock go.sum uv.lock flake.lock mix.lock pubspec.lock packages.lock.json podfile.lock deno.lock".split(
    " ",
  ),
)
const PLACEHOLDER = /example|dummy|placeholder|changeme|xxxx|<your|\$\{|process\.env|os\.environ/i

type Rule = { id: string; pattern: RegExp; group?: number }

const RULES: Rule[] = [
  { id: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    id: "aws-secret-access-key",
    pattern: /aws_?secret_?access_?key\S*\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi,
    group: 1,
  },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { id: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { id: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: "stripe-live-key", pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-project-key", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-api-key", pattern: /\bsk-[A-Za-z0-9]{32,}/g },
  { id: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "sendgrid-api-key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{30,}/g },
  { id: "razorpay-live-key", pattern: /\brzp_live_[A-Za-z0-9]{14,}/g },
  { id: "twilio-api-key", pattern: /\bSK[0-9a-f]{32}\b/g },
]
const GENERIC =
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)[A-Za-z0-9_-]*["']?\s*(?::=|=>|[:=])\s*["']([^"'\s]{12,})["']/gi

function preview(value: string) {
  return value.slice(0, 4) + "…"
}

function entropy(value: string) {
  const counts = [...value].reduce((map, char) => map.set(char, (map.get(char) ?? 0) + 1), new Map<string, number>())
  return [...counts.values()].reduce((sum, count) => {
    const p = count / value.length
    return sum - p * Math.log2(p)
  }, 0)
}

function skipped(file: string) {
  const name = (file.split(/[\\/]/).at(-1) ?? file).toLowerCase()
  return LOCKFILES.has(name) || name.endsWith(".snap") || name.endsWith(".min.js")
}

function scanLine(file: string, line: number, text: string): Finding[] {
  const strong = RULES.flatMap((rule) =>
    [...text.matchAll(rule.pattern)]
      .map((match) => match[rule.group ?? 0])
      .filter((value) => value !== undefined && !/example/i.test(value))
      .map((value) => ({ file, line, rule: rule.id, preview: preview(value) })),
  )
  if (strong.length > 0 || PLACEHOLDER.test(text)) return strong
  return [...text.matchAll(GENERIC)]
    .map((match) => match[1])
    .filter((value) => entropy(value) >= 3.5)
    .map((value) => ({ file, line, rule: "generic-secret", preview: preview(value) }))
}

function unquotePath(text: string) {
  const trimmed = text.replace(/\t.*$/, "")
  if (!trimmed.startsWith('"')) return trimmed
  return trimmed.slice(1, -1).replace(/\\(["\\])/g, "$1")
}

/** Findings on added lines of a unified diff (`git diff -U0` output). */
export function scanDiff(diff: string): Finding[] {
  const findings: Finding[] = []
  const state = { file: "", line: 0, oldLeft: 0, newLeft: 0 }
  for (const text of diff.split("\n")) {
    if (state.oldLeft > 0 || state.newLeft > 0) {
      if (text.startsWith("+")) {
        state.newLeft--
        // Lines with NUL bytes come from real binary content forced through --text.
        if (state.file && !skipped(state.file) && !text.includes(NUL))
          findings.push(...scanLine(state.file, state.line, text.slice(1)))
        state.line++
      } else if (text.startsWith("-")) state.oldLeft--
      else if (text.startsWith(" ") || text === "") {
        state.oldLeft--
        state.newLeft--
        state.line++
      }
      continue
    }
    if (text.startsWith("diff --git ")) {
      state.file = ""
      continue
    }
    if (text.startsWith("+++ ")) {
      const target = unquotePath(text.slice(4))
      state.file = target === "/dev/null" ? "" : target.replace(/^b\//, "")
      continue
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text)
    if (!hunk) continue
    state.oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1])
    state.line = Number(hunk[2])
    state.newLeft = hunk[3] === undefined ? 1 : Number(hunk[3])
  }
  return findings
}

/** Findings in a whole file (used for untracked files that an earlier `git add` in the command stages). */
export function scanFile(file: string, content: string): Finding[] {
  if (skipped(file)) return []
  const head = content.slice(0, FILE_CAP)
  if (head.includes(NUL)) return []
  return head.split("\n").flatMap((text, index) => scanLine(file, index + 1, text))
}

/** Filenames that should never be committed without a second look (.env, private keys, credential stores). */
export function riskyFilename(file: string) {
  const name = (file.split(/[\\/]/).at(-1) ?? file).toLowerCase()
  if (name.endsWith(".env") || /\.env\./.test(name)) return !/\.(?:example|sample|template)$/.test(name)
  if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials.json"].includes(name)) return true
  return /\.(?:pem|p12|pfx|key)$/.test(name)
}

/**
 * Scans what `git commit` would record: staged additions, plus HEAD..worktree changes for -a/-i/pathspecs,
 * plus changes and untracked files for paths an earlier `git add` in the same command stages.
 * Any git failure, timeout or size overflow marks the result incomplete (callers fail closed).
 */
export async function scanCommit(
  run: GitRunner,
  plan: CommitPlan,
  limits: Limits = LIMITS,
  readFile?: (file: string) => Promise<string | undefined>,
): Promise<{ findings: Finding[]; incomplete: boolean }> {
  const findings: Finding[] = []
  const state = { incomplete: false, bytes: 0 }
  const deadline = Date.now() + (limits.timeoutMs ?? LIMITS.timeoutMs)

  const bounded = async <T>(work: Promise<T>) => {
    const remaining = deadline - Date.now()
    if (state.incomplete || remaining <= 0) {
      state.incomplete = true
      return
    }
    const timer: { id?: ReturnType<typeof setTimeout> } = {}
    const result = await Promise.race([
      work.then(
        (value) => ({ value }),
        () => undefined,
      ),
      new Promise<undefined>((resolve) => {
        timer.id = setTimeout(() => resolve(undefined), remaining)
      }),
    ])
    clearTimeout(timer.id)
    if (!result) {
      state.incomplete = true
      return
    }
    return result.value
  }

  const count = (text: string) => {
    state.bytes += Buffer.byteLength(text)
    if (state.bytes <= limits.maxBytes) return true
    state.incomplete = true
    return false
  }

  const git = async (args: string[], allowFailure = false) => {
    if (state.incomplete) return
    const result = await bounded(run(args))
    if (!result) return
    if (result.code !== 0 && !allowFailure) {
      state.incomplete = true
      return
    }
    if (!count(result.stdout)) return
    return result
  }

  const pathspec = (file: string) => `:(top,literal)${file}`

  /**
   * Diffs `head` (the diff command and its revision options) limited to `spec`. A `-diff`/`binary` attribute or a
   * diff driver makes git print "Binary files differ" for text files, so those files are diffed again with --text.
   * Files git itself detects as binary (no attribute) are left out.
   */
  const diff = async (head: string[], spec: string[]) => {
    const result = await git([...head, ...DIFF, ...spec])
    if (!result) return
    findings.push(...scanDiff(result.stdout))
    if (!/^Binary files /m.test(result.stdout)) return
    const stat = await git([...head, "--no-ext-diff", "--numstat", "--no-renames", "-z", ...spec])
    const binary = (stat?.stdout.split(NUL) ?? [])
      .map((record) => /^-\t-\t(.+)$/s.exec(record)?.[1])
      .filter((file): file is string => !!file)
    if (binary.length === 0) return
    const prefix = await git(["rev-parse", "--show-prefix"])
    if (!prefix) return
    const up = prefix.stdout
      .trim()
      .split("/")
      .filter(Boolean)
      .map(() => "..")
    const relative = binary.map((file) => [...up, file].join("/"))
    const marked = new Set<string>()
    for (const cached of [[], ["--cached"]]) {
      const attrs = await git(["check-attr", ...cached, "-z", "diff", "--", ...relative])
      const fields = attrs?.stdout.split(NUL) ?? []
      for (let i = 0; i + 2 < fields.length; i += 3) if (fields[i + 2] !== "unspecified") marked.add(fields[i])
    }
    const text = binary.filter((_, index) => marked.has(relative[index]))
    if (text.length === 0) return
    const forced = await git([...head, ...DIFF, "--text", "--", ...text.map(pathspec)])
    if (forced) findings.push(...scanDiff(forced.stdout))
  }

  const names = async (args: string[]) => {
    const result = await git(args)
    if (!result) return
    result.stdout
      .split(NUL)
      .filter((file) => file && riskyFilename(file))
      .forEach((file) => findings.push({ file, line: 0, rule: "sensitive-file", preview: "" }))
  }

  await diff(["diff", "--cached"], [])
  await names(["diff", "--cached", ...NAMES])

  if (plan.all || plan.include || plan.paths.length > 0) {
    const spec = plan.paths.length > 0 ? ["--", ...plan.paths] : []
    const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], true)
    if (head) {
      const base = head.code === 0 ? ["diff", "HEAD"] : ["diff"]
      await diff(base, spec)
      await names([...base, ...NAMES, ...spec])
    }
  }

  if (plan.addPaths.length > 0) {
    await diff(["diff"], ["--", ...plan.addPaths])
    await names(["diff", ...NAMES, "--", ...plan.addPaths])
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...plan.addPaths])
    // `git add -f` also stages gitignored files, the usual way a .env ends up in a commit.
    const forced = plan.forcePaths?.length
      ? await git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...plan.forcePaths])
      : undefined
    const files = [...(untracked?.stdout.split(NUL) ?? []), ...(forced?.stdout.split(NUL) ?? [])].filter(Boolean)
    for (const file of new Set(files)) {
      if (state.incomplete) break
      if (riskyFilename(file)) findings.push({ file, line: 0, rule: "sensitive-file", preview: "" })
      if (!readFile) continue
      const content = await bounded(readFile(file))
      if (content === undefined || !count(content.slice(0, FILE_CAP))) continue
      findings.push(...scanFile(file, content))
    }
    // The literal names being added are checked too, whether git lists them as untracked, ignored or tracked.
    plan.addPaths
      .filter((file) => !file.startsWith(":") && riskyFilename(file))
      .forEach((file) => findings.push({ file, line: 0, rule: "sensitive-file", preview: "" }))
  }

  const seen = new Set<string>()
  return {
    findings: findings.filter((finding) => {
      const key = `${finding.file}:${finding.line}:${finding.rule}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
    incomplete: state.incomplete,
  }
}

export * as SecretScan from "./secret-scan"
