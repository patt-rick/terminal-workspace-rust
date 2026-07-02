//! Wire protocol shared by the embedded server and the web client.
//!
//! Control messages are JSON `{ "type": ..., ... }`. Terminal output is sent as
//! binary WebSocket frames prefixed with a 4-byte big-endian tag identifying the
//! attached terminal (assigned per connection at attach time), so a slow client's
//! output volume never bloats JSON.

use serde::{Deserialize, Serialize};

/// Messages the client sends to the server.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientMsg {
    /// Authenticate; must be the first message.
    Hello { token: String },
    #[serde(rename = "term.attach")]
    TermAttach { terminal_id: String },
    #[serde(rename = "term.detach")]
    TermDetach { terminal_id: String },
    /// PTY input; `data` is base64 (standard alphabet).
    #[serde(rename = "term.input")]
    TermInput { terminal_id: String, data: String },
    #[serde(rename = "term.resize")]
    TermResize {
        terminal_id: String,
        cols: u16,
        rows: u16,
    },
    /// Spawn a terminal. `kind` is "shell" or "claude".
    #[serde(rename = "term.create")]
    TermCreate {
        project_id: String,
        kind: String,
        cwd: Option<String>,
    },
    #[serde(rename = "term.close")]
    TermClose { terminal_id: String },
    #[serde(rename = "git.repos")]
    GitRepos { project_id: String },
    #[serde(rename = "git.status")]
    GitStatus { repo_id: String },
    #[serde(rename = "git.diff")]
    GitDiff { repo_id: String },
    #[serde(rename = "git.push")]
    GitPush { repo_id: String },
    #[serde(rename = "claude.sessions")]
    ClaudeSessions { project_id: String },
    #[serde(rename = "claude.resume")]
    ClaudeResume {
        project_id: String,
        session_id: String,
    },
    /// Register the browser's push subscription for closed-app notifications.
    #[serde(rename = "push.subscribe")]
    PushSubscribe {
        endpoint: String,
        p256dh: String,
        auth: String,
    },
    #[serde(rename = "push.unsubscribe")]
    PushUnsubscribe,
    Ping,
}

/// Messages the server pushes to the client.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ServerMsg {
    #[serde(rename = "hello.ok")]
    HelloOk {
        state: StateSnapshot,
        app_version: String,
        /// VAPID applicationServerKey (b64url) for Web Push, when available.
        vapid_public_key: Option<String>,
    },
    #[serde(rename = "hello.err")]
    HelloErr { message: String },
    /// Sent right after a successful attach, before the snapshot and live frames.
    #[serde(rename = "term.attached")]
    TermAttached { terminal_id: String, tag: u32 },
    /// Scrollback replay; `data` is base64 of the raw ring buffer.
    #[serde(rename = "term.snapshot")]
    TermSnapshot {
        terminal_id: String,
        tag: u32,
        data: String,
    },
    #[serde(rename = "term.created")]
    TermCreated { terminal: TermInfo },
    #[serde(rename = "term.closed")]
    TermClosed { terminal_id: String },
    /// A terminal became busy/idle (from Rust-side title/OSC detection).
    #[serde(rename = "state.working")]
    StateWorking { terminal_id: String, working: bool },
    /// A terminal rang the bell.
    #[serde(rename = "state.bell")]
    StateBell { terminal_id: String },
    /// A terminal's PTY exited.
    #[serde(rename = "state.exit")]
    StateExit { terminal_id: String },
    #[serde(rename = "git.repos")]
    GitRepos {
        project_id: String,
        repos: Vec<crate::git::discover::RepoInfo>,
    },
    #[serde(rename = "git.status")]
    GitStatus {
        repo_id: String,
        info: crate::git::GitInfo,
    },
    #[serde(rename = "git.diff")]
    GitDiff {
        repo_id: String,
        files: Vec<crate::git::FileDiff>,
    },
    #[serde(rename = "git.push.progress")]
    GitPushProgress { repo_id: String, message: String },
    #[serde(rename = "git.push.done")]
    GitPushDone {
        repo_id: String,
        ok: bool,
        output: String,
    },
    #[serde(rename = "claude.sessions")]
    ClaudeSessions {
        project_id: String,
        sessions: Vec<crate::claude::SessionSummary>,
    },
    /// Another client paired; this connection is being disconnected.
    #[serde(rename = "session.evicted")]
    SessionEvicted,
    Error { message: String },
    Pong,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub projects: Vec<ProjectInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub color: String,
    pub terminals: Vec<TermInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    pub id: String,
    pub name: String,
    pub project_id: String,
    /// True if a live PTY currently backs this record.
    pub live: bool,
}

