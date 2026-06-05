use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "com.ddnazzah.terminalworkspace";
const KEYRING_USER: &str = "github-token";
const API: &str = "https://api.github.com";
const DEFAULT_SCOPE: &str = "repo workflow read:user";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

// ---- persisted config (non-secret; token lives in the OS keychain) ----

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct GithubConfig {
    client_id: Option<String>,
    login: Option<String>,
    source: Option<String>,
    has_token: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSettings {
    pub client_id: Option<String>,
    pub has_token: bool,
    pub login: Option<String>,
    pub source: Option<String>,
}

pub struct GithubStore {
    path: PathBuf,
    inner: Mutex<GithubConfig>,
}

impl GithubStore {
    pub fn new(path: PathBuf) -> Self {
        let inner = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            inner: Mutex::new(inner),
        }
    }

    fn persist(&self, cfg: &GithubConfig) {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string_pretty(cfg) {
            let tmp = self.path.with_extension("tmp");
            if fs::write(&tmp, s).is_ok() {
                let _ = fs::rename(&tmp, &self.path);
            }
        }
    }

    pub fn settings(&self) -> GithubSettings {
        let c = self.inner.lock();
        GithubSettings {
            client_id: c.client_id.clone(),
            has_token: c.has_token,
            login: c.login.clone(),
            source: c.source.clone(),
        }
    }

    pub fn client_id(&self) -> Option<String> {
        self.inner.lock().client_id.clone()
    }

    pub fn set_client_id(&self, id: Option<String>) {
        let mut c = self.inner.lock();
        c.client_id = id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        self.persist(&c);
    }

    pub fn token(&self) -> Option<String> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .ok()?
            .get_password()
            .ok()
    }

    pub fn require_token(&self) -> AppResult<String> {
        self.token()
            .ok_or_else(|| AppError::Msg("not authenticated".to_string()))
    }

    pub fn set_auth(&self, token: &str, login: Option<String>, source: &str) {
        if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
            let _ = e.set_password(token);
        }
        let mut c = self.inner.lock();
        c.has_token = true;
        c.login = login;
        c.source = Some(source.to_string());
        self.persist(&c);
    }

    pub fn sign_out(&self) {
        if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
            let _ = e.delete_credential();
        }
        let mut c = self.inner.lock();
        c.has_token = false;
        c.login = None;
        c.source = None;
        self.persist(&c);
    }
}

// ---- HTTP ----

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("terminal-workspace")
        .build()
        .unwrap_or_default()
}

