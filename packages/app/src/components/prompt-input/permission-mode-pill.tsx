import type { PermissionMode } from "@opencode-ai/sdk/v2/client"
import { Select } from "@opencode-ai/ui/select"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import type { JSX } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { modeDescriptionKey, modeLabelKey } from "@/context/permission-mode"
import { permissionModeTone, permissionModeToneClass, type PermissionModeTone } from "./permission-mode-controls"

// Literal class names so Tailwind generates them; the trigger draws its dot with a ::before.
const TRIGGER_DOT: Record<PermissionModeTone, string> = {
  neutral: "before:bg-icon-weak-base",
  success: "before:bg-icon-success-base",
  info: "before:bg-icon-info-base",
  critical: "before:bg-icon-critical-base",
  warning: "before:bg-icon-warning-base",
}

export function PermissionModePill(props: {
  mode: PermissionMode
  options: PermissionMode[]
  disabled?: boolean
  onSelect: (mode: PermissionMode) => void
  triggerStyle?: JSX.CSSProperties
}) {
  const command = useCommand()
  const language = useLanguage()
  const label = (mode: PermissionMode) => language.t(modeLabelKey(mode))
  const dot = (mode: PermissionMode) => permissionModeToneClass(permissionModeTone(mode))

  return (
    <div data-component="prompt-permission-mode-control">
      <TooltipKeybind
        placement="top"
        gutter={4}
        title={language.t("prompt.permissionMode.label")}
        keybind={command.keybind("permission.mode.cycle")}
      >
        <Select
          size="normal"
          options={props.options}
          current={props.mode}
          label={label}
          disabled={props.disabled}
          onSelect={(value) => {
            if (value) props.onSelect(value)
          }}
          class="text-text-base"
          valueClass={`truncate text-13-regular text-text-base before:content-[''] before:inline-block before:size-1.5 before:rounded-full before:mr-1.5 before:align-middle ${TRIGGER_DOT[permissionModeTone(props.mode)]}`}
          triggerStyle={{ "max-width": "180px", ...props.triggerStyle }}
          triggerProps={{
            "data-action": "prompt-permission-mode",
            "data-mode": props.mode,
            "aria-label": language.t("prompt.permissionMode.label"),
          }}
          variant="ghost"
        >
          {(mode) =>
            mode && (
              <div class="flex items-start gap-2 min-w-0 max-w-[280px] py-0.5">
                <span class={`mt-1.5 size-1.5 shrink-0 rounded-full ${dot(mode)}`} />
                <div class="flex flex-col min-w-0">
                  <span class="text-13-regular text-text-strong">{label(mode)}</span>
                  <span class="text-12-regular text-text-weak whitespace-normal">
                    {language.t(modeDescriptionKey(mode))}
                  </span>
                </div>
              </div>
            )
          }
        </Select>
      </TooltipKeybind>
    </div>
  )
}
