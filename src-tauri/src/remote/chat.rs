//! Follows one Claude terminal's transcript for a phone connection and streams
//! it as `chat.history` / `chat.append`. Polls (500 ms) instead of watching:
//! no new dependency, and it works on WSL UNC paths.

use axum::extract::ws::Message;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use super::protocol::ServerMsg;
use crate::claude::transcript::{load_tail, Tail, TailRead, Transcript};
use crate::pty::{ChatSource, PtyManager};

const TICK: Duration = Duration::from_millis(500);
const PROBE_EVERY: Duration = Duration::from_secs(2);

/// Find `<session>.jsonl` under `<projects>/*/` (the cwd may differ from the
/// project root, e.g. a worktree).
pub fn find_in_projects(projects: &Path, session_id: &str) -> Option<PathBuf> {
    if !crate::claude::is_uuid(session_id) {
        return None;
    }
    let name = format!("{session_id}.jsonl");
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|e| e.path().join(&name))
        .find(|p| p.is_file())
}

/// Where this terminal's transcript lives: the hook-reported path when it names
/// this session's file, else a search of the terminal's own home only.
pub fn resolve(home: &Path, src: &ChatSource) -> Option<PathBuf> {
    let sid = src.session_id.as_deref()?;
    // A bare `wsl:` is the default distro; `\\wsl$\` needs its real name.
    let distro = match crate::wsl::parse_shell_token(&src.shell) {
        #[cfg(windows)]
        Some(d) => Some(crate::wsl::resolve_distro(d)?),
        #[cfg(not(windows))]
        Some(d) => Some(d.to_string()),
        None => None,
    };
    let distro = distro.as_deref();
    if let Some(tp) = &src.transcript_path {
        let p = match distro {
            Some(d) if tp.starts_with('/') => crate::wsl::unc_path(d, tp),
            _ => PathBuf::from(tp),
        };
        // Only ever read the session's own transcript file.
        let want = format!("{sid}.jsonl");
        if p.file_name().and_then(|n| n.to_str()) == Some(want.as_str()) {
            return Some(p);
        }
    }
    // distro_home is cached after its first wsl.exe call, and the distro is
    // already running (this terminal lives in it).
    let base = match distro {
        #[cfg(windows)]
        Some(d) => crate::wsl::unc_path(d, &crate::wsl::distro_home(d)?),
        #[cfg(not(windows))]
        Some(_) => return None,
        None => home.to_path_buf(),
    };
    find_in_projects(&base.join(".claude").join("projects"), sid)
}

/// Owned by the connection; dropping it stops the follower thread.
pub struct ChatFollow {
    pub terminal_id: String,
    stop: Arc<AtomicBool>,
}

