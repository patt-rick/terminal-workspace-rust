# One-Click Provider Setup — Design

**Date:** 2026-07-05
**Status:** Approved
**Builds on:** `2026-07-03-multi-llm-provider-keys-design.md` (v1 of the provider-key system)

## Problem

Setting up a non-Claude provider is tricky today: the add-key form exposes label, env
var, launch command, and extra-env pairs all at once; the "Use other models" picker lists
entries that can't launch (greyed out); launch commands assume the CLI (`codex`, `aider`,
`gemini`) is already installed; and a bug makes the label stick on "Anthropic / Claude"
when the user switches the preset dropdown.

Goal: pick a provider, paste an API key, launch — the app handles the rest.

## Decisions (user-approved)

1. **Provider set:** Anthropic, OpenAI, Google Gemini, DeepSeek, xAI Grok, Mistral,
   Groq, OpenRouter, plus Qwen (kept for backward compat; official CLI exists) and
   Custom (OpenAI-compatible).
2. **Missing CLI:** prompt first ("X isn't installed — install now?"), then install in a
   visible terminal and launch right after. Never silent.
3. **CLI per provider:** official CLI where one exists (codex, gemini, claude, qwen);
   `aider` with the provider's native litellm model prefix otherwise.

## 1. Presets (`src/lib/apikey-presets.ts`)

`ProviderPreset` gains:

- `binaryName: string | null` — executable checked before launch (`codex`, `aider`, …).
  `null` for Custom (no check possible).
- `installCommand: string | null` — command that installs the binary. `null` for Custom.

Preset table (model ids and install commands MUST be verified against current provider
docs at implementation time):

| id | name | keyEnvVar | launchCommand | binaryName | installCommand |
|---|---|---|---|---|---|
| anthropic | Anthropic / Claude | `ANTHROPIC_API_KEY` | `claude` | `claude` | `npm install -g @anthropic-ai/claude-code` |
| openai | OpenAI | `OPENAI_API_KEY` | `codex` | `codex` | `npm install -g @openai/codex` |
| gemini | Google Gemini | `GEMINI_API_KEY` | `gemini` | `gemini` | `npm install -g @google/gemini-cli` |
| deepseek | DeepSeek | `DEEPSEEK_API_KEY` | `aider --model deepseek/deepseek-chat` | `aider` | aider installer |
| grok | xAI Grok | `XAI_API_KEY` | `aider --model xai/<current>` | `aider` | aider installer |
| mistral | Mistral | `MISTRAL_API_KEY` | `aider --model mistral/<current>` | `aider` | aider installer |
| groq | Groq | `GROQ_API_KEY` | `aider --model groq/<current>` | `aider` | aider installer |
| openrouter | OpenRouter | `OPENROUTER_API_KEY` | `aider --model openrouter/<current>` | `aider` | aider installer |
| qwen | Qwen (DashScope) | `DASHSCOPE_API_KEY` | `qwen` | `qwen` | `npm install -g @qwen-code/qwen-code` |
| custom | Custom (OpenAI-compatible) | `OPENAI_API_KEY` | (empty) | null | null |

Notes:

- aider reads each provider's native key env var via litellm (`deepseek/…` ⇒
  `DEEPSEEK_API_KEY`, `xai/…` ⇒ `XAI_API_KEY`, etc.), so these presets need **no**
  `OPENAI_BASE_URL` extra env — the preset is just the key.
- The existing `qwen` preset changes launch command from aider to the official `qwen`
  CLI; already-saved entries keep whatever launch command they stored (entries are
  self-contained), so nothing breaks.
- Storage schema is unchanged: `binaryName`/`installCommand` live on the preset only and
  are resolved from `provider` id at launch time. Custom/unknown providers get no
  installer.

## 2. Simplified add flow + label fix (`providers-section.tsx`)

- "+ Add key" opens the form showing **only** the preset dropdown and the API-key paste
  field. Label, key env var, launch command, and extra env are prefilled from the preset
  and hidden behind an "Advanced" toggle (collapsed by default). Selecting **Custom**
  auto-expands Advanced.
- **Label bug fix:** `applyPreset` currently keeps the old label because it is never
  empty (`label: draft.label || p.name`). New rule: replace the label when it is empty
  **or equals any preset's default name** (user hasn't customized it); otherwise keep
  the user's custom label.

## 3. Picker shows only ready entries (`model-picker.tsx`)

Filter the listed keys to `launchBlocker(k) === null` (enabled + secret stored + launch
command present). If no entry is ready, show the existing empty state ("No models added
yet…" → Open settings) — also when `keys.length > 0` but none are launchable, with copy
adjusted to "No providers are set up yet."

## 4. Prompt-then-install launch flow

**Backend:** new command `binary_exists(name: String) -> bool` in `commands.rs`,
registered in `lib.rs`. Implementation: `which::which(name).is_ok()` (add the `which`
crate) — respects PATH and PATHEXT on Windows. On any internal error, return `true`
so launches are never blocked by the check.

**Frontend:** a shared helper `launchProviderEntry(projectId, entry)` in
`src/lib/launch-provider.ts`, used by both the picker and the settings section:

1. `binary = first whitespace-separated token of entry.launchCommand`.
2. `await binaryExists(binary)` → if true, `createProjectTerminal(projectId, { name:
   entry.label, startupCommand: entry.launchCommand })` (unchanged behavior).
3. If false and the entry's preset has an `installCommand` → show a confirm dialog:
   *"`codex` isn't installed. Install it now? Runs: `npm install -g @openai/codex`"*.
   - Confirm → `startupCommand = "<installCommand> ; <launchCommand>"`. `;` is a valid
     sequential separator in PowerShell (the Windows default shell here), bash, and zsh.
     The user watches the install in the terminal and the CLI starts right after.
   - Cancel → do nothing.
4. If false and no installer is known (custom/unknown provider) → launch anyway;
   the shell's "command not found" is the feedback (current behavior).

The confirm dialog is a small in-app modal (same overlay pattern as the picker), not a
native dialog.

## Error handling

- `binary_exists` failure ⇒ `true` (fail open).
- Install failure surfaces in the terminal itself; the chained launch command then fails
  visibly in the same terminal. No extra state to track.

## Testing

Extend `src/lib/apikey-presets.test.ts`:

- new presets expose sane `keyEnvVar`/`binaryName`/`installCommand`;
- label-replacement rule (pure function, e.g. `nextLabel(current, preset)`): default
  labels are replaced on preset switch, customized labels are kept;
- picker filter: only `launchBlocker === null` entries listed;
- startup-command chaining: `withInstall(install, launch)` joins with `" ; "`.

UI behavior (Advanced toggle, confirm dialog) is verified manually.

## Out of scope

- No auto-install of package managers themselves (npm/python missing ⇒ install command
  fails visibly in the terminal).
- No storage/keychain/injection changes.
- No retroactive injection into running terminals (unchanged from v1).
