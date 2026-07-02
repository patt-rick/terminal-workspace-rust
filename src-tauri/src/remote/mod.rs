//! Remote access: an embedded axum server that lets a paired web client control
//! terminals and view git over a WebSocket. Milestone 3a: localhost-only server,
//! protocol, pairing, and attach/type/create/close + snapshot replay.

mod bridge;
mod client;
pub mod protocol;
pub mod push;
pub mod ratelimit;
pub mod server;
pub mod session;
pub mod tailscale;
pub mod tunnel;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Listener, Manager};

use push::PushManager;
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
    /// Non-fatal setup advice (e.g. how to unlock HTTPS in Tailscale mode).
    pub hint: Option<String>,
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
    pub hint: Option<String>,
}

struct Running {
    port: u16,
    mode: String,
    url: String,
    local_url: String,
    hint: Option<String>,
    /// A `tailscale serve` HTTPS front is active and must be torn down on stop.
    serve_active: bool,
    /// Global bell/working listeners feeding Web Push; unlistened on stop.
    push_listeners: Vec<tauri::EventId>,
    shutdown: tokio::sync::oneshot::Sender<()>,
    /// Kept alive for the session; dropping it kills `cloudflared`.
    _tunnel: Option<tunnel::Tunnel>,
}

/// Managed state: owns the running server (if any) and the session manager.
pub struct RemoteServer {
    inner: Mutex<Option<Running>>,
    sessions: Arc<SessionManager>,
    /// Web Push (VAPID keys + subscription). None if keygen failed.
    push: Option<Arc<PushManager>>,
    app: AppHandle,
}

impl RemoteServer {
    pub fn new(app: AppHandle) -> Self {
        Self {
            inner: Mutex::new(None),
            sessions: Arc::new(SessionManager::new()),
            push: PushManager::new().map(Arc::new),
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

        // Tailscale mode wants a stable port (the serve config references it).
        let port = if mode == MODE_TAILSCALE && port == 0 { 8765 } else { port };

        // Try to front the server with `tailscale serve` HTTPS first. A secure
        // origin is required for the phone PWA (service worker, notifications,
        // install); when it works we bind localhost only — the HTTPS proxy is
        // the sole way in. Falls back to plain HTTP on the tailnet IP.
        let (serve_url, mut hint) = if mode == MODE_TAILSCALE && !bind_all {
            match tokio::task::spawn_blocking(move || tailscale::serve_start(port))
                .await
                .map_err(|e| e.to_string())?
            {
                Ok(url) => (Some(url), None),
                Err(why) => (None, Some(format!("HTTPS unavailable ({why})"))),
            }
        } else {
            (None, None)
        };

        let bind_ip: IpAddr = match mode {
            MODE_TAILSCALE if serve_url.is_some() => Ipv4Addr::LOCALHOST.into(),
            MODE_TAILSCALE if bind_all => Ipv4Addr::UNSPECIFIED.into(),
            MODE_TAILSCALE => ts_info
                .as_ref()
                .unwrap()
                .ip
                .parse()
                .map_err(|_| "invalid tailnet address".to_string())?,
            _ => Ipv4Addr::LOCALHOST.into(),
        };

        let listener = match tokio::net::TcpListener::bind((bind_ip, port)).await {
            Ok(l) => l,
            Err(e) => {
                // Don't leak the serve config if we never got a server behind it.
                if serve_url.is_some() {
                    let _ = tokio::task::spawn_blocking(tailscale::serve_stop);
                }
                return Err(format!("bind failed: {e}"));
            }
        };
        let actual = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .port();
        let local_url = format!("http://{bind_ip}:{actual}");

        let code = self.sessions.new_code();
        // Live-WebSocket count: pushes are only sent when this is zero (a
        // connected client shows notifications via its own service worker).
        let sockets = Arc::new(AtomicUsize::new(0));
        let ctx = server::ServerCtx {
            app: self.app.clone(),
            sessions: self.sessions.clone(),
            // ~10 /pair attempts burst per IP, refilling 1/6s (10/min sustained).
            rate_limit: Arc::new(ratelimit::RateLimiter::new(10.0, 1.0 / 6.0)),
            push: self.push.clone(),
            sockets: sockets.clone(),
        };
        let (shutdown, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let router = server::router(ctx);
        let make_service =
            router.into_make_service_with_connect_info::<std::net::SocketAddr>();
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, make_service)
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
            MODE_TAILSCALE => match &serve_url {
                Some(https) => (None, https.clone()),
                None => {
                    let host = ts_info.as_ref().unwrap().host();
                    if hint.is_some() {
                        hint = Some(format!(
                            "{} Serving plain HTTP — the phone PWA (install, notifications) \
                             needs the HTTPS address.",
                            hint.unwrap()
                        ));
                    }
                    (None, format!("http://{host}:{actual}"))
                }
            },
            _ => (None, local_url.clone()),
        };

        let serve_active = serve_url.is_some();
        let push_listeners = match &self.push {
            Some(push) => register_push_listeners(&self.app, push.clone(), sockets),
            None => Vec::new(),
        };
        *self.inner.lock() = Some(Running {
            port: actual,
            mode: mode.to_string(),
            url: url.clone(),
            local_url: local_url.clone(),
            hint: hint.clone(),
            serve_active,
            push_listeners,
            shutdown,
            _tunnel: tunnel,
        });
        Ok(StartInfo {
            port: actual,
            mode: mode.to_string(),
            url,
            local_url,
            pairing_code: code,
            hint,
        })
    }

