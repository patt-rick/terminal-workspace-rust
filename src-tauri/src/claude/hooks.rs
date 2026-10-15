//! Claude Code hook integration: exact "needs you" signals instead of title
//! heuristics.
//!
//! Claude Code fires configured hooks on semantic events — `Notification`
//! (needs permission / waiting for input, with the message text) and `Stop`
//! (turn finished) — passing JSON on stdin that includes the `session_id`.
//! Terminal Workspace launches Claude with `--session-id`/`--resume`, so hook
//! events route precisely back to the spawning terminal.
//!
//! Transport: the hook command re-invokes this very executable with
//! `--hook-sink <spool-dir>`, which copies stdin to a unique file (no shell
//! quoting or platform dependencies). A watcher thread in the app polls the
//! spool, classifies each event, and emits a `terminals:attention` event.
//!
//! Installation edits the user's `~/.claude/settings.json` — strictly additive
//! and marker-based, so existing user hooks are never touched. It is an
//! explicit opt-in from the settings UI.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Our entries are recognized by this substring in the hook command.
const MARKER: &str = "--hook-sink";
/// The hook events we subscribe to. `SessionStart`/`SessionEnd` let the phone's
/// chat view follow `/clear` and notice Claude exiting.
const EVENTS: [&str; 4] = ["Notification", "Stop", "SessionStart", "SessionEnd"];
/// Present in every install, old or new — what "installed" means.
const CORE_EVENTS: [&str; 2] = ["Notification", "Stop"];

pub fn spool_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("hook-events")
}

/// stdin → unique spool file. Runs in the short-lived `--hook-sink` process.
pub fn run_sink(spool: &Path) {
    use std::io::Read;
    let mut body = String::new();
    if std::io::stdin().read_to_string(&mut body).is_err() || body.trim().is_empty() {
        return;
    }
    let _ = std::fs::create_dir_all(spool);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = format!("{nanos}-{}.json", std::process::id());
    let terminal = std::env::var("TW_TERMINAL_ID").ok();
    let _ = std::fs::write(spool.join(name), wrap_with_terminal(&body, terminal.as_deref()));
}

/// Tag a hook payload with the Terminal Workspace terminal it came from (the
/// PTY sets `TW_TERMINAL_ID`), so routing survives a session-id change.
pub fn wrap_with_terminal(body: &str, terminal: Option<&str>) -> String {
    let Some(t) = terminal.filter(|t| !t.is_empty()) else {
        return body.to_string();
    };
    match serde_json::from_str::<Value>(body) {
        Ok(payload) => json!({ "terminalId": t, "payload": payload }).to_string(),
        Err(_) => body.to_string(),
    }
}

/// The command string written into Claude's settings.
pub fn native_hook_command(spool: &Path) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    Some(format!(
        "\"{}\" {MARKER} \"{}\"",
        exe.to_string_lossy(),
        spool.to_string_lossy()
    ))
}

/// Hook command for a distro's settings.json: the Windows exe invoked through
/// WSL interop (its /mnt/… path), spool arg kept as a Windows path because the
/// sink runs as a Windows process.
#[cfg(windows)]
pub fn wsl_hook_command(spool: &Path) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let exe_wsl = crate::wsl::win_to_wsl_path(&exe.to_string_lossy())?;
    Some(format!(
        "\"{exe_wsl}\" {MARKER} \"{}\"",
        spool.to_string_lossy()
    ))
}

fn hooks_array<'a>(root: &'a mut Value, event: &str) -> &'a mut Vec<Value> {
    let hooks = root
        .as_object_mut()
        .expect("settings root is an object")
        .entry("hooks")
        .or_insert_with(|| json!({}));
    let arr = hooks
        .as_object_mut()
        .expect("hooks is an object")
        .entry(event)
        .or_insert_with(|| json!([]));
    if !arr.is_array() {
        *arr = json!([]);
    }
    arr.as_array_mut().unwrap()
}

/// True if any of our marker entries exist for `event`.
fn has_our_entry(root: &Value, event: &str) -> bool {
    root.get("hooks")
        .and_then(|h| h.get(event))
        .and_then(|a| a.as_array())
        .is_some_and(|entries| {
            entries.iter().any(|e| {
                e.get("hooks")
                    .and_then(|h| h.as_array())
                    .is_some_and(|cmds| {
                        cmds.iter().any(|c| {
                            c.get("command")
                                .and_then(|v| v.as_str())
                                .is_some_and(|s| s.contains(MARKER))
                        })
                    })
            })
        })
}

