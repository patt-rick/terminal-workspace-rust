use crate::apikeys::{ApiKey, ApiKeyMeta, ApiKeyStore, DetectedEnvKey, TestResult};
use crate::error::{AppError, AppResult};
use crate::fs::{FsEntry, ReadResult};
use crate::git::discover::RepoInfo;
use crate::git::{FileDiff, GitInfo};
use crate::github::{
    self, DeviceFlowStart, DevicePoll, GithubSettings, GithubStore, PullRequestDetail,
    PullRequestSummary, WorkflowRunDetail, WorkflowRunSummary, WorkflowSummary,
};
use crate::identity::{
    Account, ApplyResult, CurrentIdentity, DetectedGhAccount, IdentityConfig, IdentityStore,
    Resolution, UnmappedBehavior,
};
use crate::pty::{shell, CreateOpts, PtyManager};
use crate::settings::SettingsStore;
use crate::state::{AppState, Project, StateStore, TerminalRecord};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

fn project_root(store: &StateStore, project_id: &str) -> AppResult<String> {
    store
        .project_path(project_id)
        .ok_or_else(|| AppError::Msg("project not found".to_string()))
}

// ---------- app ----------

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ---------- settings ----------

#[tauri::command]
pub fn settings_get(store: State<SettingsStore>) -> Option<Value> {
    store.get()
}

#[tauri::command]
pub fn settings_set(store: State<SettingsStore>, value: Value) -> AppResult<()> {
    store.set(value)
}

// ---------- projects ----------

#[tauri::command]
pub fn projects_snapshot(store: State<StateStore>) -> AppState {
    store.snapshot()
}

#[tauri::command]
pub fn projects_add(store: State<StateStore>, path: String) -> Project {
    store.add_project(path)
}

#[tauri::command]
pub fn projects_remove(store: State<StateStore>, id: String) {
    store.remove_project(&id)
}

#[tauri::command]
pub fn projects_rename(store: State<StateStore>, id: String, name: String) {
    store.rename_project(&id, name)
}

#[tauri::command]
pub fn projects_select(store: State<StateStore>, id: Option<String>) {
    store.select(id)
}

#[tauri::command]
pub fn projects_set_active(
    store: State<StateStore>,
    project_id: String,
    terminal_id: Option<String>,
) {
    store.set_active(project_id, terminal_id)
}

#[tauri::command]
pub fn project_open_in_terminal(store: State<StateStore>, id: String) -> AppResult<()> {
    let path = store
        .project_path(&id)
        .ok_or_else(|| AppError::Msg("project not found".to_string()))?;
    open_os_terminal(&path)
}

#[tauri::command]
pub fn project_open_in_file_manager(store: State<StateStore>, id: String) -> AppResult<()> {
    let path = store
        .project_path(&id)
        .ok_or_else(|| AppError::Msg("project not found".to_string()))?;
    open_file_manager(&path)
}

// ---------- terminals ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalArgs {
    pub project_id: String,
    pub name: Option<String>,
    pub shell: Option<String>,
    /// working dir relative to the project root; empty/absent = project root
    pub cwd: Option<String>,
    pub startup_command: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    pty: State<PtyManager>,
    store: State<StateStore>,
    args: CreateTerminalArgs,
) -> AppResult<Option<TerminalRecord>> {
    let Some(project_path) = store.project_path(&args.project_id) else {
        return Ok(None);
    };
    let cwd = match &args.cwd {
        Some(rel) if !rel.is_empty() => Path::new(&project_path)
            .join(rel)
            .to_string_lossy()
            .to_string(),
        _ => project_path.clone(),
    };
    let shell = args.shell.clone().unwrap_or_else(shell::default_shell);
    let id = Uuid::new_v4().to_string();
    let name = args
        .name
        .clone()
        .unwrap_or_else(|| format!("Terminal {}", store.terminal_count(&args.project_id) + 1));

    pty.create(
        &app,
        CreateOpts {
            id: id.clone(),
            cwd,
            shell: Some(shell.clone()),
            cols: args.cols.unwrap_or(80),
            rows: args.rows.unwrap_or(24),
            startup_command: args.startup_command.clone(),
            env: app.state::<ApiKeyStore>().resolved_env(),
        },
    )?;

    let record = TerminalRecord { id, name, shell };
    store.upsert_terminal(&args.project_id, record.clone());
    Ok(Some(record))
}

