import { useEffect, useState } from 'react'
import { isTauri } from '../lib/ipc'
import { useUpdater } from '../state/updater'
import {
  parseChangelog,
  compareVersions,
  entriesNewerThan,
  type ChangelogEntry,
} from '../lib/changelog'
import { ChangelogList } from './changelog-list'
import changelogRaw from '../../CHANGELOG.md?raw'

const LAST_SEEN_KEY = 'tw:last-seen-version'

function readLastSeen(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY)
  } catch {
    return null
  }
}

function stampSeen(version: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, version)
  } catch {
    // storage may be unavailable — nothing else to do
  }
}

/**
 * Mounted once at the app root, next to UpdateManager. On first launch of a
 * newer version (vs. the stored last-seen), shows the changelog entries added
 * since. First-ever launch / fresh install / cleared storage stamps silently.
 * Only runs inside Tauri, and defers while an update dialog is showing.
 */
export function WhatsNewDialog() {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null)
  const updaterStatus = useUpdater((s) => s.status)

  useEffect(() => {
    if (!isTauri) return
    const current = __APP_VERSION__
    const last = readLastSeen()
    if (!last) {
      stampSeen(current)
      return
    }
    if (compareVersions(current, last) <= 0) {
      stampSeen(current) // same version or a downgrade — nothing to show
      return
    }
    const newer = entriesNewerThan(parseChangelog(changelogRaw), last)
    if (newer.length === 0) {
      stampSeen(current) // version moved but changelog has no matching entries
      return
    }
    setEntries(newer)
  }, [])

  // Don't stack over the updater's own dialog. Subscribed to status, so if an
  // update surfaces after mount we hide, and reveal again once it's dismissed.
  const updaterBusy =
    updaterStatus === 'checking' ||
    updaterStatus === 'available' ||
    updaterStatus === 'downloading' ||
    updaterStatus === 'error'

  if (!entries || updaterBusy) return null

  const dismiss = (): void => {
    stampSeen(__APP_VERSION__)
    setEntries(null)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--backdrop)' }}
      onClick={dismiss}
    >
      <div
        className="flex max-h-[85vh] w-[min(880px,90vw)] flex-col overflow-hidden rounded-xl border border-border bg-overlay p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold text-foreground">
          What's New in v{__APP_VERSION__}
        </div>
        <div className="mt-3 overflow-auto">
          <ChangelogList entries={entries} large />
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
