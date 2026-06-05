import { useCallback, useEffect, useState } from 'react'
import { ipc, type FsEntry } from '../../lib/ipc'
import { useFiles } from '../../state/files'

export function FileTree({ projectId }: { projectId: string }) {
  const [rootEntries, setRootEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(() => {
    setLoading(true)
    void ipc.fs
      .list(projectId, '')
      .then(setRootEntries)
      .catch(() => setRootEntries([]))
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(refresh, [refresh])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 flex-shrink-0 items-center justify-between px-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Files</span>
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
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2 text-sm">
        {loading ? (
          <div className="px-3 py-2 text-xs text-muted">Loading…</div>
        ) : (
          rootEntries.map((e) => <TreeNode key={e.path} projectId={projectId} entry={e} depth={0} />)
        )}
      </div>
    </div>
  )
}

function TreeNode({
  projectId,
  entry,
  depth,
}: {
  projectId: string
  entry: FsEntry
  depth: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FsEntry[] | null>(null)
  const openFile = useFiles((s) => s.openFile)
  const activePath = useFiles((s) => s.activeFileByProject[projectId] ?? null)

  const toggle = (): void => {
    if (!entry.isDirectory) {
      openFile({ projectId, path: entry.path })
      return
    }
    const next = !expanded
    setExpanded(next)
    if (next && children === null) {
      void ipc.fs
        .list(projectId, entry.path)
        .then(setChildren)
        .catch(() => setChildren([]))
    }
  }

  const isActive = !entry.isDirectory && activePath === entry.path

  return (
    <div>
      <div
        onClick={toggle}
        style={{ paddingLeft: depth * 12 + 8 }}
        className={`flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 ${
          isActive ? 'bg-accent/15 text-foreground' : 'hover:bg-foreground/5'
        } ${entry.ignored ? 'opacity-45' : ''}`}
      >
        <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-muted">
          {entry.isDirectory ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>
              <polyline points="9 18 15 12 9 6" />
            </svg>
          ) : null}
        </span>
        <span className="truncate text-foreground/85">{entry.name}</span>
      </div>
      {entry.isDirectory && expanded && children && (
        <div>
          {children.map((c) => (
            <TreeNode key={c.path} projectId={projectId} entry={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}
