import { describe, expect, test } from "bun:test"
import { desktopNativePluralCategories } from "./desktop-native"

const appLocales = [
  "ar",
  "br",
  "bs",
  "da",
  "de",
  "es",
  "fr",
  "ja",
  "ko",
  "no",
  "pl",
  "ru",
  "uk",
  "th",
  "tr",
  "zh",
  "zht",
  "hi",
  "nl",
  "id",
  "vi",
  "it",
  "ur",
  "pa",
  "az",
  "fi",
  "sv",
  "am",
  "bg",
  "bn",
  "ca",
  "cs",
  "dv",
  "dz",
  "el",
  "et",
  "fa",
  "fo",
  "hr",
  "hu",
  "hy",
  "is",
  "ka",
  "km",
  "lo",
  "lt",
  "lv",
  "mk",
  "mn",
  "ms",
  "my",
  "ne",
  "ro",
  "si",
  "sk",
  "sl",
  "sq",
  "sr",
  "tg",
  "tk",
  "uz",
] as const
const desktopLocales = appLocales
const pluralCategories = new Map(
  appLocales.map(
    (locale) =>
      [
        locale,
        desktopNativePluralCategories(locale).filter((category) => category !== "one" && category !== "other"),
      ] as const,
  ),
)

const domains = [
  {
    name: "app",
    source: "./en.ts",
    target: (locale: string) => `./${locale}.ts`,
    locales: appLocales,
  },
  {
    name: "ui",
    source: "../../../ui/src/i18n/en.ts",
    target: (locale: string) => `../../../ui/src/i18n/${locale}.ts`,
    locales: appLocales,
  },
  {
    name: "desktop",
    source: "../../../desktop/src/renderer/i18n/en.ts",
    target: (locale: string) => `../../../desktop/src/renderer/i18n/${locale}.ts`,
    locales: desktopLocales,
  },
] as const

describe("i18n parity", () => {
  test("non-English locales have every English key and required plural variants", async () => {
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const missing = Object.keys(source).filter((key) => !Object.hasOwn(target, key))
        const extra = Object.keys(target)
          .filter((key) => !Object.hasOwn(source, key))
          .sort()
        const expected = pluralFamilies(source)
          .flatMap((key) => (pluralCategories.get(locale) ?? []).map((category) => `${key}.${category}`))
          .sort()
        expect({ domain: domain.name, locale, missing, extra }).toEqual({
          domain: domain.name,
          locale,
          missing: [],
          extra: expected,
        })
      }
    }
  })

  test("non-English locales preserve English placeholders", async () => {
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const mismatched = Object.keys(source).filter(
          (key) => Object.hasOwn(target, key) && placeholders(source[key]).join() !== placeholders(target[key]).join(),
        )
        const pluralMismatched = pluralFamilies(source).flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter((variant) => placeholders(source[`${key}.other`]).join() !== placeholders(target[variant]).join()),
        )
        expect({ domain: domain.name, locale, mismatched, pluralMismatched }).toEqual({
          domain: domain.name,
          locale,
          mismatched: [],
          pluralMismatched: [],
        })
      }
    }
  })

  test("non-English locales translate targeted unseen session keys", async () => {
    const source = await dictionary("./en.ts")
    for (const locale of appLocales) {
      const target = await dictionary(`./${locale}.ts`)
      for (const key of ["command.session.previous.unseen", "command.session.next.unseen"]) {
        expect(target[key]).toBeDefined()
        expect(target[key]).not.toBe(source[key])
      }
    }
  })

  test("changed-file summary keys preserve rendered English copy and localize complete phrases", async () => {
    const source = await dictionary("../../../ui/src/i18n/en.ts")
    expect(source["ui.sessionTurn.diffs.changed.one"].replace("{{count}}", "1")).toBe("1 Changed file")
    expect(source["ui.sessionTurn.diffs.changed.other"].replace("{{count}}", "2")).toBe("2 Changed files")
    expect(source["ui.sessionTurn.diffs.changed"]).toBeUndefined()

    for (const locale of appLocales) {
      const target = await dictionary(`../../../ui/src/i18n/${locale}.ts`)
      for (const key of ["ui.sessionTurn.diffs.changed.one", "ui.sessionTurn.diffs.changed.other"]) {
        expect(target[key].trim()).not.toBe("")
        expect(placeholders(target[key])).toEqual(["count"])
      }
    }
  })
})

describe("i18n plural parity", () => {
  test("locale-specific categories exist and preserve count placeholders", async () => {
    for (const domain of domains.slice(0, 2)) {
      const source = await dictionary(domain.source)
      const families = pluralFamilies(source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const missing = families.flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter((variant) => !Object.hasOwn(target, variant)),
        )
        const mismatched = families.flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter(
              (variant) =>
                Object.hasOwn(target, variant) &&
                placeholders(source[`${key}.other`]).join() !== placeholders(target[variant]).join(),
            ),
        )
        expect({ domain: domain.name, locale, missing, mismatched }).toEqual({
          domain: domain.name,
          locale,
          missing: [],
          mismatched: [],
        })
      }
    }
  })
})

