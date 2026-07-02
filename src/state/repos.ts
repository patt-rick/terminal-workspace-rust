import { create } from 'zustand'
import { ipc, type RepoInfo } from '../lib/ipc'

interface ReposState {
  reposByProject: Record<string, RepoInfo[]>
  selectedByProject: Record<string, string | null>
  /** repo_id -> dirty, per project. Powers the picker dots + Git-tab badge. */
  dirtyByProject: Record<string, Record<string, boolean>>

  /**
   * Discover (cached unless `refresh`) the repos for a project and load the
   * persisted selection, then refresh dirty flags in the background. Returns the
   * repo list so callers (identity auto-apply) can act on it.
   */
  load: (projectId: string, refresh?: boolean) => Promise<RepoInfo[]>
  select: (projectId: string, repoId: string) => void
  refreshDirty: (projectId: string) => Promise<void>
}

export const useRepos = create<ReposState>((set, get) => ({
  reposByProject: {},
  selectedByProject: {},
  dirtyByProject: {},

  load: async (projectId, refresh = false) => {
    const repos = await ipc.git.discoverRepos(projectId, refresh).catch(() => [] as RepoInfo[])
    const selected = await ipc.git.selectedRepo(projectId).catch(() => null)
    set((s) => ({
      reposByProject: { ...s.reposByProject, [projectId]: repos },
      selectedByProject: {
        ...s.selectedByProject,
        [projectId]: selected ?? repos[0]?.id ?? null,
      },
    }))
    void get().refreshDirty(projectId)
    return repos
  },

  select: (projectId, repoId) => {
    set((s) => ({
      selectedByProject: { ...s.selectedByProject, [projectId]: repoId },
    }))
    void ipc.git.setSelectedRepo(projectId, repoId).catch(() => {})
  },

  refreshDirty: async (projectId) => {
    const flags = await ipc.git.dirtyFlags(projectId).catch(() => ({}) as Record<string, boolean>)
    set((s) => ({ dirtyByProject: { ...s.dirtyByProject, [projectId]: flags } }))
  },
}))

/** True if any discovered repo in the project has a dirty working tree. */
export function projectHasDirtyRepo(
  dirtyByProject: Record<string, Record<string, boolean>>,
  projectId: string
): boolean {
  const flags = dirtyByProject[projectId]
  return flags ? Object.values(flags).some(Boolean) : false
}
