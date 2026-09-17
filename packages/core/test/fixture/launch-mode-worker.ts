import { PermissionLaunchMode } from "@opencode-ai/core/permission/launch-mode"

// Runs inside a Worker started the way the TUI starts the engine worker: with OPENCODE_PERMISSION_MODE in its env.
declare const self: Worker

const probe = "process.stdout.write(String(process.env.OPENCODE_PERMISSION_MODE ?? ''))"
const copied = () => Bun.spawnSync([process.execPath, "-e", probe], { env: { ...process.env } }).stdout.toString()

const beforeClaim = copied()
PermissionLaunchMode.claim()

self.postMessage({
  beforeClaim,
  env: process.env.OPENCODE_PERMISSION_MODE ?? null,
  read: PermissionLaunchMode.read() ?? null,
  copied: copied(),
  shell: await Bun.$`${process.execPath} -e ${probe}`.text(),
  claimedTwice: (PermissionLaunchMode.claim(), PermissionLaunchMode.read() ?? null),
})
