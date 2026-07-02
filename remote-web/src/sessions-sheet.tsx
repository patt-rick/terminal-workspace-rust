import type { SessionSummary } from './protocol'

const relativeTime = (ms: number): string => {
  const diff = Date.now() - ms
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export function SessionsSheet({
  sessions,
  loading,
  onResume,
  onClose,
}: {
  sessions: SessionSummary[]
  loading: boolean
  onResume: (sessionId: string) => void
  onClose: () => void
}) {
  return (
    <div className="gitsheet">
      <div className="git-head">
        <button className="iconbtn" onClick={onClose}>
          ✕
        </button>
        <span className="title">Claude sessions</span>
      </div>

      <div className="git-files">
        {loading ? (
          <div className="git-empty">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="git-empty">No past sessions for this project.</div>
        ) : (
          sessions.map((s) => (
            <div key={s.sessionId} className="sess-row" onClick={() => onResume(s.sessionId)}>
              <div className="sess-main">
                <span className="sess-title">{s.title || 'Untitled session'}</span>
                <span className="sess-meta">
                  {s.messageCount} msg · {relativeTime(s.lastActive)}
                  {s.gitBranch ? ` · ⎇ ${s.gitBranch}` : ''}
                </span>
              </div>
              <button
                className="primary sess-resume"
                onClick={(e) => {
                  e.stopPropagation()
                  onResume(s.sessionId)
                }}
              >
                Resume
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
