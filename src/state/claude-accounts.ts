import { create } from 'zustand'
import {
  ipc,
  type ClaudeAccountMeta,
  type ClaudeAccountUsage,
} from '../lib/ipc'
import { useApiKeys } from './apikeys'

const POLL_INTERVAL_MS = 5 * 60 * 1000

let pollTimer: ReturnType<typeof setInterval> | null = null

interface ClaudeAccountsState {
  accounts: ClaudeAccountMeta[]
  activeAccountId: string | null
  /** by accountId */
  usage: Record<string, ClaudeAccountUsage>
  usageFetchedAt: number | null
  loaded: boolean
  /** login flow in flight (shows "waiting for browser…") */
  loggingIn: boolean
  /** switch/remove/import in flight (disables row actions) */
  busy: boolean
  error: string | null

  load: () => Promise<void>
  refreshUsage: (force?: boolean) => Promise<void>
  addViaOauth: (loginHint?: string) => Promise<void>
  cancelLogin: () => Promise<void>
  importCli: () => Promise<void>
  switchTo: (id: string) => Promise<void>
  switchToApiKey: (apiKeyId: string) => Promise<void>
  remove: (id: string) => Promise<void>
  clearError: () => void
  startPolling: () => void
  stopPolling: () => void
}

export const useClaudeAccounts = create<ClaudeAccountsState>((set, get) => ({
  accounts: [],
  activeAccountId: null,
  usage: {},
  usageFetchedAt: null,
  loaded: false,
  loggingIn: false,
  busy: false,
  error: null,

  load: async () => {
    const list = await ipc.claudeAccounts.list()
    set({ accounts: list.accounts, activeAccountId: list.activeAccountId, loaded: true })
  },

  refreshUsage: async (force = false) => {
    if (get().accounts.length === 0) return
    const entries = await ipc.claudeAccounts.usage(force)
    const usage: Record<string, ClaudeAccountUsage> = {}
    for (const e of entries) usage[e.accountId] = e
    set({ usage, usageFetchedAt: Date.now() })
    // refreshDead flags may have changed during token refresh
    await get().load()
  },

  addViaOauth: async (loginHint) => {
    set({ loggingIn: true, error: null })
    try {
      const list = await ipc.claudeAccounts.addViaOauth(loginHint)
      set({ accounts: list.accounts, activeAccountId: list.activeAccountId })
      // switching disables Anthropic provider keys — resync that store
      await useApiKeys.getState().load()
      await get().refreshUsage(true)
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ loggingIn: false })
    }
  },

  cancelLogin: async () => {
    await ipc.claudeAccounts.loginCancel()
  },

  importCli: async () => {
    set({ busy: true, error: null })
    try {
      const list = await ipc.claudeAccounts.importCli()
      set({ accounts: list.accounts, activeAccountId: list.activeAccountId })
      await get().refreshUsage(true)
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  switchTo: async (id) => {
    set({ busy: true, error: null })
    try {
      const list = await ipc.claudeAccounts.switchTo(id)
      set({ accounts: list.accounts, activeAccountId: list.activeAccountId })
      await useApiKeys.getState().load()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  switchToApiKey: async (apiKeyId) => {
    set({ busy: true, error: null })
    try {
      await ipc.claudeAccounts.switchToApiKey(apiKeyId)
      await useApiKeys.getState().load()
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ busy: false })
    }
  },

  remove: async (id) => {
    const list = await ipc.claudeAccounts.remove(id)
    set({ accounts: list.accounts, activeAccountId: list.activeAccountId })
  },

  clearError: () => set({ error: null }),

  startPolling: () => {
    if (pollTimer) return
    const tick = async () => {
      const s = get()
      if (!s.loaded) await s.load()
      await s.refreshUsage(false).catch(() => {})
    }
    void tick()
    pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS)
  },

  stopPolling: () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  },
}))
