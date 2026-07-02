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
