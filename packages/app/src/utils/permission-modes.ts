import type { GlobalHealthResponse } from "@opencode-ai/sdk/v2/client"
import type { ServerProtocol } from "./server-protocol"

type Health = Partial<GlobalHealthResponse> | undefined

/** True when a `/global/health` body advertises engine-side permission modes. */
export function advertisesPermissionModes(health: Health) {
  return health?.permissionModes === true
}

/**
 * Whether a server resolves permission modes. Answering the legacy (v1) health endpoint is not enough: a stock opencode
 * server does too, and silently drops `permissionMode`. Only a health body that advertises `permissionModes` counts. A
 * failed request is retried a few times; a server that answers without the flag is not.
 */
export async function detectPermissionModes(input: {
  protocol: Promise<ServerProtocol>
  health: () => Promise<Health>
  attempts?: number
  wait?: (attempt: number) => Promise<void>
}) {
  if ((await input.protocol.catch(() => undefined)) !== "v1") return false
  const attempts = input.attempts ?? 3
  const wait = input.wait ?? ((attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, 500 * attempt)))
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await input.health().then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    )
    if (result.ok) return advertisesPermissionModes(result.value)
    if (attempt < attempts) await wait(attempt)
  }
  return false
}

type ModeServer = {
  protocol: Promise<ServerProtocol>
  client: { global: { health: (options: { throwOnError: true }) => Promise<{ data?: GlobalHealthResponse }> } }
}

const detected = new WeakMap<object, Promise<boolean>>()

/** The cached permission-mode capability of one server SDK context. */
export function serverPermissionModes(sdk: ModeServer) {
  const existing = detected.get(sdk)
  if (existing) return existing
  const result = detectPermissionModes({
    protocol: sdk.protocol,
    health: () => sdk.client.global.health({ throwOnError: true }).then((response) => response.data),
  })
  detected.set(sdk, result)
  return result
}
