import { useCallback, useEffect, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { GithubAuth } from './github-auth'
import {
  ipc,
  type GithubSettings,
  type PullRequestSummary,
  type WorkflowRunSummary,
} from '../../lib/ipc'

type Section = 'prs' | 'actions'

export function GithubPanel({ projectId }: { projectId: string }) {
  const [settings, setSettings] = useState<GithubSettings | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ipc.github
      .getSettings()
      .then(setSettings)
      .catch(() => setSettings(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="px-3 py-3 text-xs text-muted">Loading…</div>
  if (!settings) return <div className="px-3 py-3 text-xs text-muted">GitHub unavailable</div>
  if (!settings.hasToken) return <GithubAuth settings={settings} onChange={setSettings} />

  return <Authed projectId={projectId} settings={settings} onChangeSettings={setSettings} />
}

function Authed({
  projectId,
  settings,
  onChangeSettings,
}: {
  projectId: string
  settings: GithubSettings
  onChangeSettings: (s: GithubSettings) => void
}) {
  const [section, setSection] = useState<Section>('prs')

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 flex-shrink-0 items-center gap-2 px-3 text-xs">
        <span className="truncate text-muted">@{settings.login ?? 'github'}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={async () => onChangeSettings(await ipc.github.signOut())}
          className="text-muted hover:text-foreground"
        >
          Sign out
        </button>
      </div>
      <div className="flex h-8 flex-shrink-0 border-b border-border px-2 text-xs">
        <SectionTab active={section === 'prs'} onClick={() => setSection('prs')}>
          Pull Requests
        </SectionTab>
        <SectionTab active={section === 'actions'} onClick={() => setSection('actions')}>
          Actions
        </SectionTab>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {section === 'prs' ? <PrList projectId={projectId} /> : <RunList projectId={projectId} />}
      </div>
    </div>
  )
}

function SectionTab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 font-medium ${
        active ? 'border-b-2 border-accent text-foreground' : 'text-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

const timeAgo = (iso: string): string => {
  const d = Date.parse(iso)
  if (Number.isNaN(d)) return ''
  const s = Math.floor((Date.now() - d) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function PrList({ projectId }: { projectId: string }) {
  const [prs, setPrs] = useState<PullRequestSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    ipc.github
      .listPullRequests(projectId, 'open')
      .then(setPrs)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(refresh, [refresh])

  if (loading) return <Hint>Loading pull requests…</Hint>
  if (error) return <Hint>{error}</Hint>
  if (prs.length === 0) return <Hint>No open pull requests</Hint>

  return (
    <div className="px-1 py-1">
      {prs.map((pr) => (
        <div
          key={pr.number}
          onClick={() => void openUrl(pr.url)}
          className="cursor-pointer rounded-md px-2 py-1.5 hover:bg-foreground/5"
        >
          <div className="flex items-center gap-1.5 text-sm">
            {pr.draft ? (
              <span className="text-muted">○</span>
            ) : (
              <span className="text-success">●</span>
            )}
            <span className="truncate text-foreground/90">{pr.title}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted">
            #{pr.number} · {pr.author} · {pr.headRef} → {pr.baseRef} · {timeAgo(pr.updatedAt)}
          </div>
        </div>
      ))}
    </div>
  )
}

const conclusionColor = (run: WorkflowRunSummary): string => {
  if (run.status !== 'completed') return 'text-warning'
  switch (run.conclusion) {
    case 'success':
      return 'text-success'
    case 'failure':
    case 'timed_out':
      return 'text-danger'
    case 'cancelled':
      return 'text-muted'
    default:
      return 'text-foreground/70'
  }
}

function RunList({ projectId }: { projectId: string }) {
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<number | null>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    ipc.github
      .listRuns(projectId)
      .then(setRuns)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [projectId])

  useEffect(refresh, [refresh])

  const act = async (runId: number, fn: () => Promise<void>): Promise<void> => {
    setActing(runId)
    try {
      await fn()
      refresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setActing(null)
    }
  }

  if (loading) return <Hint>Loading runs…</Hint>
  if (error) return <Hint>{error}</Hint>
  if (runs.length === 0) return <Hint>No workflow runs</Hint>

  return (
    <div className="px-1 py-1">
      {runs.map((run) => {
        const running = run.status !== 'completed'
        return (
          <div key={run.id} className="rounded-md px-2 py-1.5 hover:bg-foreground/5">
            <div className="flex items-center gap-1.5 text-sm">
              <span className={conclusionColor(run)}>●</span>
              <button
                type="button"
                onClick={() => void openUrl(run.url)}
                className="truncate text-left text-foreground/90 hover:underline"
              >
                {run.name ?? 'workflow'} #{run.runNumber}
              </button>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
              <span className="truncate">
                {run.branch ?? '—'} · {run.event} · {timeAgo(run.updatedAt)}
              </span>
              <div className="flex-1" />
              {running ? (
                <button
                  type="button"
                  disabled={acting === run.id}
                  onClick={() => void act(run.id, () => ipc.github.cancelRun(projectId, run.id))}
                  className="text-danger hover:underline disabled:opacity-50"
                >
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  disabled={acting === run.id}
                  onClick={() => void act(run.id, () => ipc.github.rerunRun(projectId, run.id))}
                  className="text-link hover:underline disabled:opacity-50"
                >
                  Re-run
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-3 text-xs text-muted">{children}</div>
}
