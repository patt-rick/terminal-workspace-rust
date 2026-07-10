import type { FileDiff } from '../../lib/ipc'

const statusColor = (status: string): string => {
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

const lineClass = (origin: string): string => {
  if (origin === '+') return 'bg-success/15'
  if (origin === '-') return 'bg-danger/15'
  return ''
}

const num = (n: number | null): string => (n === null ? '' : String(n))

export function DiffViewer({
  file,
  onClose,
  onOpen,
}: {
  file: FileDiff
  onClose: () => void
  onOpen?: () => void
}) {
  return (
    <div className="flex h-full flex-col border-l border-border bg-background">
      <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        <span className={`font-semibold uppercase ${statusColor(file.status)}`}>{file.status}</span>
        {file.oldPath && file.oldPath !== file.path && (
          <span className="truncate text-muted">{file.oldPath} →</span>
        )}
        <span className="truncate font-medium text-foreground">{file.path}</span>
        <div className="flex-1" />
        {onOpen && file.status !== 'deleted' && (
          <button
            type="button"
            onClick={onOpen}
            title="Open file"
            className="flex h-5 w-5 items-center justify-center rounded text-foreground/50 hover:bg-foreground/10 hover:text-foreground"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close diff"
          className="flex h-5 w-5 items-center justify-center rounded text-foreground/50 hover:bg-foreground/10 hover:text-foreground"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-[1.6]">
        {file.binary ? (
          <Centered>Binary file — diff not shown</Centered>
        ) : file.hunks.length === 0 ? (
          <Centered>No textual changes</Centered>
        ) : (
          file.hunks.map((hunk, hi) => (
            <div key={hi}>
              <div className="bg-foreground/5 px-3 py-1 text-link">{hunk.header}</div>
              {hunk.lines.map((line, li) => (
                <div key={li} className={`flex whitespace-pre ${lineClass(line.origin)}`}>
                  <span className="w-10 flex-shrink-0 select-none px-1 text-right text-muted/70">
                    {num(line.oldLineno)}
                  </span>
                  <span className="w-10 flex-shrink-0 select-none px-1 text-right text-muted/70">
                    {num(line.newLineno)}
                  </span>
                  <span className="w-4 flex-shrink-0 select-none text-center text-muted">
                    {line.origin === ' ' ? '' : line.origin}
                  </span>
                  <span className="flex-1 pr-3 text-foreground/90">{line.content || ' '}</span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-muted">{children}</div>
}