#[tauri::command]
pub fn terminal_attach(pty: State<PtyManager>, id: String, channel: Channel<String>) -> String {
    pty.attach(&id, channel)
}

#[tauri::command]
pub fn terminal_write(pty: State<PtyManager>, id: String, data: String) {
    pty.write(&id, &data)
}

#[tauri::command]
pub fn terminal_resize(pty: State<PtyManager>, id: String, cols: u16, rows: u16) {
    pty.resize(&id, cols, rows)
}

/// Size a remote client currently mandates for this terminal, if one is
/// attached (remote-wins sizing). Lets a freshly mounted pane adopt the remote grid.
#[tauri::command]
pub fn terminal_remote_size(pty: State<PtyManager>, id: String) -> Option<(u16, u16)> {
    #[cfg(feature = "remote-access")]
    {
        pty.remote_size(&id)
    }
    #[cfg(not(feature = "remote-access"))]
    {
        let _ = (pty, id);
        None
    }
}

#[tauri::command]
pub fn terminal_kill(pty: State<PtyManager>, id: String) {
    pty.kill(&id)
}

#[tauri::command]
pub fn terminal_rename(store: State<StateStore>, project_id: String, id: String, name: String) {
    store.rename_terminal(&project_id, &id, name)
}

#[tauri::command]
pub fn terminal_remove_record(store: State<StateStore>, project_id: String, id: String) {
    store.remove_terminal(&project_id, &id)
}

// ---------- filesystem ----------

#[tauri::command]
pub async fn fs_list(
    store: State<'_, StateStore>,
    project_id: String,
    rel: String,
) -> AppResult<Vec<FsEntry>> {
    // The gitignore walk + dir read is blocking I/O; run it off the main thread
    // so a large directory can't freeze the UI.
    let root = project_root(&store, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || crate::fs::list(Path::new(&root), &rel))
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?
}

#[tauri::command]
pub fn fs_read_text(store: State<StateStore>, project_id: String, rel: String) -> AppResult<ReadResult> {
    let root = project_root(&store, &project_id)?;
    crate::fs::read_text(Path::new(&root), &rel)
}

#[tauri::command]
pub fn fs_write_text(
    store: State<StateStore>,
    project_id: String,
    rel: String,
    content: String,
) -> AppResult<()> {
    let root = project_root(&store, &project_id)?;
    crate::fs::write_text(Path::new(&root), &rel, &content)
}

#[tauri::command]
pub fn fs_create_file(store: State<StateStore>, project_id: String, rel: String) -> AppResult<()> {
    let root = project_root(&store, &project_id)?;
    crate::fs::create_file(Path::new(&root), &rel)
}

#[tauri::command]
pub fn fs_create_folder(store: State<StateStore>, project_id: String, rel: String) -> AppResult<()> {
    let root = project_root(&store, &project_id)?;
    crate::fs::create_folder(Path::new(&root), &rel)
}

#[tauri::command]
pub fn fs_rename(store: State<StateStore>, project_id: String, from: String, to: String) -> AppResult<()> {
    let root = project_root(&store, &project_id)?;
    crate::fs::rename(Path::new(&root), &from, &to)
}

#[tauri::command]
pub fn fs_remove(store: State<StateStore>, project_id: String, rel: String) -> AppResult<()> {
    let root = project_root(&store, &project_id)?;
    crate::fs::remove(Path::new(&root), &rel)
}

#[tauri::command]
pub fn fs_duplicate(store: State<StateStore>, project_id: String, rel: String) -> AppResult<String> {
    let root = project_root(&store, &project_id)?;
    crate::fs::duplicate(Path::new(&root), &rel)
}

#[tauri::command]
pub fn fs_save_temp_paste(bytes: Vec<u8>, ext: String) -> AppResult<String> {
    crate::fs::save_temp_paste(&bytes, &ext)
}

#[tauri::command]
pub fn fs_export_text(path: String, content: String) -> AppResult<()> {
    crate::fs::write_text_abs(&path, &content)
}

// ---------- git ----------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub ok: bool,
    pub output: String,
}

/// Resolve a picker `repo_id` to its absolute working directory.
fn repo_root(store: &StateStore, repo_id: &str) -> AppResult<String> {
    store
        .repo_path(repo_id)
        .ok_or_else(|| AppError::Msg("repo not found".to_string()))
}

