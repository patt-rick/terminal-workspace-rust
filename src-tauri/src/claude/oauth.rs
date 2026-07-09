//! PKCE OAuth against claude.ai (the flow Claude Code itself uses) plus the
//! token/profile HTTP calls. Constants verified against Agent-Orchestrator's
//! auth-service.ts / auth-token-endpoint-gateway.ts.

use crate::error::{AppError, AppResult};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
pub const TOKEN_ENDPOINT: &str = "https://platform.claude.com/v1/oauth/token";
pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
pub const OAUTH_SCOPES: &[&str] = &[
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub fn pkce_pair() -> (String, String) {
    let mut bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn random_state() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn build_authorize_url(
    challenge: &str,
    state: &str,
    port: u16,
    login_hint: Option<&str>,
) -> String {
    let redirect = format!("http://localhost:{port}/callback");
    let mut url = format!(
        "{AUTHORIZE_URL}?client_id={CLIENT_ID}&response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        urlencode(&redirect),
        urlencode(&OAUTH_SCOPES.join(" ")),
        urlencode(challenge),
        urlencode(state),
    );
    if let Some(hint) = login_hint {
        url.push_str(&format!("&login_hint={}", urlencode(hint)));
    }
    url
}

/// Minimal percent-encoding for query values (RFC 3986 unreserved kept).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(
                    std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                    16,
                ) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Extract (code, state) from the callback request path.
pub fn parse_callback_path(path: &str) -> Option<(String, String)> {
    let query = path.strip_prefix("/callback?")?;
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        match k {
            "code" => code = Some(urldecode(v)),
            "state" => state = Some(urldecode(v)),
            _ => {}
        }
    }
    Some((code?, state?))
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Block until the browser hits /callback with a valid state, the timeout
/// elapses, or `cancel` flips. Runs on a blocking thread (spawn_blocking).
pub fn wait_for_callback(
    listener: TcpListener,
    expected_state: &str,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
) -> AppResult<String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let deadline = Instant::now() + timeout;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Msg("login cancelled".to_string()));
        }
        if Instant::now() >= deadline {
            return Err(AppError::Msg(
                "login timed out after 5 minutes — no response from browser".to_string(),
            ));
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("");
                let parsed = parse_callback_path(path);
                let ok = parsed
                    .as_ref()
                    .map(|(_, s)| constant_time_eq(s.as_bytes(), expected_state.as_bytes()))
                    .unwrap_or(false);
                let body = if ok {
                    "<html><body style=\"font-family:sans-serif\"><h3>Signed in.</h3>You can close this tab and return to Terminal Workspace.</body></html>"
                } else {
                    "<html><body style=\"font-family:sans-serif\"><h3>Login failed.</h3>Invalid callback — return to the app and try again.</body></html>"
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.flush();
                if ok {
                    return Ok(parsed.expect("checked above").0);
                }
                // Not our callback (favicon, wrong state) — keep listening.
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(AppError::Msg(e.to_string())),
        }
    }
}

// ---- HTTP calls (token endpoint takes JSON bodies) ----

#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    /// seconds
    pub expires_in: i64,
}

pub async fn exchange_code(
    client: &reqwest::Client,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    state: &str,
) -> AppResult<TokenResponse> {
    let resp = client
        .post(TOKEN_ENDPOINT)
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirect_uri,
            "client_id": CLIENT_ID,
            "state": state,
        }))
        .send()
        .await
        .map_err(|e| AppError::Msg(format!("token exchange failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Msg(format!("token exchange failed: HTTP {status}")));
    }
    resp.json::<TokenResponse>()
        .await
        .map_err(|e| AppError::Msg(format!("token exchange returned invalid response: {e}")))
}

pub enum RefreshOutcome {
    Fresh(TokenResponse),
    /// invalid_grant — the refresh token is dead; re-login required.
    Dead,
    /// transient failure (network / 429 / 5xx) — try again later.
    Transient(String),
}

pub async fn do_refresh(client: &reqwest::Client, refresh_token: &str) -> RefreshOutcome {
    let resp = client
        .post(TOKEN_ENDPOINT)
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
        }))
        .send()
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => return RefreshOutcome::Transient(e.to_string()),
    };
    let status = resp.status();
    if status.is_success() {
        return match resp.json::<TokenResponse>().await {
            Ok(t) => RefreshOutcome::Fresh(t),
            Err(e) => RefreshOutcome::Transient(format!("invalid refresh response: {e}")),
        };
    }
    let body = resp.text().await.unwrap_or_default();
    // 400/401 with invalid_grant = dead token. Anything else is transient.
    if (status == 400 || status == 401) && body.contains("invalid_grant") {
        RefreshOutcome::Dead
    } else {
        RefreshOutcome::Transient(format!("HTTP {status}"))
    }
}

