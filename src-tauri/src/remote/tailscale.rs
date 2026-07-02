//! Tailscale connectivity mode (milestone 3f).
//!
//! Unlike Cloudflare mode there is no tunnel process: the server simply binds the
//! machine's tailnet interface so any device on the same tailnet can reach it at
//! a stable address, with nothing exposed to the public internet. We detect the
//! tailnet address (and MagicDNS name) by shelling out to the `tailscale` CLI.

use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::process::Command;

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

/// Detect this machine's tailnet address. Returns `None` if Tailscale isn't
/// installed or the node isn't up (so the UI can show setup instructions rather
/// than failing silently — AC-3.8).
pub fn detect() -> Option<TailscaleInfo> {
    let bin = locate()?;
    let out = Command::new(&bin).arg("ip").arg("-4").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let ip = String::from_utf8_lossy(&out.stdout)
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
fn magic_dns(bin: &PathBuf) -> Option<String> {
    let out = Command::new(bin).arg("status").arg("--json").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
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

/// Configure `tailscale serve` to front the local server with HTTPS at the
/// node's MagicDNS name (needs "HTTPS Certificates" enabled on the tailnet).
/// Returns the public https URL on success. A secure origin is what unlocks the
/// full PWA on phones: service worker, background notifications, install.
pub fn serve_start(port: u16) -> Result<String, String> {
    let bin = locate().ok_or_else(|| "tailscale CLI not found".to_string())?;
    let info = detect().ok_or_else(|| "tailscale is not running".to_string())?;
    let Some(dns_name) = info.dns_name.clone() else {
        return Err("MagicDNS is disabled; HTTPS needs the tailnet DNS name".to_string());
    };
    let out = Command::new(&bin)
        .args(["serve", "--bg", "--https=443", &format!("http://127.0.0.1:{port}")])
        .output()
        .map_err(|e| format!("tailscale serve failed to run: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("does not support getting TLS certs") || err.contains("HTTPS") {
            return Err(
                "Tailnet HTTPS certificates aren't enabled. Turn on \"HTTPS Certificates\" at \
                 https://login.tailscale.com/admin/dns, then start remote access again."
                    .to_string(),
            );
        }
        return Err(format!("tailscale serve failed: {}", err.trim()));
    }
    Ok(format!("https://{dns_name}"))
}

/// Remove the serve config installed by [`serve_start`]. Best-effort.
pub fn serve_stop() {
    if let Some(bin) = locate() {
        let _ = Command::new(&bin)
            .args(["serve", "--https=443", "off"])
            .output();
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
}
