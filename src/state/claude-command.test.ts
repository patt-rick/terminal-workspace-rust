import { describe, expect, it } from 'vitest'
import { applyClaudeSkipPermissions, linkClaudeSession } from './claude-command'

const FLAG = '--dangerously-skip-permissions'

/**
 * Reproduces the transform pipeline in createProjectTerminal: the global
 * skip-permissions flag is applied first, then session linking. Returns the
 * final startup command string that gets injected into the PTY.
 */
function buildStartupCommand(command: string, skipPermissions: boolean): string {
  const withFlag = applyClaudeSkipPermissions(command, skipPermissions)
  return linkClaudeSession(withFlag).startupCommand
}

describe('applyClaudeSkipPermissions', () => {
  it('appends the flag to a bare claude launch when enabled', () => {
    expect(applyClaudeSkipPermissions('claude', true)).toBe(`claude ${FLAG}`)
  })

  it('leaves a bare claude launch untouched when disabled', () => {
    expect(applyClaudeSkipPermissions('claude', false)).toBe('claude')
  })

  it('never duplicates the flag (⇧D command already has it)', () => {
    expect(applyClaudeSkipPermissions(`claude ${FLAG}`, true)).toBe(`claude ${FLAG}`)
    expect(applyClaudeSkipPermissions(`claude ${FLAG}`, false)).toBe(`claude ${FLAG}`)
  })

  it('appends the flag to a resume launch when enabled', () => {
    expect(applyClaudeSkipPermissions('claude --resume abc123', true)).toBe(
      `claude --resume abc123 ${FLAG}`
    )
  })

  it('ignores non-claude commands even when enabled', () => {
    expect(applyClaudeSkipPermissions('npm run dev', true)).toBe('npm run dev')
    expect(applyClaudeSkipPermissions('claudia', true)).toBe('claudia')
  })
})

// AC-1.5: the four default spawn paths × both setting states.
describe('command-string builder across spawn paths', () => {
  it('chooser / ⇧T plain launch', () => {
    expect(buildStartupCommand('claude', false)).toMatch(/^claude --session-id [0-9a-f-]+$/)
    expect(buildStartupCommand('claude', true)).toMatch(
      new RegExp(`^claude ${FLAG} --session-id [0-9a-f-]+$`)
    )
  })

  it('⇧D shortcut always carries the flag, regardless of setting', () => {
    for (const skip of [false, true]) {
      const out = buildStartupCommand(`claude ${FLAG}`, skip)
      expect(out).toMatch(new RegExp(`^claude ${FLAG} --session-id [0-9a-f-]+$`))
      // exactly one flag occurrence, never doubled
      expect(out.match(new RegExp(FLAG, 'g'))).toHaveLength(1)
    }
  })

  it('resume launch gets the flag only when enabled and keeps its session id', () => {
    expect(buildStartupCommand('claude --resume s1', false)).toBe('claude --resume s1')
    expect(buildStartupCommand('claude --resume s1', true)).toBe(`claude --resume s1 ${FLAG}`)
  })
})
