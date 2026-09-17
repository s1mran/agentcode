import { describe, expect, test } from "bun:test"
import { SecretScan } from "../../src/permission/secret-scan"

// Secrets are assembled at runtime so this file never contains a scannable token itself.
const SECRETS: Record<string, string> = {
  "aws-access-key-id": "AKIA" + "Z7Q3PLMN4X8RT2VB",
  "aws-secret-access-key": "aws_secret_access_key = " + "wJalrXUtnFEMIK7MDENGbPxRfiCY" + "Q9z8Y7x6W5v4",
  "github-token": "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  "github-pat": "github_pat_" + "11ABCDEFG0123456789_abcdefghijklmnop",
  "gitlab-token": "glpat-" + "x9Y8z7W6v5U4t3S2r1Q0",
  "slack-token": "xoxb-" + "123456789012-abcdefABCDEF",
  "stripe-live-key": "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  "google-api-key": "AIza" + "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
  "anthropic-api-key": "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz012345",
  "openai-project-key": "sk-proj-" + "abcdefghijklmnopqrstuvwxyz012345",
  "openai-api-key": "sk-" + "abcdefghijklmnopqrstuvwxyzABCDEF0123",
  "private-key": "-----BEGIN RSA " + "PRIVATE KEY-----",
  "npm-token": "npm_" + "abcdefghijklmnopqrstuvwxyz0123456789",
  "sendgrid-api-key": "SG." + "ngeVfQFYQlKU0ufo8x5d1A" + "." + "TwL2iGABf9DHoTf-09kqeF8tAmbihYzrnopKc-1s5cr",
  "razorpay-live-key": "rzp_live_" + "Abcdef1234567890",
  "twilio-api-key": "SK" + "0123456789abcdef0123456789abcdef",
}

function diff(file: string, lines: string[]) {
  return [
    `diff --git a/${file} b/${file}`,
    "index 0000000..1111111 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${lines.filter((line) => !line.startsWith("+")).length} +1,${lines.filter((line) => !line.startsWith("-")).length} @@`,
    ...lines,
  ].join("\n")
}

