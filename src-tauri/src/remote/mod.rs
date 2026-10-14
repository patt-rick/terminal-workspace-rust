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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::watch;

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
    /// Set while a `tailscale serve` HTTPS front we installed is active.
    serve: Option<ServeOwnership>,
    /// Global bell/working listeners feeding Web Push; unlistened on stop.
    push_listeners: Vec<tauri::EventId>,
    shutdown: tokio::sync::oneshot::Sender<()>,
    /// Kept alive for the session; dropping it kills `cloudflared`.
    _tunnel: Option<tunnel::Tunnel>,
}

/// A `tailscale serve` front this app installed: the nonce that lets teardown
/// remove exactly that config, and the lease that marks it as live to other
/// copies of the app. The lease is released once teardown has finished.
struct ServeOwnership {
    nonce: String,
    _lease: tailscale::ServeLease,
}

/// How long a background serve teardown may take. Longer than a start can hold
/// the serve lock (a status query plus `serve --bg`), so a Stop followed at once
/// by a Start doesn't make the old teardown give up.
const TEARDOWN_BUDGET: Duration = Duration::from_secs(30);

/// Managed state: owns the running server (if any) and the session manager.
pub struct RemoteServer {
    inner: Mutex<Option<Running>>,
    sessions: Arc<SessionManager>,
    /// Web Push (VAPID keys + subscription). None if keygen failed.
    push: Option<Arc<PushManager>>,
    app: AppHandle,
    /// App data dir (honours `TW_DATA_DIR`); holds the `tailscale serve` marker.
    data_dir: PathBuf,
    /// True while `start()` is running, so two starts can't race.
    starting: AtomicBool,
    /// `tailscale serve` teardowns still running; exit waits for them.
    teardowns: Mutex<Vec<JoinHandle<()>>>,
    /// The desktop's active theme, pushed by the frontend; sent to clients.
    theme: watch::Sender<Option<serde_json::Value>>,
}

/// Clears `RemoteServer::starting` however `start()` returns.
struct StartingGuard<'a>(&'a AtomicBool);
impl Drop for StartingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl RemoteServer {
    pub fn new(app: AppHandle, data_dir: PathBuf) -> Self {
        Self {
            inner: Mutex::new(None),
            sessions: Arc::new(SessionManager::new()),
            push: PushManager::new().map(Arc::new),
            app,
            data_dir,
            starting: AtomicBool::new(false),
            teardowns: Mutex::new(Vec::new()),
            theme: watch::channel(None).0,
        }
    }

    pub fn is_running(&self) -> bool {
        self.inner.lock().is_some()
    }

    /// Store the desktop's active theme; live clients get it straight away and
    /// new ones on connect.
    pub fn set_theme(&self, theme: serde_json::Value) {
        self.theme.send_replace(Some(theme));
    }

    /// Remove a `tailscale serve` front an earlier run left behind (a crash, or
    /// an exit that ran out of time). Only touches it if it is still ours.
    pub fn clean_leftover_serve(&self) {
        let Some(nonce) = tailscale::leftover_nonce(&self.data_dir) else {
            return;
        };
        // Another running copy of the app holds the lease: its front is live.
        let Some(lease) = tailscale::take_lease(&self.data_dir) else {
            return;
        };
        self.spawn_serve_stop(ServeOwnership {
            nonce,
            _lease: lease,
        });
    }

