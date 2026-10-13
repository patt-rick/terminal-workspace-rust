import { useEffect, useRef, useState } from 'react'
import { useWorkspace } from '../../state/store'
import { keepFocus } from '../../lib/keep-focus'
import { stateDotClass, terminalState } from '../../lib/project-status'
import type { Project } from '../../lib/ipc'
import { ContextMenu } from '../context-menu'
import { useNewTerminalItems } from './new-terminal-items'

/** Asks the terminal pane with this id to take keyboard focus. */
export const focusTerminal = (terminalId: string): void => {
  window.dispatchEvent(new CustomEvent('tw:focus-terminal', { detail: terminalId }))
}

/** The selected project's terminals as tabs along the top of the terminal panel. */
export function TerminalTabs({ project }: { project: Project }) {
  const activeId = useWorkspace((s) => s.activeTerminalByProject[project.id] ?? null)
  const unread = useWorkspace((s) => s.unreadByTerminal)
  const busy = useWorkspace((s) => s.busyByTerminal)
  const titles = useWorkspace((s) => s.titleByTerminal)
  const setActiveTerminal = useWorkspace((s) => s.setActiveTerminal)
  const clearUnread = useWorkspace((s) => s.clearUnread)
  const requestClose = useWorkspace((s) => s.requestTerminalClose)
  const newItems = useNewTerminalItems(project.id)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const activeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeId])

  return (
    <div
      className="flex h-10 flex-shrink-0 border-b bg-surface"
      style={{ borderColor: 'var(--panel-outline)' }}
    >
      <div
        role="tablist"
        aria-label="Terminals"
        className="no-scrollbar flex min-w-0 flex-1 overflow-x-auto pl-1.5"
      >
        {project.terminals.map((t) => {
          const active = t.id === activeId
          const label = titles[t.id] || t.name
          return (
            <div
              key={t.id}
              ref={active ? activeRef : undefined}
              className={`group relative flex flex-shrink-0 items-center border-r text-xs first:border-l ${
                active
                  ? 'bg-background text-foreground'
                  : 'text-foreground/75 hover:bg-foreground/5 hover:text-foreground'
              }`}
              style={{
                borderColor: 'var(--panel-outline)',
                boxShadow: active ? 'inset 0 2px var(--accent)' : undefined,
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={label}
                {...keepFocus}
                onClick={() => {
                  setActiveTerminal(project.id, t.id)
                  clearUnread(t.id)
                  focusTerminal(t.id)
                }}
                className="flex h-full items-center gap-2 pl-3 pr-8 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
              >
                <span
                  className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${stateDotClass(
                    terminalState(t.id, busy, unread)
                  )}`}
                />
                <span className="max-w-48 truncate">{label}</span>
              </button>
              <button
                type="button"
                title="Close terminal"
                aria-label={`Close ${label}`}
                {...keepFocus}
                onClick={() => requestClose(project.id, t.id)}
                className={`absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-foreground/60 hover:bg-foreground/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 ${
                  active ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        title="New terminal"
        aria-label="New terminal"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        {...keepFocus}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu({ x: r.right - 240, y: r.bottom + 4 })
        }}
        className="flex w-9 flex-shrink-0 items-center justify-center border-l text-foreground/50 hover:bg-foreground/5 hover:text-foreground"
        style={{ borderColor: 'var(--panel-outline)' }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={newItems} onClose={() => setMenu(null)} />}
    </div>
  )
}
