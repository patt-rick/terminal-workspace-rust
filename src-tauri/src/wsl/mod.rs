//! WSL integration: distro discovery, the `wsl:<distro>` shell-token
//! convention, Windows↔WSL path translation, and WSLENV composition.
//!
//! wsl.exe prints its own output as UTF-16LE on a pipe; output of Linux
//! commands run through it is UTF-8. `decode_wsl_output` handles both.
//! Distro STATE words are localized — never parse them. Names and the `*`
//! default marker are locale-safe.

use serde::Serialize;

pub const SHELL_PREFIX: &str = "wsl:";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Distro {
    pub name: String,
    pub is_default: bool,
    pub running: bool,
}

/// `wsl:` → Some("") (default distro), `wsl:Ubuntu` → Some("Ubuntu"),
/// anything else → None.
pub fn parse_shell_token(shell: &str) -> Option<&str> {
    shell.strip_prefix(SHELL_PREFIX).map(str::trim)
}

/// wsl.exe's own messages are UTF-16LE; Linux command output is UTF-8.
fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.contains(&0) {
        let mut units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        if units.first() == Some(&0xFEFF) {
            units.remove(0);
        }
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Utility distros that shouldn't appear in shell pickers.
fn is_hidden_distro(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with("docker-desktop")
        || n.starts_with("rancher-desktop")
        || n.starts_with("podman-machine")
}

/// Parse `wsl -l -v` text: skip the header line, `*` marks the default.
/// Distro names cannot contain spaces, so the first token is the name.
fn parse_list_verbose(text: &str) -> Vec<(String, bool)> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let (is_default, rest) = match trimmed.strip_prefix('*') {
                Some(r) => (true, r),
                None => (false, trimmed),
            };
            let name = rest.split_whitespace().next()?.to_string();
            Some((name, is_default))
        })
        .filter(|(n, _)| !is_hidden_distro(n))
        .collect()
}

/// Translate a Windows path to its in-distro view: `C:\a\b` → `/mnt/c/a/b`,
/// `\\wsl$\Ubuntu\home\u` / `\\wsl.localhost\Ubuntu\home\u` → `/home/u`.
/// Forward slashes tolerated. None for other UNC paths.
pub fn win_to_wsl_path(path: &str) -> Option<String> {
    let p = path.replace('\\', "/");
    if let Some(rest) = p
        .strip_prefix("//wsl$/")
        .or_else(|| p.strip_prefix("//wsl.localhost/"))
    {
        let mut it = rest.splitn(2, '/');
        it.next()?; // distro segment
        let tail = it.next().unwrap_or("").trim_end_matches('/');
        return Some(format!("/{tail}"));
    }
    let bytes = p.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let tail = p[2..].trim_start_matches('/').trim_end_matches('/');
        return Some(if tail.is_empty() {
            format!("/mnt/{drive}")
        } else {
            format!("/mnt/{drive}/{tail}")
        });
    }
    None
}

/// Distro named in a `\\wsl$\<distro>\…` / `\\wsl.localhost\<distro>\…` path.
pub fn distro_of_unc(path: &str) -> Option<String> {
    let p = path.replace('\\', "/");
    let rest = p
        .strip_prefix("//wsl$/")
        .or_else(|| p.strip_prefix("//wsl.localhost/"))?;
    rest.split('/').next().filter(|s| !s.is_empty()).map(str::to_string)
}

/// The path a project root has inside `distro`: drive paths map to /mnt/…
/// in any distro; a \\wsl$ path is only visible inside its own distro.
pub fn project_root_in_distro(project_root: &str, distro: &str) -> Option<String> {
    match distro_of_unc(project_root) {
        Some(d) if d.eq_ignore_ascii_case(distro) => win_to_wsl_path(project_root),
        Some(_) => None,
        None => win_to_wsl_path(project_root),
    }
}

/// UNC view of a distro-local path, e.g. (`Ubuntu`, `/home/u`) →
/// `\\wsl$\Ubuntu\home\u`.
pub fn unc_path(distro: &str, linux_path: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(format!(
        r"\\wsl$\{distro}{}",
        linux_path.replace('/', "\\")
    ))
}

/// Compose WSLENV so vars set on the Windows process are forwarded into the
/// distro. Preserves inherited entries (with their flags) and dedupes.
pub fn compose_wslenv(existing: Option<&str>, names: &[String]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut parts: Vec<String> = Vec::new();
    for part in existing.unwrap_or("").split(':').filter(|s| !s.is_empty()) {
        let base = part.split('/').next().unwrap_or(part).to_string();
        if seen.insert(base) {
            parts.push(part.to_string());
        }
    }
    for n in names {
        if seen.insert(n.clone()) {
            parts.push(n.clone());
        }
    }
    parts.join(":")
}

