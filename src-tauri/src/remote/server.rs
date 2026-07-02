//! axum HTTP + WebSocket server. Binds 127.0.0.1 (Cloudflare/localhost mode);
//! the tunnel/Tailscale bind modes arrive in later milestones.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, HeaderName, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::bridge;
use super::protocol::{output_frame, ClientMsg, ServerMsg};
use super::push::{PushManager, PushSubscription};
use super::ratelimit::RateLimiter;
use super::session::{PairError, SessionManager, MAX_FAILED};
use super::{client, RemoteServer};
use crate::pty::PtyManager;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone)]
pub struct ServerCtx {
    pub app: AppHandle,
    pub sessions: Arc<SessionManager>,
    pub rate_limit: Arc<RateLimiter>,
    /// Web Push manager (None when keygen failed).
    pub push: Option<Arc<PushManager>>,
    /// Live authenticated WebSocket count; pushes only fire when it's zero.
    pub sockets: Arc<AtomicUsize>,
}

/// Drop-safe live-socket counter (decrements even if the task is cancelled).
struct SocketGuard(Arc<AtomicUsize>);
impl SocketGuard {
    fn new(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::Relaxed);
        Self(counter)
    }
}
impl Drop for SocketGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

pub fn router(ctx: ServerCtx) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/pair", post(pair))
        .route("/ws", get(ws_upgrade))
        // PWA assets (public, static): installability + notifications.
        .route("/sw.js", get(sw_js))
        .route("/manifest.webmanifest", get(manifest))
        .route("/icon.svg", get(icon))
        .with_state(ctx)
}

async fn index() -> Html<&'static str> {
    Html(client::WEB_CLIENT)
}

async fn sw_js() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/javascript"),
            // Allow the SW (served from root) to control the whole origin.
            (HeaderName::from_static("service-worker-allowed"), "/"),
        ],
        client::SW_JS,
    )
}

async fn manifest() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/manifest+json")],
        client::MANIFEST,
    )
}

async fn icon() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "image/svg+xml")],
        client::ICON_SVG,
    )
}

#[derive(Deserialize)]
struct PairReq {
    code: String,
}

#[derive(Serialize)]
struct PairResp {
    token: String,
}

/// Best-effort client IP: prefer Cloudflare's forwarded header (the socket is
/// always 127.0.0.1 behind the tunnel), else the peer address.
fn client_ip(headers: &HeaderMap, addr: SocketAddr) -> String {
    for h in ["cf-connecting-ip", "x-forwarded-for"] {
        if let Some(v) = headers.get(h).and_then(|v| v.to_str().ok()) {
            let first = v.split(',').next().unwrap_or("").trim();
            if !first.is_empty() {
                return first.to_string();
            }
        }
    }
    addr.ip().to_string()
}

async fn pair(
    State(ctx): State<ServerCtx>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<PairReq>,
) -> Response {
    // Rate-limit per client IP as defense in depth (R3.9).
    if !ctx.rate_limit.check(&client_ip(&headers, addr)) {
        return (StatusCode::TOO_MANY_REQUESTS, "too many attempts, slow down").into_response();
    }
    match ctx.sessions.verify_pair(&req.code) {
        Ok(token) => Json(PairResp { token }).into_response(),
        Err(err) => {
            // Too many failed attempts → tear the whole session down (R3.4).
            if err == PairError::Wrong && ctx.sessions.failed_attempts() >= MAX_FAILED {
                let _ = ctx
                    .app
                    .emit("remote:auto-stopped", "too many failed pairing attempts");
                ctx.app.state::<RemoteServer>().stop();
            }
            (StatusCode::UNAUTHORIZED, "invalid pairing code").into_response()
        }
    }
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(ctx): State<ServerCtx>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, ctx))
}

fn text(msg: &ServerMsg) -> Message {
    Message::Text(serde_json::to_string(msg).unwrap_or_default())
}

#[derive(Deserialize)]
struct WorkingEvt {
    id: String,
    working: bool,
}

#[derive(Deserialize)]
struct IdEvt {
    id: String,
}

/// Forward Rust-side terminal state (working/bell/exit) Tauri events to this
/// client as `state.*` messages. Returns the listener ids to unlisten on close.
fn spawn_state_forwarders(app: &AppHandle, out_tx: mpsc::Sender<Message>) -> Vec<tauri::EventId> {
    use tauri::Listener;
    let mut ids = Vec::new();

    let tx = out_tx.clone();
    ids.push(app.listen("terminals:working", move |ev| {
        if let Ok(p) = serde_json::from_str::<WorkingEvt>(ev.payload()) {
            let _ = tx.try_send(text(&ServerMsg::StateWorking {
                terminal_id: p.id,
                working: p.working,
            }));
        }
    }));

    let tx = out_tx.clone();
    ids.push(app.listen("terminals:bell", move |ev| {
        if let Ok(p) = serde_json::from_str::<IdEvt>(ev.payload()) {
            let _ = tx.try_send(text(&ServerMsg::StateBell { terminal_id: p.id }));
        }
    }));

    ids.push(app.listen("terminals:exit", move |ev| {
        if let Ok(p) = serde_json::from_str::<IdEvt>(ev.payload()) {
            let _ = out_tx.try_send(text(&ServerMsg::StateExit { terminal_id: p.id }));
        }
    }));

    ids
}

