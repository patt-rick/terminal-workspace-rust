import { useCallback, useEffect, useMemo, useState } from 'react'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { ipc, type ClaudeSession } from '../../lib/ipc'
import { createProjectTerminal, useWorkspace } from '../../state/store'
import { ContextMenu, type MenuItem } from '../context-menu'
import { ConfirmDialog } from '../confirm-dialog'

const timeAgo = (ms: number): string => {
  if (!ms) return ''
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function SessionsPanel({ projectId }: { projectId: string }) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; session: ClaudeSession } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ClaudeSession | null>(null)

  const project = useWorkspace((s) => s.projects.find((p) => p.id === projectId))
  const sessionIdByTerminal = useWorkspace((s) => s.sessionIdByTerminal)
  const setActiveTerminal = useWorkspace((s) => s.setActiveTerminal)

  // sessionId -> terminalId for terminals open in THIS project.
  const openBySession = useMemo(() => {
    const m: Record<string, string> = {}
    for (const t of project?.terminals ?? []) {
      const sid = sessionIdByTerminal[t.id]
      if (sid) m[sid] = t.id
    }
    return m
  }, [project, sessionIdByTerminal])

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    ipc.claude
      .listSessions(projectId)
      .then(setSessions)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(refresh, [refresh])

  // A finished session's title/count may have changed; refresh when a terminal exits.
  useEffect(() => {
    let un: UnlistenFn | undefined
    void ipc.terminals.onExit(() => refresh()).then((f) => {
      un = f
    })
    return () => un?.()
  }, [refresh])

  const onOpen = (s: ClaudeSession): void => {
    const openId = openBySession[s.sessionId]
    if (openId) {
      setActiveTerminal(projectId, openId)
      return
    }
    void createProjectTerminal(projectId, {
      name: s.title.slice(0, 40) || 'Claude',
      startupCommand: `claude --resume ${s.sessionId}`,
      claudeSessionId: s.sessionId,
    })
  }

  const onDelete = async (s: ClaudeSession): Promise<void> => {
    try {
      await ipc.claude.deleteSession(projectId, s.sessionId)
      refresh()
    } catch (e) {
      setError(String(e))
    }
  }

  if (loading) return <Hint>Loading sessions…</Hint>
  if (error) {
    return (
      <div className="px-3 py-3 text-xs text-muted">
        {error}
        <button type="button" onClick={refresh} className="ml-2 text-link hover:underline">
          Retry
        </button>
      </div>
    )
  }
  if (sessions.length === 0) return <Hint>No Claude sessions yet for this project.</Hint>

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 flex-shrink-0 items-center px-3 text-xs text-muted">
        <span>
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <button type="button" onClick={refresh} className="hover:text-foreground">
          Refresh
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {sessions.map((s) => {
          const open = !!openBySession[s.sessionId]
          return (
            <div
              key={s.sessionId}
              onClick={() => onOpen(s)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, session: s })
              }}
              className="cursor-pointer rounded-md px-2 py-1.5 hover:bg-foreground/5"
            >
              <div className="flex items-center gap-1.5 text-sm">
                {open && (
                  <span className="text-success" title="Open in a terminal">
                    ●
                  </span>
                )}
                <span className="truncate text-foreground/90">{s.title}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-muted">
                {timeAgo(s.lastActive)} · {s.messageCount} msg
                {s.gitBranch ? ` · ${s.gitBranch}` : ''}
                {open ? ' · open' : ''}
              </div>
            </div>
          )
        })}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            [
              {
                label: openBySession[menu.session.sessionId] ? 'Focus terminal' : 'Resume session',
                onClick: () => onOpen(menu.session),
              },
              {
                label: 'Delete session',
                danger: true,
                separatorBefore: true,
                onClick: () => setPendingDelete(menu.session),
              },
            ] satisfies MenuItem[]
          }
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete session?"
        message={
          <>
            Permanently delete{' '}
            <span className="font-medium text-foreground/90">{pendingDelete?.title}</span>? This
            removes its transcript from disk and cannot be undone.
          </>
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (pendingDelete) void onDelete(pendingDelete)
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-3 text-xs text-muted">{children}</div>
}
