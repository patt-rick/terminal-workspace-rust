#[cfg(feature = "remote-access")]
pub mod detect;
#[cfg(windows)]
mod job;
pub mod shell;

use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

// How much recent output to keep per terminal for replay on attach. Panes mount
// shortly after creation, so this only needs to cover the early prompt and any
// output produced while a terminal hasn't been viewed yet.
const RING_CAP: usize = 1_000_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    id: String,
    exit_code: i32,
}

/// Per-terminal output state. `ring` is the raw replay buffer; `carry` holds
/// trailing bytes of an incomplete UTF-8 sequence so live chunks sent over the
/// channel never split a multibyte character.
#[derive(Default)]
struct OutputState {
    ring: Vec<u8>,
    carry: Vec<u8>,
    channel: Option<Channel<String>>,
    // Raw-byte fan-out to remote subscribers, installed lazily on first remote
    // attach. Independent of `channel`, so the desktop stream is never disturbed.
    #[cfg(feature = "remote-access")]
    remote_tx: Option<tokio::sync::broadcast::Sender<Vec<u8>>>,
    // Working/idle + bell detection, drained by the reader loop into Tauri events.
    #[cfg(feature = "remote-access")]
    detector: detect::ShellDetector,
    #[cfg(feature = "remote-access")]
    pending: Vec<detect::DetectEvent>,
    // Prompt-silence heuristic inputs: when did output last arrive, what does
    // the tail look like, and have we already flagged this silence period.
    #[cfg(feature = "remote-access")]
    last_output: Option<std::time::Instant>,
    #[cfg(feature = "remote-access")]
    tail: Vec<u8>,
    #[cfg(feature = "remote-access")]
    prompt_flagged: bool,
}

/// How much trailing output the prompt heuristic inspects.
#[cfg(feature = "remote-access")]
const TAIL_CAP: usize = 256;

impl OutputState {
    fn on_data(&mut self, bytes: &[u8]) {
        self.ring.extend_from_slice(bytes);
        if self.ring.len() > RING_CAP {
            let excess = self.ring.len() - RING_CAP;
            self.ring.drain(..excess);
        }
        #[cfg(feature = "remote-access")]
        {
            self.last_output = Some(std::time::Instant::now());
            self.prompt_flagged = false;
            self.tail.extend_from_slice(bytes);
            if self.tail.len() > TAIL_CAP {
                let excess = self.tail.len() - TAIL_CAP;
                self.tail.drain(..excess);
            }
        }
        // Feed remote subscribers raw bytes (xterm.js reassembles split UTF-8
        // across writes). A full/lagged receiver just drops frames — never blocks.
        #[cfg(feature = "remote-access")]
        if let Some(tx) = &self.remote_tx {
            let _ = tx.send(bytes.to_vec());
        }
        #[cfg(feature = "remote-access")]
        {
            let events = self.detector.feed(bytes);
            self.pending.extend(events);
        }
        if self.channel.is_none() {
            return;
        }
        self.carry.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&self.carry) {
            Ok(s) => s.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid > 0 {
            let chunk = String::from_utf8_lossy(&self.carry[..valid]).into_owned();
            if let Some(ch) = &self.channel {
                let _ = ch.send(chunk);
            }
            self.carry.drain(..valid);
        }
    }

    #[cfg(feature = "remote-access")]
    fn drain_events(&mut self) -> Vec<detect::DetectEvent> {
        std::mem::take(&mut self.pending)
    }
}

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    out: Arc<Mutex<OutputState>>,
    /// Job Object owning the shell's process tree. Terminating it on kill takes
    /// down anything the shell spawned — including a grandchild that would
    /// otherwise keep the ConPTY (and this entry) alive forever.
    #[cfg(windows)]
    job: Option<job::JobObject>,
    /// Last size the desktop pane requested. A remote attach resizes the shared
    /// PTY to the phone's dimensions; on detach we snap back to this (R3.14).
    #[cfg(feature = "remote-access")]
    local_size: (u16, u16),
    /// Size mandated by an attached remote client. While `Some`, the remote
    /// owns the PTY size: desktop resizes are recorded in `local_size` but not
    /// applied, and the desktop pane mirrors this grid (letterboxed).
    #[cfg(feature = "remote-access")]
    remote_size: Option<(u16, u16)>,
    /// Claude session id parsed from the startup command (`--session-id` /
    /// `--resume`), used to route Claude-hook events back to this terminal.
    #[cfg(feature = "remote-access")]
    session_id: Option<String>,
}

