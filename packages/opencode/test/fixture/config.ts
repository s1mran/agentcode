import { Config } from "@/config/config"
import { emptyConsoleState } from "@opencode-ai/core/v1/config/console-state"
import { Effect, Layer } from "effect"

/** A trusted folder with nothing held, for fakes that do not exercise workspace trust. */
export const trusted: Config.Trust = {
  state: {
    key: "/",
    path: "/",
    kind: "directory",
    sessionOnly: false,
    status: "trusted",
    source: "launch",
    policy: "trusted",
    effective: "full",
    mcp: { approved: {}, rejected: [] },
  },
  held: [],
  mcpOrigins: {},
}

export function make(overrides: Partial<Config.Interface> = {}) {
  const directories = overrides.directories ?? (() => Effect.succeed([]))
  return Config.Service.of({
    get: () => Effect.succeed({}),
    getGlobal: () => Effect.succeed({}),
    getConsoleState: () => Effect.succeed(emptyConsoleState),
    update: () => Effect.void,
    updateGlobal: (config) => Effect.succeed({ info: config, changed: false }),
    invalidate: () => Effect.void,
    directories,
    waitForDependencies: () => Effect.void,
    trust: () => Effect.succeed(trusted),
    mcpOrigin: () => Effect.succeed(undefined),
    trustedDirectories: directories,
    ...overrides,
  })
}

export function layer(overrides?: Partial<Config.Interface>) {
  return Layer.succeed(Config.Service, make(overrides))
}

export * as TestConfig from "./config"