describe("scanDiff", () => {
  for (const [rule, secret] of Object.entries(SECRETS)) {
    test(`${rule} fires on added lines only`, () => {
      const added = SecretScan.scanDiff(diff("src/config.ts", [`+const value = "${secret}"`]))
      expect(added.map((finding) => finding.rule)).toContain(rule)
      expect(added[0].file).toBe("src/config.ts")
      expect(added[0].line).toBe(1)
      for (const finding of added) {
        expect(finding.preview.length).toBeLessThanOrEqual(5)
        expect(finding.preview.endsWith("…")).toBe(true)
        expect(secret.includes(finding.preview.slice(0, -1))).toBe(true)
        expect(JSON.stringify(finding)).not.toContain(secret.slice(-12))
      }
      expect(SecretScan.scanDiff(diff("src/config.ts", [`-const value = "${secret}"`]))).toEqual([])
    })
  }

  test("line numbers follow hunk headers", () => {
    const text = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -10,0 +11,2 @@",
      "+const x = 1",
      `+const token = "${SECRETS["github-token"]}"`,
      "@@ -40 +42 @@",
      "-old",
      `+const key = "${SECRETS["npm-token"]}"`,
      "diff --git a/b.ts b/b.ts",
      "--- /dev/null",
      "+++ b/b.ts",
      "@@ -0,0 +1 @@",
      `+${SECRETS["slack-token"]}`,
    ].join("\n")
    expect(SecretScan.scanDiff(text).map((finding) => [finding.file, finding.line, finding.rule])).toEqual([
      ["a.ts", 12, "github-token"],
      ["a.ts", 42, "npm-token"],
      ["b.ts", 1, "slack-token"],
    ])
  })

  test("an added line that looks like a header is still content", () => {
    const text = ["--- a/x", "+++ b/x", "@@ -1 +1,2 @@", "-a", "+++ b/evil", `+${SECRETS["npm-token"]}`].join("\n")
    expect(SecretScan.scanDiff(text).map((finding) => [finding.file, finding.line])).toEqual([["x", 2]])
  })

  test("skips lockfiles, snapshots and minified bundles", () => {
    const line = `+"${SECRETS["github-token"]}"`
    expect(SecretScan.scanDiff(diff("bun.lock", [line]))).toEqual([])
    expect(SecretScan.scanDiff(diff("web/package-lock.json", [line]))).toEqual([])
    expect(SecretScan.scanDiff(diff("test/__snapshots__/a.test.ts.snap", [line]))).toEqual([])
    expect(SecretScan.scanDiff(diff("dist/app.min.js", [line]))).toEqual([])
  })

  test("generic rule needs entropy and skips placeholders", () => {
    const hit = SecretScan.scanDiff(diff("a.py", [`+API_KEY = "q8Zr4mT1xW9pL2vN7bK3"`]))
    expect(hit.map((finding) => finding.rule)).toEqual(["generic-secret"])
    expect(hit[0].preview).toBe("q8Zr…")
    expect(SecretScan.scanDiff(diff("a.json", [`+  "password": "Hq7!mZ2@vL9#xR4$"`]))).toHaveLength(1)
    expect(SecretScan.scanDiff(diff("a.ts", [`+password = "\${DATABASE_PASSWORD}"`]))).toEqual([])
    expect(SecretScan.scanDiff(diff("a.ts", [`+const secret = "aaaaaaaaaaaaaaaa"`]))).toEqual([])
    expect(SecretScan.scanDiff(diff("a.ts", [`+api_key: "your-api-key-example-here"`]))).toEqual([])
    expect(SecretScan.scanDiff(diff("a.ts", [`+const password = process.env.PASSWORD ?? "fallbackValue123"`]))).toEqual(
      [],
    )
    expect(SecretScan.scanDiff(diff("a.ts", [`+password = "short"`]))).toEqual([])
  })

  test("AWS documentation example keys are ignored", () => {
    expect(SecretScan.scanDiff(diff("README.md", ["+aws_access_key_id = AKIAIOSFODNN7EXAMPLE"]))).toEqual([])
  })
})

describe("scanFile and riskyFilename", () => {
  test("scanFile reports line numbers and skips binary content", () => {
    const content = ["# config", `TOKEN=${SECRETS["github-token"]}`].join("\n")
    expect(SecretScan.scanFile("notes.txt", content)).toEqual([
      { file: "notes.txt", line: 2, rule: "github-token", preview: "ghp_…" },
    ])
    expect(SecretScan.scanFile("blob.bin", "a" + String.fromCharCode(0) + SECRETS["github-token"])).toEqual([])
    expect(SecretScan.scanFile("big.txt", "x".repeat(300 * 1024) + SECRETS["github-token"])).toEqual([])
  })

  test("riskyFilename", () => {
    for (const file of [
      ".env",
      ".env.local",
      "config/.env.production",
      "k.env",
      "id_rsa",
      "keys/id_ed25519",
      "cert.pem",
      "a.p12",
      "b.pfx",
      "server.key",
      "credentials.json",
    ]) {
      expect({ file, risky: SecretScan.riskyFilename(file) }).toEqual({ file, risky: true })
    }
    for (const file of [
      ".env.example",
      ".env.sample",
      ".env.template",
      "id_rsa.pub",
      "environment.ts",
      ".envrc",
      "src/env.ts",
      "keys.ts",
    ]) {
      expect({ file, risky: SecretScan.riskyFilename(file) }).toEqual({ file, risky: false })
    }
  })
})

type Call = string[]

function fakeGit(responses: (args: string[]) => { code: number; stdout: string } | Promise<never>) {
  const calls: Call[] = []
  const run: SecretScan.GitRunner = async (args) => {
    calls.push(args)
    return responses(args)
  }
  return { calls, run }
}

const plan = (input: Partial<SecretScan.CommitPlan> = {}): SecretScan.CommitPlan => ({
  all: false,
  include: false,
  paths: [],
  addPaths: [],
  ...input,
})

