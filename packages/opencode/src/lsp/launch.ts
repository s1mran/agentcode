import type { ChildProcessWithoutNullStreams } from "child_process"
import { Process } from "@/util/process"
import { PermissionLaunchMode } from "@opencode-ai/core/permission/launch-mode"

type Child = Process.Child & ChildProcessWithoutNullStreams

export function spawn(cmd: string, args: string[], opts?: Process.Options): Child
export function spawn(cmd: string, opts?: Process.Options): Child
export function spawn(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  const proc = Process.spawn([cmd, ...args], {
    ...cfg,
    // The launch permission mode is this engine's setting, never a language server's. Process.spawn merges the env
    // over process.env, and an undefined value is left out of the child's environment.
    env: cfg?.env === null ? null : { ...cfg?.env, [PermissionLaunchMode.ENV_KEY]: undefined },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Child

  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")

  return proc
}