/// Wait (with a timeout) for a valid `hello`. Returns the session generation the
/// connection is bound to, or None if authentication failed / the socket closed.
async fn wait_for_hello(socket: &mut WebSocket, ctx: &ServerCtx) -> Option<u64> {
    let token = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match socket.recv().await {
                Some(Ok(Message::Text(txt))) => {
                    if let Ok(ClientMsg::Hello { token }) = serde_json::from_str::<ClientMsg>(&txt) {
                        return Some(token);
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return None,
                _ => {}
            }
        }
    })
    .await
    .ok()
    .flatten()?;

    match ctx.sessions.validate_token(&token) {
        Some(generation) => Some(generation),
        None => {
            let _ = socket
                .send(text(&ServerMsg::HelloErr {
                    message: "invalid token".into(),
                }))
                .await;
            None
        }
    }
}

struct Attachment {
    handle: JoinHandle<()>,
}

/// Per-connection state + handlers. Output for all attached terminals funnels
/// through a single mpsc so exactly one task writes to the socket.
struct Conn {
    ctx: ServerCtx,
    out_tx: mpsc::Sender<Message>,
    attachments: HashMap<String, Attachment>,
    next_tag: u32,
}

impl Conn {
    async fn handle(&mut self, txt: &str) {
        let msg = match serde_json::from_str::<ClientMsg>(txt) {
            Ok(m) => m,
            Err(_) => return, // ignore malformed frames
        };
        match msg {
            ClientMsg::Hello { .. } => {} // already authenticated
            ClientMsg::Ping => self.send(ServerMsg::Pong).await,
            ClientMsg::TermInput { terminal_id, data } => {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()) {
                    self.ctx.app.state::<PtyManager>().write_bytes(&terminal_id, &bytes);
                }
            }
            ClientMsg::TermResize {
                terminal_id,
                cols,
                rows,
            } => self
                .ctx
                .app
                .state::<PtyManager>()
                .resize_remote(&terminal_id, cols, rows),
            ClientMsg::TermAttach { terminal_id } => self.attach(terminal_id).await,
            ClientMsg::TermDetach { terminal_id } => self.detach(&terminal_id),
            ClientMsg::TermCreate {
                project_id,
                kind,
                cwd,
            } => match bridge::create_terminal(&self.ctx.app, &project_id, &kind, cwd.as_deref()) {
                Ok(terminal) => self.send(ServerMsg::TermCreated { terminal }).await,
                Err(message) => self.send(ServerMsg::Error { message }).await,
            },
            ClientMsg::TermClose { terminal_id } => {
                bridge::close_terminal(&self.ctx.app, &terminal_id);
                self.detach(&terminal_id);
                self.send(ServerMsg::TermClosed { terminal_id }).await;
            }
            ClientMsg::GitRepos { project_id } => {
                let (app, out_tx) = (self.ctx.app.clone(), self.out_tx.clone());
                tokio::task::spawn_blocking(move || {
                    let repos = bridge::git_repos(&app, &project_id);
                    let _ = out_tx.blocking_send(text(&ServerMsg::GitRepos { project_id, repos }));
                });
            }
            ClientMsg::GitStatus { repo_id } => {
                let (app, out_tx) = (self.ctx.app.clone(), self.out_tx.clone());
                tokio::task::spawn_blocking(move || {
                    if let Some(info) = bridge::git_status(&app, &repo_id) {
                        let _ = out_tx.blocking_send(text(&ServerMsg::GitStatus { repo_id, info }));
                    }
                });
            }
            ClientMsg::GitDiff { repo_id } => {
                let (app, out_tx) = (self.ctx.app.clone(), self.out_tx.clone());
                tokio::task::spawn_blocking(move || {
                    let msg = match bridge::git_diff(&app, &repo_id) {
                        Ok(files) => ServerMsg::GitDiff { repo_id, files },
                        Err(message) => ServerMsg::Error { message },
                    };
                    let _ = out_tx.blocking_send(text(&msg));
                });
            }
            ClientMsg::GitPush { repo_id } => {
                self.send(ServerMsg::GitPushProgress {
                    repo_id: repo_id.clone(),
                    message: "Pushing…".into(),
                })
                .await;
                let (app, out_tx) = (self.ctx.app.clone(), self.out_tx.clone());
                tokio::task::spawn_blocking(move || {
                    let (ok, output) = bridge::git_push(&app, &repo_id);
                    let _ = out_tx.blocking_send(text(&ServerMsg::GitPushDone { repo_id, ok, output }));
                });
            }
            ClientMsg::ClaudeSessions { project_id } => {
                // Reading every transcript can be heavy; keep it off the runtime.
                let (app, out_tx) = (self.ctx.app.clone(), self.out_tx.clone());
                tokio::task::spawn_blocking(move || {
                    let sessions = bridge::claude_sessions(&app, &project_id);
                    let _ = out_tx
                        .blocking_send(text(&ServerMsg::ClaudeSessions { project_id, sessions }));
                });
            }
            ClientMsg::ClaudeResume {
                project_id,
                session_id,
            } => match bridge::resume_session(&self.ctx.app, &project_id, &session_id) {
                Ok(terminal) => self.send(ServerMsg::TermCreated { terminal }).await,
                Err(message) => self.send(ServerMsg::Error { message }).await,
            },
            ClientMsg::PushSubscribe {
                endpoint,
                p256dh,
                auth,
            } => {
                if let Some(push) = &self.ctx.push {
                    push.set_subscription(PushSubscription { endpoint, p256dh, auth });
                }
            }
            ClientMsg::PushUnsubscribe => {
                if let Some(push) = &self.ctx.push {
                    push.clear_subscription();
                }
            }
        }
    }

    async fn send(&self, msg: ServerMsg) {
        let _ = self.out_tx.send(text(&msg)).await;
    }

    async fn attach(&mut self, terminal_id: String) {
        if self.attachments.contains_key(&terminal_id) {
            return; // already attached
        }
        let pty = self.ctx.app.state::<PtyManager>();
        let Some((snapshot, mut rx)) = pty.subscribe_remote(&terminal_id) else {
            self.send(ServerMsg::Error {
                message: format!("terminal {terminal_id} not found"),
            })
            .await;
            return;
        };
        let tag = self.next_tag;
        self.next_tag += 1;

        self.send(ServerMsg::TermAttached {
            terminal_id: terminal_id.clone(),
            tag,
        })
        .await;
        self.send(ServerMsg::TermSnapshot {
            terminal_id: terminal_id.clone(),
            tag,
            data: base64::engine::general_purpose::STANDARD.encode(&snapshot),
        })
        .await;

        // Forward live output as tagged binary frames until detach or PTY exit.
        let out_tx = self.out_tx.clone();
        let handle = tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(bytes) => {
                        if out_tx
                            .send(Message::Binary(output_frame(tag, &bytes)))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    // Slow client: dropped intermediate frames, keep going (R3.2).
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        self.attachments.insert(terminal_id, Attachment { handle });
    }

    fn detach(&mut self, terminal_id: &str) {
        if let Some(att) = self.attachments.remove(terminal_id) {
            att.handle.abort();
            // Snap the PTY back to the desktop pane's size (R3.14).
            self.ctx
                .app
                .state::<PtyManager>()
                .restore_local_size(terminal_id);
        }
    }
}