/// Extract the Claude session id from a startup command, if present.
#[cfg(feature = "remote-access")]
fn extract_claude_session(cmd: &str) -> Option<String> {
    let mut tokens = cmd.split_whitespace();
    while let Some(tok) = tokens.next() {
        if tok == "--session-id" || tok == "--resume" {
            return tokens.next().map(|s| s.to_string());
        }
    }
    None
}

/// If the output tail's last non-empty line looks like an interactive prompt,
/// return it (trimmed). Deliberately conservative — this only runs when a
/// command is mid-flight and has been silent for a while.
#[cfg(feature = "remote-access")]
fn prompt_like_tail(tail: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(tail);
    let line = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())?
        .to_string();
    let lower = line.to_lowercase();
    let looks_prompt = lower.contains("password")
        || lower.contains("passphrase")
        || lower.contains("(y/n)")
        || lower.contains("[y/n]")
        || lower.contains("(yes/no)")
        || line.ends_with('?')
        || line.ends_with(':');
    if looks_prompt {
        Some(line)
    } else {
        None
    }
}

/// Resize a PTY master, clamping to a 1x1 floor.
fn apply_size(master: &(dyn MasterPty + Send), cols: u16, rows: u16) {
    let _ = master.resize(PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    });
}

pub struct CreateOpts {
    pub id: String,
    pub cwd: String,
    pub shell: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub startup_command: Option<String>,
    /// Extra env pairs applied after TERM* and before shell-integration env.
    /// Later pairs override earlier ones (provider-key collision rule).
    pub env: Vec<(String, String)>,
    /// Vars removed from the child env (ambient credential stripping).
    pub env_remove: Vec<String>,
}

#[derive(Default)]
pub struct PtyManager {
    entries: Arc<Mutex<HashMap<String, PtyHandle>>>,
    #[cfg(feature = "remote-access")]
    sweeper_started: std::sync::atomic::AtomicBool,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(&self, app: &AppHandle, opts: CreateOpts) -> AppResult<()> {
        if self.entries.lock().contains_key(&opts.id) {
            return Ok(());
        }
        let shell = opts.shell.clone().unwrap_or_else(shell::default_shell);
        let prepared = shell::prepare(&shell);

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: opts.rows,
                cols: opts.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Msg(e.to_string()))?;