describe("scanCommit", () => {
  test("reports staged findings and risky staged names", async () => {
    const git = fakeGit((args) => {
      if (args.includes("--cached") && args.includes("--name-only"))
        return { code: 0, stdout: ["src/a.ts", ".env", ""].join(String.fromCharCode(0)) }
      if (args.includes("--cached"))
        return { code: 0, stdout: diff("src/a.ts", [`+const t = "${SECRETS["github-token"]}"`]) }
      return { code: 0, stdout: "" }
    })
    const result = await SecretScan.scanCommit(git.run, plan())
    expect(result.incomplete).toBe(false)
    expect(result.findings).toEqual([
      { file: "src/a.ts", line: 1, rule: "github-token", preview: "ghp_…" },
      { file: ".env", line: 0, rule: "sensitive-file", preview: "" },
    ])
    expect(git.calls[0]).toEqual(expect.arrayContaining(["diff", "--cached", "--no-ext-diff", "--no-textconv", "-U0"]))
    expect(git.calls.some((args) => args.includes("HEAD"))).toBe(false)
  })

  test("a failing git command marks the scan incomplete", async () => {
    const git = fakeGit(() => ({ code: 128, stdout: "" }))
    expect(await SecretScan.scanCommit(git.run, plan())).toEqual({ findings: [], incomplete: true })
  })

  test("a rejected runner marks the scan incomplete", async () => {
    const git = fakeGit(() => Promise.reject(new Error("spawn failed")))
    expect((await SecretScan.scanCommit(git.run, plan())).incomplete).toBe(true)
  })

  test("output over maxBytes marks the scan incomplete", async () => {
    const git = fakeGit(() => ({ code: 0, stdout: "x".repeat(2048) }))
    expect((await SecretScan.scanCommit(git.run, plan(), { maxBytes: 1024 })).incomplete).toBe(true)
  })

  test("a slow runner times out and marks the scan incomplete", async () => {
    const run: SecretScan.GitRunner = () => new Promise(() => {})
    const result = await SecretScan.scanCommit(run, plan(), { maxBytes: 1024, timeoutMs: 20 })
    expect(result.incomplete).toBe(true)
  })

  test("commit -a diffs against HEAD", async () => {
    const git = fakeGit((args) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: "abc\n" }
      if (args[0] === "diff" && args[1] === "HEAD" && !args.includes("--name-only"))
        return { code: 0, stdout: diff("app.ts", [`+key = "${SECRETS["stripe-live-key"]}"`]) }
      return { code: 0, stdout: "" }
    })
    const result = await SecretScan.scanCommit(git.run, plan({ all: true }))
    expect(result).toEqual({
      findings: [{ file: "app.ts", line: 1, rule: "stripe-live-key", preview: "sk_l…" }],
      incomplete: false,
    })
  })

  test("first commit without HEAD falls back to the index", async () => {
    const git = fakeGit((args) => {
      if (args[0] === "rev-parse") return { code: 1, stdout: "" }
      if (args.includes("HEAD")) return { code: 128, stdout: "" }
      if (args.includes("--cached") && !args.includes("--name-only"))
        return { code: 0, stdout: diff("init.ts", [`+${SECRETS["npm-token"]}`]) }
      return { code: 0, stdout: "" }
    })
    const result = await SecretScan.scanCommit(git.run, plan({ all: true, paths: ["init.ts"] }))
    expect(result.incomplete).toBe(false)
    expect(result.findings.map((finding) => finding.rule)).toEqual(["npm-token"])
    expect(git.calls.filter((args) => args.includes("HEAD")).map((args) => args[0])).toEqual(["rev-parse"])
  })

  test("untracked files from an earlier git add are read and scanned", async () => {
    const git = fakeGit((args) => {
      if (args[0] === "ls-files")
        return { code: 0, stdout: ["new/secret.txt", "id_rsa", ""].join(String.fromCharCode(0)) }
      return { code: 0, stdout: "" }
    })
    const read: string[] = []
    const result = await SecretScan.scanCommit(
      git.run,
      plan({ addPaths: ["new", "id_rsa"] }),
      SecretScan.LIMITS,
      async (file) => {
        read.push(file)
        return file === "new/secret.txt" ? `token: ${SECRETS["gitlab-token"]}` : "-----"
      },
    )
    expect(read).toEqual(["new/secret.txt", "id_rsa"])
    expect(result).toEqual({
      findings: [
        { file: "new/secret.txt", line: 1, rule: "gitlab-token", preview: "glpa…" },
        { file: "id_rsa", line: 0, rule: "sensitive-file", preview: "" },
      ],
      incomplete: false,
    })
    const lsFiles = git.calls.find((args) => args[0] === "ls-files")
    expect(lsFiles).toEqual(["ls-files", "--others", "--exclude-standard", "-z", "--", "new", "id_rsa"])
  })
})

