export * as WorkspaceTrustStore from "./store"

// The implementation lives in core so both config systems (this engine's and core's location config) read the same
// decisions. See packages/core/src/trust/store.ts.
export * from "@opencode-ai/core/trust/store"