/// Args for spawning a WSL shell PTY: `wsl.exe [--distribution <d>] --cd <cwd>`.
pub fn spawn_args(distro: &str, cwd: &str) -> Vec<String> {
    let mut args = Vec::new();
    if !distro.is_empty() {
        args.push("--distribution".to_string());
        args.push(distro.to_string());
    }
    args.push("--cd".to_string());
    args.push(cwd.to_string());
    args
}

/// `command -v` line for a plain (non-login) shell. Login shells can abort
/// while sourcing profiles that choke on interop PATH entries with spaces
/// (`export: Files/...: bad variable name`), so the common user bin dirs —
/// where the Claude native installer lands — are added explicitly instead.
fn presence_probe(token: &str) -> String {
    format!("PATH=\"$HOME/.local/bin:$HOME/bin:$PATH\" command -v {token}")
}

/// A resolution counts only when it lands on a distro-native path. Interop
/// makes Windows installs visible under /mnt/, and those run through the old
/// in-box conhost (typing artifacts on Windows 10) — offering the native
/// install is the right call, so they don't count as present.
fn native_resolution(output: &str) -> bool {
    let line = output.lines().next().unwrap_or("").trim();
    !line.is_empty() && !line.starts_with("/mnt/")
}

/// True for tokens safe to interpolate into a `sh -c` line (CLI/module names).
fn safe_token(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(windows)]
fn run_wsl(args: &[&str]) -> Option<String> {
    let out = crate::proc::hidden_command("wsl.exe").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(decode_wsl_output(&out.stdout))
}

