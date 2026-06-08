import { create } from 'zustand'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauri } from '../lib/ipc'

export interface UpdateInfo {
  /** version offered by the update manifest */
  version: string
  /** version currently running */
  currentVersion: string
  /** release notes (manifest `notes` / GitHub release body) */
  notes: string
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'upToDate'
  | 'downloading'
  | 'error'

interface UpdaterState {
  status: UpdateStatus
  info: UpdateInfo | null
  error: string | null
  /** download progress 0..1, or -1 when the total size is unknown */
  progress: number
  /** the plugin handle backing an available update; held so install() can run it */
  handle: Update | null
  /**
   * Query the update endpoint. `manual` distinguishes a user-initiated check
   * (which surfaces "up to date" / errors in the UI) from the silent launch
   * check (which stays quiet unless an update is actually found).
   */
  check: (manual?: boolean) => Promise<void>
  /** Download + install the available update, then relaunch into it. */
  install: () => Promise<void>
  dismiss: () => void
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: 'idle',
  info: null,
  error: null,
  progress: 0,
  handle: null,

  async check() {
    // The updater plugin needs the Tauri runtime; in a plain browser (vite dev)
    // there's nothing to update, so report "up to date" without calling in.
    if (!isTauri) {
      set({ status: 'upToDate', info: null, handle: null, error: null })
      return
    }
    set({ status: 'checking', info: null, handle: null, error: null })
    try {
      const update = await check()
      if (update) {
        set({
          status: 'available',
          handle: update,
          info: {
            version: update.version,
            currentVersion: update.currentVersion,
            notes: update.body ?? '',
          },
        })
      } else {
        set({ status: 'upToDate', handle: null, info: null })
      }
    } catch (err) {
      set({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  async install() {
    const update = get().handle
    if (!update) return
    set({ status: 'downloading', progress: 0, error: null })
    try {
      let total = 0
      let received = 0
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0
        } else if (event.event === 'Progress') {
          received += event.data.chunkLength
          set({ progress: total > 0 ? received / total : -1 })
        }
      })
      // On Windows the NSIS installer relaunches us; relaunch() covers macOS
      // (and is a harmless no-op when the installer already restarted).
      await relaunch()
    } catch (err) {
      set({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  dismiss() {
    set({ status: 'idle', info: null, error: null, handle: null, progress: 0 })
  },
}))
