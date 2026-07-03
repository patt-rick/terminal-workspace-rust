import { describe, expect, it } from 'vitest'
import { envConflicts, PROVIDER_PRESETS, presetById } from './apikey-presets'

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
})