/// Discover (or revalidate) the git repos under a project. `refresh=false`
/// returns the cached list with stale entries (missing `.git`) pruned; `true`
/// runs a full recursive rescan. Both persist the result.
#[tauri::command]
pub async fn git_discover_repos(
    store: State<'_, StateStore>,
    project_id: String,
    refresh: bool,
) -> AppResult<Vec<RepoInfo>> {
    let root = project_root(&store, &project_id)?;
    let cached = store.get_repos(&project_id);

    if !refresh && !cached.is_empty() {
        // Cheap focus revalidation: drop repos whose `.git` vanished.
        let valid: Vec<RepoInfo> = cached
            .into_iter()
            .filter(|r| Path::new(&r.path).join(".git").exists())
            .collect();
        store.set_repos(&project_id, valid.clone());
        return Ok(valid);
    }

    let pid = project_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::git::discover::discover_repos(&pid, Path::new(&root))
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))?;
    if result.capped {
        eprintln!(
            "git_discover_repos: directory-visit cap hit for project {project_id}; results may be incomplete"
        );
    }
    store.set_repos(&project_id, result.repos.clone());
    Ok(result.repos)
}

#[tauri::command]
pub fn git_selected_repo(store: State<StateStore>, project_id: String) -> Option<String> {
    store.selected_repo(&project_id)
}

#[tauri::command]
pub fn git_set_selected_repo(store: State<StateStore>, project_id: String, repo_id: String) {
    store.set_selected_repo(project_id, repo_id);
}

/// Per-repo working-tree dirty flags (repo_id → dirty) for the picker dots and
/// the aggregate Git-tab indicator. Computed off the main thread.
#[tauri::command]
pub async fn git_dirty_flags(
    store: State<'_, StateStore>,
    project_id: String,
) -> AppResult<std::collections::HashMap<String, bool>> {
    let repos = store.get_repos(&project_id);
    tauri::async_runtime::spawn_blocking(move || -> std::collections::HashMap<String, bool> {
        repos
            .into_iter()
            .map(|r| (r.id, crate::git::is_dirty(Path::new(&r.path))))
            .collect()
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))
}

#[tauri::command]
pub async fn git_info(store: State<'_, StateStore>, repo_id: String) -> AppResult<GitInfo> {
    let root = repo_root(&store, &repo_id)?;
    tauri::async_runtime::spawn_blocking(move || crate::git::get_info(Path::new(&root)))
        .await
        .map_err(|e| AppError::Msg(e.to_string()))
}

#[tauri::command]
pub async fn git_push(
    store: State<'_, StateStore>,
    repo_id: String,
    branch: String,
) -> AppResult<PushResult> {
    let root = repo_root(&store, &repo_id)?;
    let (ok, output) = tauri::async_runtime::spawn_blocking(move || {
        crate::git::push(Path::new(&root), &branch)
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))?;
    Ok(PushResult { ok, output })
}

#[tauri::command]
pub async fn git_diff(store: State<'_, StateStore>, repo_id: String) -> AppResult<Vec<FileDiff>> {
    let root = repo_root(&store, &repo_id)?;
    tauri::async_runtime::spawn_blocking(move || crate::git::diff(Path::new(&root)).map_err(AppError::Msg))
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?
}

// ---------- github ----------

/// Resolve a Phase 2 `repo_id` to its GitHub `(owner, repo)` slug, parsed from
/// that repo's origin (Phase 4 / R4.1: GitHub operations target the picker-
/// selected sub-repo, not the project root).
fn repo_slug_by_id(store: &StateStore, repo_id: &str) -> AppResult<(String, String)> {
    let path = store
        .repo_path(repo_id)
        .ok_or_else(|| AppError::Msg("repo not found".to_string()))?;
    let info = crate::git::get_info(Path::new(&path));
    let gh = info
        .github_repo
        .ok_or_else(|| AppError::Msg("repo has no github remote".to_string()))?;
    Ok((gh.owner, gh.repo))
}

#[tauri::command]
pub fn github_get_settings(gh: State<GithubStore>) -> GithubSettings {
    gh.settings()
}

#[tauri::command]
pub fn github_set_client_id(gh: State<GithubStore>, client_id: Option<String>) -> GithubSettings {
    gh.set_client_id(client_id);
    gh.settings()
}

