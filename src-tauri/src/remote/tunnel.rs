//! `cloudflared` process management for the Cloudflare quick-tunnel connectivity
//! mode (milestone 3e).
//!
//! We locate the binary (app-data managed copy → `PATH`), one-click download it
//! when missing (win-x64 first, then linux; macOS points at Homebrew because
//! Cloudflare ships it as a tarball), then spawn
//! `cloudflared tunnel --url http://127.0.0.1:<port>`, parse the assigned
//! `*.trycloudflare.com` URL from stderr, and health-monitor the child so a
//! tunnel death mid-session surfaces to the desktop (R3.11).
//!
//! No account or config is required — quick tunnels are anonymous and ephemeral;
//! the public URL changes every launch.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

/// How long to wait for cloudflared to publish its public URL before giving up.
const URL_TIMEOUT: Duration = Duration::from_secs(30);
/// A sanity floor for a downloaded binary — the real thing is tens of MB.
const MIN_BINARY_BYTES: usize = 1_000_000;

/// A running quick tunnel. Dropping it (or calling [`Tunnel::kill`]) tears down
/// the `cloudflared` child.
pub struct Tunnel {
    pub url: String,
    kill_tx: Option<oneshot::Sender<()>>,
}

impl Tunnel {
    /// Launch a quick tunnel pointing at `127.0.0.1:<port>` and resolve once its
    /// public URL is known (or error on spawn failure / 30s URL timeout).
    pub async fn spawn(app: AppHandle, port: u16) -> Result<Tunnel, String> {
        let bin = locate_or_install(&app).await?;

        let _ = app.emit("remote:cloudflared-progress", "Starting tunnel…");
        let mut child = Command::new(&bin)
            .arg("tunnel")
            .arg("--no-autoupdate")
            .arg("--url")
            .arg(format!("http://127.0.0.1:{port}"))
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to launch cloudflared: {e}"))?;

        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "cloudflared produced no stderr pipe".to_string())?;
        let (url_tx, url_rx) = oneshot::channel::<String>();

        // Reader task: scan stderr for the assigned URL, then keep draining so the
        // pipe never fills and stalls the child.
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut url_tx = Some(url_tx);
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(url) = parse_trycloudflare_url(&line) {
                    if let Some(tx) = url_tx.take() {
                        let _ = tx.send(url);
                    }
                }
            }
        });

        // Monitor task: owns the child so it can kill on request and emit when the
        // tunnel dies on its own (R3.11 → desktop toast + restart offer).
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let monitor_app = app.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = kill_rx => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
                _ = child.wait() => {
                    let _ = monitor_app.emit("remote:tunnel-died", ());
                }
            }
        });

        let url = tokio::time::timeout(URL_TIMEOUT, url_rx)
            .await
            .map_err(|_| "timed out waiting for the tunnel URL (30s)".to_string())?
            .map_err(|_| "cloudflared exited before publishing a URL".to_string())?;

        let _ = app.emit("remote:cloudflared-progress", "Tunnel ready.");
        Ok(Tunnel {
            url,
            kill_tx: Some(kill_tx),
        })
    }

    /// Signal the monitor task to kill the child. Idempotent.
    pub fn kill(&mut self) {
        if let Some(tx) = self.kill_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Pull a `https://<sub>.trycloudflare.com` URL out of a cloudflared log line.
/// cloudflared prints it inside an ASCII box, so we stop at the first whitespace
/// or box border after `https://` and trim any trailing slash.
fn parse_trycloudflare_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches('/').to_string();
    if url.ends_with(".trycloudflare.com") {
        Some(url)
    } else {
        None
    }
}

fn bin_name() -> &'static str {
    if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

/// Locate an existing cloudflared, else download one into app-data.
async fn locate_or_install(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = locate(app) {
        return Ok(path);
    }
    install(app).await
}

/// Managed app-data copy first (what we downloaded), then anything on `PATH`.
fn locate(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().app_data_dir() {
        let managed = dir.join(bin_name());
        if managed.is_file() {
            return Some(managed);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin_name()))
        .find(|candidate| candidate.is_file())
}

