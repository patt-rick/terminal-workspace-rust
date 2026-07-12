import { describe, expect, it } from 'vitest'
import { WSL_CLAUDE_INSTALL, wslClaudeCheckTarget } from './wsl-claude'

describe('wslClaudeCheckTarget', () => {
  it('returns the distro for claude launches into a wsl shell', () => {
    expect(wslClaudeCheckTarget('wsl:Ubuntu', 'claude')).toBe('Ubuntu')
    expect(
      wslClaudeCheckTarget('wsl:Ubuntu', 'claude --resume x --dangerously-skip-permissions')
    ).toBe('Ubuntu')
  })

  it('returns the empty string for the default distro', () => {
    expect(wslClaudeCheckTarget('wsl:', 'claude')).toBe('')
  })

  it('ignores plain terminals and non-claude commands', () => {
    expect(wslClaudeCheckTarget('wsl:Ubuntu', undefined)).toBeNull()
    expect(wslClaudeCheckTarget('wsl:Ubuntu', 'npm run dev')).toBeNull()
  })

  it('ignores non-wsl shells', () => {
    expect(wslClaudeCheckTarget(undefined, 'claude')).toBeNull()
    expect(wslClaudeCheckTarget('powershell.exe', 'claude')).toBeNull()
  })

  it('ignores chained install commands so consented installs never re-prompt', () => {
    expect(wslClaudeCheckTarget('wsl:Ubuntu', `${WSL_CLAUDE_INSTALL} ; claude`)).toBeNull()
    expect(
      wslClaudeCheckTarget('wsl:Ubuntu', 'npm install -g @anthropic-ai/claude-code ; claude')
    ).toBeNull()
  })
})
