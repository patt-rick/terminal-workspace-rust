import { describe, expect, it } from 'vitest'
import {
  binaryFromCommand,
  checkTarget,
  commandUsesCli,
  envConflicts,
  launchBlocker,
  nextLabel,
  presetById,
  presetEnvDrift,
  PROVIDER_PRESETS,
  upgradeExtraEnv,
  upgradeLaunchCommand,
  withInstall,
} from './apikey-presets'

const entry = (
  id: string,
  keyEnvVar: string,
  enabled = true,
  extraEnv: Record<string, string> = {}
) => ({
  id,
  provider: 'custom',
  label: id,
  keyEnvVar,
  extraEnv,
  enabled,
  scope: 'global' as const,
  hasValue: true,
})

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
    expect(presetById('deepseek')?.launchCommand).toBe(
      'python -m aider --model deepseek/deepseek-chat'
    )
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
        expect(p.check).toBeNull()
        expect(p.installCommand).toBeNull()
        continue
      }
      expect(p.launchCommand.length, p.id).toBeGreaterThan(0)
      expect(p.check, p.id).not.toBeNull()
      expect(commandUsesCli(p.launchCommand, p.check!), p.id).toBe(true)
      expect(p.installCommand?.length, p.id).toBeGreaterThan(0)
      expect(p.keyEnvVar, p.id).toMatch(/^[A-Z][A-Z0-9_]*$/)
    }
  })

  it('every installable preset links official install docs for manual installs', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.id === 'custom') expect(p.installUrl).toBeNull()
      else expect(p.installUrl, p.id).toMatch(/^https:\/\//)
    }
    for (const id of ['deepseek', 'grok', 'mistral', 'groq', 'openrouter'])
      expect(presetById(id)?.installUrl, id).toBe('https://aider.chat/docs/install.html')
  })

  it('aider presets never depend on PATH (pip console scripts often are not on it)', () => {
    for (const id of ['deepseek', 'grok', 'mistral', 'groq', 'openrouter']) {
      const p = presetById(id)!
      expect(p.launchCommand, id).toMatch(/^python -m aider /)
      expect(p.installCommand, id).toBe('python -m pip install aider-chat')
      expect(p.check, id).toEqual({ kind: 'pythonModule', module: 'aider' })
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

describe('commandUsesCli', () => {
  const binary = { kind: 'binary', name: 'codex' } as const
  const module = { kind: 'pythonModule', module: 'aider' } as const

  it('binary checks match the command\'s first token', () => {
    expect(commandUsesCli('codex --full-auto', binary)).toBe(true)
    expect(commandUsesCli('"codex" resume', binary)).toBe(true)
    expect(commandUsesCli('my-codex', binary)).toBe(false)
    expect(commandUsesCli('npx codex', binary)).toBe(false)
  })

  it('python-module checks match `python -m <module>` invocations only', () => {
    expect(commandUsesCli('python -m aider --model deepseek/deepseek-chat', module)).toBe(true)
    expect(commandUsesCli('python3 -m aider', module)).toBe(true)
    expect(commandUsesCli('python  -m  aider', module)).toBe(true)
    expect(commandUsesCli('python -m aider_ci', module)).toBe(false)
    expect(commandUsesCli('aider --model x', module)).toBe(false)
    expect(commandUsesCli('python script.py', module)).toBe(false)
  })

  it('checkTarget names the CLI for the install prompt', () => {
    expect(checkTarget(binary)).toBe('codex')
    expect(checkTarget(module)).toBe('aider')
  })
})

describe('upgradeLaunchCommand', () => {
  it('rewrites stored stale preset defaults to the current preset command', () => {
    expect(upgradeLaunchCommand('deepseek', 'aider --model deepseek/deepseek-chat')).toBe(
      'python -m aider --model deepseek/deepseek-chat'
    )
    expect(upgradeLaunchCommand('grok', 'aider --model xai/grok-4')).toBe(
      'python -m aider --model xai/grok-4'
    )
    expect(upgradeLaunchCommand('qwen', 'aider --model openai/qwen-plus')).toBe('qwen')
  })

  it('leaves user-customized, current, null and unknown-provider commands alone', () => {
    expect(upgradeLaunchCommand('deepseek', 'aider --model deepseek/deepseek-coder')).toBe(
      'aider --model deepseek/deepseek-coder'
    )
    expect(
      upgradeLaunchCommand('deepseek', 'python -m aider --model deepseek/deepseek-chat')
    ).toBe('python -m aider --model deepseek/deepseek-chat')
    expect(upgradeLaunchCommand('deepseek', null)).toBeNull()
    expect(upgradeLaunchCommand('nope', 'aider --model deepseek/deepseek-chat')).toBe(
      'aider --model deepseek/deepseek-chat'
    )
  })
})

describe('withInstall', () => {
  it('chains install and launch with ";"', () => {
    expect(withInstall('npm install -g @openai/codex', 'codex')).toBe(
      'npm install -g @openai/codex ; codex'
    )
  })
})

const CLAUDE_CODE_PRESET_IDS = [
  'deepseek-claude',
  'kimi-claude',
  'glm-claude',
  'openrouter-claude',
  'ollama-claude',
]

describe('claude-code presets', () => {
  it.each(CLAUDE_CODE_PRESET_IDS)('%s is a launch-scoped anthropic-wire claude launcher', (id) => {
    const p = presetById(id)!
    expect(p.wire).toBe('anthropic')
    expect(p.scope).toBe('launch')
    expect(p.keyEnvVar).toBe('ANTHROPIC_AUTH_TOKEN')
    expect(p.launchCommand).toBe('claude')
    expect(p.check).toEqual({ kind: 'binary', name: 'claude' })
    expect(p.installCommand).toBe('npm install -g @anthropic-ai/claude-code')
    expect(p.extraEnv.ANTHROPIC_BASE_URL).toMatch(/^https?:\/\//)
    expect(p.extraEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1')
  })

  it('every preset declares a scope and existing presets stay global', () => {
    for (const p of PROVIDER_PRESETS) expect(['global', 'launch']).toContain(p.scope)
    expect(presetById('anthropic')!.scope).toBe('global')
    expect(presetById('deepseek')!.scope).toBe('global')
  })
})

describe('presetEnvDrift', () => {
  it('flags changed and missing preset-defaulted vars, ignores user-added vars', () => {
    const p = presetById('deepseek-claude')!
    expect(presetEnvDrift('deepseek-claude', { ...p.extraEnv })).toEqual([])
    const changed = { ...p.extraEnv, ANTHROPIC_MODEL: 'something-else' }
    expect(presetEnvDrift('deepseek-claude', changed)).toEqual(['ANTHROPIC_MODEL'])
    const { ANTHROPIC_BASE_URL: _, ...missing } = p.extraEnv
    expect(presetEnvDrift('deepseek-claude', missing)).toEqual(['ANTHROPIC_BASE_URL'])
    const extra = { ...p.extraEnv, MY_CUSTOM: 'x' }
    expect(presetEnvDrift('deepseek-claude', extra)).toEqual([])
  })

  it('never flags empty preset defaults or unknown providers', () => {
    expect(presetEnvDrift('custom', { OPENAI_BASE_URL: 'https://x' })).toEqual([])
    expect(presetEnvDrift('nope', { A: 'b' })).toEqual([])
  })
})

describe('upgradeExtraEnv', () => {
  it('returns the same reference when nothing matches a legacy snapshot', () => {
    const env = { ANTHROPIC_MODEL: 'user-picked' }
    expect(upgradeExtraEnv('deepseek-claude', env)).toBe(env)
    expect(upgradeExtraEnv('unknown', env)).toBe(env)
  })
})

describe('envConflicts scope', () => {
  it('ignores launch-scoped entries', () => {
    const mk = (id: string, scope: 'global' | 'launch') => ({
      id,
      enabled: true,
      scope,
      keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
      extraEnv: {},
    })
    expect(envConflicts([mk('a', 'launch'), mk('b', 'launch')]).size).toBe(0)
    expect(envConflicts([mk('a', 'global'), mk('b', 'global')]).size).toBe(1)
  })
})
