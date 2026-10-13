import { create } from 'zustand'
import { ipc } from '../lib/ipc'

/** Uploaded project icons, as `data:` URLs the tiles can show. */
interface ProjectIconsState {
  urls: Record<string, string>
  load: () => Promise<void>
  set: (projectId: string, url: string) => void
  remove: (projectId: string) => void
}

export const useProjectIcons = create<ProjectIconsState>((set) => ({
  urls: {},
  load: async () => {
    const urls = await ipc.projects.loadIcons().catch(() => ({}) as Record<string, string>)
    // Keep anything set while the load was in flight.
    set((s) => ({ urls: { ...urls, ...s.urls } }))
  },
  set: (projectId, url) => set((s) => ({ urls: { ...s.urls, [projectId]: url } })),
  remove: (projectId) =>
    set((s) => {
      const { [projectId]: _gone, ...rest } = s.urls
      return { urls: rest }
    }),
}))