#[tauri::command]
pub async fn github_set_token(gh: State<'_, GithubStore>, token: String) -> AppResult<GithubSettings> {
    let login = github::fetch_login(&token).await;
    gh.set_auth(&token, login, "pat");
    Ok(gh.settings())
}

#[tauri::command]
pub fn github_sign_out(gh: State<GithubStore>) -> GithubSettings {
    gh.sign_out();
    gh.settings()
}

#[tauri::command]
pub async fn github_device_start(gh: State<'_, GithubStore>) -> AppResult<DeviceFlowStart> {
    let client_id = gh
        .client_id()
        .ok_or_else(|| AppError::Msg("no OAuth client id configured".to_string()))?;
    github::device_start(&client_id).await
}

#[tauri::command]
pub async fn github_device_poll(
    gh: State<'_, GithubStore>,
    device_code: String,
) -> AppResult<DevicePoll> {
    let client_id = gh
        .client_id()
        .ok_or_else(|| AppError::Msg("no OAuth client id configured".to_string()))?;
    Ok(github::device_poll(&gh, &client_id, &device_code).await)
}

#[tauri::command]
pub async fn github_list_prs(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    repo_id: String,
    state: Option<String>,
) -> AppResult<Vec<PullRequestSummary>> {
    let token = gh.require_token()?;
    let (owner, repo) = repo_slug_by_id(&store, &repo_id)?;
    let st = state.unwrap_or_else(|| "open".to_string());
    let path = format!("/repos/{owner}/{repo}/pulls?state={st}&per_page=50&sort=updated&direction=desc");
    let v = github::api(&token, Method::GET, &path, None).await?;
    Ok(v.as_array()
        .map(|a| a.iter().map(github::pr_summary).collect())
        .unwrap_or_default())
}