        let mut cmd = match crate::wsl::parse_shell_token(&shell) {
            Some(distro) => {
                let mut c = CommandBuilder::new("wsl.exe");
                for a in crate::wsl::spawn_args(distro, &opts.cwd) {
                    c.arg(a);
                }
                c
            }
            None => CommandBuilder::new(&shell),
        };
        cmd.cwd(&opts.cwd);
        for k in &opts.env_remove {
            cmd.env_remove(k);
        }
        // Advertise a modern terminal profile (matches the Electron app).
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "ghostty");
        cmd.env("TERM_PROGRAM_VERSION", "1.1.0");
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        for (k, v) in &prepared.env {
            cmd.env(k, v);
        }
        // WSL only forwards Windows env vars named in WSLENV into the distro.
        if crate::wsl::parse_shell_token(&shell).is_some() {
            let mut names: Vec<String> = vec![
                "TERM_PROGRAM".to_string(),
                "TERM_PROGRAM_VERSION".to_string(),
            ];
            names.extend(opts.env.iter().map(|(k, _)| k.clone()));
            let existing = std::env::var("WSLENV").ok();
            cmd.env(
                "WSLENV",
                crate::wsl::compose_wslenv(existing.as_deref(), &names),
            );
        }
        for a in &prepared.args {
            cmd.arg(a);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Msg(e.to_string()))?;
        drop(pair.slave);

        #[cfg(windows)]
        let job = job::JobObject::new().ok().and_then(|j| {
            let pid = child.process_id()?;
            j.assign_pid(pid).ok()?;
            Some(j)
        });

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Msg(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Msg(e.to_string()))?;

        let writer = Arc::new(Mutex::new(writer));
        let child = Arc::new(Mutex::new(child));
        let out = Arc::new(Mutex::new(OutputState::default()));

        self.entries.lock().insert(
            opts.id.clone(),
            PtyHandle {
                master: pair.master,
                writer: writer.clone(),
                child: child.clone(),
                out: out.clone(),
                #[cfg(windows)]
                job,
                #[cfg(feature = "remote-access")]
                local_size: (opts.cols, opts.rows),
                #[cfg(feature = "remote-access")]
                remote_size: None,
                #[cfg(feature = "remote-access")]
                session_id: opts
                    .startup_command
                    .as_deref()
                    .and_then(extract_claude_session),
            },
        );
        #[cfg(feature = "remote-access")]
        self.ensure_sweeper(app);

        let entries = self.entries.clone();
        let app = app.clone();
        let id = opts.id.clone();
        let startup = opts.startup_command.clone();
        thread::spawn(move || {
            reader_loop(reader, out, writer, startup, child, app, entries, id);
        });

        Ok(())
    }

    /// Returns everything emitted so far and installs the channel for live
    /// output. Done under the output lock so no chunk is lost or duplicated.
    pub fn attach(&self, id: &str, channel: Channel<String>) -> String {
        let entries = self.entries.lock();
        let Some(handle) = entries.get(id) else {
            return String::new();
        };
        let mut out = handle.out.lock();
        let snapshot = String::from_utf8_lossy(&out.ring).into_owned();
        out.carry.clear();
        out.channel = Some(channel);
        snapshot
    }

    pub fn write(&self, id: &str, data: &str) {
        self.write_bytes(id, data.as_bytes());
    }

    pub fn write_bytes(&self, id: &str, data: &[u8]) {
        if let Some(handle) = self.entries.lock().get(id) {
            let mut w = handle.writer.lock();
            let _ = w.write_all(data);
            let _ = w.flush();
        }
    }

    /// True if a live PTY exists for this id (the entry is removed on exit).
    #[cfg(feature = "remote-access")]
    pub fn has(&self, id: &str) -> bool {
        self.entries.lock().contains_key(id)
    }

    /// Terminal backing a Claude session id, if any (routes hook events).
    #[cfg(feature = "remote-access")]
    pub fn terminal_for_session(&self, session_id: &str) -> Option<String> {
        self.entries
            .lock()
            .iter()
            .find(|(_, h)| h.session_id.as_deref() == Some(session_id))
            .map(|(id, _)| id.clone())
    }

    /// Start the prompt-silence sweeper once: a terminal that is mid-command
    /// (OSC 133;C seen, no D yet) but has produced no output for a while, with a
    /// prompt-looking tail, is probably waiting for input (sudo, y/n, wizards).
    #[cfg(feature = "remote-access")]
    fn ensure_sweeper(&self, app: &AppHandle) {
        use std::sync::atomic::Ordering;
        if self.sweeper_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let entries = self.entries.clone();
        let app = app.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_secs(2));
            let mut flagged: Vec<(String, String)> = Vec::new();
            {
                let map = entries.lock();
                for (id, handle) in map.iter() {
                    let mut out = handle.out.lock();
                    let silent_long = out
                        .last_output
                        .is_some_and(|t| t.elapsed() >= Duration::from_secs(10));
                    if !out.detector.is_working() || !silent_long || out.prompt_flagged {
                        continue;
                    }
                    if let Some(line) = prompt_like_tail(&out.tail) {
                        out.prompt_flagged = true; // once per silence period
                        flagged.push((id.clone(), line));
                    }
                }
            }
            for (id, line) in flagged {
                emit_attention(&app, &id, "waiting-input", Some(line));
            }
        });
    }

    /// Subscribe a remote client to a terminal's live output. Returns the current
    /// scrollback snapshot (raw bytes) plus a receiver for subsequent output,
    /// captured atomically under the output lock so nothing is lost or doubled.
    #[cfg(feature = "remote-access")]
    pub fn subscribe_remote(
        &self,
        id: &str,
    ) -> Option<(Vec<u8>, tokio::sync::broadcast::Receiver<Vec<u8>>)> {
        let entries = self.entries.lock();
        let handle = entries.get(id)?;
        let mut out = handle.out.lock();
        let snapshot = out.ring.clone();
        let rx = match &out.remote_tx {
            Some(tx) => tx.subscribe(),
            None => {
                let (tx, rx) = tokio::sync::broadcast::channel(1024);
                out.remote_tx = Some(tx);
                rx
            }
        };
        Some((snapshot, rx))
    }

    /// Resize from the desktop pane. Records the size as the "local" size so a
    /// later remote detach can snap the PTY back to it (R3.14). While a remote
    /// client owns the size, the request is recorded but not applied — the
    /// remote wins until it detaches (remote-wins sizing).
    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        let mut entries = self.entries.lock();
        if let Some(handle) = entries.get_mut(id) {
            #[cfg(feature = "remote-access")]
            {
                handle.local_size = (cols, rows);
                if handle.remote_size.is_some() {
                    return;
                }
            }
            apply_size(handle.master.as_ref(), cols, rows);
        }
    }

    /// Resize from a remote client: takes ownership of the PTY size (remote-wins sizing).
    /// Deliberately does NOT update `local_size`, so the desktop dimensions are
    /// preserved for snap-back on detach (R3.14). Returns false if the terminal
    /// is gone.
    #[cfg(feature = "remote-access")]
    pub fn resize_remote(&self, id: &str, cols: u16, rows: u16) -> bool {
        let mut entries = self.entries.lock();
        if let Some(handle) = entries.get_mut(id) {
            handle.remote_size = Some((cols, rows));
            apply_size(handle.master.as_ref(), cols, rows);
            true
        } else {
            false
        }
    }

    /// The size an attached remote client currently mandates, if any.
    #[cfg(feature = "remote-access")]
    pub fn remote_size(&self, id: &str) -> Option<(u16, u16)> {
        self.entries.lock().get(id).and_then(|h| h.remote_size)
    }

    /// Release remote size ownership and snap the PTY back to the last
    /// desktop-pane size (called when a remote client detaches or disconnects,
    /// R3.14).
    #[cfg(feature = "remote-access")]
    pub fn restore_local_size(&self, id: &str) {
        let mut entries = self.entries.lock();
        if let Some(handle) = entries.get_mut(id) {
            handle.remote_size = None;
            let (cols, rows) = handle.local_size;
            apply_size(handle.master.as_ref(), cols, rows);
        }
    }

    pub fn kill(&self, id: &str) {
        // Remove the entry up front (releasing the map lock before teardown) so
        // that dropping `handle` at the end of this scope drops the PTY master —
        // ClosePseudoConsole then terminates any client still attached to the
        // ConPTY. On Windows the job kill takes down the shell's whole tree,
        // including a grandchild that would otherwise hold the ConPTY open and
        // stop the reader from ever hitting EOF.
        let Some(handle) = self.entries.lock().remove(id) else {
            return;
        };
        #[cfg(windows)]
        if let Some(job) = &handle.job {
            job.terminate();
        }
        let _ = handle.child.lock().kill();
        // The reader thread still EOFs and emits `terminals:exit` via its own Arc
        // clones; its `entries.remove(&id)` on exit is now a harmless no-op.
    }

    pub fn dispose_all(&self) {
        let handles: Vec<PtyHandle> = self.entries.lock().drain().map(|(_, h)| h).collect();
        for handle in handles {
            #[cfg(windows)]
            if let Some(job) = &handle.job {
                job.terminate();
            }
            let _ = handle.child.lock().kill();
        }
    }
}

