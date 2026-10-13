// The command registry. Commands are built at call time from the stores, so
// the list always reflects the current projects and themes. Both the keyboard
// handler and the palette run commands from here.
//
// A command's `run` takes no arguments on purpose: nothing typed into the
// palette may ever be passed on to a shell or an agent.

import { ipc } from '../lib/ipc'
import { isMac } from '../lib/platform'
import { shortcutLabel } from '../lib/keybindings'
import type { PaletteItem } from '../lib/palette'
import { THEMES } from '../themes'
import { addProject } from '../hooks/use-projects'
import { SETTINGS_TABS } from '../lib/settings-tabs'
import { createProjectTerminal, useWorkspace } from '../state/store'
import { useSettings } from '../state/settings'
import { useUi } from '../state/ui'
import { useUsage } from '../state/usage'
import { useApiKeys } from '../state/apikeys'
import { currentKeybindings } from '../state/keybindings'

export interface Command {
  id: string
  title: string
  /** absent means always enabled */
  enabled?: () => boolean
  run: () => void
  /** what the palette runs where a toggle would be wrong: it opens, never closes */
  paletteRun?: () => void
}

const PALETTE_TOGGLE = 'palette.toggle'
// Terminal titles come from the program running in them and are not capped.
const MAX_TITLE_LENGTH = 200

function selection(): { projectId: string | null; terminalId: string | null } {
  const ws = useWorkspace.getState()
  const project = ws.projects.find((p) => p.id === ws.selectedProjectId)
  if (!project) return { projectId: null, terminalId: null }
  return { projectId: project.id, terminalId: ws.activeTerminalByProject[project.id] ?? null }
}

function newClaude(projectId: string, startupCommand: string): void {
  useWorkspace.getState().setProjectExpanded(projectId, true)
  void createProjectTerminal(projectId, { name: 'Claude Code', startupCommand })
}

export function appCommands(): Command[] {
  // The selection is read when a command runs, not when the list is built: the
  // palette holds its list open while terminals can exit or be added.
  const hasProject = (): boolean => selection().projectId !== null
  const withProject = (fn: (id: string) => void) => (): void => {
    const { projectId } = selection()
    if (projectId) fn(projectId)
  }

  const commands: Command[] = [
    {
      id: 'terminal.new',
      title: 'New terminal',
      enabled: hasProject,
      run: withProject((id) => void createProjectTerminal(id)),
    },
    {
      id: 'terminal.newClaude',
      title: 'New Claude Code terminal',
      enabled: hasProject,
      run: withProject((id) => newClaude(id, 'claude')),
    },
    {
      id: 'terminal.newClaudeSkipPermissions',
      title: 'New Claude Code terminal (skip permissions)',
      enabled: hasProject,
      run: withProject((id) => newClaude(id, 'claude --dangerously-skip-permissions')),
    },
    {
      id: 'terminal.newOtherModel',
      title: 'New terminal with another model…',
      enabled: hasProject,
      run: withProject((id) => useApiKeys.getState().openLauncher(id)),
    },
    {
      id: 'terminal.close',
      title: 'Close terminal',
      enabled: () => selection().terminalId !== null && !useUsage.getState().open,
      run: withProject((id) => {
        const { terminalId } = selection()
        if (terminalId) useWorkspace.getState().requestTerminalClose(id, terminalId)
      }),
    },
    {
      id: 'file.quickOpen',
      title: 'Go to file…',
      enabled: hasProject,
      run: () => useUi.getState().toggleQuickOpen(),
    },
    {
      id: 'view.toggleSidebar',
      title: 'Toggle project sidebar',
      run: () => useWorkspace.getState().toggleSidebar(),
    },
    {
      id: 'view.toggleRightSidebar',
      title: 'Toggle right panel',
      run: () => useWorkspace.getState().toggleRightSidebar(),
    },
    {
      id: 'view.usage',
      title: 'Usage',
      run: () => useUsage.getState().togglePage(),
      paletteRun: () => {
        useUi.getState().closeSettings()
        useUsage.getState().openPage()
      },
    },
    {
      id: 'view.settings',
      title: 'Settings',
      run: () => useUi.getState().toggleSettings(),
      paletteRun: () => useUi.getState().openSettings(),
    },
    { id: 'project.add', title: 'Add project…', run: () => void addProject() },
    {
      id: 'project.revealInFileManager',
      title: 'Reveal project in file manager',
      enabled: hasProject,
      run: withProject((id) => void ipc.projects.openInFileManager(id)),
    },
    {
      id: 'project.openInSystemTerminal',
      title: 'Open project in system terminal',
      enabled: hasProject,
      run: withProject((id) => void ipc.projects.openInTerminal(id)),
    },
    { id: PALETTE_TOGGLE, title: 'Command palette', run: () => useUi.getState().togglePalette() },
  ]

  for (const tab of SETTINGS_TABS) {
    commands.push({
      id: `settings.${tab.id}`,
      title: `Settings: ${tab.label}`,
      run: () => useUi.getState().openSettings(tab.id),
    })
  }

  const settings = useSettings.getState()
  for (const theme of [...THEMES, ...settings.customThemes]) {
    commands.push({
      id: `theme.${theme.meta.id}`,
      title: `Theme: ${theme.meta.name}`,
      run: () => useSettings.getState().setThemeId(theme.meta.id),
    })
  }

  return commands
}

/** Runs a command if it exists and is enabled; reports whether it ran. */
export function runCommand(id: string): boolean {
  const command = appCommands().find((c) => c.id === id)
  if (!command || (command.enabled && !command.enabled())) return false
  command.run()
  return true
}

/** Everything the palette can show, in its default order. */
export function paletteItems(): PaletteItem[] {
  const items: PaletteItem[] = []
  for (const command of appCommands()) {
    if (command.id === PALETTE_TOGGLE) continue
    if (command.enabled && !command.enabled()) continue
    items.push({
      key: `command:${command.id}`,
      kind: 'command',
      title: command.title,
      hint: shortcutLabel(command.id, isMac, currentKeybindings()) ?? '',
      run: command.paletteRun ?? command.run,
    })
  }

  const ws = useWorkspace.getState()
  for (const project of ws.projects) {
    for (const terminal of project.terminals) {
      items.push({
        key: `terminal:${terminal.id}`,
        kind: 'terminal',
        title: (ws.titleByTerminal[terminal.id] || terminal.name).slice(0, MAX_TITLE_LENGTH),
        hint: `Terminal · ${project.name}`,
        run: () => {
          const state = useWorkspace.getState()
          const live = state.projects.find((p) => p.id === project.id)
          if (!live?.terminals.some((t) => t.id === terminal.id)) return
          useUi.getState().closeSettings()
          state.selectProject(project.id)
          state.setActiveTerminal(project.id, terminal.id)
        },
      })
    }
  }
  for (const project of ws.projects) {
    items.push({
      key: `project:${project.id}`,
      kind: 'project',
      title: project.name,
      hint: 'Project',
      run: () => {
        const state = useWorkspace.getState()
        if (!state.projects.some((p) => p.id === project.id)) return
        useUi.getState().closeSettings()
        state.selectProject(project.id)
      },
    })
  }
  return items
}