describe("scanCommit review regressions", () => {
  const NUL = String.fromCharCode(0)

  test("forced adds list gitignored files and literal risky names are always reported", async () => {
    const git = fakeGit((args) => {
      if (args[0] === "ls-files" && args.includes("--ignored")) return { code: 0, stdout: ["secret.txt", ""].join(NUL) }
      return { code: 0, stdout: "" }
    })
    const result = await SecretScan.scanCommit(
      git.run,
      plan({ addPaths: ["secret.txt", ".env"], forcePaths: ["secret.txt", ".env"] }),
      SecretScan.LIMITS,
      async (file) => (file === "secret.txt" ? `token: ${SECRETS["github-token"]}` : undefined),
    )
    expect(result.findings).toEqual([
      { file: "secret.txt", line: 1, rule: "github-token", preview: "ghp_…" },
      { file: ".env", line: 0, rule: "sensitive-file", preview: "" },
    ])
    expect(git.calls).toContainEqual([
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      "secret.txt",
      ".env",
    ])
  })

  test("files marked binary by an attribute are diffed again as text", async () => {
    const git = fakeGit((args) => {
      if (args.includes("--numstat")) return { code: 0, stdout: ["-\t-\tsecret.txt", "1\t0\tok.ts", ""].join(NUL) }
      if (args[0] === "rev-parse") return { code: 0, stdout: "\n" }
      if (args[0] === "check-attr") return { code: 0, stdout: ["secret.txt", "diff", "unset", ""].join(NUL) }
      if (args.includes("--text"))
        return { code: 0, stdout: diff("secret.txt", [`+t = "${SECRETS["github-token"]}"`, "+bin" + NUL + "x"]) }
      if (args.includes("--cached") && !args.includes("--name-only"))
        return {
          code: 0,
          stdout: "diff --git a/secret.txt b/secret.txt\nBinary files /dev/null and b/secret.txt differ\n",
        }
      return { code: 0, stdout: "" }
    })
    const result = await SecretScan.scanCommit(git.run, plan())
    expect(result).toEqual({
      findings: [{ file: "secret.txt", line: 1, rule: "github-token", preview: "ghp_…" }],
      incomplete: false,
    })
    expect(git.calls.find((args) => args.includes("--text"))).toContain(":(top,literal)secret.txt")
  })

  test("auto-detected binary files without an attribute are not diffed as text", async () => {
    const git = fakeGit((args) => {
      if (args.includes("--numstat")) return { code: 0, stdout: ["-\t-\timage.png", ""].join(NUL) }
      if (args[0] === "rev-parse") return { code: 0, stdout: "\n" }
      if (args[0] === "check-attr") return { code: 0, stdout: ["image.png", "diff", "unspecified", ""].join(NUL) }
      if (args.includes("--cached") && !args.includes("--name-only"))
        return { code: 0, stdout: "Binary files /dev/null and b/image.png differ\n" }
      return { code: 0, stdout: "" }
    })
    expect(await SecretScan.scanCommit(git.run, plan())).toEqual({ findings: [], incomplete: false })
    expect(git.calls.some((args) => args.includes("--text"))).toBe(false)
  })
})
