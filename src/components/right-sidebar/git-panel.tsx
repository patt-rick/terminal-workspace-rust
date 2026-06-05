import { useCallback, useEffect, useState } from 'react'
import { ipc, type FileDiff, type GitInfo } from '../../lib/ipc'
import { useDiffView } from '../../state/diff'

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

const statusDot = (status: string): string => {
  switch (status) {
    case 'added':
      return 'text-success'
    case 'deleted':
      return 'text-danger'
    case 'renamed':
    case 'copied':
      return 'text-link'
    default:
      return 'text-warning'
  }
}

const statusGlyph = (status: string): string => {
  switch (status) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    default:
      return 'M'
  }
}

export function GitPanel({ projectId }: { projectId: string }) {
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [diffs, setDiffs] = useState<FileDiff[]>([])
  const [loading, setLoading] = useState(true)
  const [pushing, setPushing] = useState(false)
  const [pushMsg, setPushMsg] = useState<string | null>(null)
  const show = useDiffView((s) => s.show)
  const active = useDiffView((s) => s.active)

  const refresh = useCallback(() => {
    setLoading(true)
    Promise.all([
      ipc.git.info(projectId).catch(() => null),
      ipc.git.diff(projectId).catch(() => [] as FileDiff[]),
    ])
      .then(([i, d]) => {
        setInfo(i)
        setDiffs(d)
      })
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(refresh, [refresh])

  const onPush = async (): Promise<void> => {
    if (!info?.branch) return
    setPushing(true)
    setPushMsg(null)
    try {
      const res = await ipc.git.push(projectId, info.branch)
      setPushMsg(res.ok ? 'Pushed.' : res.output || 'Push failed')
      if (res.ok) refresh()
    } catch (e) {
      setPushMsg(String(e))
    } finally {
      setPushing(false)
    }
  }

  if (loading && !info) {
    return <div className="px-3 py-3 text-xs text-muted">Loading…</div>
  }
  if (!info?.isRepo) {
    return <div className="px-3 py-3 text-xs text-muted">Not a git repository</div>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 flex-shrink-0 items-center justify-between px-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 text-muted">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span className="truncate font-medium text-foreground">{info.branch ?? 'detached'}</span>
          {info.ahead > 0 && <span className="text-success">↑{info.ahead}</span>}
          {info.behind > 0 && <span className="text-warning">↓{info.behind}</span>}
        </div>
        <button
          type="button"
          onClick={refresh}
          title="Refresh"
          className="flex h-5 w-5 items-center justify-center rounded text-foreground/50 hover:bg-foreground/10 hover:text-foreground"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>

      {(info.dirty || info.ahead > 0 || !info.hasUpstream) && info.branch && (
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={() => void onPush()}
            disabled={pushing}
            className="w-full rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {pushing ? 'Pushing…' : info.hasUpstream ? `Push ${info.ahead || ''}`.trim() : 'Publish branch'}
          </button>
          {pushMsg && <div className="mt-1 max-h-16 overflow-auto text-[11px] text-muted">{pushMsg}</div>}
        </div>
      )}

      <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Changes {diffs.length > 0 && `(${diffs.length})`}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2 text-sm">
        {diffs.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted">Working tree clean</div>
        ) : (
          diffs.map((f) => {
            const isActive = active?.file.path === f.path
            return (
              <div
                key={f.path}
                onClick={() => show(projectId, f)}
                className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 ${
                  isActive ? 'bg-accent/15' : 'hover:bg-foreground/5'
                }`}
              >
                <span className={`w-3 flex-shrink-0 text-center font-mono text-xs font-bold ${statusDot(f.status)}`}>
                  {statusGlyph(f.status)}
                </span>
                <span className="truncate text-foreground/85">{basename(f.path)}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted">
                  {f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}
                </span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
