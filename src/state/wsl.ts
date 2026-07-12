import { create } from 'zustand'
import { ipc, isTauri, type WslDistro } from '../lib/ipc'
import { isWindows } from '../lib/platform'

interface WslState {
  distros: WslDistro[]
  loaded: boolean
  /** Fetch once per app run; no-op off-Windows or outside Tauri. */
  load: () => Promise<void>
}

export const useWsl = create<WslState>((set, get) => ({
  distros: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return
    if (!isTauri || !isWindows) {
      set({ loaded: true })
      return
    }
    try {
      const distros = await ipc.wsl.listDistros()
      set({ distros, loaded: true })
    } catch {
      set({ distros: [], loaded: true })
    }
  },
}))
