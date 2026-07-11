/** How the CLI's presence is detected before launch. */
export type PresenceCheck =
  | { kind: 'binary'; name: string }
  | { kind: 'pythonModule'; module: string }

export interface ProviderPreset {
  id: string
  name: string
  /** which auth check the backend runs; anthropic vs OpenAI-compatible */
  wire: 'anthropic' | 'openai'
  /** injection scope for entries created from this preset */
  scope: 'global' | 'launch'
  keyEnvVar: string
  extraEnv: Record<string, string>
  launchCommand: string
  /** presence probe run before launch; null = no check (custom) */
  check: PresenceCheck | null
  /** command that installs the CLI when the check fails; null = none known */
  installCommand: string | null
  /** official install docs, offered as the manual alternative to installCommand */
  installUrl: string | null
}

/**
 * pip + `python -m` keep the whole install-then-launch chain PATH-independent:
 * pip's console scripts often land in a Scripts dir that isn't on PATH
 * (Windows user-site installs), and PATH edits made by an installer never
 * reach the already-running shell that would chain-launch `aider` right after.
 */
const AIDER_INSTALL = 'python -m pip install aider-chat'
const AIDER_CHECK: PresenceCheck = { kind: 'pythonModule', module: 'aider' }
const AIDER_INSTALL_URL = 'https://aider.chat/docs/install.html'

