import { create } from 'zustand'
import type { FileDiff } from '../lib/ipc'

interface DiffViewState {
  active: { projectId: string; repoId: string; file: FileDiff } | null
  show: (projectId: string, repoId: string, file: FileDiff) => void
  close: () => void
}

/** The working-tree diff currently shown in the center pane (if any). */
export const useDiffView = create<DiffViewState>((set) => ({
  active: null,
  show: (projectId, repoId, file) => set({ active: { projectId, repoId, file } }),
  close: () => set({ active: null }),
}))
