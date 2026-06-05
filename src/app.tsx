import { useCallback, useEffect, useMemo, useState } from 'react'
import { ProjectList } from './components/sidebar/project-list'
import { TerminalPane } from './components/workspace/terminal-pane'
import { FileViewer } from './components/workspace/file-viewer'
import { RightSidebar } from './components/right-sidebar/right-sidebar'
import { DiffViewer } from './components/diff/diff-viewer'
import { ConfirmDialog } from './components/confirm-dialog'
import { SettingsModal } from './components/settings-modal'
import { IdentityAutoApply } from './components/identity/identity-auto-apply'
import { Resizer } from './components/resizer'
import { useFiles } from './state/files'
import { useDiffView } from './state/diff'
import { useProjects } from './hooks/use-projects'
import { closeProjectTerminal, createProjectTerminal, useWorkspace } from './state/store'
import { kbd } from './lib/platform'
import { notify } from './lib/notify'
import type { Project, TerminalRecord } from './lib/ipc'

export default function App() {
  const { projects, selectedProject, addProject } = useProjects()

  const openFiles = useFiles((s) => s.openFiles)
  const filePaneWidth = useFiles((s) => s.filePaneWidth)
  const setFilePaneWidth = useFiles((s) => s.setFilePaneWidth)
  const activeDiffRaw = useDiffView((s) => s.active)
  const closeDiff = useDiffView((s) => s.close)

  const activeTerminalByProject = useWorkspace((s) => s.activeTerminalByProject)
  const titleByTerminal = useWorkspace((s) => s.titleByTerminal)
  const sidebarCollapsed = useWorkspace((s) => s.sidebarCollapsed)
  const toggleSidebar = useWorkspace((s) => s.toggleSidebar)
  const sidebarWidth = useWorkspace((s) => s.sidebarWidth)
  const setSidebarWidth = useWorkspace((s) => s.setSidebarWidth)
  const rightSidebarCollapsed = useWorkspace((s) => s.rightSidebarCollapsed)
  const toggleRightSidebar = useWorkspace((s) => s.toggleRightSidebar)
  const rightSidebarWidth = useWorkspace((s) => s.rightSidebarWidth)
  const setRightSidebarWidth = useWorkspace((s) => s.setRightSidebarWidth)
  const bumpUnread = useWorkspace((s) => s.bumpUnread)
  const clearUnread = useWorkspace((s) => s.clearUnread)
  const requestTerminalClose = useWorkspace((s) => s.requestTerminalClose)
  const pendingTerminalClose = useWorkspace((s) => s.pendingTerminalClose)
  const clearPendingTerminalClose = useWorkspace((s) => s.clearPendingTerminalClose)

  const [settingsOpen, setSettingsOpen] = useState(false)

  const activeTerminalId = selectedProject
    ? activeTerminalByProject[selectedProject.id] ?? null
    : null

  const activeTerminal = useMemo(
    () => selectedProject?.terminals.find((t) => t.id === activeTerminalId) ?? null,
    [selectedProject, activeTerminalId]
  )

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === ',') {
        e.preventDefault()
        setSettingsOpen((v) => !v)
        return
      }
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault()
        if (e.shiftKey) toggleRightSidebar()
        else toggleSidebar()
        return
      }
      if (!selectedProject) return
      if (e.key === 't') {
        e.preventDefault()
        void createProjectTerminal(selectedProject.id)
      } else if (e.key === 'w' && activeTerminalId) {
        e.preventDefault()
        requestTerminalClose(selectedProject.id, activeTerminalId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedProject, activeTerminalId, toggleSidebar, toggleRightSidebar, requestTerminalClose])

  useEffect(() => {
    if (activeTerminalId && document.hasFocus()) clearUnread(activeTerminalId)
  }, [activeTerminalId, clearUnread])

  const showEmptyNoProject = !selectedProject
  const showEmptyNoTerminals = !!selectedProject && selectedProject.terminals.length === 0
  const hasOpenFiles = !!selectedProject && openFiles.some((f) => f.projectId === selectedProject.id)
  const activeDiff =
    activeDiffRaw && selectedProject && activeDiffRaw.projectId === selectedProject.id
      ? activeDiffRaw
      : null
  const showFilePane = !!selectedProject && (!!activeDiff || hasOpenFiles)

  return (
    <div className="flex h-screen w-screen bg-surface text-foreground">
      {!sidebarCollapsed && (
        <>
          <ProjectList />
          <Resizer width={sidebarWidth} setWidth={setSidebarWidth} side="left" label="Resize sidebar" />
        </>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="app-titlebar flex h-11 items-center gap-2 border-b border-border px-4">
          {sidebarCollapsed && (
            <button
              type="button"
              onClick={toggleSidebar}
              title={`Show sidebar (${kbd('B')})`}
              className="flex h-6 w-6 items-center justify-center rounded-md text-foreground/50 hover:bg-foreground/10 hover:text-foreground"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}
          {selectedProject ? (
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="inline-block h-2 w-2 flex-shrink-0 rounded-full" style={{ background: selectedProject.color }} />
              <span className="truncate font-medium">{selectedProject.name}</span>
              {activeTerminal && (
                <>
                  <span className="text-foreground/30">/</span>
                  <span className="truncate text-foreground/85">
                    {titleByTerminal[activeTerminal.id] || activeTerminal.name}
                  </span>
                </>
              )}
            </div>
          ) : (
            <span className="text-sm text-foreground/40">Terminal Workspace</span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={`Settings (${kbd(',')})`}
            className="flex h-6 w-6 items-center justify-center rounded-md text-foreground/50 hover:bg-foreground/10 hover:text-foreground"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={toggleRightSidebar}
            disabled={!selectedProject}
            title={`Toggle panel (${kbd('⇧B')})`}
            className={`flex h-6 w-6 items-center justify-center rounded-md hover:bg-foreground/10 hover:text-foreground disabled:opacity-30 ${
              selectedProject && !rightSidebarCollapsed ? 'text-foreground/80' : 'text-foreground/50'
            }`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="15" y1="3" x2="15" y2="21" />
            </svg>
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1 overflow-hidden">
            {allTerminals.map((t) => (
              <TerminalPane
                key={t.id}
                terminalId={t.id}
                active={t.project.id === selectedProject?.id && t.id === activeTerminalId}
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
                actionLabel={`New terminal (${kbd('T')})`}
                onAction={() => selectedProject && void createProjectTerminal(selectedProject.id)}
                secondaryLabel="✳ Claude Code"
                onSecondary={() =>
                  selectedProject &&
                  void createProjectTerminal(selectedProject.id, {
                    name: 'Claude Code',
                    startupCommand: 'claude',
                  })
                }
              />
            )}
          </div>
          {showFilePane && selectedProject && (
            <>
              <Resizer
                width={filePaneWidth}
                setWidth={setFilePaneWidth}
                side="right"
                label="Resize file pane"
              />
              <div style={{ width: filePaneWidth }} className="h-full min-w-0 flex-shrink-0">
                {activeDiff ? (
                  <DiffViewer file={activeDiff.file} onClose={closeDiff} />
                ) : (
                  <FileViewer projectId={selectedProject.id} />
                )}
              </div>
            </>
          )}
        </div>
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

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <IdentityAutoApply />
    </div>
  )
}

function EmptyState({
  title,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
}: {
  title: string
  actionLabel: string
  onAction: () => void
  secondaryLabel?: string
  onSecondary?: () => void
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="text-sm text-muted">{title}</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onAction}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90"
          >
            {actionLabel}
          </button>
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              onClick={onSecondary}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-foreground/5"
            >
              {secondaryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
