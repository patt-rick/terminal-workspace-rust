import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ipc, type CurrentIdentity, type FileDiff, type GitInfo, type PreflightResult, type RepoInfo } from '../../lib/ipc'
import { useDiffView } from '../../state/diff'
import { useIdentity } from '../../state/identity'
import { useRepos } from '../../state/repos'
import { useSettings } from '../../state/settings'

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/** Picker label: the relative path, or the repo name for a root-level repo. */
const repoLabel = (r: RepoInfo): string => r.relativePath || r.name

const accountLabel = (
  identity: CurrentIdentity | null,
  accounts: { id: string; label: string }[]
): string => {
  const id = identity?.accountId
  const matched = id ? accounts.find((a) => a.id === id) : undefined
  if (matched) return matched.label
  if (identity?.remoteLogin) return identity.remoteLogin
  return 'Set account'
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

function RepoPicker({
  repos,
  selectedId,
  dirty,
  onSelect,
}: {
  repos: RepoInfo[]
  selectedId: string | null
  dirty: Record<string, boolean>
  onSelect: (repoId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = repos.find((r) => r.id === selectedId) ?? null

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // One repo: a static label, preserving the original single-repo appearance.
  if (repos.length <= 1) {
    if (!selected) return null
    return (
      <div className="flex items-center gap-1.5 px-3 pb-1 text-[11px] text-muted">
        <span className="truncate">{repoLabel(selected)}</span>
        {dirty[selected.id] && <span className="text-warning">●</span>}
      </div>
    )
  }

  return (
    <div ref={ref} className="relative px-3 pb-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-foreground/80 hover:bg-foreground/5"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{selected ? repoLabel(selected) : 'Select repo'}</span>
          {selected?.isSubmodule && <span className="text-[9px] text-link">sub</span>}
          {selected && dirty[selected.id] && <span className="text-warning">●</span>}
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-3 right-3 z-20 mt-1 max-h-60 overflow-auto rounded-md border border-border bg-surface py-1 shadow-xl">
          {repos.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                onSelect(r.id)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-foreground/5 ${
                r.id === selectedId ? 'text-foreground' : 'text-foreground/70'
              }`}
              style={r.isSubmodule ? { paddingLeft: '1.25rem' } : undefined}
            >
              <span className="truncate">{repoLabel(r)}</span>
              {r.isSubmodule && <span className="text-[9px] text-link">sub</span>}
              {dirty[r.id] && <span className="ml-auto text-warning">●</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function GitPanel({ projectId }: { projectId: string }) {
  const discovered = useRepos((s) => s.reposByProject[projectId])
  const repos = discovered ?? EMPTY_REPOS
  const selectedId = useRepos((s) => s.selectedByProject[projectId] ?? null)
  const dirty = useRepos((s) => s.dirtyByProject[projectId] ?? EMPTY_DIRTY)
  const loadRepos = useRepos((s) => s.load)
  const selectRepo = useRepos((s) => s.select)
  const refreshDirty = useRepos((s) => s.refreshDirty)

  const [info, setInfo] = useState<GitInfo | null>(null)
  const [diffs, setDiffs] = useState<FileDiff[]>([])
  const [loading, setLoading] = useState(true)
  const [pushing, setPushing] = useState(false)
  const [pushMsg, setPushMsg] = useState<string | null>(null)
  const [identity, setIdentity] = useState<CurrentIdentity | null>(null)
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const alignGhOnSelect = useSettings((s) => s.identity.alignGhOnSelect)
  const accounts = useIdentity((s) => s.accounts)
  const appliedTick = useIdentity((s) => s.appliedTick)
  const openPicker = useIdentity((s) => s.openPicker)
  const show = useDiffView((s) => s.show)
  const active = useDiffView((s) => s.active)
  const closeDiff = useDiffView((s) => s.close)

  const selectedRepo = useMemo(
    () => repos.find((r) => r.id === selectedId) ?? null,
    [repos, selectedId]
  )

  const mappedAccount = identity?.accountId
    ? accounts.find((a) => a.id === identity.accountId)
    : undefined
  const pushLogin = identity?.remoteLogin ?? mappedAccount?.login ?? null
  const routingSkipped = !!identity?.accountId && !identity?.remoteLogin
  const preflightBad = !!preflight && !preflight.ok

  // Discover repos (cached) whenever the project changes.
  useEffect(() => {
    void loadRepos(projectId)
  }, [projectId, loadRepos])

  const refresh = useCallback(() => {
    if (!selectedId) {
      setInfo(null)
      setDiffs([])
      setLoading(false)
      return
    }
    setLoading(true)
    Promise.all([
      ipc.git.info(selectedId).catch(() => null),
      ipc.git.diff(selectedId).catch(() => [] as FileDiff[]),
    ])
      .then(([i, d]) => {
        setInfo(i)
        setDiffs(d)
      })
      .finally(() => setLoading(false))
    ipc.identity.current(selectedId).then(setIdentity).catch(() => setIdentity(null))
    ipc.identity.pushPreflight(selectedId).then(setPreflight).catch(() => setPreflight(null))
    void refreshDirty(projectId)
  }, [selectedId, projectId, refreshDirty])

  useEffect(refresh, [refresh])

  // Refresh the badge when an account is applied elsewhere (picker / auto-apply).
  useEffect(() => {
    if (!selectedId) return
    ipc.identity.current(selectedId).then(setIdentity).catch(() => setIdentity(null))
    ipc.identity.pushPreflight(selectedId).then(setPreflight).catch(() => setPreflight(null))
  }, [selectedId, appliedTick])

  // Opt-in: keep the gh CLI's active account aligned with the selected repo.
  useEffect(() => {
    if (!alignGhOnSelect || !pushLogin) return
    ipc.identity.alignGh(pushLogin).catch(() => {})
  }, [alignGhOnSelect, pushLogin, selectedId])

  const onSelectRepo = (repoId: string): void => {
    if (repoId === selectedId) return
    // The diff viewer shows one repo at a time — drop a diff from another repo.
    if (active && active.repoId !== repoId) closeDiff()
    selectRepo(projectId, repoId)
  }

  const onPush = async (): Promise<void> => {
    if (!info?.branch || !selectedId) return
    setPushing(true)
    setPushMsg(null)
    try {
      const pf = await ipc.identity.pushPreflight(selectedId).catch(() => null)
      setPreflight(pf)
      const warn = pf && !pf.ok ? `${pf.reason ?? 'Credential preflight failed'}\n` : ''
      const res = await ipc.git.push(selectedId, info.branch)
      setPushMsg(warn + (res.ok ? 'Pushed.' : res.output || 'Push failed'))
      if (res.ok) refresh()
    } catch (e) {
      setPushMsg(String(e))
    } finally {
      setPushing(false)
    }
  }

  // Repos not discovered yet for this project — avoid flashing the empty state.
  if (!discovered) {
    return <div className="px-3 py-3 text-xs text-muted">Loading…</div>
  }

  if (repos.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
        <div className="text-xs text-muted">No repository here.</div>
        <div className="text-[11px] text-muted/70">
          Nested repos are detected automatically — add a folder containing git repos.
        </div>
        <button
          type="button"
          onClick={() => void loadRepos(projectId, true)}
          className="mt-1 rounded border border-border px-2 py-0.5 text-[11px] text-foreground/70 hover:bg-foreground/5"
        >
          Rescan
        </button>
      </div>
    )
  }

  const picker = (
    <RepoPicker repos={repos} selectedId={selectedId} dirty={dirty} onSelect={onSelectRepo} />
  )

  if (loading && !info) {
    return (
      <div className="flex h-full flex-col">
        {picker}
        <div className="px-3 py-3 text-xs text-muted">Loading…</div>
      </div>
    )
  }
  if (!info?.isRepo) {
    return (
      <div className="flex h-full flex-col">
        {picker}
        <div className="px-3 py-3 text-xs text-muted">Not a git repository</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {picker}
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
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              selectedRepo &&
              openPicker([
                {
                  repoId: selectedRepo.id,
                  label: repoLabel(selectedRepo),
                  suggestedId: identity?.accountId ?? null,
                },
              ])
            }
            title="Switch GitHub account for this repo"
            className="max-w-[8rem] truncate rounded border border-border px-1.5 py-0.5 text-[11px] text-foreground/70 hover:bg-foreground/5"
          >
            {accountLabel(identity, accounts)}
          </button>
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
      </div>

      {pushLogin && (
        <div
          className={`px-3 pb-1 text-[11px] ${
            preflightBad || routingSkipped ? 'text-warning' : 'text-muted'
          }`}
        >
          {preflightBad
            ? preflight?.reason
            : routingSkipped
            ? `Author only — ${pushLogin} not routed (non-HTTPS remote)`
            : `Pushing as ${pushLogin}`}
        </div>
      )}

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
            const isActive = active?.repoId === selectedId && active?.file.path === f.path
            return (
              <div
                key={f.path}
                onClick={() => selectedId && show(projectId, selectedId, f)}
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

// Stable empty references so selector-derived defaults don't re-render forever.
const EMPTY_REPOS: RepoInfo[] = []
const EMPTY_DIRTY: Record<string, boolean> = {}
