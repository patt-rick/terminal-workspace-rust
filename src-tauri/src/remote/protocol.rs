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
    fn output_frame_prefixes_big_endian_tag() {
        let f = output_frame(0x01020304, b"hi");
        assert_eq!(&f[..4], &[1, 2, 3, 4]);
        assert_eq!(&f[4..], b"hi");
    }
}
