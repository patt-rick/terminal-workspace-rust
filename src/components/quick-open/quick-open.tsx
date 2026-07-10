import { useCallback, useEffect, useRef, useState } from 'react'
import { ipc, type SearchHit, type SearchIndexStatus } from '../../lib/ipc'
import { useFiles } from '../../state/files'

const LIMIT = 50
const BUILD_RETRY_MS = 300

export function QuickOpen({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const openFile = useFiles((s) => s.openFile)
  const openFiles = useFiles((s) => s.openFiles)

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [selected, setSelected] = useState(0)
  const [status, setStatus] = useState<SearchIndexStatus | null>(null)

  const stampRef = useRef(0)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Recently-opened files for this project (most-recent first), used on empty query.
  const recents: SearchHit[] = openFiles
    .filter((f) => f.projectId === projectId)
    .slice()
    .reverse()
    .map((f) => ({ path: f.path, score: 0, indices: [] }))

  const clearRetry = () => {
    if (retryRef.current) {
      clearTimeout(retryRef.current)
      retryRef.current = null
    }
  }

  const run = useCallback(
    (q: string) => {
      clearRetry()
      const stamp = ++stampRef.current
      if (!q) {
        setHits(recents)
        setSelected(0)
        return
      }
      void ipc.search
        .query(projectId, q, LIMIT)
        .then((res) => {
          if (stamp !== stampRef.current) return // drop out-of-order response
          setHits(res.hits)
          setSelected(0)
          if (res.status !== 'ready') {
            retryRef.current = setTimeout(() => run(q), BUILD_RETRY_MS)
          }
        })
        .catch(() => {
          if (stamp === stampRef.current) setHits([])
        })
    },
    [projectId, recents]
  )

  useEffect(() => {
    inputRef.current?.focus()
    void ipc.search.indexStatus(projectId).then(setStatus).catch(() => setStatus(null))
    setHits(recents)
    return clearRetry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Poll index status while it is building/stale so the footer stays live.
  useEffect(() => {
    if (!status || status.status === 'ready') return
    const t = setTimeout(() => {
      void ipc.search.indexStatus(projectId).then(setStatus).catch(() => {})
    }, BUILD_RETRY_MS)
    return () => clearTimeout(t)
  }, [status, projectId])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return
    openFile({ projectId, path: hit.path })
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(hits[selected])
    }
  }

  const footer = status
    ? status.truncated
      ? `Index truncated at ${status.fileCount.toLocaleString()} files`
      : status.status !== 'ready'
        ? 'indexing…'
        : `${status.fileCount.toLocaleString()} files`
    : ''

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/40 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="flex h-fit max-h-[70vh] w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            run(e.target.value)
          }}
          onKeyDown={onKeyDown}
          placeholder="Search files by name…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted"
        />
        <div ref={listRef} className="min-h-0 flex-1 overflow-auto py-1">
          {hits.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted">
              {query ? 'No matching files' : 'Recently opened files appear here'}
            </div>
          ) : (
            hits.map((hit, i) => (
              <div
                key={hit.path}
                data-idx={i}
                onClick={() => choose(hit)}
                onMouseEnter={() => setSelected(i)}
                className={`flex cursor-pointer items-center px-4 py-1.5 text-sm ${
                  i === selected ? 'bg-accent/15' : 'hover:bg-foreground/5'
                }`}
              >
                <Highlighted path={hit.path} indices={hit.indices} />
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-1.5 text-[11px] text-muted">
          <span>{footer}</span>
          <span>↑↓ navigate · ↵ open · esc close</span>
        </div>
      </div>
    </div>
  )
}

/** Render the path with the filename emphasized, directory dimmed, and matched
 *  characters (from `indices`) highlighted. */
function Highlighted({ path, indices }: { path: string; indices: number[] }) {
  const set = new Set(indices)
  const chars = [...path]
  const slash = path.lastIndexOf('/')
  return (
    <span className="truncate">
      {chars.map((ch, i) => {
        const isName = i > slash
        const hit = set.has(i)
        return (
          <span
            key={i}
            className={`${hit ? 'font-semibold text-accent ' : ''}${
              isName ? 'text-foreground' : 'text-foreground/45'
            }`}
          >
            {ch}
          </span>
        )
      })}
    </span>
  )
}
