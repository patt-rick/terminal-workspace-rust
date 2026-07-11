import { invoke, Channel } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

// ---- Types mirroring the Rust serde models (camelCase) ----

export interface TerminalRecord {
  id: string
  name: string
  shell: string
}

export interface Project {
  id: string
  name: string
  path: string
  color: string
  terminals: TerminalRecord[]
}

export interface AppStateSnapshot {
  version: number
  selectedProjectId: string | null
  projects: Project[]
  activeTerminalByProject: Record<string, string | null>
}

export interface CreateTerminalOptions {
  projectId: string
  name?: string
  shell?: string
  /** working dir relative to the project root; defaults to the project root */
  cwd?: string
  startupCommand?: string
  cols?: number
  rows?: number
  /** provider-key entry whose env is injected into this terminal only */
  apikeyEntryId?: string
}

export interface ExitPayload {
  id: string
  exitCode: number
}

/** A remote client took over a terminal's size (cols/rows set) or released it
 * (both null). While owned, the desktop pane mirrors the remote grid (remote-wins sizing). */
export interface RemoteSizePayload {
  id: string
  cols: number | null
  rows: number | null
}

export interface FsEntry {
  name: string
  /** path relative to the project root, forward slashes; "" = root */
  path: string
  isDirectory: boolean
  ignored: boolean
}

export type ReadResult =
  | { kind: 'text'; content: string }
  | { kind: 'binary' }
  | { kind: 'tooLarge' }

export type SearchStatus = 'building' | 'ready' | 'stale'

export interface SearchHit {
  path: string
  score: number
  /** matched character positions (char indices) for highlighting */
  indices: number[]
}

export interface SearchQueryResult {
  status: SearchStatus
  total: number
  hits: SearchHit[]
}

export interface SearchIndexStatus {
  status: SearchStatus
  fileCount: number
  truncated: boolean
  /** epoch millis of last full build, or null while first build is pending */
  builtAt: number | null
}

export interface RepoInfo {
  id: string
  /** Absolute working-directory path (opaque to the UI). */
  path: string
  /** Display path relative to the project root; empty for a root-level repo. */
  relativePath: string
  name: string
  isSubmodule: boolean
  parentRepoId: string | null
}

export interface GitInfo {
  isRepo: boolean
  branch: string | null
  githubRepo: { owner: string; repo: string } | null
  hasUpstream: boolean
  ahead: number
  behind: number
  dirty: boolean
  defaultBranch: string | null
}

export interface DiffLine {
  /** ' ' context, '+' added, '-' removed */
  origin: string
  content: string
  oldLineno: number | null
  newLineno: number | null
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  oldPath: string | null
  status: string
  binary: boolean
  hunks: DiffHunk[]
}

export interface GithubSettings {
  clientId: string | null
  hasToken: boolean
  login: string | null
  source: string | null
}

export interface DeviceFlowStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export type DevicePoll =
  | { status: 'pending' }
  | { status: 'slow-down'; interval: number }
  | { status: 'authorized'; login: string | null }
  | { status: 'error'; error: string; description?: string }

export interface PullRequestSummary {
  number: number
  title: string
  state: string
  draft: boolean
  merged: boolean
  url: string
  author: string
  authorAvatar: string | null
  headRef: string
  baseRef: string
  createdAt: string
  updatedAt: string
}

export interface PrComment {
  id: number
  author: string
  avatar: string | null
  body: string
  createdAt: string
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string
  mergeable: boolean | null
  additions: number
  deletions: number
  changedFiles: number
  comments: PrComment[]
}

export interface WorkflowSummary {
  id: number
  name: string
  path: string
  state: string
}

export interface WorkflowRunSummary {
  id: number
  name: string | null
  workflowId: number
  branch: string | null
  event: string
  status: string
  conclusion: string | null
  url: string
  runNumber: number
  actor: string
  createdAt: string
  updatedAt: string
}

export interface JobStep {
  name: string
  status: string
  conclusion: string | null
  number: number
}

export interface WorkflowJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  url: string
  steps: JobStep[]
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  jobs: WorkflowJob[]
}

