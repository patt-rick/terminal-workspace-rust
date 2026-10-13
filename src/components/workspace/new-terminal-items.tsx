import { createProjectTerminal, useWorkspace } from '../../state/store'
import { useApiKeys } from '../../state/apikeys'
import { useWsl } from '../../state/wsl'
import { useShortcutLabel } from '../../state/keybindings'
import type { MenuItem } from '../context-menu'

/** The "new terminal" entries shared by the project menu and the tab strip's "+". */
export function useNewTerminalItems(projectId: string): MenuItem[] {
  const wslDistros = useWsl((s) => s.distros)
  const newTerminalKey = useShortcutLabel('terminal.new')
  const newClaudeKey = useShortcutLabel('terminal.newClaude')

  const expandAnd = (fn: () => void): void => {
    useWorkspace.getState().setProjectExpanded(projectId, true)
    fn()
  }
  const hint = (label: string): React.ReactNode =>
    label ? <span className="text-xs text-muted">{label}</span> : undefined

  return [
    {
      label: 'New terminal',
      trailing: hint(newTerminalKey),
      onClick: () => expandAnd(() => void createProjectTerminal(projectId)),
    },
    ...wslDistros.map((d) => ({
      label: `New terminal — WSL ${d.name}`,
      onClick: () =>
        expandAnd(
          () => void createProjectTerminal(projectId, { shell: `wsl:${d.name}`, name: d.name })
        ),
    })),
    {
      label: 'New Claude Code terminal',
      trailing: hint(newClaudeKey),
      onClick: () =>
        expandAnd(
          () => void createProjectTerminal(projectId, { name: 'Claude Code', startupCommand: 'claude' })
        ),
    },
    {
      label: 'New terminal with another model…',
      onClick: () => expandAnd(() => useApiKeys.getState().openLauncher(projectId)),
    },
  ]
}