// Convert a startup script into something a shell runs: newlines become
// carriage returns (Enter) and a trailing CR fires the final line.
fn normalize_startup(cmd: &str) -> String {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut s = trimmed.replace("\r\n", "\r").replace('\n', "\r");
    s.push('\r');
    s
}

#[cfg(feature = "remote-access")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkingPayload {
    id: String,
    working: bool,
}

#[cfg(feature = "remote-access")]
#[derive(Clone, Serialize)]
struct IdPayload {
    id: String,
}

#[cfg(feature = "remote-access")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttentionPayload {
    id: String,
    /// Why the terminal wants the user: "failed" | "notify" | "waiting-input"
    /// | "needs-permission" | "finished" (the latter two come from Claude hooks).
    reason: String,
    message: Option<String>,
}

#[cfg(feature = "remote-access")]
#[derive(Clone, Serialize)]
struct RemoteSizePayload {
    id: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

/// A remote client took ownership of a terminal's size (`Some`) or released it
/// (`None`). The desktop pane mirrors the remote grid while owned (remote-wins sizing).
#[cfg(feature = "remote-access")]
pub fn emit_remote_size(app: &AppHandle, id: &str, size: Option<(u16, u16)>) {
    let _ = app.emit(
        "terminals:remote-size",
        RemoteSizePayload {
            id: id.to_string(),
            cols: size.map(|s| s.0),
            rows: size.map(|s| s.1),
        },
    );
}

/// A terminal needs the user, with a machine-readable reason. Consumed by the
/// desktop sidebar, the remote server, and Web Push.
#[cfg(feature = "remote-access")]
pub fn emit_attention(app: &AppHandle, id: &str, reason: &str, message: Option<String>) {
    let _ = app.emit(
        "terminals:attention",
        AttentionPayload {
            id: id.to_string(),
            reason: reason.to_string(),
            message,
        },
    );
}

/// Emit a detected working/bell transition as a Tauri event. Consumed by the
/// remote server (forwarded to web clients) and available to the desktop.
#[cfg(feature = "remote-access")]
fn emit_detect_event(app: &AppHandle, id: &str, ev: detect::DetectEvent) {
    match ev {
        detect::DetectEvent::Working(working) => {
            let _ = app.emit(
                "terminals:working",
                WorkingPayload {
                    id: id.to_string(),
                    working,
                },
            );
        }
        detect::DetectEvent::Bell => {
            let _ = app.emit("terminals:bell", IdPayload { id: id.to_string() });
        }
        detect::DetectEvent::CommandDone { exit_code } => {
            // Success is covered by the working=false transition; only failures
            // are attention-worthy.
            if let Some(code) = exit_code {
                if code != 0 {
                    emit_attention(app, id, "failed", Some(format!("exited with code {code}")));
                }
            }
        }
        detect::DetectEvent::Notify { message } => {
            emit_attention(app, id, "notify", Some(message));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn reader_loop(
    mut reader: Box<dyn Read + Send>,
    out: Arc<Mutex<OutputState>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    startup: Option<String>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    app: AppHandle,
    entries: Arc<Mutex<HashMap<String, PtyHandle>>>,
    id: String,
) {
    let mut buf = [0u8; 8192];
    let mut startup_pending = startup.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false);

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                {
                    let mut guard = out.lock();
                    guard.on_data(&buf[..n]);
                    #[cfg(feature = "remote-access")]
                    {
                        let events = guard.drain_events();
                        drop(guard);
                        for ev in events {
                            emit_detect_event(&app, &id, ev);
                        }
                    }
                }
                // Inject the startup command once the shell is alive (its first
                // output means the prompt/rc loaded). A short delay lets the
                // prompt finish rendering so the command lands cleanly after it.
                if startup_pending {
                    startup_pending = false;
                    if let Some(cmd) = startup.clone() {
                        let w = writer.clone();
                        thread::spawn(move || {
                            thread::sleep(Duration::from_millis(150));
                            let mut g = w.lock();
                            let _ = g.write_all(normalize_startup(&cmd).as_bytes());
                            let _ = g.flush();
                        });
                    }
                }
            }
            Err(_) => break,
        }
    }