/// Authenticated GitHub REST call returning the parsed JSON (Null for 204).
pub async fn api(
    token: &str,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> AppResult<Value> {
    let url = if path.starts_with("http") {
        path.to_string()
    } else {
        format!("{API}{path}")
    };
    let mut req = http()
        .request(method, &url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| AppError::Msg(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.as_u16() == 204 || text.is_empty() {
        return Ok(Value::Null);
    }
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
    if !status.is_success() {
        let msg = parsed
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("request failed")
            .to_string();
        return Err(AppError::Msg(format!("GitHub {}: {}", status.as_u16(), msg)));
    }
    Ok(parsed)
}

// ---- device flow ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

pub async fn device_start(client_id: &str) -> AppResult<DeviceFlowStart> {
    let resp = http()
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .json(&json!({ "client_id": client_id, "scope": DEFAULT_SCOPE }))
        .send()
        .await
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let v: Value = resp.json().await.map_err(|e| AppError::Msg(e.to_string()))?;
    let user_code = v["user_code"].as_str().unwrap_or_default().to_string();
    let verification_uri = v["verification_uri"].as_str().unwrap_or_default().to_string();
    Ok(DeviceFlowStart {
        device_code: v["device_code"].as_str().unwrap_or_default().to_string(),
        verification_uri_complete: v["verification_uri_complete"]
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| format!("{verification_uri}?user_code={user_code}")),
        user_code,
        verification_uri,
        expires_in: v["expires_in"].as_u64().unwrap_or(900),
        interval: v["interval"].as_u64().unwrap_or(5),
    })
}

/// One poll of the device-flow token endpoint. The frontend drives the polling
/// loop (honoring `interval`/`slow_down`).
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum DevicePoll {
    Pending,
    SlowDown { interval: u64 },
    Authorized { login: Option<String> },
    Error { error: String, description: Option<String> },
}

pub async fn device_poll(store: &GithubStore, client_id: &str, device_code: &str) -> DevicePoll {
    let resp = match http()
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .json(&json!({
            "client_id": client_id,
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return DevicePoll::Error {
                error: "network".to_string(),
                description: Some(e.to_string()),
            }
        }
    };
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if let Some(token) = v["access_token"].as_str() {
        let login = fetch_login(token).await;
        store.set_auth(token, login.clone(), "device");
        return DevicePoll::Authorized { login };
    }
    match v["error"].as_str() {
        Some("authorization_pending") => DevicePoll::Pending,
        Some("slow_down") => DevicePoll::SlowDown {
            interval: v["interval"].as_u64().unwrap_or(5),
        },
        other => DevicePoll::Error {
            error: other.unwrap_or("unknown_error").to_string(),
            description: v["error_description"].as_str().map(String::from),
        },
    }
}

pub async fn fetch_login(token: &str) -> Option<String> {
    let v = api(token, reqwest::Method::GET, "/user", None).await.ok()?;
    v["login"].as_str().map(String::from)
}

// ---- output models + mapping ----

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}
fn u(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(|x| x.as_u64()).unwrap_or(0)
}
fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub merged: bool,
    pub url: String,
    pub author: String,
    pub author_avatar: Option<String>,
    pub head_ref: String,
    pub base_ref: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn pr_summary(v: &Value) -> PullRequestSummary {
    PullRequestSummary {
        number: u(v, "number"),
        title: s(v, "title"),
        state: s(v, "state"),
        draft: b(v, "draft"),
        merged: v.get("merged").and_then(|m| m.as_bool()).unwrap_or(!v["merged_at"].is_null()),
        url: s(v, "html_url"),
        author: v["user"]["login"].as_str().unwrap_or_default().to_string(),
        author_avatar: v["user"]["avatar_url"].as_str().map(String::from),
        head_ref: v["head"]["ref"].as_str().unwrap_or_default().to_string(),
        base_ref: v["base"]["ref"].as_str().unwrap_or_default().to_string(),
        created_at: s(v, "created_at"),
        updated_at: s(v, "updated_at"),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestDetail {
    #[serde(flatten)]
    pub summary: PullRequestSummary,
    pub body: String,
    pub mergeable: Option<bool>,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub comments: Vec<PrComment>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub id: u64,
    pub author: String,
    pub avatar: Option<String>,
    pub body: String,
    pub created_at: String,
}

pub fn pr_detail(v: &Value, comments: &[Value]) -> PullRequestDetail {
    PullRequestDetail {
        summary: pr_summary(v),
        body: v["body"].as_str().unwrap_or_default().to_string(),
        mergeable: v.get("mergeable").and_then(|m| m.as_bool()),
        additions: u(v, "additions"),
        deletions: u(v, "deletions"),
        changed_files: u(v, "changed_files"),
        comments: comments
            .iter()
            .map(|c| PrComment {
                id: u(c, "id"),
                author: c["user"]["login"].as_str().unwrap_or_default().to_string(),
                avatar: c["user"]["avatar_url"].as_str().map(String::from),
                body: c["body"].as_str().unwrap_or_default().to_string(),
                created_at: s(c, "created_at"),
            })
            .collect(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummary {
    pub id: u64,
    pub name: String,
    pub path: String,
    pub state: String,
}

pub fn workflow_summary(v: &Value) -> WorkflowSummary {
    WorkflowSummary {
        id: u(v, "id"),
        name: s(v, "name"),
        path: s(v, "path"),
        state: s(v, "state"),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunSummary {
    pub id: u64,
    pub name: Option<String>,
    pub workflow_id: u64,
    pub branch: Option<String>,
    pub event: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub url: String,
    pub run_number: u64,
    pub actor: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn run_summary(v: &Value) -> WorkflowRunSummary {
    WorkflowRunSummary {
        id: u(v, "id"),
        name: v["name"].as_str().map(String::from),
        workflow_id: u(v, "workflow_id"),
        branch: v["head_branch"].as_str().map(String::from),
        event: s(v, "event"),
        status: s(v, "status"),
        conclusion: v["conclusion"].as_str().map(String::from),
        url: s(v, "html_url"),
        run_number: u(v, "run_number"),
        actor: v["actor"]["login"].as_str().unwrap_or_default().to_string(),
        created_at: s(v, "created_at"),
        updated_at: s(v, "updated_at"),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowJob {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub url: String,
    pub steps: Vec<JobStep>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStep {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub number: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunDetail {
    #[serde(flatten)]
    pub summary: WorkflowRunSummary,
    pub jobs: Vec<WorkflowJob>,
}

pub fn run_detail(v: &Value, jobs: &[Value]) -> WorkflowRunDetail {
    WorkflowRunDetail {
        summary: run_summary(v),
        jobs: jobs
            .iter()
            .map(|j| WorkflowJob {
                id: u(j, "id"),
                name: s(j, "name"),
                status: s(j, "status"),
                conclusion: j["conclusion"].as_str().map(String::from),
                url: s(j, "html_url"),
                steps: j["steps"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .map(|st| JobStep {
                                name: s(st, "name"),
                                status: s(st, "status"),
                                conclusion: st["conclusion"].as_str().map(String::from),
                                number: u(st, "number"),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect(),
    }
}
