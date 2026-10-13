import { create } from 'zustand'
import { ipc, type UsageScanResult, type UsageSummary } from '../lib/ipc'
import {
  buildBoundaries,
  type UsageDimension,
  type UsageMetric,
  type UsagePeriod,
} from '../lib/usage'

export type UsageView = UsageMetric | 'limits'

let requestSeq = 0

interface UsageState {
  open: boolean
  view: UsageView
  period: UsagePeriod
  dimension: UsageDimension
  /** breakdown row the chart and totals are filtered to */
  filterKey: string | null
  boundaries: number[]
  /** the period `boundaries` and `summary` were built for; lags `period` while loading */
  loadedPeriod: UsagePeriod
  summary: UsageSummary | null
  scan: UsageScanResult | null
  loading: boolean
  progress: { done: number; total: number } | null
  error: string | null

  openPage: () => void
  closePage: () => void
  togglePage: () => void
  setView: (view: UsageView) => void
  setPeriod: (period: UsagePeriod) => void
  setDimension: (dimension: UsageDimension) => void
  toggleFilter: (key: string) => void
  setProgress: (progress: { done: number; total: number }) => void
  /** `scan` re-reads transcripts first; a period change only re-aggregates. */
  load: (scan: boolean) => Promise<void>
  refresh: () => Promise<void>
}

export const useUsage = create<UsageState>((set, get) => ({
  open: false,
  view: 'cost',
  period: '7d',
  dimension: 'model',
  filterKey: null,
  boundaries: [],
  loadedPeriod: '7d',
  summary: null,
  scan: null,
  loading: false,
  progress: null,
  error: null,

  openPage: () => {
    if (get().open) return
    set({ open: true })
    void get().load(true)
    void ipc.usage
      .refreshPrices(false)
      .then((changed) => {
        if (changed && get().open) void get().load(false)
      })
      .catch(() => {})
  },

  closePage: () => set({ open: false }),

  togglePage: () => (get().open ? get().closePage() : get().openPage()),

  setView: (view) => set({ view }),

  setPeriod: (period) => {
    set({ period })
    void get().load(false)
  },

  setDimension: (dimension) => set({ dimension, filterKey: null }),

  toggleFilter: (key) => set((s) => ({ filterKey: s.filterKey === key ? null : key })),

  setProgress: (progress) => set({ progress }),

  load: async (scan) => {
    let seq = ++requestSeq
    set({ loading: true, error: null })
    try {
      if (scan) {
        // A scan result is always kept, and always followed by a summary, even
        // if another request started meanwhile: that request may have read the
        // ledger before this scan filled it.
        const result = await ipc.usage.scan()
        set({ scan: result })
        seq = ++requestSeq
      }
      const period = get().period
      const boundaries = buildBoundaries(period, new Date())
      const summary = await ipc.usage.summary(boundaries)
      if (seq !== requestSeq) return
      set({ boundaries, summary, loadedPeriod: period })
    } catch (e) {
      if (seq === requestSeq) set({ error: String(e) })
    } finally {
      if (seq === requestSeq) set({ loading: false, progress: null })
    }
  },

  refresh: async () => {
    await get().load(true)
    const changed = await ipc.usage.refreshPrices(true).catch(() => false)
    if (changed) await get().load(false)
  },
}))
