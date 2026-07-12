import { commandUsesCli, type PresenceCheck } from './apikey-presets'

/**
 * Official native installer, chained with a PATH export because it lands in
 * ~/.local/bin — which isn't on the already-running shell's PATH, and the
 * chained `claude` would otherwise not be found.
 */
export const WSL_CLAUDE_INSTALL =
  'curl -fsSL https://claude.ai/install.sh | bash ; export PATH="$HOME/.local/bin:$PATH"'

const CLAUDE_CHECK: PresenceCheck = { kind: 'binary', name: 'claude' }

/**
 * The WSL distro ('' = default) a claude launch is about to run in, or null
 * when this launch needs no native-claude presence check (not a WSL shell,
 * plain terminal, or a command that doesn't start with the claude CLI —
 * including already-chained install commands).
 */
export function wslClaudeCheckTarget(
  shell: string | undefined,
  startupCommand: string | undefined
): string | null {
  if (!shell || !shell.startsWith('wsl:')) return null
  if (!startupCommand || !commandUsesCli(startupCommand, CLAUDE_CHECK)) return null
  return shell.slice('wsl:'.length)
}
