import { useEffect, useRef, useState } from 'react'
import { useProjects } from '../../hooks/use-projects'
import { useWorkspace } from '../../state/store'
import type { Project } from '../../lib/ipc'
import { hoverLines, projectBadge, stateDotClass } from '../../lib/project-status'
import { ContextMenu } from '../context-menu'
import { ProjectTile } from './project-tile'
import { useProjectMenu } from './project-menu'

const HOVER_DELAY_MS = 150

/** The left nav's small state: one tile per project. */
export function ProjectRail() {
  const { projects, addProject } = useProjects()

  return (
    <aside className="panel flex w-[52px] flex-shrink-0 flex-col items-center bg-surface">
      <div className="no-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-2.5 overflow-y-auto overflow-x-hidden py-2.5">
        {projects.map((p) => (
          <RailTile key={p.id} project={p} />
        ))}
      </div>
      <button
        type="button"
        onClick={() => void addProject()}
        title="Add project"
        aria-label="Add project"
        className="my-2 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] border border-dashed border-border text-foreground/50 hover:border-accent hover:text-foreground"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </aside>
  )
}

function RailTile({ project }: { project: Project }) {
  const selected = useWorkspace((s) => s.selectedProjectId === project.id)
  const selectProject = useWorkspace((s) => s.selectProject)
  const busy = useWorkspace((s) => s.busyByTerminal)
  const unread = useWorkspace((s) => s.unreadByTerminal)
  const { items, dialogs } = useProjectMenu(project)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [label, setLabel] = useState<{ left: number; top: number } | null>(null)
  const timer = useRef<number | null>(null)
  const ref = useRef<HTMLButtonElement | null>(null)

  const hide = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    setLabel(null)
  }
  const show = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const r = ref.current?.getBoundingClientRect()
      if (r) setLabel({ left: r.right + 10, top: r.top })
    }, HOVER_DELAY_MS)
  }

  useEffect(() => hide, [])

  // The label is placed once, from where the tile was; scrolling would strand it.
  const labelShown = label !== null
  useEffect(() => {
    if (!labelShown) return
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [labelShown])

  const badge = projectBadge(
    project.terminals.map((t) => t.id),
    busy,
    unread
  )

  return (
    <div className="relative flex-shrink-0">
      <button
        ref={ref}
        type="button"
        aria-label={project.name}
        aria-current={selected || undefined}
        onClick={() => {
          hide()
          selectProject(project.id)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          hide()
          selectProject(project.id)
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className={`block rounded-[10px] outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-focus ${
          selected
            ? 'ring-2 ring-foreground/80 ring-offset-2 ring-offset-surface'
            : 'opacity-60 hover:opacity-100 focus-visible:opacity-100'
        }`}
      >
        <ProjectTile project={project} size={36} />
      </button>
      {badge && (
        <span
          className={`pointer-events-none absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-surface ${
            badge === 'busy' ? 'animate-pulse bg-warning motion-reduce:animate-none' : 'bg-link'
          }`}
        />
      )}
      {label && !menu && <HoverLabel project={project} left={label.left} top={label.top} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      {dialogs}
    </div>
  )
}

function HoverLabel({ project, left, top }: { project: Project; left: number; top: number }) {
  const busy = useWorkspace((s) => s.busyByTerminal)
  const unread = useWorkspace((s) => s.unreadByTerminal)
  const titles = useWorkspace((s) => s.titleByTerminal)
  const { lines, more } = hoverLines(project.terminals, titles, busy, unread)
  // Rows are 20px; keep the box inside the window when the tile is near the bottom.
  const height = 44 + Math.max(1, lines.length + (more ? 1 : 0)) * 20
  const clampedTop = Math.max(8, Math.min(top, window.innerHeight - height - 8))

  return (
    <div
      role="tooltip"
      style={{ left, top: clampedTop }}
      className="pointer-events-none fixed z-[55] w-max max-w-72 rounded-lg border border-border bg-overlay px-3 py-2 text-xs shadow-xl"
    >
      <div className="truncate text-sm font-medium text-foreground">{project.name}</div>
      <div className="mt-1.5 flex flex-col">
        {lines.length === 0 && <div className="h-5 text-muted">No terminals</div>}
        {lines.map((line) => (
          <div key={line.id} className="flex h-5 items-center gap-2">
            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${stateDotClass(line.state)}`} />
            <span className="min-w-0 flex-1 truncate text-foreground/85">{line.title}</span>
            <span className="flex-shrink-0 pl-3 text-muted">{line.label}</span>
          </div>
        ))}
        {more > 0 && <div className="flex h-5 items-center text-muted">+{more} more</div>}
      </div>
    </div>
  )
}