pub struct Profile {
    pub email: String,
    pub display_name: Option<String>,
    pub plan: Option<String>,
}

/// Fetch the account profile for a token. Email is required; a response
/// without one is an error (we key accounts by email).
pub async fn fetch_profile(client: &reqwest::Client, access_token: &str) -> AppResult<Profile> {
    let resp = client
        .get(PROFILE_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| AppError::Msg(format!("profile fetch failed: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Msg(format!("profile fetch failed: HTTP {status}")));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Msg(format!("profile returned invalid JSON: {e}")))?;
    let account = v.get("account");
    let email = account
        .and_then(|a| a.get("email"))
        .and_then(|e| e.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Msg("profile response had no email".to_string()))?
        .to_string();
    let display_name = account
        .and_then(|a| a.get("display_name").or_else(|| a.get("full_name")))
        .and_then(|d| d.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let plan = v
        .get("organization")
        .and_then(|o| o.get("rate_limit_tier"))
        .and_then(|p| p.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok(Profile { email, display_name, plan })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_pair_is_base64url_and_s256() {
        let (verifier, challenge) = pkce_pair();
        assert!(verifier.len() >= 43 && verifier.len() <= 128);
        assert!(verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        // challenge must equal base64url(sha256(verifier))
        use sha2::{Digest, Sha256};
        let expect = base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
            Sha256::digest(verifier.as_bytes()),
        );
        assert_eq!(challenge, expect);
        // two calls differ
        assert_ne!(pkce_pair().0, verifier);
    }

    #[test]
    fn parses_callback_query() {
        let r = parse_callback_path("/callback?code=abc123&state=st-1");
        assert_eq!(r, Some(("abc123".to_string(), "st-1".to_string())));
        // reversed param order
        let r2 = parse_callback_path("/callback?state=st-1&code=abc123");
        assert_eq!(r2, Some(("abc123".to_string(), "st-1".to_string())));
        // url-encoded characters decode
        let r3 = parse_callback_path("/callback?code=a%2Bb&state=s");
        assert_eq!(r3, Some(("a+b".to_string(), "s".to_string())));
        assert_eq!(parse_callback_path("/callback?code=only"), None);
        assert_eq!(parse_callback_path("/favicon.ico"), None);
    }

    #[test]
    fn state_compare_is_exact() {
        assert!(constant_time_eq(b"same-state", b"same-state"));
        assert!(!constant_time_eq(b"same-state", b"other-stat"));
        assert!(!constant_time_eq(b"short", b"longer-state"));
    }

    #[test]
    fn authorize_url_contains_required_params() {
        let url = build_authorize_url("challenge-x", "state-y", 8123, Some("hint@x.y"));
        assert!(url.starts_with("https://claude.ai/oauth/authorize?"));
        for needle in [
            "client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            "response_type=code",
            "code_challenge=challenge-x",
            "code_challenge_method=S256",
            "state=state-y",
            "redirect_uri=http%3A%2F%2Flocalhost%3A8123%2Fcallback",
            "login_hint=hint%40x.y",
        ] {
            assert!(url.contains(needle), "missing {needle} in {url}");
        }
        assert!(url.contains("scope=org%3Acreate_api_key+user%3Aprofile")
            || url.contains("scope=org%3Acreate_api_key%20user%3Aprofile"));
    }
}