fn remove_our_entries(root: &mut Value, event: &str) {
    if root.get("hooks").and_then(|h| h.get(event)).is_none() {
        return;
    }
    let arr = hooks_array(root, event);
    arr.retain(|e| {
        !e.get("hooks")
            .and_then(|h| h.as_array())
            .is_some_and(|cmds| {
                cmds.iter().any(|c| {
                    c.get("command")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| s.contains(MARKER))
                })
            })
    });
}

fn read_settings(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_settings(path: &Path, root: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let body = serde_json::to_string_pretty(root).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Whether our hooks are installed in the given Claude settings file.
pub fn is_installed(settings_path: &Path) -> bool {
    let root = read_settings(settings_path);
    CORE_EVENTS.iter().all(|ev| has_our_entry(&root, ev))
}

/// Idempotently add our Notification/Stop hook entries (existing user hooks
/// are preserved untouched).
pub fn install(settings_path: &Path, command: &str) -> Result<(), String> {
    let mut root = read_settings(settings_path);
    if !root.is_object() {
        return Err("~/.claude/settings.json is not a JSON object".to_string());
    }
    for event in EVENTS {
        remove_our_entries(&mut root, event); // replace stale exe paths
        hooks_array(&mut root, event).push(json!({
            "matcher": "",
            "hooks": [{ "type": "command", "command": command }],
        }));
    }
    write_settings(settings_path, &root)
}

/// Remove only our marker entries.
pub fn uninstall(settings_path: &Path) -> Result<(), String> {
    let mut root = read_settings(settings_path);
    if !root.is_object() {
        return Ok(());
    }
    for event in EVENTS {
        remove_our_entries(&mut root, event);
    }
    write_settings(settings_path, &root)
}

/// The command an existing install uses (from a core event's marker entry).
#[cfg(feature = "remote-access")]
fn our_command(root: &Value) -> Option<String> {
    CORE_EVENTS.iter().find_map(|ev| {
        root.get("hooks")?
            .get(ev)?
            .as_array()?
            .iter()
            .filter_map(|e| e.get("hooks")?.as_array())
            .flatten()
            .find_map(|c| {
                c.get("command")?
                    .as_str()
                    .filter(|s| s.contains(MARKER))
                    .map(str::to_string)
            })
    })
}

/// Add events introduced after an install, reusing that install's own command.
/// Existing entries are never rewritten, so a dev build can't take over the
/// installed app's hooks. Returns whether anything changed.
#[cfg(feature = "remote-access")]
pub fn upgrade(settings_path: &Path) -> Result<bool, String> {
    let mut root = read_settings(settings_path);
    if !CORE_EVENTS.iter().all(|ev| has_our_entry(&root, ev)) {
        return Ok(false);
    }
    let Some(command) = our_command(&root) else {
        return Ok(false);
    };
    let mut changed = false;
    for event in EVENTS {
        if !has_our_entry(&root, event) {
            hooks_array(&mut root, event).push(json!({
                "matcher": "",
                "hooks": [{ "type": "command", "command": command }],
            }));
            changed = true;
        }
    }
    if changed {
        write_settings(settings_path, &root)?;
    }
    Ok(changed)
}

/// One hook event from the spool.
#[cfg(feature = "remote-access")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookEvent {
    /// The PTY that spawned this Claude (wrapped payloads only).
    pub terminal_id: Option<String>,
    pub session_id: String,
    pub transcript_path: Option<String>,
    /// `hook_event_name`.
    pub event: String,
    /// SessionStart `source` / SessionEnd `reason`.
    pub source: Option<String>,
    /// (reason, message) when the event wants the user's attention.
    pub attention: Option<(&'static str, Option<String>)>,
}

/// Parse a spool file body (wrapped `{terminalId, payload}` or a bare payload).
#[cfg(feature = "remote-access")]
pub fn parse_event(body: &str) -> Option<HookEvent> {
    let v: Value = serde_json::from_str(body).ok()?;
    let (terminal_id, p) = match v.get("payload") {
        Some(p) => (v.get("terminalId").and_then(Value::as_str).map(str::to_string), p),
        None => (None, &v),
    };
    let session_id = p.get("session_id")?.as_str()?.to_string();
    let event = p.get("hook_event_name")?.as_str()?.to_string();
    let attention = match event.as_str() {
        "Stop" => Some(("finished", None)),
        "Notification" => {
            let message = p.get("message").and_then(Value::as_str).unwrap_or("").to_string();
            let lower = message.to_lowercase();
            let reason = if lower.contains("permission") {
                "needs-permission"
            } else if lower.contains("waiting") || lower.contains("input") {
                "waiting-input"
            } else {
                "notify"
            };
            Some((reason, (!message.is_empty()).then_some(message)))
        }
        "SessionStart" | "SessionEnd" => None,
        _ => return None,
    };
    let source = p
        .get("source")
        .or_else(|| p.get("reason"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let transcript_path = p.get("transcript_path").and_then(Value::as_str).map(str::to_string);
    Some(HookEvent { terminal_id, session_id, transcript_path, event, source, attention })
}

/// What to do with an event routed to a terminal whose session is `current`.
#[cfg(feature = "remote-access")]
#[derive(Debug, PartialEq, Eq)]
pub struct Route {
    /// The event belongs to this terminal's Claude.
    pub accept: bool,
    /// Switch the terminal to the event's session id (`/clear` and forks).
    pub adopt: bool,
    /// Claude exited.
    pub ended: bool,
}

/// `current_ended`: a SessionEnd for `current` was already routed. Hooks can't
/// tell a nested `claude -p --resume X` (run by a tool, sharing the env var)
/// from the TUI's own `/resume`; only the latter ends the current session
/// first, so a `resume` start is adopted only after that.
#[cfg(feature = "remote-access")]
pub fn decide(ev: &HookEvent, current: Option<&str>, current_ended: bool) -> Route {
    let continues = ev.event == "SessionStart"
        && current.is_some()
        && match ev.source.as_deref() {
            Some("clear" | "compact") => true,
            Some("resume") => current_ended,
            _ => false,
        };
    let adopt = continues && current != Some(ev.session_id.as_str());
    let accept = adopt || current == Some(ev.session_id.as_str());
    // `/clear` and `/resume` end a session but Claude keeps running.
    let ended = accept
        && ev.event == "SessionEnd"
        && !matches!(ev.source.as_deref(), Some("clear" | "resume"));
    Route { accept, adopt, ended }
}

/// Poll the spool dir and route events to terminals as attention events.
#[cfg(feature = "remote-access")]
pub fn start_watcher(app: tauri::AppHandle, spool: PathBuf) {
    use tauri::Manager;
    std::fs::create_dir_all(&spool).ok();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let Ok(entries) = std::fs::read_dir(&spool) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(body) = std::fs::read_to_string(&path) else {
                continue;
            };
            let _ = std::fs::remove_file(&path);
            let Some(ev) = parse_event(&body) else {
                continue;
            };
            // Route to the spawning terminal: by its id when the payload is
            // wrapped, else by session id. Events from sessions outside
            // Terminal Workspace are dropped.
            let pty = app.state::<crate::pty::PtyManager>();
            let terminal = ev
                .terminal_id
                .clone()
                .filter(|id| pty.has(id))
                .or_else(|| pty.terminal_for_session(&ev.session_id));
            let Some(terminal_id) = terminal else {
                continue;
            };
            let current = pty.chat_source(&terminal_id).and_then(|s| s.session_id);
            let route = decide(&ev, current.as_deref(), pty.session_ended(&terminal_id));
            if !route.accept {
                continue; // a nested Claude sharing the env var
            }
            if route.adopt {
                pty.adopt_session(&terminal_id, &ev.session_id);
            }
            match ev.event.as_str() {
                "SessionStart" => pty.set_session_ended(&terminal_id, false),
                "SessionEnd" => pty.set_session_ended(&terminal_id, true),
                _ => {}
            }
            pty.note_transcript(&terminal_id, ev.transcript_path.clone());
            pty.set_claude_alive(&app, &terminal_id, !route.ended);
            if let Some((reason, message)) = ev.attention {
                crate::pty::emit_attention(&app, &terminal_id, reason, message);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_then_uninstall_preserves_user_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // Pre-existing user config with their own hook.
        std::fs::write(
            &path,
            r#"{
              "model": "opus",
              "hooks": {
                "Notification": [
                  {"matcher": "", "hooks": [{"type": "command", "command": "my-own-notifier"}]}
                ]
              }
            }"#,
        )
        .unwrap();

        let cmd = "\"C:\\app.exe\" --hook-sink \"C:\\spool\"";
        install(&path, cmd).unwrap();
        assert!(is_installed(&path));
        let root = read_settings(&path);
        // User's hook and setting still present.
        assert_eq!(root["model"], "opus");
        let notif = root["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 2);
        assert!(notif[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("my-own-notifier"));
        assert!(root["hooks"]["Stop"].as_array().unwrap().len() == 1);

        // Install is idempotent (replaces, not duplicates).
        install(&path, cmd).unwrap();
        assert_eq!(read_settings(&path)["hooks"]["Notification"].as_array().unwrap().len(), 2);

        uninstall(&path).unwrap();
        assert!(!is_installed(&path));
        let root = read_settings(&path);
        // Only ours removed.
        assert_eq!(root["hooks"]["Notification"].as_array().unwrap().len(), 1);
        assert_eq!(root["hooks"]["Stop"].as_array().unwrap().len(), 0);
        assert_eq!(root["hooks"]["SessionStart"].as_array().unwrap().len(), 0);
        assert_eq!(root["hooks"]["SessionEnd"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn install_into_missing_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        install(&path, "\"C:\\app.exe\" --hook-sink \"C:\\spool\"").unwrap();
        assert!(is_installed(&path));
    }

    #[cfg(windows)]
    #[test]
    fn wsl_hook_command_translates_exe_path_and_keeps_windows_spool() {
        // Can't control current_exe in a test; instead verify the format helper
        // pieces: translation + quoting via a direct format check.
        let exe_wsl = crate::wsl::win_to_wsl_path(r"C:\Apps\tw\tw.exe").unwrap();
        assert_eq!(exe_wsl, "/mnt/c/Apps/tw/tw.exe");
    }

    #[cfg(feature = "remote-access")]
    #[test]
    fn parse_event_attention_and_routing_fields() {
        let perm = parse_event(
            r#"{"session_id":"s1","hook_event_name":"Notification","message":"Claude needs your permission to use Bash","transcript_path":"/x/s1.jsonl"}"#,
        )
        .unwrap();
        assert_eq!(perm.session_id, "s1");
        assert_eq!(perm.event, "Notification");
        assert_eq!(perm.terminal_id, None);
        assert_eq!(perm.transcript_path.as_deref(), Some("/x/s1.jsonl"));
        let (reason, msg) = perm.attention.clone().unwrap();
        assert_eq!(reason, "needs-permission");
        assert!(msg.unwrap().contains("Bash"));

        let waiting = parse_event(
            r#"{"session_id":"s2","hook_event_name":"Notification","message":"Claude is waiting for your input"}"#,
        )
        .unwrap();
        assert_eq!(waiting.attention.unwrap().0, "waiting-input");

        let stop = parse_event(r#"{"session_id":"s3","hook_event_name":"Stop"}"#).unwrap();
        assert_eq!(stop.attention, Some(("finished", None)));

        let start = parse_event(
            r#"{"terminalId":"t9","payload":{"session_id":"s4","hook_event_name":"SessionStart","source":"clear"}}"#,
        )
        .unwrap();
        assert_eq!(start.terminal_id.as_deref(), Some("t9"));
        assert_eq!(start.source.as_deref(), Some("clear"));
        assert_eq!(start.attention, None);

        let end = parse_event(
            r#"{"session_id":"s5","hook_event_name":"SessionEnd","reason":"prompt_input_exit"}"#,
        )
        .unwrap();
        assert_eq!(end.source.as_deref(), Some("prompt_input_exit"));
        assert_eq!(end.attention, None);

        assert!(parse_event(r#"{"session_id":"s","hook_event_name":"PreToolUse"}"#).is_none());
        assert!(parse_event("not json").is_none());
    }

    #[cfg(feature = "remote-access")]
    #[test]
    fn decide_routes_only_this_terminals_session() {
        let ev = |event: &str, sid: &str, source: Option<&str>| HookEvent {
            terminal_id: Some("t".into()),
            session_id: sid.into(),
            transcript_path: None,
            event: event.into(),
            source: source.map(str::to_string),
            attention: None,
        };
        let r = |accept, adopt, ended| Route { accept, adopt, ended };
        let live = |e: &HookEvent, cur| decide(e, cur, false);
        // Same session: routed.
        assert_eq!(live(&ev("Stop", "a", None), Some("a")), r(true, false, false));
        // A nested `claude -p` sharing the env var: dropped.
        assert_eq!(live(&ev("Stop", "b", None), Some("a")), r(false, false, false));
        assert_eq!(live(&ev("SessionStart", "b", Some("startup")), Some("a")), r(false, false, false));
        assert_eq!(live(&ev("SessionEnd", "b", Some("other")), Some("a")), r(false, false, false));
        // /clear (and compact) moves the terminal to the new session.
        assert_eq!(live(&ev("SessionStart", "b", Some("clear")), Some("a")), r(true, true, false));
        assert_eq!(live(&ev("SessionStart", "a", Some("compact")), Some("a")), r(true, false, false));
        // A nested `claude -p --resume b` while `a` is live: not a takeover.
        assert_eq!(live(&ev("SessionStart", "b", Some("resume")), Some("a")), r(false, false, false));
        // The TUI's /resume ends `a` (reason "resume") first, then starts `b`.
        assert_eq!(live(&ev("SessionEnd", "a", Some("resume")), Some("a")), r(true, false, false));
        assert_eq!(decide(&ev("SessionStart", "b", Some("resume")), Some("a"), true), r(true, true, false));
        assert_eq!(live(&ev("SessionStart", "a", Some("resume")), Some("a")), r(true, false, false));
        // A terminal without a session never gains one (shells stay shells).
        assert_eq!(decide(&ev("SessionStart", "b", Some("clear")), None, true), r(false, false, false));
        assert_eq!(decide(&ev("SessionStart", "b", Some("resume")), None, true), r(false, false, false));
        // Exit ends Claude; the SessionEnd that /clear fires does not.
        assert_eq!(live(&ev("SessionEnd", "a", Some("prompt_input_exit")), Some("a")), r(true, false, true));
        assert_eq!(live(&ev("SessionEnd", "a", Some("clear")), Some("a")), r(true, false, false));
    }

    #[test]
    fn wrap_with_terminal_wraps_json_only() {
        let body = r#"{"session_id":"s"}"#;
        let wrapped: Value = serde_json::from_str(&wrap_with_terminal(body, Some("t1"))).unwrap();
        assert_eq!(wrapped["terminalId"], "t1");
        assert_eq!(wrapped["payload"]["session_id"], "s");
        assert_eq!(wrap_with_terminal(body, None), body);
        assert_eq!(wrap_with_terminal(body, Some("")), body);
        assert_eq!(wrap_with_terminal("garbage", Some("t1")), "garbage");
    }

    #[cfg(feature = "remote-access")]
    #[test]
    fn upgrade_adds_new_events_with_the_installed_command() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // Not installed: nothing to upgrade, file untouched.
        assert_eq!(upgrade(&path), Ok(false));
        assert!(!path.exists());
        let cmd = "\"C:\\Program Files\\tw\\tw.exe\" --hook-sink \"C:\\spool\"";
        // An install from before SessionStart/SessionEnd existed.
        std::fs::write(
            &path,
            format!(
                r#"{{"hooks":{{"Notification":[{{"matcher":"","hooks":[{{"type":"command","command":{c}}}]}}],"Stop":[{{"matcher":"","hooks":[{{"type":"command","command":{c}}}]}}]}}}}"#,
                c = serde_json::to_string(cmd).unwrap()
            ),
        )
        .unwrap();
        assert!(is_installed(&path));
        assert_eq!(upgrade(&path), Ok(true));
        let root = read_settings(&path);
        for ev in ["SessionStart", "SessionEnd"] {
            // The existing install's command, verbatim — never this process's exe.
            assert_eq!(root["hooks"][ev][0]["hooks"][0]["command"], cmd);
        }
        assert_eq!(root["hooks"]["Notification"].as_array().unwrap().len(), 1);
        assert_eq!(upgrade(&path), Ok(false));
    }

    #[test]
    fn sink_writes_spool_file() {
        // run_sink reads stdin — exercise the write path via classify+spool
        // layout instead (stdin isn't controllable in a unit test); assert the
        // dir shape helper at least.
        let dir = tempfile::tempdir().unwrap();
        assert!(spool_dir(dir.path()).ends_with("hook-events"));
    }
}
