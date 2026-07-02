// Pure helpers that build the command string injected into a new terminal for
// Claude Code launches. Kept free of Tauri/ipc imports so they can be unit
// tested in a plain Node environment (see claude-command.test.ts).

const CLAUDE_INVOCATION = /^claude(\s|$)/
const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions'

/**
 * If `command` is a bare `claude` invocation with no resume/continue/session-id
 * flag, append `--session-id <uuid>` and return that id so the app can track
 * which session the terminal is running. Otherwise returns the command unchanged.
 */
export function linkClaudeSession(command: string): {
  startupCommand: string
  sessionId?: string
} {
  const trimmed = command.trim()
  if (!CLAUDE_INVOCATION.test(trimmed)) return { startupCommand: command }
  if (/(^|\s)(--resume|-r|--continue|-c|--session-id)(\s|=|$)/.test(trimmed)) {
    return { startupCommand: command }
  }
  const sessionId = crypto.randomUUID()
  return { startupCommand: `${trimmed} --session-id ${sessionId}`, sessionId }
}

/**
 * When the global "always skip permissions" setting is on, append
 * `--dangerously-skip-permissions` to any `claude` invocation that doesn't
 * already carry it. Non-claude commands and already-flagged commands (e.g. the
 * ⇧D shortcut) are returned unchanged, so the flag is never duplicated.
 */
export function applyClaudeSkipPermissions(command: string, skipPermissions: boolean): string {
  if (!skipPermissions) return command
  const trimmed = command.trim()
  if (!CLAUDE_INVOCATION.test(trimmed)) return command
  if (new RegExp(`(^|\\s)${SKIP_PERMISSIONS_FLAG}(\\s|$)`).test(trimmed)) return command
  return `${trimmed} ${SKIP_PERMISSIONS_FLAG}`
}