async function dictionary(file: string) {
  const module: unknown = await import(file)
  if (typeof module !== "object" || module === null || !("dict" in module) || !isDictionary(module.dict)) {
    throw new Error(`Invalid translation dictionary: ${file}`)
  }
  return module.dict
}

function isDictionary(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === "string")
}

function placeholders(value: string) {
  return Array.from(value.matchAll(/{{\s*([^}]+?)\s*}}/g), (match) => match[1]).sort()
}

function pluralFamilies(dictionary: Record<string, string>) {
  return Object.keys(dictionary)
    .filter(
      (key) =>
        key.endsWith(".one") &&
        dictionary[key].includes("{{count}}") &&
        dictionary[`${key.slice(0, -4)}.other`]?.includes("{{count}}"),
    )
    .map((key) => key.slice(0, -4))
}

// OpenCode's external paid services, which AgentCode can still connect to, keep their real names and URLs.
const externalOpencodeNames = ["OpenCode Zen", "OpenCode Go", "opencode.ai/zen", "opencode.ai/go", "opencode.json"]
// These messages name the real `opencode` executable, whose name does not change.
const opencodeExecutableKeys = [
  "desktop.wsl.error.opencodeMissing",
  "desktop.wsl.error.opencodeCannotRun",
  "desktop.cli.installed.message",
]
// Messages whose English names OpenCode Go by its short name alone, e.g. "Go limit reached".
const goShortNameKeys = ["ui:dialog.usageExceeded.accountRateLimit.title"]
// Translations that leave the product name out of a sentence whose English names it.
const productNameOmitted = ["dv", "zht"]
  .map((locale) => `app:${locale}:wsl.onboarding.wslNotInstalled.description`)
  .concat("app:ja:wsl.onboarding.wslUnavailable.description")

describe("i18n branding", () => {
  // Feedback goes to AgentCode GitHub issues, so no locale may point users at Discord either.
  test("non-English locales name AgentCode and keep only external OpenCode names", async () => {
    const leftovers: string[] = []
    for (const domain of domains) {
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        for (const key of Object.keys(target)) {
          const text = externalOpencodeNames.reduce((value, name) => value.replaceAll(name, ""), target[key])
          const rest = opencodeExecutableKeys.includes(key) ? text.replaceAll("opencode", "") : text
          if (/opencode|agentcode\.ai|agentcode (?:zen|go)\b|discord/i.test(rest))
            leftovers.push(`${domain.name}:${locale}:${key}`)
        }
      }
    }
    expect(leftovers).toEqual([])
  })

  test("non-English locales keep the product name wherever English uses it", async () => {
    const missing: string[] = []
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      const named = Object.keys(source).filter((key) => /AgentCode(?! (?:Zen|Go)\b)/.test(source[key]))
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        for (const key of named) {
          const id = `${domain.name}:${locale}:${key}`
          if (!target[key].includes("AgentCode") && !productNameOmitted.includes(id)) missing.push(id)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test("messages about the opencode executable keep its literal name", async () => {
    const renamed: string[] = []
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      const keys = opencodeExecutableKeys.filter((key) => Object.hasOwn(source, key))
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        renamed.push(
          ...keys.filter((key) => !target[key].includes("opencode")).map((key) => `${domain.name}:${locale}:${key}`),
        )
      }
    }
    expect(renamed).toEqual([])
  })

  test("OpenCode Zen keeps its product name and its real link text", async () => {
    const wrong: string[] = []
    for (const locale of appLocales) {
      const target = await dictionary(`./${locale}.ts`)
      if (!target["provider.connect.opencodeZen.line1"].includes("OpenCode Zen")) wrong.push(`${locale}:line1`)
      if (target["provider.connect.opencodeZen.visit.link"] !== "opencode.ai/zen") wrong.push(`${locale}:visit.link`)
    }
    expect(wrong).toEqual([])
  })

  // "Go" is a product name here, not the verb "to go", so it must stay in Latin script and never be dropped.
  test("OpenCode Go keeps its product name wherever English names it", async () => {
    const wrong: string[] = []
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      const shortName = goShortNameKeys
        .filter((id) => id.startsWith(`${domain.name}:`))
        .map((id) => id.slice(domain.name.length + 1))
      for (const key of shortName) expect(source[key]).toMatch(/(?<![A-Za-z])Go(?![A-Za-z])/)
      const fullName = Object.keys(source).filter((key) => source[key].includes("OpenCode Go"))
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        for (const key of fullName) {
          if (!target[key].includes("OpenCode Go")) wrong.push(`${domain.name}:${locale}:${key}`)
        }
        for (const key of shortName) {
          if (!/(?<![A-Za-z])Go(?![A-Za-z])/.test(target[key])) wrong.push(`${domain.name}:${locale}:${key}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  test("Hungarian puts az, not a, before AgentCode and OpenCode", async () => {
    const wrong: string[] = []
    for (const domain of domains) {
      const target = await dictionary(domain.target("hu"))
      for (const key of Object.keys(target)) {
        if (/(?<!\p{L})a (?:AgentCode|OpenCode)/iu.test(target[key])) wrong.push(`${domain.name}:${key}`)
      }
    }
    expect(wrong).toEqual([])
  })
})
