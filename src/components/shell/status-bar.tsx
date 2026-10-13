import { useEffect, useRef } from 'react'
import { keepFocus } from '../../lib/keep-focus'
import { statusItems, type StatusItem } from '../../lib/status-bar'
import { useApiKeys } from '../../state/apikeys'
import { useClaudeAccounts } from '../../state/claude-accounts'
import { useGitStatus } from '../../state/git-status'
import { useRepos } from '../../state/repos'
import { useWorkspace } from '../../state/store'
import { useUsage } from '../../state/usage'

/**
 * The strip along the bottom: branch and changes of the selected repo, what is
 * left of the 5-hour limit, and the terminal count. It adds no timer; the git
 * figures reload when the repo changes, when the window regains focus and when
 * a terminal of the project stops working (an agent's turn just ended).
 */
export function StatusBar() {
  const project = useWorkspace((s) => s.projects.find((p) => p.id === s.selectedProjectId) ?? null)
  const busyByTerminal = useWorkspace((s) => s.busyByTerminal)
  const projectId = project?.id ?? null
  const reposLoaded = useRepos((s) => (projectId ? s.reposByProject[projectId] !== undefined : true))
  const repoId = useRepos((s) => (projectId ? (s.selectedByProject[projectId] ?? null) : null))
  const loadRepos = useRepos((s) => s.load)
  const info = useGitStatus((s) => (repoId ? (s.infoByRepo[repoId] ?? null) : null))
  const refresh = useGitStatus((s) => s.refresh)
  const activeAccountId = useClaudeAccounts((s) => s.activeAccountId)
  const usage = useClaudeAccounts((s) => s.usage)
  const apiKeyActive = useApiKeys((s) =>
    s.keys.some((k) => k.provider === 'anthropic' && k.enabled && k.hasValue)
  )

  useEffect(() => {
    if (projectId && !reposLoaded) void loadRepos(projectId)
  }, [projectId, reposLoaded, loadRepos])

  useEffect(() => {
    if (!repoId) return
    void refresh(repoId)
    const onFocus = (): void => void refresh(repoId)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [repoId, refresh])

  const busyCount = project ? project.terminals.filter((t) => busyByTerminal[t.id]).length : 0
  const lastBusy = useRef(busyCount)
  useEffect(() => {
    if (repoId && busyCount < lastBusy.current) void refresh(repoId)
    lastBusy.current = busyCount
  }, [busyCount, repoId, refresh])

  const fiveHour =
    !apiKeyActive && activeAccountId
      ? (usage[activeAccountId]?.usage?.fiveHour?.utilization ?? null)
      : null
  const items = statusItems({
    hasProject: project !== null,
    info,
    fiveHourUtilization: fiveHour,
    terminalCount: project?.terminals.length ?? 0,
  })
  const left = items.filter((i) => i.action === 'git')
  const right = items.filter((i) => i.action !== 'git')

  return (
    <footer className="flex h-6 flex-shrink-0 items-center gap-1 px-2 text-[11px] text-foreground/70">
      {left.map((item) => (
        <Item key={item.id} item={item} />
      ))}
      <div className="flex-1" />
      {right.map((item) => (
        <Item key={item.id} item={item} />
      ))}
    </footer>
  )
}

function Item({ item }: { item: StatusItem }) {
  const content = (
    <>
      {item.id === 'branch' && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0" aria-hidden>
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      )}
      <span className="truncate">{item.text}</span>
    </>
  )
  if (item.action === null) {
    return <span className="flex h-6 min-w-0 items-center gap-1.5 px-1.5">{content}</span>
  }
  const action = item.action
  return (
    <button
      type="button"
      {...keepFocus}
      onClick={() => {
        if (action === 'git') useWorkspace.getState().openRightTab('git')
        else useUsage.getState().openPage()
      }}
      title={action === 'git' ? 'Open the Git tab' : 'Open the Usage page'}
      className="flex h-6 min-w-0 items-center gap-1.5 rounded px-1.5 hover:bg-foreground/10 hover:text-foreground"
    >
      {content}
    </button>
  )
}
