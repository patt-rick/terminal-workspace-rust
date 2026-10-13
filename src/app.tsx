import { useCallback, useEffect, useMemo } from 'react'
import { ProjectList } from './components/sidebar/project-list'
import { ProjectRail } from './components/sidebar/project-rail'
import { ProjectIconDialog } from './components/sidebar/project-icon-dialog'
import { TerminalTabs } from './components/workspace/terminal-tabs'
import { TopBar } from './components/shell/top-bar'
import { StatusBar } from './components/shell/status-bar'
import { TerminalPane } from './components/workspace/terminal-pane'
import { FileViewer } from './components/workspace/file-viewer'
import { RightSidebar } from './components/right-sidebar/right-sidebar'
import { DiffViewer } from './components/diff/diff-viewer'
import { ConfirmDialog } from './components/confirm-dialog'
import { SettingsModal } from './components/settings-modal'
import { QuickOpen } from './components/quick-open/quick-open'
import { IdentityAutoApply } from './components/identity/identity-auto-apply'
import { ModelPicker } from './components/apikeys/model-picker'
import { InstallPrompt } from './components/apikeys/install-prompt'
import { WslInstallPrompt } from './components/wsl-install-prompt'
import { UpdateManager } from './components/update-manager'
import { WhatsNewDialog } from './components/whats-new-dialog'
import { Resizer } from './components/resizer'
import { useFiles } from './state/files'
import { useDiffView } from './state/diff'
import { useRepos } from './state/repos'
import { useProjects } from './hooks/use-projects'
import { closeProjectTerminal, createProjectTerminal, useWorkspace } from './state/store'
import { registerAutoSwitch } from './state/auto-switch'
import { useUi } from './state/ui'
import { useApiKeys } from './state/apikeys'
import { useWsl } from './state/wsl'
import { useUsage } from './state/usage'
import { useProjectIcons } from './state/project-icons'
import { UsagePage } from './components/usage/usage-page'
import { CommandPalette } from './components/command-palette/command-palette'
import { runCommand } from './commands/app-commands'
import { bindingForEvent, withShortcut } from './lib/keybindings'
import { currentKeybindings, useShortcutLabel } from './state/keybindings'
import { isMac } from './lib/platform'
import { useNarrowWindow } from './lib/use-narrow-window'
import { notify } from './lib/notify'
import { ipc, isTauri, type Project, type TerminalRecord } from './lib/ipc'
import { listen } from '@tauri-apps/api/event'

