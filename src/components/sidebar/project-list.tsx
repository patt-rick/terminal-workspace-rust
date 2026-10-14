import { Fragment, useEffect, useState } from 'react'
import { useProjects } from '../../hooks/use-projects'
import { useDragReorder } from '../../hooks/use-drag-reorder'
import { useWorkspace, createProjectTerminal } from '../../state/store'
import { useUi } from '../../state/ui'
import { ipc, type Project } from '../../lib/ipc'
import { stateDotClass, terminalState } from '../../lib/project-status'
import { ContextMenu } from '../context-menu'
import { ProjectTile } from './project-tile'
import { focusTerminal } from '../workspace/terminal-tabs'
import { useProjectMenu } from './project-menu'
import { NavActions } from './nav-actions'

export function ProjectList() {
  const { projects, addProject } = useProjects()
  const sidebarWidth = useWorkspace((s) => s.sidebarWidth)
  const moveProject = useWorkspace((s) => s.moveProject)
  const { containerRef, drag, onPointerDown } = useDragReorder(moveProject)

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

      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-px">
        {projects.length === 0 ? (
          <button
            type="button"
            onClick={() => void addProject()}
            className="mt-2 w-full rounded-lg border border-dashed border-border px-3 py-6 text-sm text-muted hover:border-accent hover:text-foreground"
          >
            Add a project folder
          </button>
        ) : (
          <>
            {projects.map((p, i) => (
              <Fragment key={p.id}>
                {drag?.slot === i && <DropLine />}
                <ProjectRow
                  project={p}
                  dragging={drag?.id === p.id}
                  onDragStart={(e) => onPointerDown(e, p.id)}
                />
              </Fragment>
            ))}
            {drag?.slot === projects.length && <DropLine />}
          </>
        )}
      </div>
      <div className="flex flex-shrink-0 px-2 pb-2">
        <NavActions vertical={false} />
      </div>
    </aside>
  )
}

/** Where a dragged project would land. Zero height, so the list does not shift. */
export function DropLine() {
  return (
    <div className="relative h-0" aria-hidden>
      <div className="absolute inset-x-1 -top-px h-0.5 rounded-full bg-accent" />
    </div>
  )
}

function ProjectRow({
  project,
  dragging,
  onDragStart,
}: {
  project: Project
  dragging: boolean
  onDragStart: (e: React.PointerEvent<HTMLElement>) => void
}) {
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
  // With its active terminal in view, that row carries the strong highlight and
  // the project keeps a lighter one.
  const headerFilled =
    isSelected && !(expanded && project.terminals.some((t) => t.id === activeTerminalId))

  const newTerminal = (): void => {
    selectProject(project.id)
    useWorkspace.getState().setProjectExpanded(project.id, true)
    void createProjectTerminal(project.id)
  }
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
    <div data-reorder-id={project.id} className={`mt-0.5 ${dragging ? 'opacity-50' : ''}`}>
      <div
        onPointerDown={editing ? undefined : onDragStart}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-current={isSelected || undefined}
        className={`group flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${
          headerFilled ? 'bg-foreground/10' : isSelected ? 'bg-foreground/5' : 'hover:bg-foreground/5'
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
        {/* Ringed like the selected tile in the collapsed rail. */}
        <span
          className={`flex flex-shrink-0 rounded-[7px] ${
            isSelected ? 'ring-[1.5px] ring-foreground/70 ring-offset-1 ring-offset-surface' : ''
          }`}
        >
          <ProjectTile project={project} size={22} />
        </span>
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
            className={`min-w-0 flex-1 truncate ${
              isSelected ? 'font-medium text-foreground' : 'text-foreground/80'
            }`}
            onDoubleClick={(e) => {
              e.stopPropagation()
              requestRename(project.id)
            }}
          >
            {project.name}
          </span>
        )}
        {collapsedUnread && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-link" />}
        {!expanded && project.terminals.length > 0 && !menu && (
          <span
            title={`${project.terminals.length} hidden terminal${project.terminals.length === 1 ? '' : 's'}`}
            className="flex-shrink-0 rounded-full bg-foreground/10 px-1.5 text-[11px] leading-4 text-foreground/60 group-focus-within:hidden group-hover:hidden"
          >
            {project.terminals.length}
          </span>
        )}
        {/* Zero width until hovered, so invisible buttons do not cut the name short. */}
        <div
          className={`flex flex-shrink-0 items-center gap-0.5 overflow-hidden ${
            menu ? 'w-auto' : 'w-0 group-focus-within:w-auto group-hover:w-auto'
          }`}
        >
          <button
            type="button"
            title="More actions"
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              setMenu({ x: r.left, y: r.bottom + 2 })
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-foreground/50 outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
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
              newTerminal()
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-foreground/50 outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      </div>

      {expanded && (
        // The guide line runs down from the centre of the project's tile.
        <div className="ml-[18px] mt-0.5 flex flex-col gap-px border-l border-border pl-2">
          {project.terminals.length === 0 ? (
            <button
              type="button"
              onClick={newTerminal}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New terminal
            </button>
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
                  className={`group relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${
                    isActive
                      ? 'bg-foreground/10 text-foreground'
                      : 'text-foreground/65 hover:bg-foreground/5 hover:text-foreground/90'
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
                  {isActive && (
                    <span
                      aria-hidden
                      className="absolute inset-y-1 -left-[9px] w-0.5 rounded-full bg-accent"
                    />
                  )}
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
                    className="flex h-5 w-0 flex-shrink-0 items-center justify-center overflow-hidden rounded text-foreground/40 outline-none hover:bg-foreground/10 hover:text-danger focus-visible:w-5 focus-visible:ring-2 focus-visible:ring-focus group-hover:w-5"
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
