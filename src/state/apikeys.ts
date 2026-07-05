import { create } from 'zustand'
import {
  ipc,
  type ApiKeyEntry,
  type ApiKeyMeta,
  type ApiKeyTestResult,
  type DetectedEnvKey,
} from '../lib/ipc'
import { binaryFromCommand, presetById, withInstall } from '../lib/apikey-presets'
import { applyClaudeSkipPermissions, linkClaudeSession } from './claude-command'
import { useSettings } from './settings'
import { createProjectTerminal, useWorkspace } from './store'

interface ApiKeysState {
  keys: ApiKeyMeta[]
  loaded: boolean
  /** keys found in the environment, refreshed by detectEnv() */
  detected: DetectedEnvKey[]
  /** project the "Use other models" picker is open for; null = closed */
  launcherProjectId: string | null
  /** launch blocked on a missing CLI, awaiting the user's install decision */
  pendingInstall: {
    projectId: string
    entry: ApiKeyMeta
    binary: string
    installCommand: string
  } | null

  load: () => Promise<void>
  save: (entry: ApiKeyEntry, secret: string | null) => Promise<void>
  remove: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  test: (id: string) => Promise<ApiKeyTestResult>
  detectEnv: () => Promise<void>
  importEnv: (envVar: string, provider: string, label: string, launchCommand: string | null) => Promise<void>
  openLauncher: (projectId: string) => void
  closeLauncher: () => void

  /**
   * Launch an entry's CLI in a new terminal. When the binary is missing and
   * the preset knows an installer, opens the install prompt instead.
   */
  requestLaunch: (projectId: string, entry: ApiKeyMeta) => Promise<void>
  confirmInstall: () => Promise<void>
  cancelInstall: () => void
}

export const useApiKeys = create<ApiKeysState>((set, get) => ({
  keys: [],
  loaded: false,
  detected: [],
  launcherProjectId: null,
  pendingInstall: null,

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

  requestLaunch: async (projectId, entry) => {
    if (!entry.launchCommand) return
    const preset = presetById(entry.provider)
    const binary = binaryFromCommand(entry.launchCommand)
    if (
      binary &&
      preset?.installCommand &&
      binary === preset.binaryName &&
      !(await ipc.apikeys.binaryExists(binary))
    ) {
      set({
        pendingInstall: { projectId, entry, binary, installCommand: preset.installCommand },
      })
      return
    }
    await launchTerminal(projectId, entry.label, entry.launchCommand)
  },

  confirmInstall: async () => {
    const p = get().pendingInstall
    if (!p?.entry.launchCommand) return
    set({ pendingInstall: null })
    // The Claude command transforms only match commands starting with `claude`,
    // so they must run on the launch half before the install command is chained
    // in front — createProjectTerminal's own pass no-ops on the chained string.
    const flagged = applyClaudeSkipPermissions(
      p.entry.launchCommand,
      useSettings.getState().terminal.claudeSkipPermissions
    )
    const linked = linkClaudeSession(flagged)
    await launchTerminal(
      p.projectId,
      p.entry.label,
      withInstall(p.installCommand, linked.startupCommand),
      linked.sessionId
    )
  },

  cancelInstall: () => set({ pendingInstall: null }),
}))

async function launchTerminal(
  projectId: string,
  name: string,
  startupCommand: string,
  claudeSessionId?: string
): Promise<void> {
  useWorkspace.getState().setProjectExpanded(projectId, true)
  await createProjectTerminal(projectId, { name, startupCommand, claudeSessionId })
}