export interface CreatePullRequestInput {
  repoId: string
  title: string
  body: string
  head: string
  base: string
  draft: boolean
}

export interface ClaudeSession {
  sessionId: string
  title: string
  messageCount: number
  /** epoch millis (file mtime) */
  lastActive: number
  gitBranch: string | null
}

export interface Account {
  id: string
  label: string
  login: string
  name: string
  email: string
}

export type UnmappedBehavior = 'useDefault' | 'ask'

export interface IdentityConfig {
  defaultAccountId: string | null
  unmappedBehavior: UnmappedBehavior
}

export type IdentityResolution =
  | { kind: 'none' }
  | { kind: 'apply'; account: Account }
  | { kind: 'ask'; suggestedAccountId: string | null }

export interface CurrentIdentity {
  isRepo: boolean
  name: string | null
  email: string | null
  remoteLogin: string | null
  accountId: string | null
}

export interface ApplyResult {
  current: CurrentIdentity
  routingSkipped: boolean
}

export interface PreflightResult {
  ok: boolean
  reason: string | null
  login: string | null
}

export interface DetectedGhAccount {
  login: string
  active: boolean
  name: string | null
  email: string | null
}

export interface ApiKeyMeta {
  id: string
  /** preset id: anthropic | openai | gemini | deepseek | grok | mistral | groq | openrouter | qwen | deepseek-claude | kimi-claude | glm-claude | openrouter-claude | ollama-claude | custom */
  provider: string
  label: string
  /** env var carrying the secret, e.g. OPENAI_API_KEY */
  keyEnvVar: string
  /** non-secret env injected alongside the key (base URLs etc.) */
  extraEnv: Record<string, string>
  /** command auto-run in a terminal launched for this entry */
  launchCommand: string | null
  enabled: boolean
  /** 'global' = inject into every new terminal; 'launch' = only entry-launched terminals */
  scope: 'global' | 'launch'
  /** derived from the keychain; the secret itself never crosses IPC */
  hasValue: boolean
}

export type ApiKeyEntry = Omit<ApiKeyMeta, 'hasValue'>

export type ApiKeyTestResult =
  | { status: 'ok' }
  | { status: 'authFailed' }
  | { status: 'unreachable'; message: string }

export interface DetectedEnvKey {
  envVar: string
  maskedTail: string
}

export interface ClaudeAccountMeta {
  id: string
  email: string
  displayName: string | null
  /** raw Anthropic tier, e.g. "max_20x" — humanize with formatPlanName */
  plan: string | null
  /** epoch millis */
  addedAt: number
  /** refresh token rejected — needs re-login */
  refreshDead: boolean
  hasToken: boolean
}

export interface ClaudeAccountsList {
  accounts: ClaudeAccountMeta[]
  activeAccountId: string | null
}

export interface ClaudeUsageBucket {
  /** 0-100, may exceed 100 when over quota */
  utilization: number
  resetsAt: string | null
}

export interface ClaudeExtraUsage {
  isEnabled: boolean | null
  monthlyLimit: number | null
  usedCredits: number | null
  utilization: number | null
}

export interface ClaudeUsage {
  fiveHour: ClaudeUsageBucket | null
  sevenDay: ClaudeUsageBucket | null
  extraUsage: ClaudeExtraUsage | null
  /** epoch millis */
  fetchedAt: number
}

export interface ClaudeAccountUsage {
  accountId: string
  usage: ClaudeUsage | null
  error: string | null
}

/** Connectivity mode for remote access. */
export type RemoteMode = 'cloudflare' | 'local' | 'tailscale'

export interface TailscaleInfo {
  /** This machine's tailnet IPv4 address. */
  ip: string
  /** MagicDNS name, when resolvable. */
  dnsName: string | null
}

export interface RemoteStatus {
  running: boolean
  mode: RemoteMode | null
  port: number | null
  /** User-facing URL to scan/share (tunnel URL in Cloudflare mode, else local). */
  url: string | null
  /** Always the 127.0.0.1 URL the server binds. */
  localUrl: string | null
  pairingCode: string | null
  /** Unix-epoch ms the current session connected, if any. */
  connectedSince: number | null
  /** Non-fatal setup advice (e.g. how to unlock HTTPS in Tailscale mode). */
  hint: string | null
}

