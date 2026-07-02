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
}

impl OutputState {
    fn on_data(&mut self, bytes: &[u8]) {
        self.ring.extend_from_slice(bytes);
        if self.ring.len() > RING_CAP {
            let excess = self.ring.len() - RING_CAP;
            self.ring.drain(..excess);
        }
        // Feed remote subscribers raw bytes (xterm.js reassembles split UTF-8
        // across writes). A full/lagged receiver just drops frames — never blocks.
        #[cfg(feature = "remote-access")]
        if let Some(tx) = &self.remote_tx {
            let _ = tx.send(bytes.to_vec());
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
}

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    out: Arc<Mutex<OutputState>>,
}

pub struct CreateOpts {
    pub id: String,
    pub cwd: String,
    pub shell: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub startup_command: Option<String>,
}

#[derive(Default)]
pub struct PtyManager {
    entries: Arc<Mutex<HashMap<String, PtyHandle>>>,
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

        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&opts.cwd);
        // Advertise a modern terminal profile (matches the Electron app).
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "ghostty");
        cmd.env("TERM_PROGRAM_VERSION", "1.1.0");
        for (k, v) in &prepared.env {
            cmd.env(k, v);
        }
        for a in &prepared.args {
            cmd.arg(a);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Msg(e.to_string()))?;
        drop(pair.slave);

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
            },
        );

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

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(handle) = self.entries.lock().get(id) {
            let _ = handle.master.resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    pub fn kill(&self, id: &str) {
        if let Some(handle) = self.entries.lock().get(id) {
            let _ = handle.child.lock().kill();
        }
        // The reader thread emits exit + removes the entry on EOF.
    }

    pub fn dispose_all(&self) {
        let entries = self.entries.lock();
        for handle in entries.values() {
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
                out.lock().on_data(&buf[..n]);
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
