//! Tailscale connectivity mode (milestone 3f).
//!
//! Unlike Cloudflare mode there is no tunnel process: the server simply binds the
//! machine's tailnet interface so any device on the same tailnet can reach it at
//! a stable address, with nothing exposed to the public internet. We detect the
//! tailnet address (and MagicDNS name) by shelling out to the `tailscale` CLI.
//!
//! When the tailnet allows it we also front the server with `tailscale serve`
//! HTTPS. That config is persistent on the Tailscale side (it survives app exit
//! and reboots), so we record what we installed in a marker file and only ever
//! remove a config that still matches it — never one the user set up.

use crate::proc::hidden_command;
use parking_lot::Mutex;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Budget for a read-only CLI query (`ip`, `status`, `serve status`, `serve off`).
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
/// Budget for `serve --bg`. Recent CLIs wait here for the user to enable Serve /
/// HTTPS in the admin console instead of exiting, so this must be bounded.
const SERVE_TIMEOUT: Duration = Duration::from_secs(15);

/// Serialises every `tailscale serve` change so a teardown from an old session
/// can't interleave with the next session's setup.
static SERVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleInfo {
    /// This machine's tailnet IPv4 address (100.64.0.0/10).
    pub ip: String,
    /// MagicDNS name (e.g. `host.tailnet.ts.net`) when resolvable — nicer than a
    /// bare IP and stable across address changes.
    pub dns_name: Option<String>,
}

impl TailscaleInfo {
    /// Preferred host for URLs: MagicDNS name if present, else the tailnet IP.
    pub fn host(&self) -> String {
        self.dns_name.clone().unwrap_or_else(|| self.ip.clone())
    }
}

struct CliOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

enum RunError {
    Spawn(String),
    /// Killed at the deadline; carries whatever it printed before then.
    TimedOut {
        stdout: String,
        stderr: String,
    },
}

/// Run the CLI, killing it if it is still running at `deadline`. Both pipes are
/// drained on their own threads so a chatty child can't stall on a full pipe.
fn run(bin: &Path, args: &[&str], deadline: Instant) -> Result<CliOutput, RunError> {
    let mut cmd = hidden_command(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| RunError::Spawn(e.to_string()))?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(CliOutput {
                    success: status.success(),
                    stdout: collect(stdout),
                    stderr: collect(stderr),
                })
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::TimedOut {
                    stdout: collect(stdout),
                    stderr: collect(stderr),
                });
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunError::Spawn(e.to_string()));
            }
        }
    }
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).into_owned()
    })
}

fn collect(reader: JoinHandle<String>) -> String {
    reader.join().unwrap_or_default()
}

/// Detect this machine's tailnet address. Returns `None` if Tailscale isn't
/// installed or the node isn't up (so the UI can show setup instructions rather
/// than failing silently — AC-3.8).
pub fn detect() -> Option<TailscaleInfo> {
    let bin = locate()?;
    let out = run(&bin, &["ip", "-4"], Instant::now() + QUERY_TIMEOUT).ok()?;
    if !out.success {
        return None;
    }
    let ip = out
        .stdout
        .lines()
        .map(str::trim)
        .find(|line| is_tailnet_ipv4(line))?
        .to_string();
    Some(TailscaleInfo {
        ip,
        dns_name: magic_dns(&bin),
    })
}

/// Best-effort MagicDNS name for this node from `tailscale status --json`.
fn magic_dns(bin: &Path) -> Option<String> {
    let out = run(bin, &["status", "--json"], Instant::now() + QUERY_TIMEOUT).ok()?;
    if !out.success {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&out.stdout).ok()?;
    let name = v.get("Self")?.get("DNSName")?.as_str()?;
    let name = name.trim_end_matches('.').trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Locate the `tailscale` CLI: `PATH` first, then the Windows default install.
fn locate() -> Option<PathBuf> {
    let bin = if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    };
    if let Some(path) = std::env::var_os("PATH") {
        if let Some(found) = std::env::split_paths(&path)
            .map(|dir| dir.join(bin))
            .find(|candidate| candidate.is_file())
        {
            return Some(found);
        }
    }
    #[cfg(windows)]
    {
        let default = PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe");
        if default.is_file() {
            return Some(default);
        }
    }
    None
}

