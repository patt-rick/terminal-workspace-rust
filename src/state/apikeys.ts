import { create } from 'zustand'
import {
  ipc,
  type ApiKeyEntry,
  type ApiKeyMeta,
  type ApiKeyTestResult,
  type DetectedEnvKey,
} from '../lib/ipc'

interface ApiKeysState {
  keys: ApiKeyMeta[]
  loaded: boolean
  /** keys found in the environment, refreshed by detectEnv() */
  detected: DetectedEnvKey[]
  /** project the "Use other models" picker is open for; null = closed */
  launcherProjectId: string | null

  load: () => Promise<void>
  save: (entry: ApiKeyEntry, secret: string | null) => Promise<void>
  remove: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  test: (id: string) => Promise<ApiKeyTestResult>
  detectEnv: () => Promise<void>
  importEnv: (envVar: string, provider: string, label: string, launchCommand: string | null) => Promise<void>
  openLauncher: (projectId: string) => void
  closeLauncher: () => void
}

export const useApiKeys = create<ApiKeysState>((set) => ({
  keys: [],
  loaded: false,
  detected: [],
  launcherProjectId: null,

  load: async () => {
    const keys = await ipc.apikeys.list()
    set({ keys, loaded: true })
  },

  save: async (entry, secret) => {
    const keys = await ipc.apikeys.save(entry, secret)
    set({ keys })
  },

  remove: async (id) => {
    const keys = await ipc.apikeys.remove(id)
    set({ keys })
  },

  setEnabled: async (id, enabled) => {
    const keys = await ipc.apikeys.setEnabled(id, enabled)
    set({ keys })
  },

  test: (id) => ipc.apikeys.test(id),

  detectEnv: async () => {
    const detected = await ipc.apikeys.detectEnv()
    set({ detected })
  },

  importEnv: async (envVar, provider, label, launchCommand) => {
    const keys = await ipc.apikeys.importEnv(envVar, provider, label, launchCommand)
    // The imported var is stored now, so it drops out of the candidates.
    const detected = await ipc.apikeys.detectEnv()
    set({ keys, detected })
  },

  openLauncher: (projectId) => set({ launcherProjectId: projectId }),
  closeLauncher: () => set({ launcherProjectId: null }),
}))