impl Drop for ChatFollow {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn send(out_tx: &mpsc::Sender<Message>, msg: &ServerMsg) -> bool {
    let body = serde_json::to_string(msg).unwrap_or_default();
    out_tx.blocking_send(Message::Text(body)).is_ok()
}

pub fn start(app: AppHandle, terminal_id: String, out_tx: mpsc::Sender<Message>) -> ChatFollow {
    let stop = Arc::new(AtomicBool::new(false));
    let follow = ChatFollow { terminal_id: terminal_id.clone(), stop: stop.clone() };
    std::thread::spawn(move || run(app, terminal_id, out_tx, stop));
    follow
}

fn run(app: AppHandle, terminal_id: String, out_tx: mpsc::Sender<Message>, stop: Arc<AtomicBool>) {
    let pty = app.state::<PtyManager>();
    let home = app.path().home_dir().unwrap_or_default();
    let mut followed: Option<String> = None;
    let mut open: Option<(PathBuf, Transcript, Tail)> = None;
    let mut last_probe: Option<Instant> = None;
    let mut sent_empty = false;

    while !stop.load(Ordering::Relaxed) {
        let Some(src) = pty.chat_source(&terminal_id) else {
            break; // terminal gone
        };
        let Some(sid) = src.session_id.clone() else {
            send(&out_tx, &ServerMsg::ChatUnavailable {
                terminal_id: terminal_id.clone(),
                reason: "This terminal isn't running a tracked Claude session.".into(),
            });
            break;
        };
        if followed.as_deref() != Some(sid.as_str()) {
            followed = Some(sid.clone());
            open = None;
            last_probe = None;
            sent_empty = false;
        }

        if open.is_none() && last_probe.is_none_or(|t| t.elapsed() >= PROBE_EVERY) {
            last_probe = Some(Instant::now());
            match resolve(&home, &src).filter(|p| p.is_file()) {
                Some(path) => match load_tail(&path) {
                    Ok((t, offset, truncated)) => {
                        if !send(&out_tx, &ServerMsg::ChatHistory {
                            terminal_id: terminal_id.clone(),
                            session_id: Some(sid.clone()),
                            messages: t.history(),
                            truncated,
                        }) {
                            break;
                        }
                        open = Some((path, t, Tail::at(offset)));
                    }
                    Err(e) => {
                        send(&out_tx, &ServerMsg::ChatUnavailable {
                            terminal_id: terminal_id.clone(),
                            reason: format!("Couldn't read the transcript: {e}"),
                        });
                        break;
                    }
                },
                // Claude writes nothing until the first prompt: show an empty chat.
                None if !sent_empty => {
                    sent_empty = true;
                    if !send(&out_tx, &ServerMsg::ChatHistory {
                        terminal_id: terminal_id.clone(),
                        session_id: Some(sid.clone()),
                        messages: Vec::new(),
                        truncated: false,
                    }) {
                        break;
                    }
                }
                None => {}
            }
        }

        if let Some((path, t, tail)) = open.as_mut() {
            match tail.read_new(path) {
                Ok(TailRead::Lines(lines)) if !lines.is_empty() => {
                    let changed: Vec<String> = lines.iter().flat_map(|l| t.ingest(l)).collect();
                    if !changed.is_empty()
                        && !send(&out_tx, &ServerMsg::ChatAppend {
                            terminal_id: terminal_id.clone(),
                            messages: t.get(&changed),
                        })
                    {
                        break;
                    }
                }
                Ok(TailRead::Lines(_)) => {}
                Ok(TailRead::Reset) | Err(_) => {
                    open = None;
                    last_probe = None;
                }
            }
        }
        std::thread::sleep(TICK);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const U: &str = "2b5c191b-945b-418d-9a3e-0d6c3f1e2a4b";

    fn src(session: Option<&str>, tp: Option<&str>) -> ChatSource {
        ChatSource {
            session_id: session.map(str::to_string),
            transcript_path: tp.map(str::to_string),
            shell: "powershell.exe".into(),
        }
    }

    #[test]
    fn finds_session_in_any_project_dir() {
        let home = tempfile::tempdir().unwrap();
        let other = home.path().join(".claude").join("projects").join("C--repo-worktree");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join(format!("{U}.jsonl")), "").unwrap();
        assert_eq!(resolve(home.path(), &src(Some(U), None)), Some(other.join(format!("{U}.jsonl"))));
        assert_eq!(resolve(home.path(), &src(Some("not-a-uuid"), None)), None);
        assert_eq!(resolve(home.path(), &src(None, None)), None);
    }

    #[test]
    fn prefers_hook_path_only_when_it_names_the_session_file() {
        let home = tempfile::tempdir().unwrap();
        let good = home.path().join(format!("{U}.jsonl"));
        assert_eq!(resolve(home.path(), &src(Some(U), Some(good.to_str().unwrap()))), Some(good));
        // A path to some other file is ignored (falls back to the search: none).
        assert_eq!(resolve(home.path(), &src(Some(U), Some("C:\\Windows\\win.ini"))), None);
    }
}