/// Installed distros (utility distros filtered), default + running flags.
/// Empty when WSL isn't installed. Locale-safe (see module docs).
#[cfg(windows)]
pub fn list_distros() -> Vec<Distro> {
    let all = run_wsl(&["--list", "--verbose"])
        .map(|t| parse_list_verbose(&t))
        .unwrap_or_default();
    let running: std::collections::HashSet<String> = run_wsl(&["--list", "--running", "--quiet"])
        .map(|t| {
            t.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();
    all.into_iter()
        .map(|(name, is_default)| Distro {
            running: running.contains(&name),
            name,
            is_default,
        })
        .collect()
}

#[cfg(not(windows))]
pub fn list_distros() -> Vec<Distro> {
    Vec::new()
}

/// $HOME inside a distro, cached for the app's lifetime. `""` = default distro.
#[cfg(windows)]
pub fn distro_home(distro: &str) -> Option<String> {
    use parking_lot::Mutex;
    use std::collections::HashMap;
    use std::sync::OnceLock;
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = cache.lock().get(distro) {
        return v.clone();
    }
    let mut args: Vec<&str> = Vec::new();
    if !distro.is_empty() {
        args.extend(["--distribution", distro]);
    }
    args.extend(["--", "printenv", "HOME"]);
    let home = run_wsl(&args)
        .and_then(|t| t.lines().next().map(|l| l.trim().to_string()))
        .filter(|h| h.starts_with('/'));
    cache.lock().insert(distro.to_string(), home.clone());
    home
}

/// Whether a CLI is installed *natively* inside a distro (interop /mnt/…
/// fallbacks don't count — see `native_resolution`).
#[cfg(windows)]
pub fn binary_in_distro(distro: &str, name: &str) -> bool {
    if !safe_token(name) {
        return false;
    }
    let probe = presence_probe(name);
    let mut args: Vec<&str> = Vec::new();
    if !distro.is_empty() {
        args.extend(["--distribution", distro]);
    }
    args.extend(["--", "/bin/sh", "-c", &probe]);
    run_wsl(&args).is_some_and(|t| native_resolution(&t))
}

/// `python3 -c "import <module>"` inside a distro.
#[cfg(windows)]
pub fn python_module_in_distro(distro: &str, module: &str) -> bool {
    if !safe_token(module) {
        return false;
    }
    let probe = format!("import {module}");
    let mut args: Vec<&str> = Vec::new();
    if !distro.is_empty() {
        args.extend(["--distribution", distro]);
    }
    args.extend(["--", "python3", "-c", &probe]);
    run_wsl(&args).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Encode a &str the way wsl.exe emits it: UTF-16LE with BOM.
    fn utf16le(s: &str) -> Vec<u8> {
        let mut out = vec![0xFF, 0xFE];
        for u in s.encode_utf16() {
            out.extend_from_slice(&u.to_le_bytes());
        }
        out
    }

    #[test]
    fn decodes_utf16le_and_utf8() {
        assert_eq!(decode_wsl_output(&utf16le("Ubuntu\r\n")), "Ubuntu\r\n");
        assert_eq!(decode_wsl_output(b"plain utf8"), "plain utf8");
        assert_eq!(decode_wsl_output(b""), "");
    }

    #[test]
    fn parses_list_verbose_with_default_marker_and_filters_utility_distros() {
        let text = "  NAME                   STATE           VERSION\r\n\
                    * Ubuntu                 Stopped         2\r\n\
                      docker-desktop         Stopped         2\r\n\
                      docker-desktop-data    Stopped         2\r\n\
                      Debian                 Running         2\r\n";
        let got = parse_list_verbose(text);
        assert_eq!(
            got,
            vec![("Ubuntu".to_string(), true), ("Debian".to_string(), false)]
        );
    }

    #[test]
    fn parses_shell_tokens() {
        assert_eq!(parse_shell_token("wsl:Ubuntu"), Some("Ubuntu"));
        assert_eq!(parse_shell_token("wsl:"), Some(""));
        assert_eq!(parse_shell_token("powershell.exe"), None);
        assert_eq!(parse_shell_token("/bin/zsh"), None);
    }

    #[test]
    fn translates_drive_paths() {
        assert_eq!(
            win_to_wsl_path(r"C:\Users\Pat\proj").as_deref(),
            Some("/mnt/c/Users/Pat/proj")
        );
        assert_eq!(win_to_wsl_path("D:/x/y/").as_deref(), Some("/mnt/d/x/y"));
        assert_eq!(win_to_wsl_path(r"C:\").as_deref(), Some("/mnt/c"));
        assert_eq!(win_to_wsl_path(r"\\server\share\x"), None);
    }

    #[test]
    fn translates_wsl_unc_paths() {
        assert_eq!(
            win_to_wsl_path(r"\\wsl$\Ubuntu\home\u\proj").as_deref(),
            Some("/home/u/proj")
        );
        assert_eq!(
            win_to_wsl_path(r"\\wsl.localhost\Ubuntu\home\u").as_deref(),
            Some("/home/u")
        );
    }

    #[test]
    fn extracts_distro_from_unc() {
        assert_eq!(distro_of_unc(r"\\wsl$\Ubuntu\home\u").as_deref(), Some("Ubuntu"));
        assert_eq!(
            distro_of_unc(r"\\wsl.localhost\Debian\srv").as_deref(),
            Some("Debian")
        );
        assert_eq!(distro_of_unc(r"C:\Users"), None);
    }

    #[test]
    fn project_root_visibility_per_distro() {
        assert_eq!(
            project_root_in_distro(r"C:\p", "Ubuntu").as_deref(),
            Some("/mnt/c/p")
        );
        assert_eq!(
            project_root_in_distro(r"\\wsl$\Ubuntu\home\u\p", "Ubuntu").as_deref(),
            Some("/home/u/p")
        );
        assert_eq!(project_root_in_distro(r"\\wsl$\Debian\srv", "Ubuntu"), None);
    }

    #[test]
    fn builds_unc_paths() {
        assert_eq!(
            unc_path("Ubuntu", "/home/u/.claude"),
            std::path::PathBuf::from(r"\\wsl$\Ubuntu\home\u\.claude")
        );
    }

    #[test]
    fn composes_wslenv_preserving_existing_flags_and_deduping() {
        let names = vec!["ANTHROPIC_API_KEY".to_string(), "TERM_PROGRAM".to_string()];
        assert_eq!(
            compose_wslenv(Some("USERPROFILE/p:TERM_PROGRAM"), &names),
            "USERPROFILE/p:TERM_PROGRAM:ANTHROPIC_API_KEY"
        );
        assert_eq!(compose_wslenv(None, &names), "ANTHROPIC_API_KEY:TERM_PROGRAM");
        assert_eq!(compose_wslenv(Some(""), &[]), "");
    }

    #[test]
    fn spawn_args_with_and_without_distro() {
        assert_eq!(
            spawn_args("Ubuntu", r"C:\p"),
            vec!["--distribution", "Ubuntu", "--cd", r"C:\p"]
        );
        assert_eq!(spawn_args("", r"C:\p"), vec!["--cd", r"C:\p"]);
    }

    #[test]
    fn native_resolution_rejects_interop_paths_and_empty_output() {
        // A Windows install visible through interop (/mnt/…) runs under the
        // old in-box conhost and must not count as "installed in the distro".
        assert!(native_resolution("/usr/local/bin/claude\n"));
        assert!(native_resolution("/home/u/.local/bin/claude\n"));
        assert!(!native_resolution(
            "/mnt/c/Users/u/AppData/Roaming/npm/claude\n"
        ));
        assert!(!native_resolution(""));
        assert!(!native_resolution("  \n"));
    }

    #[test]
    fn presence_probe_avoids_login_shell_pitfalls_and_covers_user_bins() {
        // Login shells (`sh -l`) can abort while sourcing profiles that choke
        // on Windows PATH entries with spaces; the probe must be a plain -c
        // command line that adds the common user bin dirs itself.
        let p = presence_probe("claude");
        assert!(p.contains("command -v claude"));
        assert!(p.contains("$HOME/.local/bin"));
        assert!(p.contains("$HOME/bin"));
    }

    #[test]
    fn safe_token_rejects_shell_metacharacters() {
        assert!(safe_token("claude"));
        assert!(safe_token("python3.11"));
        assert!(!safe_token("a b"));
        assert!(!safe_token("x;rm"));
        assert!(!safe_token(""));
    }
}
