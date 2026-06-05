import { useState } from 'react'
import { FileTree } from './file-tree'
import { GitPanel } from './git-panel'
import { GithubPanel } from './github-panel'
import { SessionsPanel } from './sessions-panel'
import { useWorkspace } from '../../state/store'

type Tab = 'files' | 'git' | 'github' | 'sessions'

export function RightSidebar({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<Tab>('files')
  const width = useWorkspace((s) => s.rightSidebarWidth)

  return (
    <aside
      style={{ width }}
      className="flex flex-shrink-0 flex-col border-l border-border bg-surface"
    >
      <div className="flex h-9 flex-shrink-0 border-b border-border">
        <TabButton active={tab === 'files'} onClick={() => setTab('files')}>
          Files
        </TabButton>
        <TabButton active={tab === 'git'} onClick={() => setTab('git')}>
          Git
        </TabButton>
        <TabButton active={tab === 'github'} onClick={() => setTab('github')}>
          GitHub
        </TabButton>
        <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')}>
          Sessions
        </TabButton>
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'files' && <FileTree projectId={projectId} />}
        {tab === 'git' && <GitPanel projectId={projectId} />}
        {tab === 'github' && <GithubPanel projectId={projectId} />}
        {tab === 'sessions' && <SessionsPanel projectId={projectId} />}
      </div>
    </aside>
  )
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
      className={`flex-1 text-xs font-medium ${
        active
          ? 'border-b-2 border-accent text-foreground'
          : 'text-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
