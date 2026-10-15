import { useState } from 'react'
import type { ProjectInfo, TermInfo } from './protocol'
import { readableOn, tileLetter } from './project-tile'
import { ChevronDownIcon, CloseIcon, HistoryIcon, PlusIcon, SparklesIcon, TerminalIcon } from './icons'

export type Attention = Record<string, { reason: string; message: string | null }>

/** The phone's menu, drawn like the desktop's open left nav: project rows with
 *  their tile, the terminals under a guide line, then the project's actions. */
export function Drawer({
  projects,
  currentId,
  working,
  attention,
  onPick,
  onCloseTerminal,
  onCreate,
  onSessions,
  onDismiss,
}: {
  projects: ProjectInfo[]
  currentId: string | null
  working: Set<string>
  attention: Attention
  onPick: (id: string) => void
  onCloseTerminal: (id: string) => void
  onCreate: (projectId: string, kind: 'shell' | 'claude') => void
  onSessions: (projectId: string) => void
  onDismiss: () => void
}) {
  // Collapsed projects, for this page only; every project starts open.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  return (
    <>
      <div className="scrim" onClick={onDismiss} />
      <nav className="drawer" aria-label="Projects">
        <div className="nav-head">Projects</div>
        <div className="nav-list">
          {projects.length === 0 && <div className="nav-empty">No projects on the desktop yet.</div>}
          {projects.map((p) => {
            const open = !collapsed[p.id]
            const current = p.terminals.some((t) => t.id === currentId)
            const badge = projectBadge(p.terminals, working, attention)
            return (
              <div className="nav-proj" key={p.id}>
                <button
                  className={`nav-proj-row ${current && !open ? 'filled' : current ? 'tinted' : ''}`}
                  aria-expanded={open}
                  onClick={() => setCollapsed((c) => ({ ...c, [p.id]: open }))}
                >
                  <span className={`nav-tile-wrap ${current ? 'ringed' : ''}`}>
                    <Tile name={p.name} color={p.color} />
                    {badge && <span className={`nav-tile-badge ${badge}`} />}
                  </span>
                  <span className={`nav-proj-name ${current ? 'current' : ''}`}>{p.name}</span>
                  {!open && p.terminals.length > 0 && (
                    <span className="nav-count">{p.terminals.length}</span>
                  )}
                  <span className={`nav-chevron ${open ? '' : 'shut'}`}>
                    <ChevronDownIcon size={14} />
                  </span>
                </button>
                {open && (
                  <div className="nav-terms">
                    {p.terminals.map((t) => (
                      <TerminalRow
                        key={t.id}
                        t={t}
                        active={t.id === currentId}
                        busy={working.has(t.id)}
                        attention={attention[t.id]?.reason}
                        onPick={() => onPick(t.id)}
                        onClose={() => onCloseTerminal(t.id)}
                      />
                    ))}
                    <div className="nav-actions">
                      <button className="nav-action" onClick={() => onCreate(p.id, 'shell')}>
                        <PlusIcon size={12} />
                        <TerminalIcon size={13} />
                        Shell
                      </button>
                      <button className="nav-action" onClick={() => onCreate(p.id, 'claude')}>
                        <PlusIcon size={12} />
                        <SparklesIcon size={13} />
                        Claude
                      </button>
                      <button className="nav-action" onClick={() => onSessions(p.id)}>
                        <HistoryIcon size={13} />
                        Sessions
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </nav>
    </>
  )
}

/** A project's square: its colour with the first letter of its name. (The
 *  desktop can also show an uploaded or generated icon; the phone isn't sent it.) */
function Tile({ name, color }: { name: string; color: string }) {
  return (
    <span className="nav-tile" style={{ background: color, color: readableOn(color) }}>
      {tileLetter(name)}
    </span>
  )
}

function TerminalRow({
  t,
  active,
  busy,
  attention,
  onPick,
  onClose,
}: {
  t: TermInfo
  active: boolean
  busy: boolean
  attention: string | undefined
  onPick: () => void
  onClose: () => void
}) {
  const label = statusLabel(t, busy, attention)
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={active || undefined}
      className={`nav-term ${active ? 'active' : ''} ${t.live ? '' : 'dead'}`}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onPick()
        }
      }}
    >
      <span className={`state-dot ${dotClass(busy, attention)}`} />
      <span className={`nav-term-kind ${t.claude ? 'claude' : ''}`}>
        {t.claude ? <SparklesIcon size={13} /> : <TerminalIcon size={13} />}
      </span>
      <span className="nav-term-name">{t.name}</span>
      {label && <span className={`nav-term-status ${label.tone}`}>{label.text}</span>}
      <button
        className="nav-term-x"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label={`Close ${t.name}`}
      >
        <CloseIcon size={13} />
      </button>
    </div>
  )
}

/** Busy beats attention, as on the desktop's terminal tabs. */
export function dotClass(busy: boolean, attention: string | undefined): string {
  if (busy) return 'busy'
  if (attention === 'needs-permission' || attention === 'failed') return 'att-red'
  if (attention === 'finished') return 'att-green'
  return attention ? 'att-amber' : ''
}

const ATTENTION_LABEL: Record<string, string> = {
  'needs-permission': 'Needs you',
  'waiting-input': 'Waiting',
  failed: 'Failed',
  finished: 'Done',
  notify: 'Needs you',
}

function statusLabel(
  t: TermInfo,
  busy: boolean,
  attention: string | undefined
): { text: string; tone: string } | null {
  if (!t.live) return { text: 'Exited', tone: 'muted' }
  if (busy) return { text: 'Working', tone: 'busy' }
  if (attention) return { text: ATTENTION_LABEL[attention] ?? 'Needs you', tone: dotClass(false, attention) }
  return null
}

/** The one badge a project tile shows: working beats needing you. */
function projectBadge(terminals: TermInfo[], working: Set<string>, attention: Attention): string | null {
  if (terminals.some((t) => working.has(t.id))) return 'busy'
  return terminals.some((t) => attention[t.id]) ? 'attention' : null
}
