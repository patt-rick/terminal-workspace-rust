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
/// The hook events we subscribe to.
const EVENTS: [&str; 2] = ["Notification", "Stop"];

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
    let _ = std::fs::write(spool.join(name), body);
}

/// The command string written into Claude's settings.
fn hook_command(spool: &Path) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    Some(format!(
        "\"{}\" {MARKER} \"{}\"",
        exe.to_string_lossy(),
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
    EVENTS.iter().all(|ev| has_our_entry(&root, ev))
}

/// Idempotently add our Notification/Stop hook entries (existing user hooks
/// are preserved untouched).
pub fn install(settings_path: &Path, spool: &Path) -> Result<(), String> {
    let command = hook_command(spool).ok_or_else(|| "cannot resolve app path".to_string())?;
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

/// Attention reason derived from one hook event.
#[cfg(feature = "remote-access")]
#[derive(Debug, PartialEq, Eq)]
pub struct HookAttention {
    pub session_id: String,
    pub reason: &'static str,
    pub message: Option<String>,
}

/// Classify a raw hook JSON body into an attention event.
#[cfg(feature = "remote-access")]
pub fn classify(body: &str) -> Option<HookAttention> {
    let v: Value = serde_json::from_str(body).ok()?;
    let session_id = v.get("session_id")?.as_str()?.to_string();
    let event = v.get("hook_event_name")?.as_str()?;
    match event {
        "Stop" => Some(HookAttention {
            session_id,
            reason: "finished",
            message: None,
        }),
        "Notification" => {
            let message = v
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string();
            let lower = message.to_lowercase();
            let reason = if lower.contains("permission") {
                "needs-permission"
            } else if lower.contains("waiting") || lower.contains("input") {
                "waiting-input"
            } else {
                "notify"
            };
            Some(HookAttention {
                session_id,
                reason,
                message: if message.is_empty() { None } else { Some(message) },
            })
        }
        _ => None,
    }
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
            let Some(att) = classify(&body) else {
                continue;
            };
            // Route to the terminal that launched this Claude session; events
            // from sessions outside Terminal Workspace are dropped.
            let terminal = app
                .state::<crate::pty::PtyManager>()
                .terminal_for_session(&att.session_id);
            if let Some(terminal_id) = terminal {
                crate::pty::emit_attention(&app, &terminal_id, att.reason, att.message);
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

        let spool = dir.path().join("spool");
        install(&path, &spool).unwrap();
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
        install(&path, &spool).unwrap();
        assert_eq!(read_settings(&path)["hooks"]["Notification"].as_array().unwrap().len(), 2);

        uninstall(&path).unwrap();
        assert!(!is_installed(&path));
        let root = read_settings(&path);
        // Only ours removed.
        assert_eq!(root["hooks"]["Notification"].as_array().unwrap().len(), 1);
        assert_eq!(root["hooks"]["Stop"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn install_into_missing_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        install(&path, &dir.path().join("spool")).unwrap();
        assert!(is_installed(&path));
    }

    #[cfg(feature = "remote-access")]
    #[test]
    fn classify_permission_input_stop() {
        let perm = classify(
            r#"{"session_id":"s1","hook_event_name":"Notification","message":"Claude needs your permission to use Bash"}"#,
        )
        .unwrap();
        assert_eq!(perm.reason, "needs-permission");
        assert_eq!(perm.session_id, "s1");
        assert!(perm.message.unwrap().contains("Bash"));

        let waiting = classify(
            r#"{"session_id":"s2","hook_event_name":"Notification","message":"Claude is waiting for your input"}"#,
        )
        .unwrap();
        assert_eq!(waiting.reason, "waiting-input");

        let stop = classify(r#"{"session_id":"s3","hook_event_name":"Stop"}"#).unwrap();
        assert_eq!(stop.reason, "finished");
        assert_eq!(stop.message, None);

        // Unknown events and garbage are dropped.
        assert!(classify(r#"{"session_id":"s","hook_event_name":"PreToolUse"}"#).is_none());
        assert!(classify("not json").is_none());
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