/// Prepend the 4-byte tag to an output chunk for a binary WS frame.
pub fn output_frame(tag: u32, bytes: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + bytes.len());
    frame.extend_from_slice(&tag.to_be_bytes());
    frame.extend_from_slice(bytes);
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_hello_deserializes() {
        let m: ClientMsg = serde_json::from_str(r#"{"type":"hello","token":"abc"}"#).unwrap();
        assert!(matches!(m, ClientMsg::Hello { token } if token == "abc"));
    }

    #[test]
    fn client_dotted_and_camel_fields_deserialize() {
        let m: ClientMsg =
            serde_json::from_str(r#"{"type":"term.input","terminalId":"t1","data":"aGk="}"#).unwrap();
        match m {
            ClientMsg::TermInput { terminal_id, data } => {
                assert_eq!(terminal_id, "t1");
                assert_eq!(data, "aGk=");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_msg_tag_and_fields_serialize_as_expected() {
        let m = ServerMsg::TermAttached {
            terminal_id: "t1".into(),
            tag: 7,
        };
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&m).unwrap()).unwrap();
        assert_eq!(v["type"], "term.attached");
        assert_eq!(v["terminalId"], "t1");
        assert_eq!(v["tag"], 7);
    }

    #[test]
    fn no_filesystem_or_project_management_endpoints() {
        // AC-3.10: the remote protocol must not expose file read/write or
        // project add/remove. These type tags must not deserialize into any
        // ClientMsg variant.
        for tag in [
            "fs.read",
            "fs.write",
            "fs.list",
            "project.add",
            "project.remove",
            "settings.set",
            "invoke",
        ] {
            let json = format!(r#"{{"type":"{tag}","path":"/etc/passwd"}}"#);
            assert!(
                serde_json::from_str::<ClientMsg>(&json).is_err(),
                "'{tag}' must not be a valid client message"
            );
        }
    }

    #[test]
    fn claude_session_messages_deserialize() {
        let m: ClientMsg =
            serde_json::from_str(r#"{"type":"claude.resume","projectId":"p1","sessionId":"s1"}"#)
                .unwrap();
        match m {
            ClientMsg::ClaudeResume {
                project_id,
                session_id,
            } => {
                assert_eq!(project_id, "p1");
                assert_eq!(session_id, "s1");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn server_msg_wire_tags_are_stable() {
        // Drift guard: pins every OUTGOING wire `type` tag. The TS client is a
        // hand-maintained mirror (remote-web/src/protocol.ts) — if a tag changes
        // here, update that mirror to match.
        use crate::git::GitInfo;
        let ti = TermInfo {
            id: "t".into(),
            name: "n".into(),
            project_id: "p".into(),
            live: true,
        };
        let cases: Vec<(ServerMsg, &str)> = vec![
            (
                ServerMsg::HelloOk {
                    state: StateSnapshot { projects: vec![] },
                    app_version: "0".into(),
                    vapid_public_key: None,
                },
                "hello.ok",
            ),
            (ServerMsg::HelloErr { message: "e".into() }, "hello.err"),
            (
                ServerMsg::TermAttached {
                    terminal_id: "t".into(),
                    tag: 1,
                },
                "term.attached",
            ),
            (
                ServerMsg::TermSnapshot {
                    terminal_id: "t".into(),
                    tag: 1,
                    data: String::new(),
                },
                "term.snapshot",
            ),
            (ServerMsg::TermCreated { terminal: ti }, "term.created"),
            (
                ServerMsg::TermClosed {
                    terminal_id: "t".into(),
                },
                "term.closed",
            ),
            (
                ServerMsg::StateWorking {
                    terminal_id: "t".into(),
                    working: true,
                },
                "state.working",
            ),
            (
                ServerMsg::StateBell {
                    terminal_id: "t".into(),
                },
                "state.bell",
            ),
            (
                ServerMsg::StateExit {
                    terminal_id: "t".into(),
                },
                "state.exit",
            ),
            (
                ServerMsg::GitRepos {
                    project_id: "p".into(),
                    repos: vec![],
                },
                "git.repos",
            ),
            (
                ServerMsg::GitStatus {
                    repo_id: "r".into(),
                    info: GitInfo::default(),
                },
                "git.status",
            ),
            (
                ServerMsg::GitDiff {
                    repo_id: "r".into(),
                    files: vec![],
                },
                "git.diff",
            ),
            (
                ServerMsg::GitPushProgress {
                    repo_id: "r".into(),
                    message: "m".into(),
                },
                "git.push.progress",
            ),
            (
                ServerMsg::GitPushDone {
                    repo_id: "r".into(),
                    ok: true,
                    output: String::new(),
                },
                "git.push.done",
            ),
            (
                ServerMsg::ClaudeSessions {
                    project_id: "p".into(),
                    sessions: vec![],
                },
                "claude.sessions",
            ),
            (ServerMsg::SessionEvicted, "session.evicted"),
            (ServerMsg::Error { message: "e".into() }, "error"),
            (ServerMsg::Pong, "pong"),
        ];
        for (msg, tag) in cases {
            let v: serde_json::Value =
                serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
            assert_eq!(v["type"], tag, "unexpected wire tag for a ServerMsg variant");
        }
    }

    #[test]
    fn client_msg_wire_tags_all_deserialize() {
        // Drift guard: pins every INCOMING wire `type` the TS client may send.
        let cases = [
            r#"{"type":"hello","token":"t"}"#,
            r#"{"type":"term.attach","terminalId":"t"}"#,
            r#"{"type":"term.detach","terminalId":"t"}"#,
            r#"{"type":"term.input","terminalId":"t","data":"aGk="}"#,
            r#"{"type":"term.resize","terminalId":"t","cols":80,"rows":24}"#,
            r#"{"type":"term.create","projectId":"p","kind":"shell"}"#,
            r#"{"type":"term.close","terminalId":"t"}"#,
            r#"{"type":"git.repos","projectId":"p"}"#,
            r#"{"type":"git.status","repoId":"r"}"#,
            r#"{"type":"git.diff","repoId":"r"}"#,
            r#"{"type":"git.push","repoId":"r"}"#,
            r#"{"type":"claude.sessions","projectId":"p"}"#,
            r#"{"type":"claude.resume","projectId":"p","sessionId":"s"}"#,
            r#"{"type":"push.subscribe","endpoint":"https://e","p256dh":"k","auth":"a"}"#,
            r#"{"type":"push.unsubscribe"}"#,
            r#"{"type":"ping"}"#,
        ];
        for json in cases {
            assert!(
                serde_json::from_str::<ClientMsg>(json).is_ok(),
                "client message must deserialize: {json}"
            );
        }
    }

    #[test]
    fn output_frame_prefixes_big_endian_tag() {
        let f = output_frame(0x01020304, b"hi");
        assert_eq!(&f[..4], &[1, 2, 3, 4]);
        assert_eq!(&f[4..], b"hi");
    }
}
