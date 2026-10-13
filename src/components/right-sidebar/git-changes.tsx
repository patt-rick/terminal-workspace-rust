import { useCallback, useEffect, useRef, useState } from 'react'
import { ipc, type FileDiff } from '../../lib/ipc'
import { canCommit, commitButtons, isNotableSuccess, pathsOf } from '../../lib/git-changes'
import { useCommitDrafts } from '../../state/commit-drafts'
import { useDiffView, type DiffScope } from '../../state/diff'

// A nested repository is listed as a folder path with a trailing slash.
const basename = (p: string): string => {
  const trimmed = p.replace(/\/$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

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

type GitResult = { ok: boolean; output: string }

export interface PushAction {
  /** "Push", "Push 2" or "Publish branch" */
  label: string
  /** "Push" or "Publish branch", for the combined button */
  verb: string
  busy: boolean
  /** there is already something to push: commits ahead, or an unpublished branch */
  pending: boolean
  /** the push needs a second look (wrong account), so it is never chained to a commit */
  hold: boolean
  run: () => Promise<void>
  /** drop the last push result, so it is not read as the result of a new commit */
  clearMessage: () => void
}
type Lists = readonly [FileDiff[], FileDiff[]]

function FileList({
  title,
  files,
  scope,
  emptyText,
  allLabel,
  rowLabel,
  rowGlyph,
  busy,
  activePath,
  onOpen,
  onRow,
  onAll,
}: {
  title: string
  files: FileDiff[]
  scope: DiffScope
  emptyText: string
  allLabel: string
  rowLabel: string
  rowGlyph: string
  busy: boolean
  activePath: string | null
  onOpen: (file: FileDiff, scope: DiffScope) => void
  onRow: (file: FileDiff) => void
  onAll: () => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <span>
          {title} {files.length > 0 && `(${files.length})`}
        </span>
        {files.length > 0 && (
          <button
            type="button"
            onClick={onAll}
            disabled={busy}
            className="font-normal normal-case tracking-normal text-link hover:underline disabled:opacity-50"
          >
            {allLabel}
          </button>
        )}
      </div>
      <div className="px-1 pb-2 text-sm">
        {files.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted">{emptyText}</div>
        ) : (
          files.map((f) => (
            <div
              key={f.path}
              onClick={() => onOpen(f, scope)}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 ${
                activePath === f.path ? 'bg-accent/15' : 'hover:bg-foreground/5'
              }`}
            >
              <span className={`w-3 flex-shrink-0 text-center font-mono text-xs font-bold ${statusDot(f.status)}`}>
                {statusGlyph(f.status)}
              </span>
              <span className="truncate text-foreground/85">{basename(f.path)}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                {f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onRow(f)
                }}
                disabled={busy}
                title={rowLabel}
                aria-label={`${rowLabel}: ${f.path}`}
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-foreground/50 hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
              >
                {rowGlyph}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * The Git tab's commit box and buttons, then the Staged and Changes lists, so
 * the tab reads in the order the work happens: write the message, commit,
 * push. Commit and Push are one button unless some changes are left unstaged
 * (see `commitButtons`); pushing itself stays in the panel, which owns the
 * identity checks. The message field
 * is text for git only; it never reaches an agent or a shell (the backend
 * hands it to `git commit` on standard input).
 *
 * The panel renders this with `key={repoId}`, so each repo gets a fresh
 * instance: one repo's rows can never be acted on against another.
 */
export function GitChanges({
  projectId,
  repoId,
  reloadTick,
  onChanged,
  push,
  pushNote,
  pushMessage,
}: {
  projectId: string
  repoId: string
  /** how to push, or null when there is no branch to push */
  push: PushAction | null
  /** who the push goes out as, or a warning about it */
  pushNote?: React.ReactNode
  /** the result of the last push */
  pushMessage: string | null
  /** bumped by the panel's Refresh button */
  reloadTick: number
  /** called after any operation so the panel can refresh the branch line */
  onChanged: () => void
}) {
  const [staged, setStaged] = useState<FileDiff[]>([])
  const [unstaged, setUnstaged] = useState<FileDiff[]>([])
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [undo, setUndo] = useState<string | null>(null)
  const genSeq = useRef(0)
  const lastAnswer = useRef<string | null>(null)
  const message = useCommitDrafts((s) => s.drafts[repoId] ?? '')
  const setDraft = useCommitDrafts((s) => s.setDraft)
  const show = useDiffView((s) => s.show)
  const active = useDiffView((s) => s.active)
  const closeDiff = useDiffView((s) => s.close)
  const loadSeq = useRef(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /** The fresh lists, or null when a newer load superseded this one or it failed. */
  const load = useCallback(async (): Promise<Lists | null> => {
    const seq = ++loadSeq.current
    try {
      const lists = await Promise.all([
        ipc.git.diff(repoId, 'staged'),
        ipc.git.diff(repoId, 'unstaged'),
      ])
      if (!alive.current || seq !== loadSeq.current) return null
      setStaged(lists[0])
      setUnstaged(lists[1])
      return lists
    } catch (e) {
      if (alive.current && seq === loadSeq.current) setOutput(String(e))
      return null
    }
  }, [repoId])

  useEffect(() => {
    void load()
  }, [load, reloadTick])

  // An agent in the terminal can stage or edit files at any time; coming back
  // to the window is the cheapest moment to catch up.
  useEffect(() => {
    const onFocus = (): void => {
      void load()
      onChanged()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load, onChanged])

  const run = async (op: () => Promise<GitResult>, clearMessage = false): Promise<boolean> => {
    setBusy(true)
    setOutput(null)
    let res: GitResult
    try {
      res = await op()
    } catch (e) {
      res = { ok: false, output: String(e) }
    }
    if (!alive.current) return false
    if (!res.ok) setOutput(res.output || 'git failed')
    else if (isNotableSuccess(res.output)) setOutput(res.output)
    if (res.ok && clearMessage) {
      setDraft(repoId, '')
      setUndo(null)
    }

    const lists = await load()
    if (!alive.current) return false
    // Keep the open diff in step: refresh it if its file is still in the same
    // list, close it if the file moved or went away.
    const open = useDiffView.getState().active
    if (lists && open?.repoId === repoId) {
      const list = open.scope === 'staged' ? lists[0] : lists[1]
      const next = list.find((f) => f.path === open.file.path)
      if (next) show(projectId, repoId, next, open.scope)
      else closeDiff()
    }
    setBusy(false)
    onChanged()
    return res.ok
  }

  const buttons = commitButtons(
    staged.length,
    unstaged.length,
    push !== null,
    push?.pending ?? false,
    push?.hold ?? false
  )
  const working = busy || generating || (push?.busy ?? false)

  // The index may have changed since the list was drawn (an agent running
  // `git add .` in the terminal). Commit only what the user has seen.
  const commit = async (): Promise<boolean> => {
    if (working || !canCommit(message, staged.length, busy)) return false
    push?.clearMessage()
    const shown = staged.map((f) => f.path).sort().join('\n')
    setBusy(true)
    const lists = await load()
    if (!alive.current) return false
    setBusy(false)
    if (lists === null) return false
    const current = lists[0].map((f) => f.path).sort().join('\n')
    if (current !== shown) {
      setOutput('The staged files changed. Review the list and commit again.')
      return false
    }
    return run(() => ipc.git.commit(repoId, message), true)
  }

  // A failed commit (a hook, nothing staged) must not be followed by a push.
  const commitAndPush = async (): Promise<void> => {
    if (!push) return
    if (await commit()) await push.run()
  }

  // Claude's answer replaces the draft; what the user had typed stays one
  // click away, also after asking a second time.
  const generate = async (): Promise<void> => {
    if (working || staged.length === 0) return
    const seq = ++genSeq.current
    const before = message
    setGenerating(true)
    setOutput(null)
    let res: GitResult
    try {
      res = await ipc.git.generateCommitMessage(repoId)
    } catch (e) {
      res = { ok: false, output: String(e) }
    }
    if (!alive.current || seq !== genSeq.current) return
    setGenerating(false)
    if (!res.ok) {
      setOutput(res.output || 'Could not write a message')
      return
    }
    // Only text the user wrote is worth restoring, not an earlier answer.
    const typed = before.trim() !== '' && before !== lastAnswer.current
    setUndo((kept) => kept ?? (typed ? before : null))
    lastAnswer.current = res.output
    setDraft(repoId, res.output)
  }

  const cancelGenerate = (): void => {
    genSeq.current++
    setGenerating(false)
  }

  const commitLabel =
    staged.length > 0 ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Commit'
  const primary =
    'w-full rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50'
  const secondary =
    'w-full rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground/5 disabled:opacity-50'

  const open = (file: FileDiff, scope: DiffScope): void => show(projectId, repoId, file, scope)
  const activePathIn = (scope: DiffScope): string | null =>
    active?.repoId === repoId && active.scope === scope ? active.file.path : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 flex-col gap-1.5 px-3 pb-2">
        <textarea
          value={message}
          onChange={(e) => {
            setUndo(null)
            setDraft(repoId, e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void (buttons === 'commit-and-push' ? commitAndPush() : commit())
            }
          }}
          disabled={busy}
          readOnly={generating}
          rows={3}
          placeholder="Commit message"
          aria-label="Commit message"
          className="w-full resize-none rounded-md border border-border bg-field-background px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted focus:border-accent"
        />
        <div className="flex h-4 items-center justify-between text-[11px]">
          {generating ? (
            <>
              <span className="text-muted">Writing…</span>
              <button type="button" onClick={cancelGenerate} className="text-link hover:underline">
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void generate()}
                disabled={working || staged.length === 0}
                title="Sends the staged changes to Claude using your Claude Code login"
                className="text-link hover:underline disabled:text-muted disabled:no-underline"
              >
                Write message
              </button>
              {undo !== null && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(repoId, undo)
                    setUndo(null)
                  }}
                  className="text-link hover:underline"
                >
                  Undo
                </button>
              )}
            </>
          )}
        </div>
        {pushNote}
        {buttons === 'commit-and-push' && push && (
          <button
            type="button"
            onClick={() => void commitAndPush()}
            disabled={working || !canCommit(message, staged.length, busy)}
            className={primary}
          >
            {busy ? 'Committing…' : push.busy ? 'Pushing…' : `${commitLabel} & ${push.verb}`}
          </button>
        )}
        {buttons === 'push' && push && (
          <button type="button" onClick={() => void push.run()} disabled={working} className={primary}>
            {push.busy ? 'Pushing…' : push.label}
          </button>
        )}
        {(buttons === 'separate' || buttons === 'commit') && (
          <button
            type="button"
            onClick={() => void commit()}
            disabled={working || !canCommit(message, staged.length, busy)}
            className={secondary}
          >
            {busy ? 'Working…' : commitLabel}
          </button>
        )}
        {buttons === 'separate' && push && (
          <button type="button" onClick={() => void push.run()} disabled={working} className={primary}>
            {push.busy ? 'Pushing…' : push.label}
          </button>
        )}
        {output && (
          <div className="max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-warning">
            {output}
          </div>
        )}
        {pushMessage && (
          <div className="max-h-16 overflow-auto whitespace-pre-wrap text-[11px] text-muted">
            {pushMessage}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <FileList
          title="Staged"
          files={staged}
          scope="staged"
          emptyText="Nothing staged"
          allLabel="Unstage all"
          rowLabel="Unstage"
          rowGlyph="−"
          busy={busy || generating}
          activePath={activePathIn('staged')}
          onOpen={open}
          onRow={(f) => void run(() => ipc.git.unstage(repoId, pathsOf(f)))}
          onAll={() => void run(() => ipc.git.unstage(repoId, []))}
        />
        <FileList
          title="Changes"
          files={unstaged}
          scope="unstaged"
          emptyText={staged.length === 0 ? 'Working tree clean' : 'No other changes'}
          allLabel="Stage all"
          rowLabel="Stage"
          rowGlyph="+"
          busy={busy || generating}
          activePath={activePathIn('unstaged')}
          onOpen={open}
          onRow={(f) => void run(() => ipc.git.stage(repoId, pathsOf(f)))}
          onAll={() => void run(() => ipc.git.stage(repoId, []))}
        />
      </div>
    </div>
  )
}
