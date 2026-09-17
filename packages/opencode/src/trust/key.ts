export * as WorkspaceTrustKey from "./key"

// The implementation lives in core so both config systems (this engine's and core's location config) resolve the same
// trust key. See packages/core/src/trust/key.ts.
export * from "@opencode-ai/core/trust/key"
