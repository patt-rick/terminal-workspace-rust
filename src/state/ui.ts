import { create } from 'zustand'
import { useWorkspace } from './store'
import { useUsage } from './usage'

/** Cross-component UI flags that don't belong to a feature store. */
interface UiState {
  settingsOpen: boolean
  settingsTab: string | null
  paletteOpen: boolean
  quickOpenOpen: boolean
  /** the project whose row is being renamed inline */
  renamingProjectId: string | null
  /** the project whose icon dialog is open */
  iconDialogProjectId: string | null
  openSettings: (tab?: string) => void
  clearSettingsTab: () => void
  closeSettings: () => void
  toggleSettings: () => void
  togglePalette: () => void
  closePalette: () => void
  toggleQuickOpen: () => void
  closeQuickOpen: () => void
  /** Starts the inline rename, opening the left nav first: the rail has no name to edit. */
  requestRename: (projectId: string) => void
  clearRename: () => void
  openIconDialog: (projectId: string) => void
  closeIconDialog: () => void
}

export const useUi = create<UiState>((set, get) => ({
  settingsOpen: false,
  settingsTab: null,
  paletteOpen: false,
  quickOpenOpen: false,
  renamingProjectId: null,
  iconDialogProjectId: null,
  // The Usage page shares the centre with Settings, so opening one closes the other.
  openSettings: (tab?: string) => {
    useUsage.getState().closePage()
    set({ settingsOpen: true, settingsTab: tab ?? null })
  },
  clearSettingsTab: () => set({ settingsTab: null }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => {
    if (!get().settingsOpen) useUsage.getState().closePage()
    set((s) => ({ settingsOpen: !s.settingsOpen }))
  },
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen, quickOpenOpen: false })),
  closePalette: () => set({ paletteOpen: false }),
  toggleQuickOpen: () => set((s) => ({ quickOpenOpen: !s.quickOpenOpen, paletteOpen: false })),
  closeQuickOpen: () => set({ quickOpenOpen: false }),
  requestRename: (projectId) => {
    const ws = useWorkspace.getState()
    if (ws.sidebarCollapsed) ws.setSidebarCollapsed(false)
    set({ renamingProjectId: projectId })
  },
  clearRename: () => set({ renamingProjectId: null }),
  openIconDialog: (projectId) => set({ iconDialogProjectId: projectId }),
  closeIconDialog: () => set({ iconDialogProjectId: null }),
}))
