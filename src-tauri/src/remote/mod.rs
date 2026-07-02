//! Remote access: an embedded axum server that lets a paired web client control
//! terminals and view git over a WebSocket. Milestone 3a: localhost-only server,
//! protocol, pairing, and attach/type/create/close + snapshot replay.

mod bridge;
mod client;
pub mod protocol;
pub mod server;
pub mod session;

use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::AppHandle;

use session::SessionManager;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub port: u16,
    pub url: String,
    pub pairing_code: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub pairing_code: Option<String>,
    /// Unix-epoch milliseconds the current session connected, if any.
    pub connected_since: Option<u64>,
}

struct Running {
    port: u16,
    shutdown: tokio::sync::oneshot::Sender<()>,
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

    /// Bind 127.0.0.1:<port> (0 = OS-assigned), spawn the server on Tauri's
    /// async runtime, and return the bound port + a fresh pairing code.
    pub async fn start(&self, port: u16) -> Result<StartInfo, String> {
        if self.is_running() {
            return Err("remote access already running".into());
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("bind failed: {e}"))?;
        let actual = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .port();

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

        *self.inner.lock() = Some(Running { port: actual, shutdown });
        Ok(StartInfo {
            port: actual,
            url: format!("http://127.0.0.1:{actual}"),
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
                port: Some(running.port),
                url: Some(format!("http://127.0.0.1:{}", running.port)),
                pairing_code: self.sessions.current_code(),
                connected_since,
            },
            None => RemoteStatus {
                running: false,
                port: None,
                url: None,
                pairing_code: None,
                connected_since: None,
            },
        }
    }
}