async fn handle_socket(mut socket: WebSocket, ctx: ServerCtx) {
    let my_generation = match wait_for_hello(&mut socket, &ctx).await {
        Some(g) => g,
        None => return,
    };

    // hello.ok with the full state snapshot.
    let hello_ok = ServerMsg::HelloOk {
        state: bridge::state_snapshot(&ctx.app),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        vapid_public_key: ctx.push.as_ref().map(|p| p.vapid_public_key()),
    };
    if socket.send(text(&hello_ok)).await.is_err() {
        return;
    }
    let _socket_guard = SocketGuard::new(ctx.sockets.clone());

    let (out_tx, mut out_rx) = mpsc::channel::<Message>(256);
    let listener_ids = spawn_state_forwarders(&ctx.app, out_tx.clone());
    let mut generation_rx = ctx.sessions.subscribe_generation();
    let mut conn = Conn {
        ctx,
        out_tx,
        attachments: HashMap::new(),
        next_tag: 1,
    };

    loop {
        tokio::select! {
            biased;
            _ = generation_rx.changed() => {
                if *generation_rx.borrow() != my_generation {
                    let _ = socket.send(text(&ServerMsg::SessionEvicted)).await;
                    break;
                }
            }
            outgoing = out_rx.recv() => {
                match outgoing {
                    Some(msg) => {
                        if socket.send(msg).await.is_err() { break; }
                    }
                    None => {}
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(txt))) => conn.handle(&txt).await,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {} // binary/ping/pong from client: ignored
                }
            }
        }
    }

    let pty = conn.ctx.app.state::<PtyManager>();
    for (id, att) in conn.attachments.drain() {
        att.handle.abort();
        // Snap each PTY back to its desktop size now the remote is gone (R3.14).
        pty.restore_local_size(&id);
    }
    use tauri::Listener;
    for id in listener_ids {
        conn.ctx.app.unlisten(id);
    }
}
