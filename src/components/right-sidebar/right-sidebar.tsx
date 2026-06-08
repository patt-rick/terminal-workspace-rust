import { useState } from 'react'
import { FileTree } from './file-tree'
import { GitPanel } from './git-panel'
import { GithubPanel } from './github-panel'
import { SessionsPanel } from './sessions-panel'
import { useWorkspace } from '../../state/store'

type Tab = 'files' | 'git' | 'github' | 'sessions'

export function RightSidebar({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<Tab>('files')
  // Panels are mounted on first visit and then kept mounted (hidden when
  // inactive) so switching tabs never re-runs their data fetch — that re-fetch
  // is what froze the app for projects with many files/sessions.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>(['files']))
  const width = useWorkspace((s) => s.rightSidebarWidth)

  const select = (t: Tab): void => {
    setTab(t)
    setVisited((v) => (v.has(t) ? v : new Set(v).add(t)))
  }

  return (
    <aside
      style={{ width }}
      className="flex flex-shrink-0 flex-col border-l border-border bg-surface"
    >
      <div className="flex h-11 flex-shrink-0 border-b border-border">
        <TabButton active={tab === 'files'} onClick={() => select('files')}>
          Files
        </TabButton>
        <TabButton active={tab === 'git'} onClick={() => select('git')}>
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
        {visited.has('files') && (
          <Panel active={tab === 'files'}>
            <FileTree projectId={projectId} />
          </Panel>
        )}
        {visited.has('git') && (
          <Panel active={tab === 'git'}>
            <GitPanel projectId={projectId} />
          </Panel>
        )}
        {visited.has('github') && (
          <Panel active={tab === 'github'}>
            <GithubPanel projectId={projectId} />
          </Panel>
        )}
        {visited.has('sessions') && (
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
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center text-xs font-medium ${
        active
          ? 'border-b-2 border-accent text-foreground'
          : 'text-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