    let code = child
        .lock()
        .wait()
        .map(|s| s.exit_code() as i32)
        .unwrap_or(0);
    let _ = app.emit("terminals:exit", ExitPayload { id: id.clone(), exit_code: code });
    entries.lock().remove(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "remote-access")]
    #[test]
    fn extracts_session_id_from_launch_and_resume_commands() {
        assert_eq!(
            extract_claude_session("claude --session-id abc-123"),
            Some("abc-123".into())
        );
        assert_eq!(
            extract_claude_session("claude --resume xyz --dangerously-skip-permissions"),
            Some("xyz".into())
        );
        assert_eq!(
            extract_claude_session("claude --dangerously-skip-permissions --session-id s1"),
            Some("s1".into())
        );
        assert_eq!(extract_claude_session("claude"), None);
        assert_eq!(extract_claude_session("npm run dev"), None);
    }

    #[cfg(feature = "remote-access")]
    #[test]
    fn prompt_tail_detection_is_conservative() {
        let hit = |s: &str| prompt_like_tail(s.as_bytes());
        assert!(hit("sudo password for user:").is_some());
        assert!(hit("Overwrite? (y/n)").is_some());
        assert!(hit("Do you want to continue? [Y/n]").is_some());
        assert!(hit("Enter passphrase for key:").is_some());
        assert!(hit("Which framework do you prefer?").is_some());
        // Plain output must not match.
        assert!(hit("Compiling foo v0.1.0").is_none());
        assert!(hit("Done in 3.2s").is_none());
        assert!(hit("").is_none());
        // Last non-empty line wins.
        assert!(hit("lots of output\nmore output\nContinue? (y/n)\n").is_some());
        assert!(hit("Continue? (y/n)\nresolved automatically\n").is_none());
    }
}
