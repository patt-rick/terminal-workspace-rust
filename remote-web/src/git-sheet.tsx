import { useState } from 'react'
import type { FileDiff, GitInfo, RepoInfo } from './protocol'

const repoLabel = (r: RepoInfo): string => r.relativePath || r.name

const GLYPHS: Record<string, string> = { added: 'A', deleted: 'D', renamed: 'R', copied: 'C' }
const CLASSES: Record<string, string> = {
  added: 'g-add',
  deleted: 'g-del',
  renamed: 'g-ren',
  copied: 'g-ren',
}
const statusGlyph = (status: string): string => GLYPHS[status] ?? 'M'
const statusClass = (status: string): string => CLASSES[status] ?? 'g-mod'

const lineClass = (origin: string): string =>
  origin === '+' ? 'g-add' : origin === '-' ? 'g-del' : ''

export function GitSheet({
  repos,
  repoId,
  status,
  diffs,
  pushMsg,
  pushing,
  onSelectRepo,
  onPush,
  onClose,
}: {
  repos: RepoInfo[]
  repoId: string | null
  status: GitInfo | null
  diffs: FileDiff[]
  pushMsg: string | null
  pushing: boolean
  onSelectRepo: (id: string) => void
  onPush: () => void
  onClose: () => void
}) {
  const [file, setFile] = useState<FileDiff | null>(null)
  const [confirm, setConfirm] = useState(false)

  const canPush =
    !!status?.branch && (status.dirty || status.ahead > 0 || !status.hasUpstream)
  const pushLabel = status?.hasUpstream ? `Push ${status.ahead || ''}`.trim() : 'Publish branch'

  return (
    <div className="gitsheet">
      <div className="git-head">
        <button className="iconbtn" onClick={file ? () => setFile(null) : onClose}>
          {file ? '‹' : '✕'}
        </button>
        {file ? (
          <span className="title">{file.path}</span>
        ) : repos.length > 1 ? (
          <select
            className="git-repo"
            value={repoId ?? ''}
            onChange={(e) => onSelectRepo(e.target.value)}
          >
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {repoLabel(r)}
                {r.isSubmodule ? ' (sub)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <span className="title">{repos[0] ? repoLabel(repos[0]) : 'Git'}</span>
        )}
      </div>

      {file ? (
        <div className="git-diff">
          {file.binary ? (
            <div className="git-empty">Binary file — diff not shown</div>
          ) : file.hunks.length === 0 ? (
            <div className="git-empty">No textual changes</div>
          ) : (
            file.hunks.map((h, i) => (
              <div key={i}>
                <div className="g-hunk">{h.header}</div>
                {h.lines.map((l, j) => (
                  <div key={j} className={`g-line ${lineClass(l.origin)}`}>
                    <span className="g-o">{l.origin === ' ' ? '' : l.origin}</span>
                    {l.content}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <div className="git-status">
            {status?.isRepo ? (
              <>
                <span className="g-branch">⎇ {status.branch ?? 'detached'}</span>
                {status.ahead > 0 && <span className="g-add">↑{status.ahead}</span>}
                {status.behind > 0 && <span className="g-mod">↓{status.behind}</span>}
              </>
            ) : (
              <span className="git-empty">Not a git repository</span>
            )}
          </div>

          {canPush && (
            <div className="git-push">
              <button className="primary" disabled={pushing} onClick={() => setConfirm(true)}>
                {pushing ? 'Pushing…' : pushLabel}
              </button>
            </div>
          )}
          {pushMsg && <div className="git-pushmsg">{pushMsg}</div>}

          <div className="git-files">
            {diffs.length === 0 ? (
              <div className="git-empty">Working tree clean</div>
            ) : (
              diffs.map((f) => (
                <div key={f.path} className="git-file" onClick={() => setFile(f)}>
                  <span className={`g-glyph ${statusClass(f.status)}`}>
                    {statusGlyph(f.status)}
                  </span>
                  <span className="g-path">{f.path}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {confirm && (
        <div className="scrim" onClick={() => setConfirm(false)}>
          <div className="confirm" onClick={(e) => e.stopPropagation()}>
            <p>
              Push <b>{status?.branch}</b>
              {status && !status.hasUpstream ? ' (new upstream)' : ''}?
            </p>
            <div className="confirm-actions">
              <button className="iconbtn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={() => {
                  setConfirm(false)
                  onPush()
                }}
              >
                Push
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
