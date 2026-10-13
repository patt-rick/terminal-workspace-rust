import { useEffect, useState } from 'react'
import { FileTree } from './file-tree'
import { GitPanel } from './git-panel'
import { GithubPanel } from './github-panel'
import { SessionsPanel } from './sessions-panel'
import { useWorkspace, type RightTab } from '../../state/store'
import { projectHasDirtyRepo, useRepos } from '../../state/repos'

const TABS: { id: RightTab; label: string; icon: string }[] = [
  { id: 'files', label: 'Files', icon: 'M4 4h6l2 3h8v13H4z' },
  {
    id: 'git',
    label: 'Git',
    icon: 'M6 3v12M6 15a3 3 0 1 0 0 6a3 3 0 0 0 0-6M18 3a3 3 0 1 0 0 6a3 3 0 0 0 0-6M18 9c0 5-12 2-12 6',
  },
  { id: 'github', label: 'GitHub', icon: 'M6 8v8M4 4h4v4H4zM4 16h4v4H4zM16 16h4v4h-4zM18 16V9l-4-3' },
  { id: 'sessions', label: 'Sessions', icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18M12 7v5l3 2' },
]

export function RightSidebar({ projectId }: { projectId: string }) {
  // The tab lives in the store so the status bar can open the Git tab.
  const tab = useWorkspace((s) => s.rightTab)
  const select = useWorkspace((s) => s.setRightTab)
  const gitDirty = useRepos((s) => projectHasDirtyRepo(s.dirtyByProject, projectId))
  // Panels are mounted on first visit and then kept mounted (hidden when
  // inactive) so switching tabs never re-runs their data fetch — that re-fetch
  // is what froze the app for projects with many files/sessions.
  const [visited, setVisited] = useState<Set<RightTab>>(() => new Set<RightTab>([tab]))
  const width = useWorkspace((s) => s.rightSidebarWidth)

  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab)))
  }, [tab])

  return (
    <aside style={{ width }} className="panel flex flex-shrink-0 flex-col bg-surface">
      <div role="tablist" aria-label="Panel" className="flex h-10 flex-shrink-0 border-b border-border">
        {TABS.map((t) => (
          <TabButton
            key={t.id}
            label={t.label}
            icon={t.icon}
            active={tab === t.id}
            onClick={() => select(t.id)}
            badge={t.id === 'git' && gitDirty}
          />
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {(visited.has('files') || tab === 'files') && (
          <Panel active={tab === 'files'}>
            <FileTree projectId={projectId} />
          </Panel>
        )}
        {(visited.has('git') || tab === 'git') && (
          <Panel active={tab === 'git'}>
            <GitPanel projectId={projectId} />
          </Panel>
        )}
        {(visited.has('github') || tab === 'github') && (
          <Panel active={tab === 'github'}>
            <GithubPanel projectId={projectId} />
          </Panel>
        )}
        {(visited.has('sessions') || tab === 'sessions') && (
          <Panel active={tab === 'sessions'}>
            <SessionsPanel projectId={projectId} />
          </Panel>
        )}
      </div>
    </aside>
  )
}

function Panel({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div className={active ? 'h-full' : 'hidden'}>{children}</div>
}

function TabButton({
  label,
  icon,
  active,
  onClick,
  badge,
}: {
  label: string
  /** SVG path data, drawn as a 24px stroked icon */
  icon: string
  active: boolean
  onClick: () => void
  badge?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      aria-label={badge ? `${label}, uncommitted changes` : label}
      title={badge ? `${label} \u2014 uncommitted changes in one or more repos` : label}
      className={`relative flex flex-1 items-center justify-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${
        active
          ? 'text-foreground'
          : 'text-foreground/60 hover:text-foreground'
      }`}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={icon} />
      </svg>
      {badge && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning" />}
      {active && <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
    </button>
  )
}
