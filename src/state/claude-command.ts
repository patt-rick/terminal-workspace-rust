// Pure helpers that build the command string injected into a new terminal for
// AI CLI launches. Kept free of Tauri/ipc imports so they can be unit
// tested in a plain Node environment (see claude-command.test.ts).

const CLAUDE_INVOCATION = /^claude(\s|$)/

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
 * Per-CLI "run without asking" flags: `invocation` recognises the command,
 * `present` detects the flag or any of its aliases already given by the user.
 */
const SKIP_PERMISSIONS_RULES: { invocation: RegExp; flag: string; present: RegExp }[] = [
  {
    invocation: CLAUDE_INVOCATION,
    flag: '--dangerously-skip-permissions',
    present: /(^|\s)--dangerously-skip-permissions(\s|$)/,
  },
  {
    invocation: /^codex(\s|$)/,
    flag: '--dangerously-bypass-approvals-and-sandbox',
    present: /(^|\s)(--dangerously-bypass-approvals-and-sandbox|--yolo)(\s|$)/,
  },
  {
    invocation: /^(gemini|qwen)(\s|$)/,
    flag: '--yolo',
    present: /(^|\s)(--yolo|-y)(\s|=|$)/,
  },
  {
    invocation: /^(python3?\s+-m\s+)?aider(\s|$)/,
    flag: '--yes-always',
    present: /(^|\s)(--yes-always|--yes|-y)(\s|=|$)/,
  },
]

/**
 * When the global "always skip permissions" setting is on, append the CLI's
 * own auto-approve flag to any recognised AI CLI invocation that doesn't
 * already carry it (or an alias). Unrecognised commands and already-flagged
 * commands (e.g. the ⇧D shortcut) are returned unchanged, so a flag is never
 * duplicated. Install chains don't match — the launch half is flagged before
 * the installer is chained in front.
 */
export function applySkipPermissions(command: string, skipPermissions: boolean): string {
  if (!skipPermissions) return command
  const trimmed = command.trim()
  const rule = SKIP_PERMISSIONS_RULES.find((r) => r.invocation.test(trimmed))
  if (!rule || rule.present.test(trimmed)) return command
  return `${trimmed} ${rule.flag}`
}
