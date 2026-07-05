export interface ProviderPreset {
  id: string
  name: string
  /** which auth check the backend runs; anthropic vs OpenAI-compatible */
  wire: 'anthropic' | 'openai'
  keyEnvVar: string
  extraEnv: Record<string, string>
  launchCommand: string
  /** executable looked up on PATH before launch; null = no check (custom) */
  binaryName: string | null
  /** command that installs binaryName when it's missing; null = none known */
  installCommand: string | null
}

/** aider's official installer; `;` is sequential in PowerShell, bash and zsh. */
const AIDER_INSTALL = 'python -m pip install aider-install ; aider-install'

/**
 * Presets only prefill the add-form; storage is fully generic, so any
 * OpenAI-compatible provider (Together, local vLLM, …) works via "custom"
 * with a base URL. aider presets rely on litellm's native provider prefixes
 * (deepseek/, xai/, mistral/, groq/, openrouter/) which read each provider's
 * own key env var — no OPENAI_BASE_URL juggling.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic / Claude',
    wire: 'anthropic',
    keyEnvVar: 'ANTHROPIC_API_KEY',
    extraEnv: {},
    launchCommand: 'claude',
    binaryName: 'claude',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    id: 'openai',
    name: 'OpenAI / ChatGPT',
    wire: 'openai',
    keyEnvVar: 'OPENAI_API_KEY',
    extraEnv: {},
    launchCommand: 'codex',
    binaryName: 'codex',
    installCommand: 'npm install -g @openai/codex',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    wire: 'openai',
    keyEnvVar: 'GEMINI_API_KEY',
    extraEnv: {},
    launchCommand: 'gemini',
    binaryName: 'gemini',
    installCommand: 'npm install -g @google/gemini-cli',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    wire: 'openai',
    keyEnvVar: 'DEEPSEEK_API_KEY',
    extraEnv: {},
    launchCommand: 'aider --model deepseek/deepseek-chat',
    binaryName: 'aider',
    installCommand: AIDER_INSTALL,
  },
  {
    id: 'grok',
    name: 'xAI Grok',
    wire: 'openai',
    keyEnvVar: 'XAI_API_KEY',
    extraEnv: {},
    launchCommand: 'aider --model xai/grok-4',
    binaryName: 'aider',
    installCommand: AIDER_INSTALL,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    wire: 'openai',
    keyEnvVar: 'MISTRAL_API_KEY',
    extraEnv: {},
    launchCommand: 'aider --model mistral/mistral-large-latest',
    binaryName: 'aider',
    installCommand: AIDER_INSTALL,
  },
  {
    id: 'groq',
    name: 'Groq',
    wire: 'openai',
    keyEnvVar: 'GROQ_API_KEY',
    extraEnv: {},
    launchCommand: 'aider --model groq/llama-3.3-70b-versatile',
    binaryName: 'aider',
    installCommand: AIDER_INSTALL,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    wire: 'openai',
    keyEnvVar: 'OPENROUTER_API_KEY',
    extraEnv: {},
    launchCommand: 'aider --model openrouter/openrouter/auto',
    binaryName: 'aider',
    installCommand: AIDER_INSTALL,
  },
  {
    id: 'qwen',
    name: 'Qwen',
    wire: 'openai',
    keyEnvVar: 'DASHSCOPE_API_KEY',
    extraEnv: {},
    launchCommand: 'qwen',
    binaryName: 'qwen',
    installCommand: 'npm install -g @qwen-code/qwen-code',
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    wire: 'openai',
    keyEnvVar: 'OPENAI_API_KEY',
    extraEnv: { OPENAI_BASE_URL: '' },
    launchCommand: '',
    binaryName: null,
    installCommand: null,
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

/**
 * Why an entry can't be launched right now, or null when it can. Order matters:
 * the most actionable problem is reported first.
 */
export function launchBlocker(k: {
  enabled: boolean
  hasValue: boolean
  launchCommand: string | null
}): string | null {
  if (!k.enabled) return 'Disabled'
  if (!k.hasValue) return 'No API key stored'
  if (!k.launchCommand) return 'No launch command'
  return null
}

const DEFAULT_LABELS = new Set(PROVIDER_PRESETS.map((p) => p.name))

/**
 * Label to show after switching the preset dropdown: preset-default labels
 * follow the selected preset; anything the user typed sticks.
 */
export function nextLabel(current: string, preset: ProviderPreset): string {
  const c = current.trim()
  return !c || DEFAULT_LABELS.has(c) ? preset.name : c
}

/** First whitespace-separated token, unquoted — the executable to look up. */
export function binaryFromCommand(cmd: string): string | null {
  const first = cmd.trim().split(/\s+/)[0] ?? ''
  const bare = first.replace(/^["']|["']$/g, '')
  return bare || null
}

/** Startup command that installs the CLI, then launches it, in one terminal. */
export function withInstall(installCommand: string, launchCommand: string): string {
  return `${installCommand} ; ${launchCommand}`
}