export interface RemoteStartInfo {
  port: number
  mode: RemoteMode
  url: string
  localUrl: string
  pairingCode: string
  hint: string | null
}

/** True when running inside the Tauri webview (false in a plain browser/dev). */
export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const ipc = {
  app: {
    version: () => invoke<string>('app_version'),
  },

  settings: {
    get: () => invoke<unknown | null>('settings_get'),
    set: (value: unknown) => invoke<void>('settings_set', { value }),
  },

  projects: {
    snapshot: () => invoke<AppStateSnapshot>('projects_snapshot'),
    add: (path: string) => invoke<Project>('projects_add', { path }),
    remove: (id: string) => invoke<void>('projects_remove', { id }),
    rename: (id: string, name: string) => invoke<void>('projects_rename', { id, name }),
    select: (id: string | null) => invoke<void>('projects_select', { id }),
    setActive: (projectId: string, terminalId: string | null) =>
      invoke<void>('projects_set_active', { projectId, terminalId }),
    openInTerminal: (id: string) => invoke<void>('project_open_in_terminal', { id }),
    openInFileManager: (id: string) => invoke<void>('project_open_in_file_manager', { id }),
  },

  terminals: {
    create: (opts: CreateTerminalOptions) =>
      invoke<TerminalRecord | null>('terminal_create', { args: opts }),
    /**
     * Subscribe to a terminal's output. `onData` first receives the replay
     * snapshot string, then each live chunk as it arrives over the channel.
     * Returns the snapshot promise (already delivered via onData too) so callers
     * can sequence the first write deterministically.
     */
    attach: (id: string, onData: (chunk: string) => void): Promise<string> => {
      const channel = new Channel<string>()
      channel.onmessage = onData
      return invoke<string>('terminal_attach', { id, channel })
    },
    write: (id: string, data: string) => invoke<void>('terminal_write', { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      invoke<void>('terminal_resize', { id, cols, rows }),
    kill: (id: string) => invoke<void>('terminal_kill', { id }),
    rename: (projectId: string, id: string, name: string) =>
      invoke<void>('terminal_rename', { projectId, id, name }),
    removeRecord: (projectId: string, id: string) =>
      invoke<void>('terminal_remove_record', { projectId, id }),
    onExit: (cb: (p: ExitPayload) => void): Promise<UnlistenFn> =>
      listen<ExitPayload>('terminals:exit', (e) => cb(e.payload)),
    remoteSize: (id: string) =>
      invoke<[number, number] | null>('terminal_remote_size', { id }),
    onRemoteSize: (cb: (p: RemoteSizePayload) => void): Promise<UnlistenFn> =>
      listen<RemoteSizePayload>('terminals:remote-size', (e) => cb(e.payload)),
  },

  fs: {
    list: (projectId: string, rel: string) =>
      invoke<FsEntry[]>('fs_list', { projectId, rel }),
    readText: (projectId: string, rel: string) =>
      invoke<ReadResult>('fs_read_text', { projectId, rel }),
    writeText: (projectId: string, rel: string, content: string) =>
      invoke<void>('fs_write_text', { projectId, rel, content }),
    createFile: (projectId: string, rel: string) =>
      invoke<void>('fs_create_file', { projectId, rel }),
    createFolder: (projectId: string, rel: string) =>
      invoke<void>('fs_create_folder', { projectId, rel }),
    rename: (projectId: string, from: string, to: string) =>
      invoke<void>('fs_rename', { projectId, from, to }),
    remove: (projectId: string, rel: string) =>
      invoke<void>('fs_remove', { projectId, rel }),
    duplicate: (projectId: string, rel: string) =>
      invoke<string>('fs_duplicate', { projectId, rel }),
    saveTempPaste: (bytes: number[], ext: string) =>
      invoke<string>('fs_save_temp_paste', { bytes, ext }),
    exportText: (path: string, content: string) =>
      invoke<void>('fs_export_text', { path, content }),
  },

  search: {
    query: (projectId: string, query: string, limit?: number) =>
      invoke<SearchQueryResult>('search_query', { projectId, query, limit }),
    indexStatus: (projectId: string) =>
      invoke<SearchIndexStatus>('search_index_status', { projectId }),
    rebuild: (projectId: string) => invoke<void>('search_rebuild', { projectId }),
  },

  git: {
    discoverRepos: (projectId: string, refresh = false) =>
      invoke<RepoInfo[]>('git_discover_repos', { projectId, refresh }),
    selectedRepo: (projectId: string) =>
      invoke<string | null>('git_selected_repo', { projectId }),
    setSelectedRepo: (projectId: string, repoId: string) =>
      invoke<void>('git_set_selected_repo', { projectId, repoId }),
    dirtyFlags: (projectId: string) =>
      invoke<Record<string, boolean>>('git_dirty_flags', { projectId }),
    info: (repoId: string) => invoke<GitInfo>('git_info', { repoId }),
    push: (repoId: string, branch: string) =>
      invoke<{ ok: boolean; output: string }>('git_push', { repoId, branch }),
    diff: (repoId: string) => invoke<FileDiff[]>('git_diff', { repoId }),
  },

  github: {
    getSettings: () => invoke<GithubSettings>('github_get_settings'),
    setClientId: (clientId: string | null) =>
      invoke<GithubSettings>('github_set_client_id', { clientId }),
    setToken: (token: string) => invoke<GithubSettings>('github_set_token', { token }),
    signOut: () => invoke<GithubSettings>('github_sign_out'),
    deviceStart: () => invoke<DeviceFlowStart>('github_device_start'),
    devicePoll: (deviceCode: string) => invoke<DevicePoll>('github_device_poll', { deviceCode }),
    listPullRequests: (repoId: string, state: 'open' | 'closed' | 'all' = 'open') =>
      invoke<PullRequestSummary[]>('github_list_prs', { repoId, state }),
    getPullRequest: (repoId: string, number: number) =>
      invoke<PullRequestDetail>('github_get_pr', { repoId, number }),
    createPullRequest: (input: CreatePullRequestInput) =>
      invoke<PullRequestSummary>('github_create_pr', { input }),
    mergePullRequest: (repoId: string, number: number, method: 'merge' | 'squash' | 'rebase') =>
      invoke<void>('github_merge_pr', { repoId, number, method }),
    commentPullRequest: (repoId: string, number: number, body: string) =>
      invoke<void>('github_comment_pr', { repoId, number, body }),
    listWorkflows: (repoId: string) =>
      invoke<WorkflowSummary[]>('github_list_workflows', { repoId }),
    listRuns: (repoId: string, branch?: string) =>
      invoke<WorkflowRunSummary[]>('github_list_runs', { repoId, branch }),
    getRun: (repoId: string, runId: number) =>
      invoke<WorkflowRunDetail>('github_get_run', { repoId, runId }),
    rerunRun: (repoId: string, runId: number) =>
      invoke<void>('github_rerun_run', { repoId, runId }),
    rerunFailed: (repoId: string, runId: number) =>
      invoke<void>('github_rerun_failed', { repoId, runId }),
    cancelRun: (repoId: string, runId: number) =>
      invoke<void>('github_cancel_run', { repoId, runId }),
    dispatchWorkflow: (
      repoId: string,
      workflowId: number,
      gitRef: string,
      inputs?: Record<string, string>
    ) => invoke<void>('github_dispatch_workflow', { repoId, workflowId, gitRef, inputs }),
  },

  claude: {
    listSessions: (projectId: string) =>
      invoke<ClaudeSession[]>('claude_sessions_list', { projectId }),
    deleteSession: (projectId: string, sessionId: string) =>
      invoke<void>('claude_session_delete', { projectId, sessionId }),
    hooksStatus: () => invoke<boolean>('claude_hooks_status'),
    hooksEnable: () => invoke<void>('claude_hooks_enable'),
    hooksDisable: () => invoke<void>('claude_hooks_disable'),
  },

  claudeAccounts: {
    list: () => invoke<ClaudeAccountsList>('claude_accounts_list'),
    addViaOauth: (loginHint?: string) =>
      invoke<ClaudeAccountsList>('claude_accounts_add_via_oauth', { loginHint }),
    loginCancel: () => invoke<void>('claude_accounts_login_cancel'),
    importCli: () => invoke<ClaudeAccountsList>('claude_accounts_import_cli'),
    switchTo: (id: string) => invoke<ClaudeAccountsList>('claude_accounts_switch', { id }),
    switchToApiKey: (id: string) =>
      invoke<ApiKeyMeta[]>('claude_accounts_switch_to_apikey', { id }),
    remove: (id: string) => invoke<ClaudeAccountsList>('claude_accounts_remove', { id }),
    usage: (force = false) =>
      invoke<ClaudeAccountUsage[]>('claude_accounts_usage', { force }),
  },

  identity: {
    listAccounts: () => invoke<Account[]>('identity_list_accounts'),
    getConfig: () => invoke<IdentityConfig>('identity_get_config'),
    saveAccount: (account: Account) =>
      invoke<Account[]>('identity_save_account', { account }),
    removeAccount: (id: string) => invoke<Account[]>('identity_remove_account', { id }),
    setConfig: (config: IdentityConfig) =>
      invoke<IdentityConfig>('identity_set_config', {
        defaultAccountId: config.defaultAccountId,
        unmappedBehavior: config.unmappedBehavior,
      }),
    resolve: (repoId: string) =>
      invoke<IdentityResolution>('identity_resolve', { repoId }),
    apply: (repoId: string, accountId: string) =>
      invoke<ApplyResult>('identity_apply', { repoId, accountId }),
    unmap: (repoId: string) => invoke<void>('identity_unmap', { repoId }),
    pushPreflight: (repoId: string) =>
      invoke<PreflightResult>('identity_push_preflight', { repoId }),
    current: (repoId: string) =>
      invoke<CurrentIdentity>('identity_current', { repoId }),
    applyGlobal: (accountId: string) =>
      invoke<void>('identity_apply_global', { accountId }),
    detectGhAccounts: () =>
      invoke<DetectedGhAccount[]>('identity_detect_gh_accounts'),
    alignGh: (login: string) => invoke<void>('identity_align_gh', { login }),
  },

  apikeys: {
    list: () => invoke<ApiKeyMeta[]>('apikeys_list'),
    /** `secret` null/empty = keep the existing stored secret (write-only field). */
    save: (entry: ApiKeyEntry, secret: string | null) =>
      invoke<ApiKeyMeta[]>('apikeys_save', { entry, secret }),
    remove: (id: string) => invoke<ApiKeyMeta[]>('apikeys_remove', { id }),
    setEnabled: (id: string, enabled: boolean) =>
      invoke<ApiKeyMeta[]>('apikeys_set_enabled', { id, enabled }),
    test: (id: string) => invoke<ApiKeyTestResult>('apikeys_test', { id }),
    detectEnv: () => invoke<DetectedEnvKey[]>('apikeys_detect_env'),
    importEnv: (envVar: string, provider: string, label: string, launchCommand: string | null) =>
      invoke<ApiKeyMeta[]>('apikeys_import_env', { envVar, provider, label, launchCommand }),
    /** PATH lookup for a CLI binary (prompt-then-install launch flow). */
    binaryExists: (name: string) => invoke<boolean>('binary_exists', { name }),
    /** Import probe for a Python module (prompt-then-install launch flow). */
    pythonModuleExists: (module: string) =>
      invoke<boolean>('python_module_exists', { module }),
  },

  // Remote access (only present when the app is built with the `remote-access`
  // cargo feature; calls reject with "command not found" otherwise).
  remote: {
    status: () => invoke<RemoteStatus>('remote_status'),
    start: (mode?: RemoteMode, port?: number, bindAll?: boolean) =>
      invoke<RemoteStartInfo>('remote_start', { mode, port, bindAll }),
    stop: () => invoke<void>('remote_stop'),
    regenerateCode: () => invoke<string | null>('remote_regenerate_code'),
    detectTailscale: () => invoke<TailscaleInfo | null>('remote_detect_tailscale'),
  },
}
