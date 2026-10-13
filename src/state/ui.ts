import { create } from 'zustand'

/** Cross-component UI flags that don't belong to a feature store. */
interface UiState {
  settingsOpen: boolean
  settingsTab: string | null
  paletteOpen: boolean
  quickOpenOpen: boolean
  openSettings: (tab?: string) => void
  clearSettingsTab: () => void
  closeSettings: () => void
  toggleSettings: () => void
  togglePalette: () => void
  closePalette: () => void
  toggleQuickOpen: () => void
  closeQuickOpen: () => void
}

export const useUi = create<UiState>((set) => ({
  settingsOpen: false,
  settingsTab: null,
  paletteOpen: false,
  quickOpenOpen: false,
  openSettings: (tab?: string) => set({ settingsOpen: true, settingsTab: tab ?? null }),
  clearSettingsTab: () => set({ settingsTab: null }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen, quickOpenOpen: false })),
  closePalette: () => set({ paletteOpen: false }),
  toggleQuickOpen: () => set((s) => ({ quickOpenOpen: !s.quickOpenOpen, paletteOpen: false })),
  closeQuickOpen: () => set({ quickOpenOpen: false }),
}))