    /// Stop the server (graceful shutdown) and invalidate all pairing/token state.
    pub fn stop(&self) {
        if let Some(running) = self.inner.lock().take() {
            let _ = running.shutdown.send(());
            if running.serve_active {
                // CLI call; keep it off whatever thread called stop().
                std::thread::spawn(tailscale::serve_stop);
            }
            for id in running.push_listeners {
                self.app.unlisten(id);
            }
        }
        if let Some(push) = &self.push {
            push.clear_subscription();
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
                hint: running.hint.clone(),
            },
            None => RemoteStatus {
                running: false,
                mode: None,
                port: None,
                url: None,
                local_url: None,
                pairing_code: None,
                connected_since: None,
                hint: None,
            },
        }
    }
}

#[derive(Deserialize)]
struct WorkingEvt {
    id: String,
    working: bool,
}

#[derive(Deserialize)]
struct BellEvt {
    id: String,
}

/// Terminal display name for notification text (best-effort).
fn terminal_name(app: &AppHandle, terminal_id: &str) -> String {
    app.state::<crate::state::StateStore>()
        .snapshot()
        .projects
        .iter()
        .flat_map(|p| p.terminals.iter())
        .find(|t| t.id == terminal_id)
        .map(|t| t.name.clone())
        .unwrap_or_else(|| "Terminal".to_string())
}

/// Listen for bell/working transitions while remote access is running, and
/// deliver them as Web Push when no client is connected (the phone's PWA is
/// closed or suspended). A connected client gets these over its socket instead.
fn register_push_listeners(
    app: &AppHandle,
    push: Arc<PushManager>,
    sockets: Arc<AtomicUsize>,
) -> Vec<tauri::EventId> {
    let mut ids = Vec::new();

    let (a, p, s) = (app.clone(), push.clone(), sockets.clone());
    ids.push(app.listen("terminals:bell", move |ev| {
        let Ok(evt) = serde_json::from_str::<BellEvt>(ev.payload()) else {
            return;
        };
        if s.load(Ordering::Relaxed) == 0 && p.has_subscription() {
            let title = terminal_name(&a, &evt.id);
            let p = p.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(why) = p.send(&title, "Bell").await {
                    eprintln!("web push failed: {why}");
                }
            });
        }
    }));

    let a = app.clone();
    ids.push(app.listen("terminals:working", move |ev| {
        let Ok(evt) = serde_json::from_str::<WorkingEvt>(ev.payload()) else {
            return;
        };
        // Always track durations; only send when it was a long-running task and
        // nobody is connected to see it live.
        let push_worthy = push.note_working(&evt.id, evt.working);
        if push_worthy && sockets.load(Ordering::Relaxed) == 0 && push.has_subscription() {
            let title = terminal_name(&a, &evt.id);
            let p = push.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(why) = p.send(&title, "Finished").await {
                    eprintln!("web push failed: {why}");
                }
            });
        }
    }));

    ids
}
