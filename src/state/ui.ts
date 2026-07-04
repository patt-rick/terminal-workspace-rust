import { create } from 'zustand'

/** Cross-component UI flags that don't belong to a feature store. */
interface UiState {
  settingsOpen: boolean
  settingsTab: string | null
  openSettings: (tab?: string) => void
  clearSettingsTab: () => void
  closeSettings: () => void
  toggleSettings: () => void
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  settingsTab: null,
  openSettings: (tab?: string) => set({ settingsOpen: true, settingsTab: tab ?? null }),
  clearSettingsTab: () => set({ settingsTab: null }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
}))
