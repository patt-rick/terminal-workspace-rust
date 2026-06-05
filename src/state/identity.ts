import { create } from 'zustand'
import { ipc, type Account, type IdentityConfig } from '../lib/ipc'

interface IdentityState {
  accounts: Account[]
  config: IdentityConfig
  loaded: boolean
  /** bumped after any apply so dependent views (the badge) refresh */
  appliedTick: number

  // UI flags (shared across the picker, badge, and modal)
  accountsModalOpen: boolean
  pickerProjectId: string | null
  pickerSuggestedId: string | null

  load: () => Promise<void>
  saveAccount: (account: Account) => Promise<void>
  removeAccount: (id: string) => Promise<void>
  setConfig: (config: IdentityConfig) => Promise<void>
  markApplied: () => void

  openAccountsModal: () => void
  closeAccountsModal: () => void
  openPicker: (projectId: string, suggestedId?: string | null) => void
  closePicker: () => void
}

export const useIdentity = create<IdentityState>((set) => ({
  accounts: [],
  config: { defaultAccountId: null, unmappedBehavior: 'ask' },
  loaded: false,
  appliedTick: 0,
  accountsModalOpen: false,
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
    set({ accounts })
  },

  setConfig: async (config) => {
    const next = await ipc.identity.setConfig(config)
    set({ config: next })
  },

  markApplied: () => set((s) => ({ appliedTick: s.appliedTick + 1 })),

  openAccountsModal: () => set({ accountsModalOpen: true }),
  closeAccountsModal: () => set({ accountsModalOpen: false }),
  openPicker: (projectId, suggestedId = null) =>
    set({ pickerProjectId: projectId, pickerSuggestedId: suggestedId }),
  closePicker: () => set({ pickerProjectId: null, pickerSuggestedId: null }),
}))