export default function App() {
  const { projects, selectedProject, addProject } = useProjects()

  const openFiles = useFiles((s) => s.openFiles)
  const openFile = useFiles((s) => s.openFile)
  const filePaneWidth = useFiles((s) => s.filePaneWidth)
  const setFilePaneWidth = useFiles((s) => s.setFilePaneWidth)
  const activeDiffRaw = useDiffView((s) => s.active)
  const closeDiff = useDiffView((s) => s.close)
  const reposByProject = useRepos((s) => s.reposByProject)

  const activeTerminalByProject = useWorkspace((s) => s.activeTerminalByProject)
  const titleByTerminal = useWorkspace((s) => s.titleByTerminal)
  const sidebarCollapsed = useWorkspace((s) => s.sidebarCollapsed)
  const sidebarWidth = useWorkspace((s) => s.sidebarWidth)
  const setSidebarWidth = useWorkspace((s) => s.setSidebarWidth)
  const rightSidebarCollapsed = useWorkspace((s) => s.rightSidebarCollapsed)
  const rightSidebarWidth = useWorkspace((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useWorkspace((s) => s.setRightSidebarWidth)
  const bumpUnread = useWorkspace((s) => s.bumpUnread)
  const clearUnread = useWorkspace((s) => s.clearUnread)
  const pendingTerminalClose = useWorkspace((s) => s.pendingTerminalClose)
  const clearPendingTerminalClose = useWorkspace((s) => s.clearPendingTerminalClose)

  const settingsOpen = useUi((s) => s.settingsOpen)
  const closeSettings = useUi((s) => s.closeSettings)
  const quickOpen = useUi((s) => s.quickOpenOpen)
  const closeQuickOpen = useUi((s) => s.closeQuickOpen)
  const paletteOpen = useUi((s) => s.paletteOpen)

  const usageOpen = useUsage((s) => s.open)
  // Usage and Settings are pages over the centre; the terminal is out of reach under them.
  const pageOpen = usageOpen || settingsOpen
  // A narrow window shows the rail whatever the stored choice, which is kept.
  const narrow = useNarrowWindow()
  const newTerminalKey = useShortcutLabel('terminal.new')

  const activeTerminalId = selectedProject
    ? activeTerminalByProject[selectedProject.id] ?? null
    : null

  const allTerminals = useMemo(
    () => projects.flatMap((p) => p.terminals.map((t) => ({ ...t, project: p }))),
    [projects]
  )

  const pendingCloseName = useMemo(() => {
    if (!pendingTerminalClose) return ''
    const term = projects
      .find((p) => p.id === pendingTerminalClose.projectId)
      ?.terminals.find((t) => t.id === pendingTerminalClose.terminalId)
    if (!term) return ''
    return titleByTerminal[term.id] || term.name
  }, [pendingTerminalClose, projects, titleByTerminal])

  const handleBell = useCallback(
    (project: Project, terminal: TerminalRecord) => {
      const isVisible = project.id === selectedProject?.id && terminal.id === activeTerminalId
      if (!(isVisible && document.hasFocus())) bumpUnread(terminal.id)
      void notify(project.name, `${terminal.name} wants your input`)
    },
    [selectedProject, activeTerminalId, bumpUnread]
  )

  // Every shortcut is a binding (lib/keybindings.ts) that names a registry
  // command. A binding with the terminal switch off does nothing while a
  // terminal has focus; xterm has already had the key by then. The default is
  // still prevented, so e.g. Ctrl+Shift+P never opens the webview print dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The editor prevents the default for keys it handles itself.
      if (e.defaultPrevented) return
      const binding = bindingForEvent(e, isMac, currentKeybindings())
      if (binding === null) return
      e.preventDefault()
      if (e.repeat) return
      const inTerminal = document.activeElement?.closest('.xterm') != null
      if (inTerminal && !binding.inTerminal) return
      // The palette's list was built when it opened; other shortcuts acting
      // behind it would make that list stale.
      const command = binding.command
      const behindPalette = command !== 'palette.toggle' && command !== 'file.quickOpen'
      if (useUi.getState().paletteOpen && behindPalette) return
      runCommand(command)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (activeTerminalId && document.hasFocus()) clearUnread(activeTerminalId)
  }, [activeTerminalId, clearUnread])

  useEffect(() => {
    void useWsl.getState().load()
    if (isTauri) void useProjectIcons.getState().load()
  }, [])

  // Auto-switch Claude accounts on a usage limit: the orchestrator owns the
  // limit-suspected listener and all episode/quiet-period state (gated at
  // runtime by the settings toggle).
  useEffect(() => {
    if (!isTauri) return
    return registerAutoSwitch()
  }, [])

  // Build + watch the search index for the selected project (and drop others).
  useEffect(() => {
    if (!isTauri || !selectedProject) return
    void ipc.search.indexStatus(selectedProject.id).catch(() => {})
  }, [selectedProject?.id])

  // Typed attention from the Rust core (Claude hooks, failed commands, prompt
  // waits): notify + unread-dot when the terminal isn't front-and-center.
  useEffect(() => {
    if (!isTauri) return
    const unlisten = listen<{ id: string; reason: string; message: string | null }>(
      'terminals:attention',
      (e) => {
        const { id, reason, message } = e.payload
        const ws = useWorkspace.getState()
        const proj = ws.projects.find((p) => p.terminals.some((t) => t.id === id))
        const term = proj?.terminals.find((t) => t.id === id)
        if (!proj || !term) return
        const isVisible =
          proj.id === useWorkspace.getState().selectedProjectId &&
          id === useWorkspace.getState().activeTerminalByProject[proj.id]
        if (isVisible && document.hasFocus()) return // you're already looking at it
        ws.bumpUnread(id)
        const body =
          reason === 'needs-permission'
            ? (message ?? 'Claude needs your permission')
            : reason === 'waiting-input'
              ? `${term.name} is waiting for input${message ? `: ${message}` : ''}`
              : reason === 'failed'
                ? `${term.name}: command failed${message ? ` — ${message}` : ''}`
                : reason === 'finished'
                  ? `${term.name} finished`
                  : (message ?? reason)
        void notify(proj.name, body)
      }
    )
    return () => {
      void unlisten.then((off) => off())
    }
  }, [])

  // A remote web client can create/resume terminals in the Rust core; surface
  // them in the desktop UI too (AC-3.5) without waiting for a state reload.
  useEffect(() => {
    if (!isTauri) return
    const unlisten = listen<{ projectId: string; terminal: TerminalRecord }>(
      'remote:terminal-added',
      (e) => {
        const { projectId, terminal } = e.payload
        const ws = useWorkspace.getState()
        const proj = ws.projects.find((p) => p.id === projectId)
        if (proj && !proj.terminals.some((t) => t.id === terminal.id)) {
          ws.addTerminal(projectId, terminal)
        }
      }
    )
    return () => {
      void unlisten.then((off) => off())
    }
  }, [])

  const showEmptyNoProject = !selectedProject
  const showEmptyNoTerminals = !!selectedProject && selectedProject.terminals.length === 0
  const hasOpenFiles = !!selectedProject && openFiles.some((f) => f.projectId === selectedProject.id)
  const activeDiff =
    activeDiffRaw && selectedProject && activeDiffRaw.projectId === selectedProject.id
      ? activeDiffRaw
      : null
  const showFilePane = !!selectedProject && (!!activeDiff || hasOpenFiles)

  const openDiffFile = useCallback(() => {
    if (!activeDiff) return
    const repo = (reposByProject[activeDiff.projectId] ?? []).find(
      (r) => r.id === activeDiff.repoId
    )
    const path = repo?.relativePath
      ? `${repo.relativePath}/${activeDiff.file.path}`
      : activeDiff.file.path
    openFile({ projectId: activeDiff.projectId, path })
    closeDiff()
  }, [activeDiff, reposByProject, openFile, closeDiff])

  return (
    <div className="shell-root flex h-screen w-screen flex-col text-foreground">
      <TopBar />
      <div className="flex min-h-0 flex-1 px-2.5">
        {sidebarCollapsed || narrow ? (
          <>
            <ProjectRail />
            <div className="flex-shrink-0" style={{ width: 'var(--gap-panel)' }} />
          </>
        ) : (
          <>
            <ProjectList />
            <Resizer width={sidebarWidth} setWidth={setSidebarWidth} side="left" label="Resize sidebar" />
          </>
        )}
        <main className="relative flex min-w-0 flex-1">
          <div className="panel flex min-w-0 flex-1 flex-col bg-background" inert={pageOpen}>
            {selectedProject && selectedProject.terminals.length > 0 && (
              <TerminalTabs project={selectedProject} />
            )}
            <div className="relative min-h-0 flex-1">
              {allTerminals.map((t) => (
                <TerminalPane
                  key={t.id}
                  terminalId={t.id}
                  active={!pageOpen && t.project.id === selectedProject?.id && t.id === activeTerminalId}
                  onBell={() => handleBell(t.project, t)}
                />
              ))}
              {showEmptyNoProject && (
                <EmptyState
                  title="No project selected"
                  actionLabel="Add a project"
                  onAction={() => void addProject()}
                />
              )}
              {showEmptyNoTerminals && (
                <EmptyState
                  title="No terminals yet"
                  actionLabel={withShortcut('New terminal', newTerminalKey)}
                  onAction={() => selectedProject && void createProjectTerminal(selectedProject.id)}
                  secondaryLabel="✳ Claude Code"
                  onSecondary={() =>
                    selectedProject &&
                    void createProjectTerminal(selectedProject.id, {
                      name: 'Claude Code',
                      startupCommand: 'claude',
                    })
                  }
                  tertiaryLabel="Use other models"
                  onTertiary={() =>
                    selectedProject && useApiKeys.getState().openLauncher(selectedProject.id)
                  }
                />
              )}
            </div>
          </div>
          {showFilePane && selectedProject && (
            <>
              <Resizer
                width={filePaneWidth}
                setWidth={setFilePaneWidth}
                side="right"
                label="Resize file pane"
              />
              <div
                style={{ width: filePaneWidth }}
                className="panel h-full min-w-0 flex-shrink-0"
                inert={pageOpen}
              >
                {activeDiff ? (
                  <DiffViewer file={activeDiff.file} onClose={closeDiff} onOpen={openDiffFile} />
                ) : (
                  <FileViewer projectId={selectedProject.id} />
                )}
              </div>
            </>
          )}
          {usageOpen && <UsagePage />}
          <SettingsModal open={settingsOpen} onClose={closeSettings} />
        </main>
        {selectedProject && !rightSidebarCollapsed && (
          <>
            <Resizer
              width={rightSidebarWidth}
              setWidth={setRightSidebarWidth}
              side="right"
              label="Resize panel"
            />
            <RightSidebar projectId={selectedProject.id} />
          </>
        )}
      </div>
      <StatusBar />

      <ConfirmDialog
        open={!!pendingTerminalClose}
        title="Close terminal?"
        message={
          pendingCloseName ? (
            <>
              Close <span className="font-medium text-foreground/90">{pendingCloseName}</span>? This
              ends the shell and any running process.
            </>
          ) : (
            'This ends the shell and any running process.'
          )
        }
        confirmLabel="Close"
        danger
        onConfirm={() => {
          if (pendingTerminalClose) {
            void closeProjectTerminal(pendingTerminalClose.projectId, pendingTerminalClose.terminalId)
          }
          clearPendingTerminalClose()
        }}
        onCancel={clearPendingTerminalClose}
      />

      <ProjectIconDialog />
      {quickOpen && selectedProject && (
        <QuickOpen projectId={selectedProject.id} onClose={closeQuickOpen} />
      )}
      {paletteOpen && <CommandPalette />}
      <IdentityAutoApply />
      <ModelPicker />
      <InstallPrompt />
      <WslInstallPrompt />
      <UpdateManager />
      <WhatsNewDialog />
    </div>
  )
}

function EmptyState({
  title,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  tertiaryLabel,
  onTertiary,
}: {
  title: string
  actionLabel: string
  onAction: () => void
  secondaryLabel?: string
  onSecondary?: () => void
  tertiaryLabel?: string
  onTertiary?: () => void
}) {
  return (
    <div className="@container absolute inset-0 flex items-center justify-center">
      <div className="flex w-full flex-col items-center gap-3 px-4">
        <div className="text-sm text-muted">{title}</div>
        <div className="flex w-full flex-col items-stretch gap-2 @sm:w-auto @sm:flex-row @sm:items-center">
          <button
            type="button"
            onClick={onAction}
            className="whitespace-nowrap rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90"
          >
            {actionLabel}
          </button>
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              onClick={onSecondary}
              className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-foreground/5"
            >
              {secondaryLabel}
            </button>
          )}
          {tertiaryLabel && onTertiary && (
            <button
              type="button"
              onClick={onTertiary}
              className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-foreground/5"
            >
              {tertiaryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
