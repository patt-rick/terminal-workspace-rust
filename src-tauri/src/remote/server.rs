//! axum HTTP + WebSocket server. Binds 127.0.0.1 (Cloudflare/localhost mode);
//! the tunnel/Tailscale bind modes arrive in later milestones.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::bridge;
use super::protocol::{output_frame, ClientMsg, ServerMsg};
use super::session::{PairError, SessionManager, MAX_FAILED};
use super::{client, RemoteServer};
use crate::pty::PtyManager;

#[derive(Clone)]
pub struct ServerCtx {
    pub app: AppHandle,
    pub sessions: Arc<SessionManager>,
}

pub fn router(ctx: ServerCtx) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/pair", post(pair))
        .route("/ws", get(ws_upgrade))
        .with_state(ctx)
}

async fn index() -> Html<&'static str> {
    Html(client::TEST_CLIENT)
}

#[derive(Deserialize)]
struct PairReq {
    code: String,
}

#[derive(Serialize)]
struct PairResp {
    token: String,
}

async fn pair(State(ctx): State<ServerCtx>, Json(req): Json<PairReq>) -> Response {
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
            } => self.ctx.app.state::<PtyManager>().resize(&terminal_id, cols, rows),
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
    };
    if socket.send(text(&hello_ok)).await.is_err() {
        return;
    }

    let (out_tx, mut out_rx) = mpsc::channel::<Message>(256);
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

    for (_, att) in conn.attachments.drain() {
        att.handle.abort();
    }
}