    /// Tear down a serve front on a background thread, tracked so exit can wait
    /// for it. The lease is held until the teardown is done.
    fn spawn_serve_stop(&self, serve: ServeOwnership) {
        let dir = self.data_dir.clone();
        let handle = std::thread::spawn(move || {
            tailscale::serve_stop(&dir, Some(&serve.nonce), Instant::now() + TEARDOWN_BUDGET);
            drop(serve);
        });
        let mut teardowns = self.teardowns.lock();
        teardowns.retain(|h| !h.is_finished());
        teardowns.push(handle);
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

        // Claim the start first, then check: the other order lets a second start
        // slip in between a first start finishing and its guard dropping.
        if self
            .starting
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("remote access already running".into());
        }
        let _starting = StartingGuard(&self.starting);
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
        //
        // The port is bound before `tailscale serve` is touched: if something
        // else already listens there (say the user's own server, fronted by
        // their own serve config) we must not adopt that config and then tear
        // it down when our bind fails.
        let mut serve_listener = None;
        let (serve, mut hint) = match (&ts_info, bind_all) {
            (Some(info), false) => {
                match tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
                    Ok(listener) => {
                        let (dir, info) = (self.data_dir.clone(), info.clone());
                        match tokio::task::spawn_blocking(move || {
                            tailscale::serve_start(&dir, port, &info)
                        })
                        .await
                        .map_err(|e| e.to_string())?
                        {
                            Ok((url, nonce, lease)) => {
                                serve_listener = Some(listener);
                                let owned = ServeOwnership {
                                    nonce,
                                    _lease: lease,
                                };
                                (Some((url, owned)), None)
                            }
                            Err(why) => (None, Some(format!("HTTPS unavailable ({why})."))),
                        }
                    }
                    Err(e) => (
                        None,
                        Some(format!(
                            "HTTPS unavailable (port {port} is in use on this machine: {e})."
                        )),
                    ),
                }
            }
            _ => (None, None),
        };

        let bind_ip: IpAddr = match mode {
            MODE_TAILSCALE if serve.is_some() => Ipv4Addr::LOCALHOST.into(),
            MODE_TAILSCALE if bind_all => Ipv4Addr::UNSPECIFIED.into(),
            MODE_TAILSCALE => ts_info
                .as_ref()
                .unwrap()
                .ip
                .parse()
                .map_err(|_| "invalid tailnet address".to_string())?,
            _ => Ipv4Addr::LOCALHOST.into(),
        };

        let listener = match serve_listener {
            Some(listener) => listener,
            None => tokio::net::TcpListener::bind((bind_ip, port))
                .await
                .map_err(|e| format!("bind failed: {e}"))?,
        };
        let actual = match listener.local_addr() {
            Ok(addr) => addr.port(),
            Err(e) => {
                // Undo the serve config: there is no server behind it.
                if let Some((_, owned)) = serve {
                    self.spawn_serve_stop(owned);
                }
                return Err(e.to_string());
            }
        };
        let local_url = format!("http://{bind_ip}:{actual}");

        // Which forwarded-for header (if any) names the real client: only the
        // proxy in front of us sets it, and only it reaches us over loopback.
        let forwarded = match mode {
            MODE_CLOUDFLARE => server::Forwarded::Cloudflare,
            MODE_TAILSCALE if serve.is_some() => server::Forwarded::TailscaleServe,
            _ => server::Forwarded::None,
        };

        let code = self.sessions.new_code();
        // Live-WebSocket count: pushes are only sent when this is zero (a
        // connected client shows notifications via its own service worker).
        let sockets = Arc::new(AtomicUsize::new(0));
        let ctx = server::ServerCtx {
            app: self.app.clone(),
            sessions: self.sessions.clone(),
            // ~10 /pair attempts burst per IP, refilling 1/6s (10/min sustained).
            rate_limit: Arc::new(ratelimit::RateLimiter::new(10.0, 1.0 / 6.0)),
            forwarded,
            push: self.push.clone(),
            sockets: sockets.clone(),
            theme: self.theme.subscribe(),
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
            MODE_TAILSCALE => match &serve {
                Some((https, _)) => (None, https.clone()),
                None => {
                    let host = ts_info.as_ref().unwrap().host();
                    if let Some(why) = hint.take() {
                        hint = Some(format!(
                            "{why} Serving plain HTTP — the phone PWA (install, notifications) \
                             needs the HTTPS address."
                        ));
                    }
                    (None, format!("http://{host}:{actual}"))
                }
            },
            _ => (None, local_url.clone()),
        };

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
            serve: serve.map(|(_, owned)| owned),
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

    /// Stop the server (graceful shutdown) and invalidate all pairing/token
    /// state. The `tailscale serve` teardown runs in the background.
    pub fn stop(&self) {
        if let Some(serve) = self.stop_inner() {
            self.spawn_serve_stop(serve);
        }
    }

    /// [`stop`](Self::stop) for app exit: tears `tailscale serve` down on this
    /// thread and waits for earlier teardowns, so they finish before the process
    /// does. Bounded by one overall deadline; a teardown that misses it is
    /// retried at the next launch (see [`clean_leftover_serve`](Self::clean_leftover_serve)).
    pub fn stop_blocking(&self) {
        let deadline = Instant::now() + Duration::from_secs(4);
        if let Some(serve) = self.stop_inner() {
            tailscale::serve_stop(&self.data_dir, Some(&serve.nonce), deadline);
        }
        let pending = std::mem::take(&mut *self.teardowns.lock());
        for handle in pending {
            while !handle.is_finished() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }

    /// Everything stop does except the serve teardown; returns the serve front
    /// to tear down, if one was active.
    fn stop_inner(&self) -> Option<ServeOwnership> {
        let mut serve = None;
        if let Some(running) = self.inner.lock().take() {
            let _ = running.shutdown.send(());
            serve = running.serve;
            for id in running.push_listeners {
                self.app.unlisten(id);
            }
        }
        if let Some(push) = &self.push {
            push.clear_subscription();
        }
        self.sessions.reset();
        serve
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
        if s.load(Ordering::Relaxed) == 0 && p.has_subscription() && p.allow_push(&evt.id) {
            let title = terminal_name(&a, &evt.id);
            let p = p.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(why) = p.send(&title, "Bell").await {
                    eprintln!("web push failed: {why}");
                }
            });
        }
    }));

    let (a, p, s) = (app.clone(), push.clone(), sockets.clone());
    ids.push(app.listen("terminals:working", move |ev| {
        let Ok(evt) = serde_json::from_str::<WorkingEvt>(ev.payload()) else {
            return;
        };
        // Always track durations; only send when it was a long-running task and
        // nobody is connected to see it live.
        let push_worthy = p.note_working(&evt.id, evt.working);
        if push_worthy
            && s.load(Ordering::Relaxed) == 0
            && p.has_subscription()
            && p.allow_push(&evt.id)
        {
            let title = terminal_name(&a, &evt.id);
            let p = p.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(why) = p.send(&title, "Finished").await {
                    eprintln!("web push failed: {why}");
                }
            });
        }
    }));

    // Typed attention (Claude hooks, failed commands, prompt waits, OSC
    // notifications) — the most precise "needs you" signal, pushed verbatim.
    let a = app.clone();
    ids.push(app.listen("terminals:attention", move |ev| {
        #[derive(Deserialize)]
        struct AttentionEvt {
            id: String,
            reason: String,
            message: Option<String>,
        }
        let Ok(evt) = serde_json::from_str::<AttentionEvt>(ev.payload()) else {
            return;
        };
        if sockets.load(Ordering::Relaxed) != 0 || !push.has_subscription() {
            return;
        }
        if !push.allow_push(&evt.id) {
            return;
        }
        let body = match (evt.reason.as_str(), evt.message) {
            ("needs-permission", Some(m)) => m,
            ("needs-permission", None) => "Needs your permission".to_string(),
            ("waiting-input", Some(m)) => format!("Waiting for input: {m}"),
            ("waiting-input", None) => "Waiting for your input".to_string(),
            ("failed", Some(m)) => format!("Command failed — {m}"),
            ("failed", None) => "Command failed".to_string(),
            ("finished", _) => "Finished".to_string(),
            (_, Some(m)) => m,
            (_, None) => return,
        };
        let title = terminal_name(&a, &evt.id);
        let p = push.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(why) = p.send(&title, &body).await {
                eprintln!("web push failed: {why}");
            }
        });
    }));

    ids
}
