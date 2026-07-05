import { describe, expect, it } from 'vitest'
import { applySkipPermissions, linkClaudeSession } from './claude-command'

const FLAG = '--dangerously-skip-permissions'

/**
 * Reproduces the transform pipeline in createProjectTerminal: the global
 * skip-permissions flag is applied first, then session linking. Returns the
 * final startup command string that gets injected into the PTY.
 */
function buildStartupCommand(command: string, skipPermissions: boolean): string {
  const withFlag = applySkipPermissions(command, skipPermissions)
  return linkClaudeSession(withFlag).startupCommand
}

describe('applySkipPermissions', () => {
  it('appends the flag to a bare claude launch when enabled', () => {
    expect(applySkipPermissions('claude', true)).toBe(`claude ${FLAG}`)
  })

  it('leaves a bare claude launch untouched when disabled', () => {
    expect(applySkipPermissions('claude', false)).toBe('claude')
  })

  it('never duplicates the flag (⇧D command already has it)', () => {
    expect(applySkipPermissions(`claude ${FLAG}`, true)).toBe(`claude ${FLAG}`)
    expect(applySkipPermissions(`claude ${FLAG}`, false)).toBe(`claude ${FLAG}`)
  })

  it('appends the flag to a resume launch when enabled', () => {
    expect(applySkipPermissions('claude --resume abc123', true)).toBe(
      `claude --resume abc123 ${FLAG}`
    )
  })

  it('ignores unknown commands even when enabled', () => {
    expect(applySkipPermissions('npm run dev', true)).toBe('npm run dev')
    expect(applySkipPermissions('claudia', true)).toBe('claudia')
  })

  it('gives every provider CLI its own auto-approve flag', () => {
    expect(applySkipPermissions('codex', true)).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox'
    )
    expect(applySkipPermissions('gemini', true)).toBe('gemini --yolo')
    expect(applySkipPermissions('qwen', true)).toBe('qwen --yolo')
    expect(applySkipPermissions('aider --model x', true)).toBe('aider --model x --yes-always')
    expect(applySkipPermissions('python -m aider --model deepseek/deepseek-chat', true)).toBe(
      'python -m aider --model deepseek/deepseek-chat --yes-always'
    )
  })

  it('leaves provider commands untouched when disabled', () => {
    expect(applySkipPermissions('codex', false)).toBe('codex')
    expect(applySkipPermissions('python -m aider --model x', false)).toBe(
      'python -m aider --model x'
    )
  })

  it('respects flags (and their aliases) the user already set', () => {
    expect(applySkipPermissions('codex --yolo', true)).toBe('codex --yolo')
    expect(
      applySkipPermissions('codex --dangerously-bypass-approvals-and-sandbox', true)
    ).toBe('codex --dangerously-bypass-approvals-and-sandbox')
    expect(applySkipPermissions('gemini -y', true)).toBe('gemini -y')
    expect(applySkipPermissions('qwen --yolo', true)).toBe('qwen --yolo')
    expect(applySkipPermissions('python -m aider --yes-always', true)).toBe(
      'python -m aider --yes-always'
    )
    expect(applySkipPermissions('aider --yes', true)).toBe('aider --yes')
  })

  it('no-ops on install chains (flags are applied to the launch half beforehand)', () => {
    const chained = 'python -m pip install aider-chat ; python -m aider --model x --yes-always'
    expect(applySkipPermissions(chained, true)).toBe(chained)
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
