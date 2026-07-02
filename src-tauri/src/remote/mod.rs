//! Remote access: an embedded axum server that lets a paired web client control
//! terminals and view git over a WebSocket. Milestone 3a: localhost-only server,
//! protocol, pairing, and attach/type/create/close + snapshot replay.

mod bridge;
mod client;
pub mod protocol;
pub mod server;
pub mod session;
pub mod tailscale;
pub mod tunnel;

use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::AppHandle;

use session::SessionManager;

/// Connectivity mode chosen at start time.
pub const MODE_CLOUDFLARE: &str = "cloudflare";
pub const MODE_LOCAL: &str = "local";
pub const MODE_TAILSCALE: &str = "tailscale";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub port: u16,
    pub mode: String,
    /// The URL to scan/share (the tunnel URL in Cloudflare mode, else the local URL).
    pub url: String,
    /// Always the `127.0.0.1` URL the server actually binds.
    pub local_url: String,
    pub pairing_code: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub mode: Option<String>,
    pub port: Option<u16>,
    /// The user-facing URL (tunnel or local).
    pub url: Option<String>,
    pub local_url: Option<String>,
    pub pairing_code: Option<String>,
    /// Unix-epoch milliseconds the current session connected, if any.
    pub connected_since: Option<u64>,
}

struct Running {
    port: u16,
    mode: String,
    url: String,
    local_url: String,
    shutdown: tokio::sync::oneshot::Sender<()>,
    /// Kept alive for the session; dropping it kills `cloudflared`.
    _tunnel: Option<tunnel::Tunnel>,
}

/// Managed state: owns the running server (if any) and the session manager.
pub struct RemoteServer {
    inner: Mutex<Option<Running>>,
    sessions: Arc<SessionManager>,
    app: AppHandle,
}

impl RemoteServer {
    pub fn new(app: AppHandle) -> Self {
        Self {
            inner: Mutex::new(None),
            sessions: Arc::new(SessionManager::new()),
            app,
        }
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().is_some()
    }

    /// Start remote access in the given mode.
    ///
    /// Bind address by mode (R3.6): Cloudflare and local bind `127.0.0.1` (only
    /// the tunnel, or this machine, can reach it); Tailscale binds the tailnet
    /// interface, or `0.0.0.0` when `bind_all` is set (an explicit opt-in the UI
    /// warns about). We never silently bind `0.0.0.0`. Returns the bound port,
    /// the user-facing URL, and a fresh pairing code.
    pub async fn start(&self, port: u16, mode: &str, bind_all: bool) -> Result<StartInfo, String> {
        use std::net::{IpAddr, Ipv4Addr};

        if self.is_running() {
            return Err("remote access already running".into());
        }

        // Tailscale needs the tailnet address resolved before we can bind it.
        let ts_info = if mode == MODE_TAILSCALE {
            let info = tokio::task::spawn_blocking(tailscale::detect)
                .await
                .ok()
                .flatten()
                .ok_or_else(|| {
                    "Tailscale isn't running on this machine. Install Tailscale, sign in, then \
                     start remote access again."
                        .to_string()
                })?;
            Some(info)
        } else {
            None
        };

        let bind_ip: IpAddr = match mode {
            MODE_TAILSCALE if bind_all => Ipv4Addr::UNSPECIFIED.into(),
            MODE_TAILSCALE => ts_info
                .as_ref()
                .unwrap()
                .ip
                .parse()
                .map_err(|_| "invalid tailnet address".to_string())?,
            _ => Ipv4Addr::LOCALHOST.into(),
        };

        let listener = tokio::net::TcpListener::bind((bind_ip, port))
            .await
            .map_err(|e| format!("bind failed: {e}"))?;
        let actual = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .port();
        let local_url = format!("http://{bind_ip}:{actual}");

        let code = self.sessions.new_code();
        let ctx = server::ServerCtx {
            app: self.app.clone(),
            sessions: self.sessions.clone(),
        };
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let router = server::router(ctx);
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        // Bring up the tunnel *after* the server is listening. If it fails, tear
        // the just-started server back down so we don't leak it.
        let (tunnel, url) = match mode {
            MODE_CLOUDFLARE => match tunnel::Tunnel::spawn(self.app.clone(), actual).await {
                Ok(t) => {
                    let url = t.url.clone();
                    (Some(t), url)
                }
                Err(e) => {
                    let _ = shutdown.send(());
                    self.sessions.reset();
                    return Err(e);
                }
            },
            MODE_TAILSCALE => {
                let host = ts_info.as_ref().unwrap().host();
                (None, format!("http://{host}:{actual}"))
            }
            _ => (None, local_url.clone()),
        };

        *self.inner.lock() = Some(Running {
            port: actual,
            mode: mode.to_string(),
            url: url.clone(),
            local_url: local_url.clone(),
            shutdown,
            _tunnel: tunnel,
        });
        Ok(StartInfo {
            port: actual,
            mode: mode.to_string(),
            url,
            local_url,
            pairing_code: code,
        })
    }

    /// Stop the server (graceful shutdown) and invalidate all pairing/token state.
    pub fn stop(&self) {
        if let Some(running) = self.inner.lock().take() {
            let _ = running.shutdown.send(());
        }
        self.sessions.reset();
    }

    /// Mint a fresh pairing code (only meaningful while running).
    pub fn regenerate_code(&self) -> Option<String> {
        if !self.is_running() {
            return None;
        }
        Some(self.sessions.new_code())
    }

    pub fn status(&self) -> RemoteStatus {
        let inner = self.inner.lock();
        let connected_since = self.sessions.connected_since().and_then(|t| {
            t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
        });
        match inner.as_ref() {
            Some(running) => RemoteStatus {
                running: true,
                mode: Some(running.mode.clone()),
                port: Some(running.port),
                url: Some(running.url.clone()),
                local_url: Some(running.local_url.clone()),
                pairing_code: self.sessions.current_code(),
                connected_since,
            },
            None => RemoteStatus {
                running: false,
                mode: None,
                port: None,
                url: None,
                local_url: None,
                pairing_code: None,
                connected_since: None,
            },
        }
    }
}
