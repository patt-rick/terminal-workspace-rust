export interface ProviderPreset {
  id: string
  name: string
  /** which auth check the backend runs; anthropic vs OpenAI-compatible */
  wire: 'anthropic' | 'openai'
  keyEnvVar: string
  extraEnv: Record<string, string>
}

/**
 * Presets only prefill the add-form; storage is fully generic, so any
 * OpenAI-compatible provider (OpenRouter, Groq, local vLLM, …) works via
 * "custom" with a base URL.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic / Claude',
    wire: 'anthropic',
    keyEnvVar: 'ANTHROPIC_API_KEY',
    extraEnv: {},
  },
  {
    id: 'openai',
    name: 'OpenAI / ChatGPT',
    wire: 'openai',
    keyEnvVar: 'OPENAI_API_KEY',
    extraEnv: {},
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    wire: 'openai',
    keyEnvVar: 'DEEPSEEK_API_KEY',
    extraEnv: { OPENAI_BASE_URL: 'https://api.deepseek.com' },
  },
  {
    id: 'qwen',
    name: 'Qwen (DashScope)',
    wire: 'openai',
    keyEnvVar: 'DASHSCOPE_API_KEY',
    extraEnv: { OPENAI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    wire: 'openai',
    keyEnvVar: 'OPENAI_API_KEY',
    extraEnv: { OPENAI_BASE_URL: '' },
  },
]

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

/**
 * env var -> ids of the enabled entries that define it, in list order, for
 * vars defined by 2+ entries. The last id in each list is the one that wins
 * at injection time (later stored entry overrides earlier).
 */
export function envConflicts(
  keys: {
    id: string
    enabled: boolean
    keyEnvVar: string
    extraEnv: Record<string, string>
  }[]
): Map<string, string[]> {
  const byVar = new Map<string, string[]>()
  for (const k of keys) {
    if (!k.enabled) continue
    for (const name of [k.keyEnvVar, ...Object.keys(k.extraEnv)]) {
      const list = byVar.get(name) ?? []
      if (!list.includes(k.id)) list.push(k.id)
      byVar.set(name, list)
    }
  }
  for (const [name, ids] of [...byVar]) {
    if (ids.length < 2) byVar.delete(name)
  }
  return byVar
}
