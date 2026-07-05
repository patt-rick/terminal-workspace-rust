import { describe, expect, it } from 'vitest'
import {
  binaryFromCommand,
  envConflicts,
  launchBlocker,
  nextLabel,
  presetById,
  PROVIDER_PRESETS,
  withInstall,
} from './apikey-presets'

const entry = (
  id: string,
  keyEnvVar: string,
  enabled = true,
  extraEnv: Record<string, string> = {}
) => ({ id, provider: 'custom', label: id, keyEnvVar, extraEnv, enabled, hasValue: true })

describe('envConflicts', () => {
  it('reports vars defined by two or more enabled entries', () => {
    const conflicts = envConflicts([
      entry('a', 'OPENAI_API_KEY'),
      entry('b', 'OPENAI_API_KEY'),
      entry('c', 'GROQ_API_KEY'),
    ])
    expect(conflicts.get('OPENAI_API_KEY')).toEqual(['a', 'b'])
    expect(conflicts.has('GROQ_API_KEY')).toBe(false)
  })

  it('ignores disabled entries and counts extraEnv vars', () => {
    const conflicts = envConflicts([
      entry('a', 'DEEPSEEK_API_KEY', true, { OPENAI_BASE_URL: 'https://api.deepseek.com' }),
      entry('b', 'OPENAI_API_KEY', true, { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }),
      entry('c', 'OPENAI_API_KEY', false),
    ])
    expect(conflicts.get('OPENAI_BASE_URL')).toEqual(['a', 'b'])
    expect(conflicts.has('OPENAI_API_KEY')).toBe(false)
  })
})

describe('presets', () => {
  it('every preset id is unique and resolvable', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(presetById(id)?.id).toBe(id)
  })

  it('prefills a launch command for every non-custom preset', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.id === 'custom') expect(p.launchCommand).toBe('')
      else expect(p.launchCommand.length).toBeGreaterThan(0)
    }
    expect(presetById('deepseek')?.launchCommand).toBe('aider --model deepseek/deepseek-chat')
  })
})

describe('launchBlocker', () => {
  it('returns null only when launchable', () => {
    const base = { enabled: true, hasValue: true, launchCommand: 'aider' }
    expect(launchBlocker(base)).toBeNull()
    expect(launchBlocker({ ...base, enabled: false })).toBe('Disabled')
    expect(launchBlocker({ ...base, hasValue: false })).toBe('No API key stored')
    expect(launchBlocker({ ...base, launchCommand: null })).toBe('No launch command')
    expect(launchBlocker({ ...base, launchCommand: '' })).toBe('No launch command')
  })
})

describe('expanded presets', () => {
  it('covers the common providers', () => {
    for (const id of [
      'anthropic',
      'openai',
      'gemini',
      'deepseek',
      'grok',
      'mistral',
      'groq',
      'openrouter',
      'qwen',
      'custom',
    ])
      expect(presetById(id), id).toBeDefined()
  })

  it('every non-custom preset is launchable out of the box', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.id === 'custom') {
        expect(p.binaryName).toBeNull()
        expect(p.installCommand).toBeNull()
        continue
      }
      expect(p.launchCommand.length, p.id).toBeGreaterThan(0)
      expect(p.binaryName, p.id).toBe(binaryFromCommand(p.launchCommand))
      expect(p.installCommand?.length, p.id).toBeGreaterThan(0)
      expect(p.keyEnvVar, p.id).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  it('aider-based presets need no base-URL extra env (litellm reads native keys)', () => {
    for (const id of ['deepseek', 'grok', 'mistral', 'groq', 'openrouter'])
      expect(presetById(id)?.extraEnv).toEqual({})
  })
})

describe('nextLabel', () => {
  const openai = presetById('openai')!
  it('replaces empty and preset-default labels on preset switch', () => {
    expect(nextLabel('', openai)).toBe(openai.name)
    expect(nextLabel('  ', openai)).toBe(openai.name)
    expect(nextLabel('Anthropic / Claude', openai)).toBe(openai.name)
  })
  it('keeps a customized label', () => {
    expect(nextLabel('work key', openai)).toBe('work key')
  })
})

describe('binaryFromCommand', () => {
  it('returns the first token, unquoted', () => {
    expect(binaryFromCommand('aider --model deepseek/deepseek-chat')).toBe('aider')
    expect(binaryFromCommand('codex')).toBe('codex')
    expect(binaryFromCommand('"my tool" --flag')).toBe('my')
    expect(binaryFromCommand("'aider' --x")).toBe('aider')
    expect(binaryFromCommand('   ')).toBeNull()
  })
})

describe('withInstall', () => {
  it('chains install and launch with ";"', () => {
    expect(withInstall('npm install -g @openai/codex', 'codex')).toBe(
      'npm install -g @openai/codex ; codex'
    )
  })
})
