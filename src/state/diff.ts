import { create } from 'zustand'
import type { FileDiff } from '../lib/ipc'

export type DiffScope = 'staged' | 'unstaged'

interface DiffViewState {
  active: { projectId: string; repoId: string; file: FileDiff; scope: DiffScope } | null
  show: (projectId: string, repoId: string, file: FileDiff, scope: DiffScope) => void
  close: () => void
}

/** The diff currently shown in the center pane (if any). */
export const useDiffView = create<DiffViewState>((set) => ({
  active: null,
  show: (projectId, repoId, file, scope) => set({ active: { projectId, repoId, file, scope } }),
  close: () => set({ active: null }),
}))
