import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

/**
 * Confirms switching to Bypass permissions. It is shown every time bypass is chosen; Cancel is focused so Enter
 * never confirms by accident.
 */
export function DialogBypassPermissions(props: { onConfirm: () => Promise<unknown> | unknown }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [pending, setPending] = createSignal(false)

  const confirm = async () => {
    if (pending()) return
    setPending(true)
    try {
      await props.onConfirm()
    } finally {
      setPending(false)
      dialog.close()
    }
  }

  return (
    <Dialog title={language.t("dialog.bypassPermissions.title")} fit>
      <div data-component="dialog-bypass-permissions" class="flex flex-col gap-4 pl-6 pr-2.5 pb-3 max-w-[480px]">
        <span class="text-14-regular text-text-strong">{language.t("dialog.bypassPermissions.body")}</span>
        <div class="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="large"
            autofocus
            data-action="bypass-permissions-cancel"
            onClick={() => dialog.close()}
          >
            {language.t("dialog.bypassPermissions.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            class="bg-surface-critical-strong!"
            data-action="bypass-permissions-confirm"
            disabled={pending()}
            onClick={() => void confirm()}
          >
            {language.t("dialog.bypassPermissions.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