/// What currently answers on the node's HTTPS port 443.
#[derive(Debug, PartialEq, Eq)]
enum ServeState {
    Free,
    /// Exactly one handler, `/ → http://127.0.0.1:<port>`, with no Funnel — the
    /// shape `serve_start` installs.
    LocalProxy(u16),
    /// Something else is configured on 443.
    Taken,
    /// The CLI failed, timed out, or printed something we can't read.
    Unknown,
}

fn serve_state(bin: &Path, deadline: Instant) -> ServeState {
    match run(bin, &["serve", "status", "--json"], deadline) {
        Ok(out) if out.success => parse_serve_status(&out.stdout),
        _ => ServeState::Unknown,
    }
}

/// Classify `tailscale serve status --json` (an `ipn.ServeConfig`), e.g.
/// `{"TCP":{"443":{"HTTPS":true}},"Web":{"host.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8765"}}}}}`.
fn parse_serve_status(json: &str) -> ServeState {
    let json = json.trim();
    if json.is_empty() {
        return ServeState::Free;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return ServeState::Unknown;
    };
    let Some(cfg) = v.as_object() else {
        return ServeState::Unknown;
    };

    // Per-session (foreground) serves live in their own sub-configs.
    if let Some(fg) = cfg.get("Foreground").and_then(|f| f.as_object()) {
        if fg.values().any(uses_443) {
            return ServeState::Taken;
        }
    }
    if let Some(funnel) = cfg.get("AllowFunnel").and_then(|f| f.as_object()) {
        if funnel
            .iter()
            .any(|(k, on)| k.ends_with(":443") && on.as_bool().unwrap_or(false))
        {
            return ServeState::Taken;
        }
    }

    let tcp = cfg.get("TCP").and_then(|t| t.get("443"));
    if let Some(tcp) = tcp {
        // `{"HTTPS": true}` is what any web serve on 443 looks like; anything
        // else (TCPForward, TerminateTLS) is a raw TCP forward.
        let plain_https = tcp.as_object().is_some_and(|o| {
            o.iter().all(|(k, val)| {
                k == "HTTPS" || val.is_null() || val == &serde_json::Value::Bool(false)
            })
        });
        if !plain_https {
            return ServeState::Taken;
        }
    }

    let web: Vec<&serde_json::Value> = cfg
        .get("Web")
        .and_then(|w| w.as_object())
        .map(|w| {
            w.iter()
                .filter(|(k, _)| k.ends_with(":443"))
                .map(|(_, site)| site)
                .collect()
        })
        .unwrap_or_default();

    match web.as_slice() {
        [] if tcp.is_none() => ServeState::Free,
        [] => ServeState::Taken,
        [site] => {
            let handlers = site.get("Handlers").and_then(|h| h.as_object());
            let only_root = handlers.filter(|h| h.len() == 1).and_then(|h| h.get("/"));
            let proxy = only_root
                .and_then(|r| r.as_object())
                .filter(|r| r.len() == 1)
                .and_then(|r| r.get("Proxy"))
                .and_then(|p| p.as_str());
            match proxy.and_then(local_proxy_port) {
                Some(port) => ServeState::LocalProxy(port),
                None => ServeState::Taken,
            }
        }
        _ => ServeState::Taken,
    }
}

fn uses_443(cfg: &serde_json::Value) -> bool {
    cfg.get("TCP").and_then(|t| t.get("443")).is_some()
        || cfg
            .get("Web")
            .and_then(|w| w.as_object())
            .is_some_and(|w| w.keys().any(|k| k.ends_with(":443")))
}