#[tauri::command]
pub async fn github_get_pr(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    repo_id: String,
    number: u64,
) -> AppResult<PullRequestDetail> {
    let token = gh.require_token()?;
    let (owner, repo) = repo_slug_by_id(&store, &repo_id)?;
    let pr = github::api(&token, Method::GET, &format!("/repos/{owner}/{repo}/pulls/{number}"), None).await?;
    let comments = github::api(
        &token,
        Method::GET,
        &format!("/repos/{owner}/{repo}/issues/{number}/comments?per_page=100"),
        None,
    )
    .await
    .ok()
    .and_then(|v| v.as_array().cloned())
    .unwrap_or_default();
    Ok(github::pr_detail(&pr, &comments))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePrInput {
    pub repo_id: String,
    pub title: String,
    pub body: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
}

#[tauri::command]
pub async fn github_create_pr(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    input: CreatePrInput,
) -> AppResult<PullRequestSummary> {
    let token = gh.require_token()?;
    let (owner, repo) = repo_slug_by_id(&store, &input.repo_id)?;
    let body = json!({
        "title": input.title, "body": input.body,
        "head": input.head, "base": input.base, "draft": input.draft,
    });
    let v = github::api(&token, Method::POST, &format!("/repos/{owner}/{repo}/pulls"), Some(body)).await?;
    Ok(github::pr_summary(&v))
}

#[tauri::command]
pub async fn github_merge_pr(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    repo_id: String,
    number: u64,
    method: String,
) -> AppResult<()> {
    let token = gh.require_token()?;
    let (owner, repo) = repo_slug_by_id(&store, &repo_id)?;
    github::api(
        &token,
        Method::PUT,
        &format!("/repos/{owner}/{repo}/pulls/{number}/merge"),
        Some(json!({ "merge_method": method })),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn github_comment_pr(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    repo_id: String,
    number: u64,
    body: String,
) -> AppResult<()> {
    let token = gh.require_token()?;
    let (owner, repo) = repo_slug_by_id(&store, &repo_id)?;
    github::api(
        &token,
        Method::POST,
        &format!("/repos/{owner}/{repo}/issues/{number}/comments"),
        Some(json!({ "body": body })),
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn github_list_workflows(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    repo_id: String,
) -> AppResult<Vec<WorkflowSummary>> {
    let token = gh.require_token()?;
    let (owner, repo) = repo_slug_by_id(&store, &repo_id)?;
    let v = github::api(&token, Method::GET, &format!("/repos/{owner}/{repo}/actions/workflows"), None).await?;
    Ok(v["workflows"]
        .as_array()
        .map(|a| a.iter().map(github::workflow_summary).collect())
        .unwrap_or_default())
}

#[tauri::command]
pub async fn github_list_runs(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    repo_id: String,
    branch: Option<String>,
) -> AppResult<Vec<WorkflowRunSummary>> {
    let token = gh.require_token()?;
    let (owner, repo) = repo_slug_by_id(&store, &repo_id)?;
    let mut path = format!("/repos/{owner}/{repo}/actions/runs?per_page=30");
    if let Some(br) = branch {
        path.push_str(&format!("&branch={br}"));
    }
    let v = github::api(&token, Method::GET, &path, None).await?;
    Ok(v["workflow_runs"]
        .as_array()
        .map(|a| a.iter().map(github::run_summary).collect())
        .unwrap_or_default())
}

#[tauri::command]
pub async fn github_get_run(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    repo_id: String,
    run_id: u64,
) -> AppResult<WorkflowRunDetail> {
    let token = gh.require_token()?;
    let (owner, repo) = repo_slug_by_id(&store, &repo_id)?;
    let run = github::api(&token, Method::GET, &format!("/repos/{owner}/{repo}/actions/runs/{run_id}"), None).await?;
    let jobs = github::api(
        &token,
        Method::GET,
        &format!("/repos/{owner}/{repo}/actions/runs/{run_id}/jobs?per_page=50"),
        None,
    )
    .await
    .ok()
    .and_then(|v| v["jobs"].as_array().cloned())
    .unwrap_or_default();
    Ok(github::run_detail(&run, &jobs))
}

async fn run_action(
    gh: &GithubStore,
    store: &StateStore,
    repo_id: &str,
    run_id: u64,
    action: &str,
) -> AppResult<()> {
    let token = gh.require_token()?;
    let (owner, repo) = repo_slug_by_id(store, repo_id)?;
    github::api(
        &token,
        Method::POST,
        &format!("/repos/{owner}/{repo}/actions/runs/{run_id}/{action}"),
        None,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn github_rerun_run(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    repo_id: String,
    run_id: u64,
) -> AppResult<()> {
    run_action(&gh, &store, &repo_id, run_id, "rerun").await
}

#[tauri::command]
pub async fn github_rerun_failed(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    repo_id: String,
    run_id: u64,
) -> AppResult<()> {
    run_action(&gh, &store, &repo_id, run_id, "rerun-failed-jobs").await
}

#[tauri::command]
pub async fn github_cancel_run(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    repo_id: String,
    run_id: u64,
) -> AppResult<()> {
    run_action(&gh, &store, &repo_id, run_id, "cancel").await
}

#[tauri::command]
pub async fn github_dispatch_workflow(
    gh: State<'_, GithubStore>,
    store: State<'_, StateStore>,
    repo_id: String,
    workflow_id: u64,
    git_ref: String,
    inputs: Option<Value>,
) -> AppResult<()> {
    let token = gh.require_token()?;
    let (owner, repo) = repo_slug_by_id(&store, &repo_id)?;
    let mut body = json!({ "ref": git_ref });
    if let Some(i) = inputs {
        body["inputs"] = i;
    }
    github::api(
        &token,
        Method::POST,
        &format!("/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches"),
        Some(body),
    )
    .await?;
    Ok(())
}

// ---------- claude sessions ----------

fn home_dir(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    app.path()
        .home_dir()
        .map_err(|e| AppError::Msg(e.to_string()))
}

#[tauri::command]
pub async fn claude_sessions_list(
    app: AppHandle,
    store: State<'_, StateStore>,
    project_id: String,
) -> AppResult<Vec<crate::claude::SessionSummary>> {
    // Reading and parsing every session transcript (can be hundreds of MB) is
    // heavy blocking work; keep it off the main thread so the UI stays live.
    let root = project_root(&store, &project_id)?;
    let home = home_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || crate::claude::list_sessions(&home, &root))
        .await
        .map_err(|e| AppError::Msg(e.to_string()))
}

fn claude_settings_path(app: &AppHandle) -> AppResult<std::path::PathBuf> {
    Ok(home_dir(app)?.join(".claude").join("settings.json"))
}

/// Whether the attention hooks are installed in the user's Claude settings.
#[tauri::command]
pub fn claude_hooks_status(app: AppHandle) -> AppResult<bool> {
    Ok(crate::claude::hooks::is_installed(&claude_settings_path(&app)?))
}

/// Opt-in: install the Notification/Stop hooks (marker-based, preserves any
/// existing user hooks).
#[tauri::command]
pub fn claude_hooks_enable(app: AppHandle) -> AppResult<()> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let spool = crate::claude::hooks::spool_dir(&data_dir);
    crate::claude::hooks::install(&claude_settings_path(&app)?, &spool).map_err(AppError::Msg)
}

#[tauri::command]
pub fn claude_hooks_disable(app: AppHandle) -> AppResult<()> {
    crate::claude::hooks::uninstall(&claude_settings_path(&app)?).map_err(AppError::Msg)
}

#[tauri::command]
pub fn claude_session_delete(
    app: AppHandle,
    store: State<StateStore>,
    project_id: String,
    session_id: String,
) -> AppResult<()> {
    let root = project_root(&store, &project_id)?;
    let home = home_dir(&app)?;
    crate::claude::delete_session(&home, &root, &session_id)
}

// ---------- identity (account switcher) ----------

#[tauri::command]
pub fn identity_list_accounts(ids: State<IdentityStore>) -> Vec<Account> {
    ids.accounts()
}

#[tauri::command]
pub fn identity_get_config(ids: State<IdentityStore>) -> IdentityConfig {
    ids.config()
}

#[tauri::command]
pub fn identity_save_account(ids: State<IdentityStore>, account: Account) -> Vec<Account> {
    ids.save_account(account)
}

#[tauri::command]
pub fn identity_remove_account(ids: State<IdentityStore>, id: String) -> Vec<Account> {
    ids.remove_account(&id)
}

#[tauri::command]
pub fn identity_set_config(
    ids: State<IdentityStore>,
    default_account_id: Option<String>,
    unmapped_behavior: UnmappedBehavior,
) -> IdentityConfig {
    ids.set_config(default_account_id, unmapped_behavior)
}

#[tauri::command]
pub fn identity_resolve(
    ids: State<IdentityStore>,
    store: State<StateStore>,
    repo_id: String,
) -> AppResult<Resolution> {
    let root = repo_root(&store, &repo_id)?;
    let info = crate::git::get_info(Path::new(&root));
    // Git identity only applies to git repos. For a non-repo project there is
    // nothing to resolve (and applying would fail in `Repository::discover`), so
    // never prompt the picker for it.
    if !info.is_repo {
        return Ok(Resolution::None);
    }
    let owner = info.github_repo.as_ref().map(|g| g.owner.clone());
    Ok(ids.resolve_for(&root, owner.as_deref()))
}

#[tauri::command]
pub fn identity_apply(
    ids: State<IdentityStore>,
    store: State<StateStore>,
    repo_id: String,
    account_id: String,
) -> AppResult<ApplyResult> {
    let root = repo_root(&store, &repo_id)?;
    ids.apply(&root, &account_id)
}

#[tauri::command]
pub fn identity_current(
    ids: State<IdentityStore>,
    store: State<StateStore>,
    repo_id: String,
) -> AppResult<CurrentIdentity> {
    let root = repo_root(&store, &repo_id)?;
    Ok(ids.current(&root))
}

#[tauri::command]
pub fn identity_apply_global(ids: State<IdentityStore>, account_id: String) -> AppResult<()> {
    ids.apply_global(&account_id)
}

#[tauri::command]
pub fn identity_detect_gh_accounts() -> AppResult<Vec<DetectedGhAccount>> {
    crate::identity::detect_gh_accounts()
}

// ---------- provider API keys ----------

#[tauri::command]
pub fn apikeys_list(store: State<ApiKeyStore>) -> Vec<ApiKeyMeta> {
    store.list()
}

#[tauri::command]
pub fn apikeys_save(
    store: State<ApiKeyStore>,
    entry: ApiKey,
    secret: Option<String>,
) -> AppResult<Vec<ApiKeyMeta>> {
    // Treat an empty paste as "no change" so the write-only field can be
    // submitted blank when editing.
    let secret = secret.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    store.save(entry, secret)?;
    Ok(store.list())
}

#[tauri::command]
pub fn apikeys_remove(store: State<ApiKeyStore>, id: String) -> Vec<ApiKeyMeta> {
    store.remove(&id);
    store.list()
}

#[tauri::command]
pub fn apikeys_set_enabled(store: State<ApiKeyStore>, id: String, enabled: bool) -> Vec<ApiKeyMeta> {
    store.set_enabled(&id, enabled);
    store.list()
}

#[tauri::command]
pub async fn apikeys_test(store: State<'_, ApiKeyStore>, id: String) -> AppResult<TestResult> {
    let (provider, base, secret) = store.test_inputs(&id)?;
    let req = crate::apikeys::build_test_request(&provider, base.as_deref(), &secret);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let mut r = client.get(&req.url);
    for (k, v) in &req.headers {
        r = r.header(k, v);
    }
    Ok(match r.send().await {
        Ok(resp) if resp.status().is_success() => TestResult::Ok,
        Ok(resp)
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED
                || resp.status() == reqwest::StatusCode::FORBIDDEN =>
        {
            TestResult::AuthFailed
        }
        Ok(resp) => TestResult::Unreachable {
            message: format!("HTTP {}", resp.status()),
        },
        Err(e) => TestResult::Unreachable {
            message: e.to_string(),
        },
    })
}

#[tauri::command]
pub fn apikeys_detect_env(store: State<ApiKeyStore>) -> Vec<DetectedEnvKey> {
    crate::apikeys::detect_candidates(&store.keys_snapshot(), |name| std::env::var(name).ok())
}

#[tauri::command]
pub fn apikeys_import_env(
    store: State<ApiKeyStore>,
    env_var: String,
    provider: String,
    label: String,
    launch_command: Option<String>,
) -> AppResult<Vec<ApiKeyMeta>> {
    let secret = std::env::var(&env_var)
        .map_err(|_| AppError::Msg(format!("{env_var} is not set in the app's environment")))?;
    let entry = ApiKey {
        id: Uuid::new_v4().to_string(),
        provider,
        label,
        key_env_var: env_var,
        extra_env: Default::default(),
        launch_command,
        enabled: true,
    };
    store.save(entry, Some(secret.trim().to_string()))?;
    Ok(store.list())
}

// ---------- remote access (feature-gated) ----------

#[cfg(feature = "remote-access")]
#[tauri::command]
pub async fn remote_start(
    server: State<'_, crate::remote::RemoteServer>,
    port: Option<u16>,
    mode: Option<String>,
    bind_all: Option<bool>,
) -> AppResult<crate::remote::StartInfo> {
    let mode = mode.unwrap_or_else(|| crate::remote::MODE_CLOUDFLARE.to_string());
    server
        .start(port.unwrap_or(0), &mode, bind_all.unwrap_or(false))
        .await
        .map_err(AppError::Msg)
}

#[cfg(feature = "remote-access")]
#[tauri::command]
pub async fn remote_detect_tailscale() -> Option<crate::remote::tailscale::TailscaleInfo> {
    tokio::task::spawn_blocking(crate::remote::tailscale::detect)
        .await
        .ok()
        .flatten()
}

#[cfg(feature = "remote-access")]
#[tauri::command]
pub fn remote_stop(server: State<crate::remote::RemoteServer>) {
    server.stop();
}

#[cfg(feature = "remote-access")]
#[tauri::command]
pub fn remote_status(server: State<crate::remote::RemoteServer>) -> crate::remote::RemoteStatus {
    server.status()
}

#[cfg(feature = "remote-access")]
#[tauri::command]
pub fn remote_regenerate_code(server: State<crate::remote::RemoteServer>) -> Option<String> {
    server.regenerate_code()
}

// ---------- helpers ----------

fn open_os_terminal(path: &str) -> AppResult<()> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Terminal", path])
            .spawn()
            .map_err(AppError::from)?;
    }
    #[cfg(target_os = "windows")]
    {
        // Prefer Windows Terminal; fall back to a new cmd window.
        if Command::new("wt").args(["-d", path]).spawn().is_err() {
            Command::new("cmd")
                .args(["/c", "start", "cmd", "/k", "cd", "/d", path])
                .spawn()
                .map_err(AppError::from)?;
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Best-effort on Linux: try a few common terminals.
        let tried = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
            .iter()
            .any(|t| Command::new(t).current_dir(path).spawn().is_ok());
        if !tried {
            return Err(AppError::Msg("no terminal emulator found".to_string()));
        }
    }
    Ok(())
}

fn open_file_manager(path: &str) -> AppResult<()> {
    use std::process::Command;
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg(path).spawn().map_err(AppError::from)?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).spawn().map_err(AppError::from)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(path).spawn().map_err(AppError::from)?;
    }
    Ok(())
}
