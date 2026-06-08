import { create } from 'zustand'
import { ipc, type Account, type IdentityConfig } from '../lib/ipc'

interface IdentityState {
  accounts: Account[]
  config: IdentityConfig
  loaded: boolean
  /** bumped after any apply so dependent views (the badge) refresh */
  appliedTick: number

  // UI flags (shared across the picker and badge)
  pickerProjectId: string | null
  pickerSuggestedId: string | null

  load: () => Promise<void>
  saveAccount: (account: Account) => Promise<void>
  removeAccount: (id: string) => Promise<void>
  /** Import accounts already logged in via the `gh` CLI; returns the new logins. */
  importGhAccounts: () => Promise<{ added: string[]; total: number }>
  setConfig: (config: IdentityConfig) => Promise<void>
  markApplied: () => void

  openPicker: (projectId: string, suggestedId?: string | null) => void
  closePicker: () => void
}

export const useIdentity = create<IdentityState>((set, get) => ({
  accounts: [],
  config: { defaultAccountId: null, unmappedBehavior: 'ask' },
  loaded: false,
  appliedTick: 0,
  pickerProjectId: null,
  pickerSuggestedId: null,

  load: async () => {
    const [accounts, config] = await Promise.all([
      ipc.identity.listAccounts(),
      ipc.identity.getConfig(),
    ])
    set({ accounts, config, loaded: true })
  },

  saveAccount: async (account) => {
    const accounts = await ipc.identity.saveAccount(account)
    set({ accounts })
  },

  removeAccount: async (id) => {
    const accounts = await ipc.identity.removeAccount(id)
    // Bump appliedTick so the git-panel badge re-resolves its label (the
    // removed account may have been the one a repo was mapped to).
    set((s) => ({ accounts, appliedTick: s.appliedTick + 1 }))
  },

  importGhAccounts: async () => {
    const detected = await ipc.identity.detectGhAccounts()
    const existing = new Set(get().accounts.map((a) => a.login.toLowerCase()))
    const toAdd = detected.filter((d) => !existing.has(d.login.toLowerCase()))
    for (const d of toAdd) {
      await get().saveAccount({
        id: crypto.randomUUID(),
        label: d.login,
        login: d.login,
        name: d.name?.trim() || d.login,
        email: d.email?.trim() || `${d.login}@users.noreply.github.com`,
      })
    }
    return { added: toAdd.map((d) => d.login), total: detected.length }
  },

  setConfig: async (config) => {
    const next = await ipc.identity.setConfig(config)
    set({ config: next })
  },

  markApplied: () => set((s) => ({ appliedTick: s.appliedTick + 1 })),

  openPicker: (projectId, suggestedId = null) =>
    set({ pickerProjectId: projectId, pickerSuggestedId: suggestedId }),
  closePicker: () => set({ pickerProjectId: null, pickerSuggestedId: null }),
}))