/// `http://127.0.0.1:8765` (optionally with a trailing `/`) → 8765.
fn local_proxy_port(target: &str) -> Option<u16> {
    target
        .strip_prefix("http://127.0.0.1:")?
        .trim_end_matches('/')
        .parse()
        .ok()
}

/// What we installed, so teardown only removes our own config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Marker {
    port: u16,
    /// Distinguishes sessions: an old session's teardown must not remove the
    /// config a newer session installed for the same port.
    nonce: String,
}

fn marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join("remote").join("tailscale-serve.json")
}

fn read_marker(data_dir: &Path) -> Option<Marker> {
    let raw = std::fs::read_to_string(marker_path(data_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_marker(data_dir: &Path, marker: &Marker) {
    let path = marker_path(data_dir);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string(marker) {
        let _ = std::fs::write(path, json);
    }
}

fn remove_marker(data_dir: &Path) {
    let _ = std::fs::remove_file(marker_path(data_dir));
}

/// The nonce of a serve config left behind by an earlier run (a crash, or an
/// exit that couldn't finish its teardown), if any. Reading it is a file read,
/// so launch costs nothing for users who never used Tailscale HTTPS.
pub fn leftover_nonce(data_dir: &Path) -> Option<String> {
    read_marker(data_dir).map(|m| m.nonce)
}

#[derive(Debug, PartialEq, Eq)]
enum StartAction {
    Configure,
    InUse,
    Unreadable,
}

fn start_action(state: &ServeState, marker: Option<&Marker>, port: u16) -> StartAction {
    match state {
        ServeState::Free => StartAction::Configure,
        // Our own leftover, or the pre-marker leftover an older version of the
        // app left pointing at the port we're about to use.
        ServeState::LocalProxy(p) if marker.map(|m| m.port) == Some(*p) || *p == port => {
            StartAction::Configure
        }
        ServeState::LocalProxy(_) | ServeState::Taken => StartAction::InUse,
        ServeState::Unknown => StartAction::Unreadable,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum StopAction {
    TurnOff,
    /// The config no longer matches what we installed: leave it, drop the marker.
    ForgetMarker,
    /// Couldn't read the state: keep the marker so a later launch retries.
    Keep,
}

fn stop_action(state: &ServeState, marker: &Marker) -> StopAction {
    match state {
        ServeState::LocalProxy(p) if *p == marker.port => StopAction::TurnOff,
        ServeState::Unknown => StopAction::Keep,
        _ => StopAction::ForgetMarker,
    }
}

fn new_nonce() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Configure `tailscale serve` to front the local server with HTTPS at the
/// node's MagicDNS name (needs "HTTPS Certificates" enabled on the tailnet).
/// Returns the https URL and the session nonce to hand back to [`serve_stop`].
/// A secure origin is what unlocks the full PWA on phones: service worker,
/// background notifications, install.
pub fn serve_start(
    data_dir: &Path,
    port: u16,
    info: &TailscaleInfo,
) -> Result<(String, String), String> {
    let Some(dns_name) = info.dns_name.clone() else {
        return Err("MagicDNS is disabled; HTTPS needs the tailnet DNS name".to_string());
    };
    let bin = locate().ok_or_else(|| "tailscale CLI not found".to_string())?;
    let _serve = SERVE_LOCK.lock();

    let state = serve_state(&bin, Instant::now() + QUERY_TIMEOUT);
    match start_action(&state, read_marker(data_dir).as_ref(), port) {
        StartAction::Configure => {}
        StartAction::InUse => {
            return Err(
                "port 443 on this machine's Tailscale address is already used by another \
                 `tailscale serve` setup; run `tailscale serve --https=443 off` to free it"
                    .to_string(),
            )
        }
        StartAction::Unreadable => {
            return Err("couldn't read the current `tailscale serve` setup".to_string())
        }
    }

    let target = format!("http://127.0.0.1:{port}");
    match run(
        &bin,
        &["serve", "--bg", "--https=443", &target],
        Instant::now() + SERVE_TIMEOUT,
    ) {
        Ok(out) if out.success => {
            let nonce = new_nonce();
            write_marker(
                data_dir,
                &Marker {
                    port,
                    nonce: nonce.clone(),
                },
            );
            Ok((format!("https://{dns_name}"), nonce))
        }
        Ok(out) => Err(describe_serve_failure(&out.stdout, &out.stderr)),
        Err(RunError::TimedOut { stdout, stderr }) => Err(match enable_url(&stdout, &stderr) {
            Some(url) => format!(
                "Tailscale Serve isn't enabled on your tailnet yet. Open {url} to enable it, \
                 then start remote access again"
            ),
            None => "`tailscale serve` didn't answer".to_string(),
        }),
        Err(RunError::Spawn(e)) => Err(format!("tailscale serve failed to run: {e}")),
    }
}

fn describe_serve_failure(stdout: &str, stderr: &str) -> String {
    let lower = format!("{stderr}\n{stdout}").to_lowercase();
    let certs = lower.contains("does not support getting tls certs")
        || lower.contains("https is not enabled")
        || (lower.contains("certificate") && (lower.contains("https") || lower.contains("tls")));
    if certs {
        return "Tailnet HTTPS certificates aren't enabled. Turn on \"HTTPS Certificates\" at \
                https://login.tailscale.com/admin/dns, then start remote access again."
            .to_string();
    }
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    format!("tailscale serve failed: {detail}")
}

/// The admin-console link a waiting `tailscale serve` prints.
fn enable_url(stdout: &str, stderr: &str) -> Option<String> {
    [stdout, stderr]
        .into_iter()
        .flat_map(str::split_whitespace)
        .find(|word| word.starts_with("https://login.tailscale.com/"))
        .map(|url| url.trim_end_matches(['.', ',', ')']).to_string())
}

/// Remove the serve config installed by [`serve_start`], if it is still ours.
///
/// With `nonce`, only the session that installed the marker may remove it (a
/// newer session may have replaced it). Gives up at `deadline`.
pub fn serve_stop(data_dir: &Path, nonce: Option<&str>, deadline: Instant) {
    let Some(_serve) = SERVE_LOCK.try_lock_until(deadline) else {
        return;
    };
    let Some(marker) = read_marker(data_dir) else {
        return;
    };
    if nonce.is_some_and(|n| n != marker.nonce) {
        return;
    }
    let Some(bin) = locate() else {
        return;
    };
    match stop_action(&serve_state(&bin, deadline), &marker) {
        StopAction::TurnOff => {
            if let Ok(out) = run(&bin, &["serve", "--https=443", "off"], deadline) {
                if out.success {
                    remove_marker(data_dir);
                }
            }
        }
        StopAction::ForgetMarker => remove_marker(data_dir),
        StopAction::Keep => {}
    }
}

/// True for an address in Tailscale's CGNAT range 100.64.0.0/10.
fn is_tailnet_ipv4(s: &str) -> bool {
    s.parse::<Ipv4Addr>()
        .map(|ip| {
            let o = ip.octets();
            o[0] == 100 && (64..=127).contains(&o[1])
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_tailnet_range() {
        assert!(is_tailnet_ipv4("100.64.0.1"));
        assert!(is_tailnet_ipv4("100.101.102.103"));
        assert!(is_tailnet_ipv4("100.127.255.254"));
    }

    #[test]
    fn rejects_non_tailnet_addresses() {
        assert!(!is_tailnet_ipv4("100.63.255.255")); // just below the range
        assert!(!is_tailnet_ipv4("100.128.0.0")); // just above the range
        assert!(!is_tailnet_ipv4("192.168.1.10"));
        assert!(!is_tailnet_ipv4("127.0.0.1"));
        assert!(!is_tailnet_ipv4("not-an-ip"));
    }

    #[test]
    fn host_prefers_dns_name() {
        let with_dns = TailscaleInfo {
            ip: "100.64.0.1".into(),
            dns_name: Some("box.tail1234.ts.net".into()),
        };
        assert_eq!(with_dns.host(), "box.tail1234.ts.net");
        let ip_only = TailscaleInfo {
            ip: "100.64.0.1".into(),
            dns_name: None,
        };
        assert_eq!(ip_only.host(), "100.64.0.1");
    }

    const OURS: &str = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"box.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8765"}}}}}"#;

    #[test]
    fn empty_status_is_free() {
        assert_eq!(parse_serve_status(""), ServeState::Free);
        assert_eq!(parse_serve_status("{}\n"), ServeState::Free);
        assert_eq!(
            parse_serve_status(r#"{"TCP":{},"Web":{}}"#),
            ServeState::Free
        );
    }

    #[test]
    fn our_shape_is_a_local_proxy() {
        assert_eq!(parse_serve_status(OURS), ServeState::LocalProxy(8765));
        let slash = OURS.replace("8765\"", "8765/\"");
        assert_eq!(parse_serve_status(&slash), ServeState::LocalProxy(8765));
    }

    #[test]
    fn other_443_setups_are_taken() {
        // Another handler path alongside ours.
        let extra = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"b.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8765"},"/api":{"Proxy":"http://127.0.0.1:9000"}}}}}"#;
        assert_eq!(parse_serve_status(extra), ServeState::Taken);
        // A static path / text handler.
        let path = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"b.ts.net:443":{"Handlers":{"/":{"Path":"C:\\site"}}}}}"#;
        assert_eq!(parse_serve_status(path), ServeState::Taken);
        // A non-loopback proxy target.
        let remote = OURS.replace("127.0.0.1", "192.168.1.5");
        assert_eq!(parse_serve_status(&remote), ServeState::Taken);
        // Raw TCP forward on 443.
        let tcp = r#"{"TCP":{"443":{"TCPForward":"127.0.0.1:22"}}}"#;
        assert_eq!(parse_serve_status(tcp), ServeState::Taken);
        // Funnel turned on for our exact shape.
        let funnel = OURS.replacen('{', r#"{"AllowFunnel":{"b.ts.net:443":true},"#, 1);
        assert_eq!(parse_serve_status(&funnel), ServeState::Taken);
        // A foreground serve on 443.
        let fg = r#"{"Foreground":{"sess1":{"TCP":{"443":{"HTTPS":true}}}}}"#;
        assert_eq!(parse_serve_status(fg), ServeState::Taken);
    }

    #[test]
    fn other_ports_do_not_count() {
        let other = r#"{"TCP":{"8443":{"HTTPS":true}},"Web":{"b.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#;
        assert_eq!(parse_serve_status(other), ServeState::Free);
    }

    #[test]
    fn unreadable_status_is_unknown() {
        assert_eq!(parse_serve_status("not json"), ServeState::Unknown);
        assert_eq!(parse_serve_status("[1,2]"), ServeState::Unknown);
    }

    fn marker(port: u16) -> Marker {
        Marker {
            port,
            nonce: "n".into(),
        }
    }

    #[test]
    fn start_configures_only_free_or_own_443() {
        assert_eq!(
            start_action(&ServeState::Free, None, 8765),
            StartAction::Configure
        );
        // Our crash leftover for a different port: reconfigure.
        assert_eq!(
            start_action(&ServeState::LocalProxy(9000), Some(&marker(9000)), 8765),
            StartAction::Configure
        );
        // Pre-marker leftover pointing at the port we're about to use: adopt.
        assert_eq!(
            start_action(&ServeState::LocalProxy(8765), None, 8765),
            StartAction::Configure
        );
        // Someone else's local proxy: leave it.
        assert_eq!(
            start_action(&ServeState::LocalProxy(3000), None, 8765),
            StartAction::InUse
        );
        assert_eq!(
            start_action(&ServeState::Taken, Some(&marker(8765)), 8765),
            StartAction::InUse
        );
        assert_eq!(
            start_action(&ServeState::Unknown, None, 8765),
            StartAction::Unreadable
        );
    }

    #[test]
    fn stop_removes_only_a_matching_config() {
        let m = marker(8765);
        assert_eq!(
            stop_action(&ServeState::LocalProxy(8765), &m),
            StopAction::TurnOff
        );
        assert_eq!(
            stop_action(&ServeState::LocalProxy(3000), &m),
            StopAction::ForgetMarker
        );
        assert_eq!(
            stop_action(&ServeState::Taken, &m),
            StopAction::ForgetMarker
        );
        assert_eq!(stop_action(&ServeState::Free, &m), StopAction::ForgetMarker);
        assert_eq!(stop_action(&ServeState::Unknown, &m), StopAction::Keep);
    }

    #[test]
    fn marker_round_trips_on_disk() {
        let dir = std::env::temp_dir().join(format!("tw-ts-marker-{}", new_nonce()));
        assert!(read_marker(&dir).is_none());
        write_marker(&dir, &marker(8765));
        assert_eq!(read_marker(&dir), Some(marker(8765)));
        assert_eq!(leftover_nonce(&dir).as_deref(), Some("n"));
        remove_marker(&dir);
        assert!(read_marker(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stop_with_a_stale_nonce_leaves_the_marker() {
        let dir = std::env::temp_dir().join(format!("tw-ts-nonce-{}", new_nonce()));
        write_marker(&dir, &marker(8765));
        // A teardown from an older session must not touch a newer session's marker.
        serve_stop(&dir, Some("older"), Instant::now() + Duration::from_secs(1));
        assert_eq!(read_marker(&dir), Some(marker(8765)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_the_enable_link() {
        let out = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n";
        assert_eq!(
            enable_url(out, "").as_deref(),
            Some("https://login.tailscale.com/f/serve?node=abc123")
        );
        assert_eq!(
            enable_url("", "visit https://login.tailscale.com/f/https?node=x.").as_deref(),
            Some("https://login.tailscale.com/f/https?node=x")
        );
        assert_eq!(enable_url("no link here", ""), None);
    }

    #[test]
    fn serve_failures_name_the_cause() {
        let certs =
            describe_serve_failure("", "error: this node does not support getting TLS certs");
        assert!(certs.contains("HTTPS Certificates"));
        let other = describe_serve_failure("", "error: port already in use");
        assert_eq!(other, "tailscale serve failed: error: port already in use");
        // A failure that merely mentions https isn't a certificate problem.
        let url = describe_serve_failure("", "failed to reach https://example");
        assert!(url.starts_with("tailscale serve failed"));
    }

    #[test]
    fn run_kills_a_child_at_the_deadline() {
        let (bin, args): (&str, &[&str]) = if cfg!(windows) {
            // Run ping itself, not via cmd: killing cmd would leave ping holding
            // the pipe open until it finished.
            ("ping", &["-n", "6", "127.0.0.1"])
        } else {
            ("sleep", &["5"])
        };
        let started = Instant::now();
        let result = run(
            Path::new(bin),
            args,
            Instant::now() + Duration::from_millis(300),
        );
        assert!(matches!(result, Err(RunError::TimedOut { .. })));
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn run_captures_output() {
        let (bin, args): (&str, &[&str]) = if cfg!(windows) {
            ("cmd", &["/C", "echo hello"])
        } else {
            ("sh", &["-c", "echo hello"])
        };
        let out = run(Path::new(bin), args, Instant::now() + QUERY_TIMEOUT)
            .ok()
            .unwrap();
        assert!(out.success);
        assert_eq!(out.stdout.trim(), "hello");
    }
}