/// Official latest-release binary URL for the current OS/arch, or an error with
/// install guidance for platforms we don't auto-download.
fn download_url() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok(concat!(
            "https://github.com/cloudflare/cloudflared/releases/latest/download/",
            "cloudflared-windows-amd64.exe"
        )),
        ("windows", "aarch64") => Ok(concat!(
            "https://github.com/cloudflare/cloudflared/releases/latest/download/",
            "cloudflared-windows-386.exe"
        )),
        ("linux", "x86_64") => Ok(concat!(
            "https://github.com/cloudflare/cloudflared/releases/latest/download/",
            "cloudflared-linux-amd64"
        )),
        ("linux", "aarch64") => Ok(concat!(
            "https://github.com/cloudflare/cloudflared/releases/latest/download/",
            "cloudflared-linux-arm64"
        )),
        ("macos", _) => Err(
            "cloudflared isn't auto-installed on macOS (Cloudflare ships it as a tarball). \
             Install it with `brew install cloudflared`, then start remote access again."
                .to_string(),
        ),
        (os, arch) => Err(format!(
            "no cloudflared download available for {os}/{arch}; install it manually and \
             ensure it's on your PATH."
        )),
    }
}

/// Download the official cloudflared into app-data. Integrity is gated by a size
/// floor, the platform executable magic, and a functional `--version` run.
async fn install(app: &AppHandle) -> Result<PathBuf, String> {
    let url = download_url()?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app-data dir: {e}"))?;
    std::fs::create_dir_all(&dir).ok();
    let dest = dir.join(bin_name());

    let _ = app.emit("remote:cloudflared-progress", "Downloading cloudflared…");
    let resp = reqwest::get(url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download failed: {e}"))?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("download failed: {e}"))?;

    if bytes.len() < MIN_BINARY_BYTES || !has_executable_magic(&bytes) {
        return Err("downloaded cloudflared failed the integrity check".to_string());
    }

    let tmp = dest.with_extension("download");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write cloudflared: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&tmp)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&tmp, perms).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &dest).map_err(|e| format!("install cloudflared: {e}"))?;

    verify_runs(&dest).await?;
    Ok(dest)
}

/// True if `bytes` starts with a Windows PE (`MZ`) or ELF magic — a cheap guard
/// against an HTML error page masquerading as the binary.
fn has_executable_magic(bytes: &[u8]) -> bool {
    bytes.starts_with(b"MZ") || bytes.starts_with(&[0x7f, b'E', b'L', b'F'])
}

/// Functional verification: the freshly-downloaded binary must run `--version`.
async fn verify_runs(bin: &PathBuf) -> Result<(), String> {
    let status = tokio::time::timeout(
        Duration::from_secs(15),
        Command::new(bin)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status(),
    )
    .await
    .map_err(|_| "cloudflared did not respond to --version".to_string())?
    .map_err(|e| format!("cloudflared failed to run: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("downloaded cloudflared did not run successfully".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_url_from_boxed_log_line() {
        let line = "2024-01-01T00:00:00Z INF |  https://calm-forest-1234.trycloudflare.com   |";
        assert_eq!(
            parse_trycloudflare_url(line).as_deref(),
            Some("https://calm-forest-1234.trycloudflare.com")
        );
    }

    #[test]
    fn parses_bare_url_line() {
        let line = "https://calm-forest-1234.trycloudflare.com";
        assert_eq!(
            parse_trycloudflare_url(line).as_deref(),
            Some("https://calm-forest-1234.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_unrelated_https_urls() {
        let line = "INF Connecting to https://api.trycloudflare.example.com/register";
        assert_eq!(parse_trycloudflare_url(line), None);
        assert_eq!(
            parse_trycloudflare_url("INF see https://developers.cloudflare.com/docs"),
            None
        );
    }

    #[test]
    fn trims_trailing_slash() {
        let line = "|  https://calm-forest-1234.trycloudflare.com/  |";
        assert_eq!(
            parse_trycloudflare_url(line).as_deref(),
            Some("https://calm-forest-1234.trycloudflare.com")
        );
    }

    #[test]
    fn magic_bytes_gate() {
        assert!(has_executable_magic(b"MZ\x90\x00"));
        assert!(has_executable_magic(&[0x7f, b'E', b'L', b'F', 1, 1]));
        assert!(!has_executable_magic(b"<!DOCTYPE html>"));
    }
}