const CLAUDE_CHECK: PresenceCheck = { kind: 'binary', name: 'claude' }
const CLAUDE_INSTALL = 'npm install -g @anthropic-ai/claude-code'
const CLAUDE_INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/setup'

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
    scope: 'global',
    keyEnvVar: 'ANTHROPIC_API_KEY',
    extraEnv: {},
    launchCommand: 'claude',
    check: CLAUDE_CHECK,
    installCommand: CLAUDE_INSTALL,
    installUrl: CLAUDE_INSTALL_URL,
  },
  {
    id: 'openai',
    name: 'OpenAI / ChatGPT',
    wire: 'openai',
    scope: 'global',
    keyEnvVar: 'OPENAI_API_KEY',
    extraEnv: {},
    launchCommand: 'codex',
    check: { kind: 'binary', name: 'codex' },
    installCommand: 'npm install -g @openai/codex',
    installUrl: 'https://github.com/openai/codex',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    wire: 'openai',
    scope: 'global',
    keyEnvVar: 'GEMINI_API_KEY',
    extraEnv: {},
    launchCommand: 'gemini',
    check: { kind: 'binary', name: 'gemini' },
    installCommand: 'npm install -g @google/gemini-cli',
    installUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    wire: 'openai',
    scope: 'global',
    keyEnvVar: 'DEEPSEEK_API_KEY',
    extraEnv: {},
    launchCommand: 'python -m aider --model deepseek/deepseek-chat',
    check: AIDER_CHECK,
    installCommand: AIDER_INSTALL,
    installUrl: AIDER_INSTALL_URL,
  },
  {
    id: 'grok',
    name: 'xAI Grok',
    wire: 'openai',
    scope: 'global',
    keyEnvVar: 'XAI_API_KEY',
    extraEnv: {},
    launchCommand: 'python -m aider --model xai/grok-4',
    check: AIDER_CHECK,
    installCommand: AIDER_INSTALL,
    installUrl: AIDER_INSTALL_URL,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    wire: 'openai',
    scope: 'global',
    keyEnvVar: 'MISTRAL_API_KEY',
    extraEnv: {},
    launchCommand: 'python -m aider --model mistral/mistral-large-latest',
    check: AIDER_CHECK,
    installCommand: AIDER_INSTALL,
    installUrl: AIDER_INSTALL_URL,
  },
  {
    id: 'groq',
    name: 'Groq',
    wire: 'openai',
    scope: 'global',
    keyEnvVar: 'GROQ_API_KEY',
    extraEnv: {},
    launchCommand: 'python -m aider --model groq/llama-3.3-70b-versatile',
    check: AIDER_CHECK,
    installCommand: AIDER_INSTALL,
    installUrl: AIDER_INSTALL_URL,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    wire: 'openai',
    scope: 'global',
    keyEnvVar: 'OPENROUTER_API_KEY',
    extraEnv: {},
    launchCommand: 'python -m aider --model openrouter/openrouter/auto',
    check: AIDER_CHECK,
    installCommand: AIDER_INSTALL,
    installUrl: AIDER_INSTALL_URL,
  },
  {
    id: 'qwen',
    name: 'Qwen',
    wire: 'openai',
    scope: 'global',
    keyEnvVar: 'DASHSCOPE_API_KEY',
    extraEnv: {},
    launchCommand: 'qwen',
    check: { kind: 'binary', name: 'qwen' },
    installCommand: 'npm install -g @qwen-code/qwen-code',
    installUrl: 'https://github.com/QwenLM/qwen-code',
  },
  {
    id: 'deepseek-claude',
    name: 'DeepSeek (Claude Code)',
    wire: 'anthropic',
    scope: 'launch',
    keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    extraEnv: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
    launchCommand: 'claude',
    check: CLAUDE_CHECK,
    installCommand: CLAUDE_INSTALL,
    installUrl: CLAUDE_INSTALL_URL,
  },
  {
    id: 'kimi-claude',
    name: 'Kimi / Moonshot (Claude Code)',
    wire: 'anthropic',
    scope: 'launch',
    keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    extraEnv: {
      ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
      ANTHROPIC_MODEL: 'kimi-k2.7-code-highspeed',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code-highspeed',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
    launchCommand: 'claude',
    check: CLAUDE_CHECK,
    installCommand: CLAUDE_INSTALL,
    installUrl: CLAUDE_INSTALL_URL,
  },
  {
    id: 'glm-claude',
    name: 'GLM / Z.ai (Claude Code)',
    wire: 'anthropic',
    scope: 'launch',
    keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    extraEnv: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_MODEL: 'glm-4.7',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
    launchCommand: 'claude',
    check: CLAUDE_CHECK,
    installCommand: CLAUDE_INSTALL,
    installUrl: CLAUDE_INSTALL_URL,
  },
  {
    id: 'openrouter-claude',
    name: 'OpenRouter (Claude Code)',
    wire: 'anthropic',
    scope: 'launch',
    keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    extraEnv: {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
    launchCommand: 'claude',
    check: CLAUDE_CHECK,
    installCommand: CLAUDE_INSTALL,
    installUrl: CLAUDE_INSTALL_URL,
  },
  {
    id: 'ollama-claude',
    name: 'Ollama local (Claude Code)',
    wire: 'anthropic',
    scope: 'launch',
    keyEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    extraEnv: {
      ANTHROPIC_BASE_URL: 'http://localhost:11434',
      ANTHROPIC_MODEL: 'qwen3-coder',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3-coder',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    },
    launchCommand: 'claude',
    check: CLAUDE_CHECK,
    installCommand: CLAUDE_INSTALL,
    installUrl: CLAUDE_INSTALL_URL,
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    wire: 'openai',
    scope: 'global',
    keyEnvVar: 'OPENAI_API_KEY',
    extraEnv: { OPENAI_BASE_URL: '' },
    launchCommand: '',
    check: null,
    installCommand: null,
    installUrl: null,
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
    scope: 'global' | 'launch'
    keyEnvVar: string
    extraEnv: Record<string, string>
  }[]
): Map<string, string[]> {
  const byVar = new Map<string, string[]>()
  for (const k of keys) {
    if (!k.enabled || k.scope === 'launch') continue
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

/** Name of the CLI a check looks for, for display in the install prompt. */
export function checkTarget(check: PresenceCheck): string {
  return check.kind === 'binary' ? check.name : check.module
}

/**
 * True when `cmd` still invokes the CLI that `check` probes for, so the
 * preset's installer is the right remedy when the probe fails. A customized
 * command (different binary, plain `aider` instead of `python -m aider`) gets
 * no install prompt — the preset can't know how that variant is provisioned.
 */
export function commandUsesCli(cmd: string, check: PresenceCheck): boolean {
  if (check.kind === 'binary') return binaryFromCommand(cmd) === check.name
  return new RegExp(`^python3?\\s+-m\\s+${check.module}(\\s|$)`).test(cmd.trim())
}

/**
 * Launch commands earlier releases wrote into stored entries as the preset
 * default. Entries still carrying one are upgraded on load — the user never
 * chose these strings, so they should track the preset's fixes (e.g. plain
 * `aider` relied on pip's Scripts dir being on PATH).
 */
const LEGACY_LAUNCH_COMMANDS: Record<string, string[]> = {
  deepseek: ['aider --model deepseek/deepseek-chat'],
  grok: ['aider --model xai/grok-4'],
  mistral: ['aider --model mistral/mistral-large-latest'],
  groq: ['aider --model groq/llama-3.3-70b-versatile'],
  openrouter: ['aider --model openrouter/openrouter/auto'],
  qwen: ['aider --model openai/qwen-plus'],
}

/** Current command for a stored one that is a stale preset default; otherwise unchanged. */
export function upgradeLaunchCommand(provider: string, cmd: string | null): string | null {
  if (!cmd) return cmd
  const preset = presetById(provider)
  if (!preset) return cmd
  return (LEGACY_LAUNCH_COMMANDS[provider] ?? []).includes(cmd.trim())
    ? preset.launchCommand
    : cmd
}

/**
 * Historical extraEnv preset defaults, one snapshot per superseded release.
 * Entries whose stored extraEnv exactly matches a snapshot are auto-upgraded
 * to the current default on load — the user never chose those values.
 * Populate whenever a release changes a preset's extraEnv defaults.
 */
const LEGACY_EXTRA_ENV: Record<string, Record<string, string>[]> = {}

const envEquals = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const ka = Object.keys(a)
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k])
}

/** Current defaults when the stored map is a stale preset snapshot; otherwise unchanged. */
export function upgradeExtraEnv(
  provider: string,
  extraEnv: Record<string, string>
): Record<string, string> {
  const preset = presetById(provider)
  if (!preset) return extraEnv
  return (LEGACY_EXTRA_ENV[provider] ?? []).some((snap) => envEquals(snap, extraEnv))
    ? { ...preset.extraEnv }
    : extraEnv
}

/**
 * Names of preset-defaulted env vars whose stored value differs from the
 * current default (missing counts as differing). Empty defaults and vars the
 * user added themselves are never flagged — this warns about endpoint/model
 * values that can go stale, nothing else.
 */
export function presetEnvDrift(provider: string, extraEnv: Record<string, string>): string[] {
  const preset = presetById(provider)
  if (!preset) return []
  return Object.entries(preset.extraEnv)
    .filter(([name, def]) => def !== '' && extraEnv[name] !== def)
    .map(([name]) => name)
}

/** Startup command that installs the CLI, then launches it, in one terminal. */
export function withInstall(installCommand: string, launchCommand: string): string {
  return `${installCommand} ; ${launchCommand}`
}
