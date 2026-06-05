import { useState } from 'react'
import { useProjects } from '../../hooks/use-projects'
import { useWorkspace, createProjectTerminal } from '../../state/store'
import { ipc, type Project } from '../../lib/ipc'
import { ContextMenu, type MenuItem } from '../context-menu'
import { ConfirmDialog } from '../confirm-dialog'
import { isMac } from '../../lib/platform'

export function ProjectList() {
  const { projects, addProject } = useProjects()
  const sidebarWidth = useWorkspace((s) => s.sidebarWidth)

  return (
    <aside
      className="flex h-full flex-col border-r border-border bg-surface"
      style={{ width: sidebarWidth }}
    >
      <div className="app-titlebar flex h-11 flex-shrink-0 items-center justify-between px-3">
        <span className="pl-1 text-xs font-semibold uppercase tracking-wide text-muted">
          Projects
        </span>
        <button
          type="button"
          onClick={() => void addProject()}
          title="Add project"
          className="flex h-6 w-6 items-center justify-center rounded-md text-foreground/60 hover:bg-foreground/10 hover:text-foreground"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {projects.length === 0 ? (
          <button
            type="button"
            onClick={() => void addProject()}
            className="mt-2 w-full rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted hover:border-accent hover:text-foreground"
          >
            Add a project folder
          </button>
        ) : (
          projects.map((p) => <ProjectRow key={p.id} project={p} />)
        )}
      </div>
    </aside>
  )
}

function ProjectRow({ project }: { project: Project }) {
  const selectedProjectId = useWorkspace((s) => s.selectedProjectId)
  const expanded = useWorkspace((s) => s.expandedProjectIds[project.id] ?? false)
  const activeTerminalId = useWorkspace((s) => s.activeTerminalByProject[project.id] ?? null)
  const unreadByTerminal = useWorkspace((s) => s.unreadByTerminal)
  const busyByTerminal = useWorkspace((s) => s.busyByTerminal)
  const titleByTerminal = useWorkspace((s) => s.titleByTerminal)
  const selectProject = useWorkspace((s) => s.selectProject)
  const toggleExpanded = useWorkspace((s) => s.toggleProjectExpanded)
  const setActiveTerminal = useWorkspace((s) => s.setActiveTerminal)
  const requestClose = useWorkspace((s) => s.requestTerminalClose)
  const clearUnread = useWorkspace((s) => s.clearUnread)
  const renameProject = useWorkspace((s) => s.renameProject)
  const removeProject = useWorkspace((s) => s.removeProject)

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const isSelected = selectedProjectId === project.id
  const collapsedUnread =
    !expanded && project.terminals.some((t) => (unreadByTerminal[t.id] ?? 0) > 0)

  const expandAnd = (fn: () => void): void => {
    useWorkspace.getState().setProjectExpanded(project.id, true)
    fn()
  }
  const newClaude = (yolo: boolean): void =>
    expandAnd(() =>
      void createProjectTerminal(project.id, {
        name: 'Claude Code',
        startupCommand: yolo ? 'claude --dangerously-skip-permissions' : 'claude',
      })
    )
  const commitRename = (value: string): void => {
    const next = value.trim()
    if (next && next !== project.name) {
      renameProject(project.id, next)
      void ipc.projects.rename(project.id, next)
    }
    setEditing(false)
  }
  const doRemove = (): void => {
    void ipc.projects.remove(project.id)
    removeProject(project.id)
    setConfirmRemove(false)
  }

  const menuItems: MenuItem[] = [
    { label: 'New terminal', onClick: () => expandAnd(() => void createProjectTerminal(project.id)) },
    { label: 'Claude Code', onClick: () => newClaude(false) },
    { label: 'Claude Code', trailing: <span className="text-accent">⚡</span>, onClick: () => newClaude(true) },
    { label: 'Rename', separatorBefore: true, onClick: () => setEditing(true) },
    {
      label: isMac ? 'Open in Finder' : 'Open in Explorer',
      onClick: () => void ipc.projects.openInFileManager(project.id),
    },
    { label: 'Open in Terminal', onClick: () => void ipc.projects.openInTerminal(project.id) },
    { label: 'Remove', danger: true, separatorBefore: true, onClick: () => setConfirmRemove(true) },
  ]

  return (
    <div className="mt-0.5">
      <div
        className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
          isSelected ? 'bg-foreground/10' : 'hover:bg-foreground/5'
        }`}
        onClick={() => {
          selectProject(project.id)
          toggleExpanded(project.id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          selectProject(project.id)
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <span className="inline-block h-2 w-2 flex-shrink-0 rounded-full" style={{ background: project.color }} />
        {editing ? (
          <input
            autoFocus
            defaultValue={project.name}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value)
              else if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={(e) => commitRename(e.target.value)}
            className="min-w-0 flex-1 rounded bg-field-background px-1 text-foreground outline-none ring-1 ring-accent"
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-foreground/90"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}
          >
            {project.name}
          </span>
        )}
        {collapsedUnread && <span className="h-1.5 w-1.5 rounded-full bg-link" />}
        <button
          type="button"
          title="More actions"
          onClick={(e) => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({ x: r.left, y: r.bottom + 2 })
          }}
          className={`flex h-5 w-5 items-center justify-center rounded text-foreground/50 hover:bg-foreground/10 hover:text-foreground ${
            menu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
        <button
          type="button"
          title="New terminal"
          onClick={(e) => {
            e.stopPropagation()
            useWorkspace.getState().setProjectExpanded(project.id, true)
            void createProjectTerminal(project.id)
          }}
          className="flex h-5 w-5 items-center justify-center rounded text-foreground/50 opacity-0 hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {expanded && (
        <div className="ml-3 border-l border-border pl-2">
          {project.terminals.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted">No terminals</div>
          ) : (
            project.terminals.map((t) => {
              const isActive = isSelected && activeTerminalId === t.id
              const unread = unreadByTerminal[t.id] ?? 0
              const busy = busyByTerminal[t.id] ?? false
              const label = titleByTerminal[t.id] || t.name
              return (
                <div
                  key={t.id}
                  className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm ${
                    isActive ? 'bg-accent/15 text-foreground' : 'text-foreground/70 hover:bg-foreground/5'
                  }`}
                  onClick={() => {
                    selectProject(project.id)
                    setActiveTerminal(project.id, t.id)
                    clearUnread(t.id)
                  }}
                >
                  {busy ? (
                    <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-warning" />
                  ) : unread > 0 ? (
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-link" />
                  ) : (
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-foreground/20" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <button
                    type="button"
                    title="Close terminal"
                    onClick={(e) => {
                      e.stopPropagation()
                      requestClose(project.id, t.id)
                    }}
                    className="flex h-5 w-5 items-center justify-center rounded text-foreground/40 opacity-0 hover:bg-foreground/10 hover:text-danger group-hover:opacity-100"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              )
            })
          )}
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      <ConfirmDialog
        open={confirmRemove}
        title="Remove project?"
        message={
          <>
            Remove <span className="font-medium text-foreground/90">{project.name}</span> from the
            workspace? This doesn’t delete any files on disk.
          </>
        }
        confirmLabel="Remove"
        danger
        onConfirm={doRemove}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  )
}
