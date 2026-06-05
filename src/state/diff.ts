import { create } from 'zustand'
import type { FileDiff } from '../lib/ipc'

interface DiffViewState {
  active: { projectId: string; file: FileDiff } | null
  show: (projectId: string, file: FileDiff) => void
  close: () => void
}

/** The working-tree diff currently shown in the center pane (if any). */
export const useDiffView = create<DiffViewState>((set) => ({
  active: null,
  show: (projectId, file) => set({ active: { projectId, file } }),
  close: () => set({ active: null }),
}))
