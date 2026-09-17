import { useCommand, type CommandOption } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLocal, type ModelSelection } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { getCursorPosition, setCursorPosition } from "@/components/prompt-input/editor-dom"
import { CYCLE_MODES, modeLabelKey } from "@/context/permission-mode"
import { createPermissionModeControl } from "./composer/session-composer-controls"
import { useSessionLayout } from "./session-layout"
import { createSessionOwnership } from "./session-ownership"

/** Keys other than Tab reach this command only from the composer editor; the editors own Shift+Tab themselves. */
const composerKeybind = (event: KeyboardEvent) => {
  if (event.key === "Tab") return false
  return event.target instanceof HTMLElement && !!event.target.closest('[data-component="prompt-input"]')
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useComposerCommands = (input: { model?: ModelSelection } = {}) => {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const { params, sessionKey } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const model = input.model ?? local.model
  const permissionMode = createPermissionModeControl({ sessionID: () => params.id })
  const modelCommand = withCategory(language.t("command.category.model"))
  const agentCommand = withCategory(language.t("command.category.agent"))
  const permissionsCommand = withCategory(language.t("command.category.permissions"))

  const chooseModel = async () => {
    const owner = sessionOwnership.capture()
    const editor = document.querySelector<HTMLElement>('[data-component="prompt-input"]')
    const selection = window.getSelection()
    const cursor =
      editor && selection?.rangeCount && editor.contains(selection.anchorNode) ? getCursorPosition(editor) : null
    const restoreComposer = () => {
      // Kobalte restores focus during its teardown effect; defer past it so the
      // composer keeps focus and the caret returns to where the user left it.
      requestAnimationFrame(() => {
        const editor = document.querySelector<HTMLElement>('[data-component="prompt-input"]')
        if (!editor) return
        editor.focus()
        if (cursor !== null) setCursorPosition(editor, cursor)
      })
    }
    const { DialogSelectModel } = await import("@/components/dialog-select-model")
    owner.run(() => {
      void dialog.show(() => <DialogSelectModel model={model} />, restoreComposer)
    })
  }

  const modeCommands = () => {
    const control = permissionMode()
    const unavailable = !control.supported || control.disabled
    return [
      permissionsCommand({
        id: "permission.mode.cycle",
        title: language.t("command.permissionMode.cycle"),
        keybind: "shift+tab",
        disabled: unavailable,
        when: composerKeybind,
        onSelect: () => control.cycle(),
      }),
      ...CYCLE_MODES.map((mode) =>
        permissionsCommand({
          id: `permission.mode.set.${mode}`,
          title: language.t("command.permissionMode.set", { mode: language.t(modeLabelKey(mode)) }),
          // /plan is not registered here: the engine's plan command stays in the slash list, so picking it inserts
          // `/plan ` for a task, and the submit path turns bare /plan into a mode switch.
          disabled: unavailable,
          onSelect: () => control.select(mode),
        }),
      ),
      permissionsCommand({
        id: "permission.mode.bypass",
        title: language.t("command.permissionMode.bypass"),
        keybind: "mod+shift+a",
        disabled: unavailable,
        onSelect: () => control.select("bypassPermissions"),
      }),
    ]
  }

  command.register("composer", () => [
    modelCommand({
      id: "model.choose",
      title: language.t("command.model.choose"),
      description: language.t("command.model.choose.description"),
      keybind: "mod+'",
      slash: "model",
      onSelect: chooseModel,
    }),
    modelCommand({
      id: "model.variant.cycle",
      title: language.t("command.model.variant.cycle"),
      description: language.t("command.model.variant.cycle.description"),
      keybind: "shift+mod+d",
      onSelect: () => model.variant.cycle(),
    }),
    agentCommand({
      id: "agent.cycle",
      title: language.t("command.agent.cycle"),
      description: language.t("command.agent.cycle.description"),
      keybind: "mod+.",
      slash: "agent",
      disabled: !local.agent.visible(),
      onSelect: () => local.agent.move(1),
    }),
    agentCommand({
      id: "agent.cycle.reverse",
      title: language.t("command.agent.cycle.reverse"),
      description: language.t("command.agent.cycle.reverse.description"),
      keybind: "shift+mod+.",
      disabled: !local.agent.visible(),
      onSelect: () => local.agent.move(-1),
    }),
    ...modeCommands(),
  ])
}
