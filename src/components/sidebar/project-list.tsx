import { useEffect, useState } from 'react'
import { useProjects } from '../../hooks/use-projects'
import { useWorkspace, createProjectTerminal } from '../../state/store'
import { useUi } from '../../state/ui'
import { ipc, type Project } from '../../lib/ipc'
import { stateDotClass, terminalState } from '../../lib/project-status'
import { ContextMenu } from '../context-menu'
import { ProjectTile } from './project-tile'
import { focusTerminal } from '../workspace/terminal-tabs'
import { useProjectMenu } from './project-menu'

export function ProjectList() {
  const { projects, addProject } = useProjects()
  const sidebarWidth = useWorkspace((s) => s.sidebarWidth)

  // A rename in progress ends when the list goes away (the nav became a rail).
  useEffect(() => () => useUi.getState().clearRename(), [])

  return (
    <aside
      className="panel flex h-full flex-shrink-0 flex-col bg-surface"
      style={{ width: sidebarWidth }}
    >
      <div className="flex h-10 flex-shrink-0 items-center justify-between px-3">
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
  const editing = useUi((s) => s.renamingProjectId === project.id)
  const requestRename = useUi((s) => s.requestRename)
  const clearRename = useUi((s) => s.clearRename)
  const { items: menuItems, dialogs } = useProjectMenu(project)

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const isSelected = selectedProjectId === project.id
  const collapsedUnread =
    !expanded && project.terminals.some((t) => (unreadByTerminal[t.id] ?? 0) > 0)

  const commitRename = (value: string): void => {
    const next = value.trim()
    if (next && next !== project.name) {
      renameProject(project.id, next)
      void ipc.projects.rename(project.id, next)
    }
    clearRename()
  }

  return (
    <div className="mt-0.5">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-current={isSelected || undefined}
        className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${
          isSelected ? 'bg-foreground/10' : 'hover:bg-foreground/5'
        }`}
        onClick={() => {
          selectProject(project.id)
          toggleExpanded(project.id)
        }}
        onKeyDown={(e) => {
          // Only the row itself: keys typed in the rename field or on a row button are theirs.
          if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
          e.preventDefault()
          selectProject(project.id)
          toggleExpanded(project.id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          selectProject(project.id)
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <ProjectTile project={project} size={22} />
        {editing ? (
          <input
            autoFocus
            defaultValue={project.name}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value)
              else if (e.key === 'Escape') clearRename()
            }}
            onBlur={(e) => commitRename(e.target.value)}
            className="min-w-0 flex-1 rounded bg-field-background px-1 text-foreground outline-none ring-1 ring-accent"
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-foreground/90"
            onDoubleClick={(e) => {
              e.stopPropagation()
              requestRename(project.id)
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
          className={`flex h-5 w-5 items-center justify-center rounded text-foreground/50 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 ${
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
          className="flex h-5 w-5 items-center justify-center rounded text-foreground/50 opacity-0 hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
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
              const label = titleByTerminal[t.id] || t.name
              return (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  aria-current={isActive || undefined}
                  className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${
                    isActive ? 'bg-accent/15 text-foreground' : 'text-foreground/70 hover:bg-foreground/5'
                  }`}
                  onClick={() => {
                    selectProject(project.id)
                    setActiveTerminal(project.id, t.id)
                    clearUnread(t.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                    e.preventDefault()
                    selectProject(project.id)
                    setActiveTerminal(project.id, t.id)
                    clearUnread(t.id)
                    focusTerminal(t.id)
                  }}
                >
                  <span
                    className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${stateDotClass(
                      terminalState(t.id, busyByTerminal, unreadByTerminal)
                    )}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <button
                    type="button"
                    title="Close terminal"
                    onClick={(e) => {
                      e.stopPropagation()
                      requestClose(project.id, t.id)
                    }}
                    className="flex h-5 w-5 items-center justify-center rounded text-foreground/40 opacity-0 hover:bg-foreground/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
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
      {dialogs}
    </div>
  )
}
