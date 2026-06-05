import { platform, version } from '@tauri-apps/plugin-os'
import { isTauri } from './ipc'

export const isMac =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
export const isWindows =
  typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent)

// xterm.js needs the Windows OS build number to enable ConPTY-correct cursor /
// input handling (its `windowsPty` option). Resolved once at startup.
let windowsBuild: number | null = null
export function getWindowsBuild(): number | null {
  return windowsBuild
}

export async function initPlatform(): Promise<void> {
  if (!isTauri) return
  try {
    if ((await platform()) === 'windows') {
      const m = /^\d+\.\d+\.(\d+)/.exec(await version())
      windowsBuild = m ? Number(m[1]) : null
    }
  } catch {
    // ignore — windowsPty just stays disabled
  }
}

/** ⌘ on macOS, Ctrl elsewhere — for shortcut labels. */
export const kbd = (key: string): string => (isMac ? `⌘${key}` : `Ctrl+${key}`)
