import { useEffect, useState } from 'react'
import { FileTree } from './file-tree'
import { GitPanel } from './git-panel'
import { GithubPanel } from './github-panel'
import { SessionsPanel } from './sessions-panel'
import { useWorkspace, type RightTab } from '../../state/store'
import { projectHasDirtyRepo, useRepos } from '../../state/repos'

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
      <div
        role="tablist"
        aria-label="Panel"
        className="mx-2 my-1.5 flex flex-shrink-0 rounded-lg p-0.5"
        style={{ background: 'var(--shell-backdrop)' }}
      >
        <TabButton active={tab === 'files'} onClick={() => select('files')}>
          Files
        </TabButton>
        <TabButton active={tab === 'git'} onClick={() => select('git')} badge={gitDirty}>
          Git
        </TabButton>
        <TabButton active={tab === 'github'} onClick={() => select('github')}>
          GitHub
        </TabButton>
        <TabButton active={tab === 'sessions'} onClick={() => select('sessions')}>
          Sessions
        </TabButton>
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
  active,
  onClick,
  children,
  badge,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  badge?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={`relative flex h-6 flex-1 items-center justify-center gap-1 rounded-md border text-xs font-medium ${
        active
          ? 'border-[var(--panel-outline)] bg-surface text-foreground shadow-sm'
          : 'border-transparent text-foreground/70 hover:text-foreground'
      }`}
    >
      {children}
      {badge && (
        <span
          title="Uncommitted changes in one or more repos"
          className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning"
        />
      )}
    </button>
  )
}
