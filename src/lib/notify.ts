import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { isTauri } from './ipc'

let granted: boolean | null = null

/** Fire a native desktop notification (best-effort; no-op outside Tauri). */
export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri) return
  try {
    if (granted === null) {
      granted = await isPermissionGranted()
      if (!granted) granted = (await requestPermission()) === 'granted'
    }
    if (granted) sendNotification({ title, body })
  } catch {
    // ignore — notifications are non-critical
  }
}
