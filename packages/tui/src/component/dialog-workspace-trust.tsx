import type { TrustInfo } from "@opencode-ai/sdk/v2"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useExit } from "../context/exit"
import { trustPayload, trustSummary, type TrustChoice } from "../context/workspace-trust"

/**
 * Asks whether this folder's own configuration may run. Trust folder saves the decision and approves the folder's MCP
 * servers; Restricted mode saves it as untrusted; Quit exits. Escape decides nothing: the folder stays restricted for
 * now and is asked about again next start.
 */
export function DialogWorkspaceTrust(props: { info: TrustInfo }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const exit = useExit()
  const summary = trustSummary(props.info.held)

  const decide = async (choice: TrustChoice) => {
    dialog.clear()
    const result = await sdk.client.trust.set(trustPayload(choice, props.info)).catch((error: unknown) => ({ error }))
    if ("error" in result && result.error) {
      toast.show({ variant: "error", message: "Could not save the workspace trust decision" })
      return
    }
    if (choice === "trust")
      toast.show({ variant: "info", message: "Folder trusted. TUI plugins from this folder load on next start" })
  }

  return (
    <DialogSelect<TrustChoice | "quit">
      title={`Trust this folder? ${props.info.path}`}
      options={[
        {
          value: "trust",
          title: props.info.sessionOnly ? "Trust for this session" : "Trust folder",
          description: "Let this folder's own configuration run on your machine",
          details: summary.length
            ? [...summary, "Only trust folders from people you trust."]
            : ["Its configuration supplies nothing that waits for trust."],
        },
        {
          value: "restricted",
          title: "Restricted mode",
          description: "Keep its plugins, MCP servers and allow rules off",
        },
        { value: "quit", title: "Quit", description: "Exit without deciding" },
      ]}
      onSelect={(option) => {
        if (option.value === "quit") {
          dialog.clear()
          exit()
          return
        }
        void decide(option.value)
      }}
    />
  )
}
