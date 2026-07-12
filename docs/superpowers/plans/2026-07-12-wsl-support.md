# WSL Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let terminals run inside WSL distros (Phase 1), make the Claude Code integration (sessions, hooks, CLI detection) work when Claude runs inside WSL (Phase 2), and support projects that live on the WSL filesystem (Phase 3).

**Architecture:** A new cross-platform `wsl` Rust module owns distro discovery (UTF-16LE-aware parsing of `wsl.exe` output), the `wsl:<distro>` shell-token convention, Windows↔WSL path translation, and `WSLENV` composition. The PTY layer expands `wsl:<distro>` tokens into `wsl.exe --distribution <d> --cd <cwd>` spawns. The frontend gains a default-shell setting, per-distro "new terminal" menu items, and passes `shell` through the already-existing (but unused) IPC plumbing. Phase 2 reads/writes Claude state in distro homes via `\\wsl$\<distro>` UNC paths. Phase 3 infers the WSL shell for `\\wsl$`-rooted projects.

**Tech Stack:** Rust (Tauri 2, portable_pty, parking_lot), TypeScript/React (zustand, vitest). No new dependencies.

**Conventions:**
- Commits go directly to `master`, conventional-commit style (`feat(wsl): …`), **no Co-Authored-By trailer**.
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml` (run from repo root). Scope with a filter, e.g. `cargo test --manifest-path src-tauri/Cargo.toml wsl::`.
- Frontend: `npm run test` (vitest), `npm run typecheck` (tsc).
- Do not add code comments that merely narrate the change; match existing comment style (short "why" doc comments).

**Ground truth about this machine (for manual verification):** WSL2 installed; distros `Ubuntu` (default), `docker-desktop`, `docker-desktop-data`. `wsl.exe` output is UTF-16LE. Windows 10 build 19045 — use `\\wsl$\` UNC prefix (works everywhere; `\\wsl.localhost` is Win11-era, but parsers must accept both).

---

## Key design decisions (read before any task)

1. **Shell token:** `TerminalRecord.shell` / `CreateOpts.shell` is a single string everywhere, so WSL shells are encoded as `wsl:<distro>` (`wsl:` alone = default distro). `crate::wsl::parse_shell_token` is the single decoder.
2. **Env forwarding:** WSL does not inherit Windows env vars unless named in `WSLENV`. When spawning a `wsl:` shell, the PTY layer composes `WSLENV` from the injected var names (API keys, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`), preserving any inherited `WSLENV` entries.
3. **Shell integration guard:** `shell::prepare()` must return an empty `Prepared` for `wsl:` tokens *before* keyword detection — a distro named e.g. `fishtank` would otherwise match `fish` and append bogus args to `wsl.exe`.
4. **Locale-safe distro parsing:** distro *names* and the `*` default marker are locale-independent; the STATE column ("Running") is localized. So: `wsl -l -v` → names + default; `wsl -l --running -q` → running set. Never parse the STATE column.
5. **Only running distros are touched in Phase 2** (sessions, hooks, binary checks with explicit distro are the exception since the user asked for that distro). Never boot a distro as a side effect of listing sessions.
6. **`\\wsl$` for UNC**, accept both `\\wsl$` and `\\wsl.localhost` when parsing.

---

## Wave 1 — Rust core (Phase 1 backend)

### Task 1: `wsl` module — parsing, tokens, paths, WSLENV

**Files:**
- Create: `src-tauri/src/wsl/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod wsl;` after `mod state;` — keep module list alphabetical: insert `mod wsl;` after `mod settings;`/`mod state;`)
- Test: unit tests inside `src-tauri/src/wsl/mod.rs`

- [ ] **Step 1: Write the module with failing tests first.** Create `src-tauri/src/wsl/mod.rs` containing ONLY the test module below plus empty stubs that `todo!()` (so tests compile and fail), or write tests + implementation in one file but run tests before implementing to see them fail. Given Rust's compile model, acceptable TDD here is: write the full test module + `todo!()` stubs, run (fail), then fill implementations.

```rust
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

/// True for tokens safe to interpolate into a `sh -lc` line (CLI/module names).
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

/// `command -v <name>` inside a distro (login shell so ~/.profile PATH counts).
#[cfg(windows)]
pub fn binary_in_distro(distro: &str, name: &str) -> bool {
    if !safe_token(name) {
        return false;
    }
    let probe = format!("command -v {name}");
    let mut args: Vec<&str> = Vec::new();
    if !distro.is_empty() {
        args.extend(["--distribution", distro]);
    }
    args.extend(["--", "/bin/sh", "-lc", &probe]);
    run_wsl(&args).is_some_and(|t| !t.trim().is_empty())
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
```

Test module (same file):

```rust
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
    fn safe_token_rejects_shell_metacharacters() {
        assert!(safe_token("claude"));
        assert!(safe_token("python3.11"));
        assert!(!safe_token("a b"));
        assert!(!safe_token("x;rm"));
        assert!(!safe_token(""));
    }
}
```

- [ ] **Step 2: Add `mod wsl;` to `src-tauri/src/lib.rs`** (in the module list near `mod state;`):

```rust
mod state;
mod wsl;
```

- [ ] **Step 3: Run the tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml wsl::`
Expected: all tests above PASS (if written stub-first, first run FAILs, then passes after filling in).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/wsl/mod.rs src-tauri/src/lib.rs
git commit -m "feat(wsl): distro discovery, shell tokens, path translation, WSLENV"
```

### Task 2: PTY spawn integration for `wsl:` shells

**Files:**
- Modify: `src-tauri/src/pty/shell.rs` (guard in `prepare`, ~line 110)
- Modify: `src-tauri/src/pty/mod.rs` (command build in `create`, ~lines 230–247)
- Test: unit tests in `src-tauri/src/pty/shell.rs`

- [ ] **Step 1: Write the failing test** in `shell.rs`'s existing `tests` module:

```rust
#[test]
fn wsl_tokens_get_no_integration_even_when_distro_name_matches_a_shell() {
    // "wsl:fishtank" contains "fish" — without the guard, prepare() would
    // append fish --init-command args to wsl.exe.
    let p = prepare("wsl:fishtank");
    assert!(p.args.is_empty());
    assert!(p.env.is_empty());
    let p = prepare("wsl:Ubuntu");
    assert!(p.args.is_empty());
    assert!(p.env.is_empty());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pty::shell`
Expected: FAIL (`wsl:fishtank` detects as Fish and returns `--init-command` args).

- [ ] **Step 3: Implement the guard** at the top of `prepare` in `shell.rs`:

```rust
pub fn prepare(shell: &str) -> Prepared {
    // WSL shells get no host-side rc injection; the distro's own shell owns
    // its rc files. (Also prevents a distro name like "fishtank" matching.)
    if crate::wsl::parse_shell_token(shell).is_some() {
        return Prepared {
            args: Vec::new(),
            env: Vec::new(),
        };
    }
    match detect(shell) {
        // ... existing body unchanged
```

- [ ] **Step 4: Update `pty/mod.rs::create`.** Replace the command construction (currently `let mut cmd = CommandBuilder::new(&shell); cmd.cwd(&opts.cwd);`) with:

```rust
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
```

Then, AFTER the existing env loops (`TERM*`, `opts.env`, `prepared.env`) and BEFORE `for a in &prepared.args`, add the WSLENV forwarding:

```rust
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
```

- [ ] **Step 5: Run the full Rust test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (all existing + new).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pty/shell.rs src-tauri/src/pty/mod.rs
git commit -m "feat(wsl): spawn wsl.exe for wsl:<distro> shell tokens with WSLENV forwarding"
```

### Task 3: `wsl_list_distros` IPC command

**Files:**
- Modify: `src-tauri/src/commands.rs` (add near the `binary_exists` section, ~line 998)
- Modify: `src-tauri/src/lib.rs` (register in `generate_handler!`)

- [ ] **Step 1: Add the command** in `commands.rs`:

```rust
// ---------- wsl ----------

/// Installed WSL distros (utility distros like docker-desktop filtered out).
/// Empty on non-Windows or when WSL isn't installed. Async: spawns wsl.exe.
#[tauri::command]
pub async fn wsl_list_distros() -> Vec<crate::wsl::Distro> {
    tauri::async_runtime::spawn_blocking(crate::wsl::list_distros)
        .await
        .unwrap_or_default()
}
```

- [ ] **Step 2: Register it** in `lib.rs` `generate_handler!` after `commands::python_module_exists,`:

```rust
commands::python_module_exists,
commands::wsl_list_distros,
```

- [ ] **Step 3: Verify it compiles and existing tests pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 4: Manual smoke (this machine has WSL):** run `cargo test --manifest-path src-tauri/Cargo.toml wsl:: -- --nocapture` — then optionally verify the real listing with a tiny ad-hoc test if desired. The definitive end-to-end check happens in the final verification wave.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(wsl): wsl_list_distros IPC command"
```

---

## Wave 2 — Frontend (Phase 1 UI)

### Task 4: settings model, IPC types, wsl store, shell pass-through

**Files:**
- Modify: `src/lib/ipc.ts` (add `WslDistro` type + `wsl` namespace)
- Modify: `src/state/settings.ts` (`TerminalSettings.defaultShell`)
- Create: `src/state/wsl.ts`
- Modify: `src/state/store.ts` (`createProjectTerminal` passes `shell`)
- Modify: `src/app.tsx` (load distros at startup)

- [ ] **Step 1: `ipc.ts`** — add the type near the other interfaces and the namespace inside `export const ipc = {` (after the `apikeys` block):

```ts
export interface WslDistro {
  name: string
  isDefault: boolean
  running: boolean
}
```

```ts
  wsl: {
    listDistros: () => invoke<WslDistro[]>('wsl_list_distros'),
  },
```

- [ ] **Step 2: `settings.ts`** — extend `TerminalSettings` and defaults:

```ts
export interface TerminalSettings {
  /** Command run automatically in every new terminal tab. Empty = nothing. */
  startupCommand: string
  /**
   * Shell for new terminals. '' = platform default (PowerShell on Windows).
   * Windows extras: 'cmd.exe', or 'wsl:<distro>' ('wsl:' = default distro).
   */
  defaultShell: string
  claudeSkipPermissions: boolean   // keep existing doc comment
}
```

```ts
export const TERMINAL_DEFAULTS: TerminalSettings = {
  startupCommand: '',
  defaultShell: '',
  claudeSkipPermissions: false,
}
```

(`readStoredSettings` already spreads `{ ...TERMINAL_DEFAULTS, ...parsed.terminal }`, so old stored settings upgrade automatically.)

- [ ] **Step 3: Create `src/state/wsl.ts`:**

```ts
import { create } from 'zustand'
import { ipc, isTauri, type WslDistro } from '../lib/ipc'
import { isWindows } from '../lib/platform'

interface WslState {
  distros: WslDistro[]
  loaded: boolean
  /** Fetch once per app run; no-op off-Windows or outside Tauri. */
  load: () => Promise<void>
}

export const useWsl = create<WslState>((set, get) => ({
  distros: [],
  loaded: false,
  load: async () => {
    if (get().loaded) return
    if (!isTauri || !isWindows) {
      set({ loaded: true })
      return
    }
    try {
      const distros = await ipc.wsl.listDistros()
      set({ distros, loaded: true })
    } catch {
      set({ distros: [], loaded: true })
    }
  },
}))
```

- [ ] **Step 4: `store.ts`** — `createProjectTerminal`: add `shell?: string` to the `opts` type and resolve it:

```ts
export async function createProjectTerminal(
  projectId: string,
  opts?: {
    cwd?: string
    name?: string
    shell?: string
    startupCommand?: string
    claudeSessionId?: string
    apikeyEntryId?: string
  }
): Promise<TerminalRecord | null> {
```

and where `ipc.terminals.create` is called:

```ts
  const shell = opts?.shell ?? (useSettings.getState().terminal.defaultShell || undefined)
  const record = await ipc.terminals.create({
    projectId,
    startupCommand,
    cwd: opts?.cwd,
    name: opts?.name,
    shell,
    apikeyEntryId: opts?.apikeyEntryId,
  })
```

- [ ] **Step 5: `app.tsx`** — in the top-level `App` component's startup effect (or a new `useEffect(() => { ... }, [])`), add:

```ts
import { useWsl } from './state/wsl'
// inside a mount effect:
void useWsl.getState().load()
```

- [ ] **Step 6: Typecheck + tests**

Run: `npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ipc.ts src/state/settings.ts src/state/wsl.ts src/state/store.ts src/app.tsx
git commit -m "feat(wsl): default-shell setting, distro store, shell pass-through"
```

### Task 5: Default-shell dropdown in Settings → Terminal

**Files:**
- Modify: `src/components/settings-modal.tsx` (Terminal `<Section>`, ~line 294)

- [ ] **Step 1: Implement.** Import `useWsl` and `isWindows`, load distros on mount, and add a "Default shell" row above the startup-command textarea. The file already defines `Row`/`Section` helpers — reuse them. Use the existing field styling for the `<select>`:

```tsx
import { useWsl } from '../state/wsl'
import { isMac, isWindows } from '../lib/platform'  // isMac may already be imported; merge
```

Inside the settings component (near other hooks):

```tsx
const wslDistros = useWsl((s) => s.distros)
useEffect(() => {
  void useWsl.getState().load()
}, [])
```

Inside `<Section title="Terminal">`, before the startup-command block:

```tsx
{isWindows && (
  <Row label="Default shell">
    <select
      value={terminal.defaultShell}
      onChange={(e) => updateTerminal({ defaultShell: e.target.value })}
      className="rounded-md border border-border bg-field-background px-2 py-1 text-foreground outline-none focus:border-accent"
    >
      <option value="">PowerShell (default)</option>
      <option value="cmd.exe">Command Prompt</option>
      {wslDistros.map((d) => (
        <option key={d.name} value={`wsl:${d.name}`}>
          {`WSL — ${d.name}${d.isDefault ? ' (default distro)' : ''}`}
        </option>
      ))}
    </select>
  </Row>
)}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/settings-modal.tsx
git commit -m "feat(wsl): default-shell picker in terminal settings"
```

### Task 6: Per-distro "New terminal" context-menu items

**Files:**
- Modify: `src/components/sidebar/project-list.tsx` (`menuItems`, ~line 101)

- [ ] **Step 1: Implement.** In `ProjectRow`, read distros and splice items after the 'New terminal' entry (the `ContextMenu` is flat — one item per distro; the hidden-distro filter keeps this short):

```tsx
import { useWsl } from '../../state/wsl'
// inside ProjectRow:
const wslDistros = useWsl((s) => s.distros)
```

```tsx
const menuItems: MenuItem[] = [
  {
    label: 'New terminal',
    trailing: <Hint>{kbd('T')}</Hint>,
    onClick: () => expandAnd(() => void createProjectTerminal(project.id)),
  },
  ...wslDistros.map((d) => ({
    label: `New terminal — WSL ${d.name}`,
    onClick: () =>
      expandAnd(
        () =>
          void createProjectTerminal(project.id, {
            shell: `wsl:${d.name}`,
            name: d.name,
          })
      ),
  })),
  { label: 'Claude Code', trailing: <Hint>{kbd('⇧T')}</Hint>, onClick: () => newClaude() },
  // ... rest unchanged
]
```

- [ ] **Step 2: Typecheck + tests**

Run: `npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/project-list.tsx
git commit -m "feat(wsl): per-distro new-terminal menu items"
```

---

## Wave 3 — Phase 2: Claude Code inside WSL

### Task 7: WSL session listing (backend)

**Files:**
- Modify: `src-tauri/src/claude/mod.rs` (`SessionSummary.distro`, `list_sessions_wsl`)
- Modify: `src-tauri/src/commands.rs` (`claude_sessions_list` merge, `claude_session_delete` distro param)
- Test: existing tests in `claude/mod.rs` updated for the new field

- [ ] **Step 1: Add the field.** In `SessionSummary`:

```rust
pub struct SessionSummary {
    pub session_id: String,
    pub title: String,
    pub message_count: u32,
    /// File mtime, epoch millis. Newest sessions sort first.
    pub last_active: i64,
    pub git_branch: Option<String>,
    /// WSL distro whose home holds this transcript; None = the Windows home.
    pub distro: Option<String>,
}
```

In `parse_session`, construct with `distro: None`.

- [ ] **Step 2: Add the WSL lister** in `claude/mod.rs`:

```rust
/// Sessions written by a `claude` running inside a WSL distro. Its home (and
/// therefore ~/.claude) is the distro's, and the encoded cwd is the Linux view
/// of the project root (/mnt/c/… for drive paths). Only running distros are
/// consulted — listing sessions must never boot a distro.
#[cfg(windows)]
pub fn list_sessions_wsl(project_root: &str) -> Vec<SessionSummary> {
    let mut out = Vec::new();
    for d in crate::wsl::list_distros().into_iter().filter(|d| d.running) {
        let Some(home) = crate::wsl::distro_home(&d.name) else {
            continue;
        };
        let Some(linux_root) = crate::wsl::project_root_in_distro(project_root, &d.name) else {
            continue;
        };
        let home_unc = crate::wsl::unc_path(&d.name, &home);
        let mut sessions = list_sessions(&home_unc, &linux_root);
        for s in &mut sessions {
            s.distro = Some(d.name.clone());
        }
        out.extend(sessions);
    }
    out
}
```

- [ ] **Step 3: Merge in the command.** In `commands.rs::claude_sessions_list`, replace the spawn_blocking closure body:

```rust
tauri::async_runtime::spawn_blocking(move || {
    let mut out = crate::claude::list_sessions(&home, &root);
    #[cfg(windows)]
    out.extend(crate::claude::list_sessions_wsl(&root));
    out.sort_by(|a, b| b.last_active.cmp(&a.last_active));
    out
})
.await
.map_err(|e| AppError::Msg(e.to_string()))
```

- [ ] **Step 4: Distro-aware delete.** Replace `claude_session_delete` with an async version taking `distro: Option<String>`:

```rust
#[tauri::command]
pub async fn claude_session_delete(
    app: AppHandle,
    store: State<'_, StateStore>,
    project_id: String,
    session_id: String,
    distro: Option<String>,
) -> AppResult<()> {
    let root = project_root(&store, &project_id)?;
    let home = home_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || match distro.as_deref() {
        #[cfg(windows)]
        Some(d) => {
            let dh = crate::wsl::distro_home(d)
                .ok_or_else(|| AppError::Msg("cannot resolve distro home".to_string()))?;
            let linux_root = crate::wsl::project_root_in_distro(&root, d)
                .ok_or_else(|| AppError::Msg("project not visible in distro".to_string()))?;
            crate::claude::delete_session(&crate::wsl::unc_path(d, &dh), &linux_root, &session_id)
        }
        _ => crate::claude::delete_session(&home, &root, &session_id),
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))?
}
```

(Note: with `#[cfg(windows)]` on the `Some` arm, non-Windows builds fall to `_` — this is intentional; keep the `_` arm last.)

- [ ] **Step 5: Fix compile fallout** — the `Row`/tests in `claude/mod.rs` don't construct `SessionSummary` directly except via `parse_session`, so only `parse_session` needs the `distro: None` addition. Run:

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/claude/mod.rs src-tauri/src/commands.rs
git commit -m "feat(wsl): list and delete Claude sessions from running WSL distros"
```

### Task 8: Sessions panel — resume into the right distro (frontend)

**Files:**
- Modify: `src/lib/ipc.ts` (`ClaudeSession.distro`, `deleteSession` param)
- Modify: `src/components/right-sidebar/sessions-panel.tsx`

- [ ] **Step 1: `ipc.ts`:**

```ts
export interface ClaudeSession {
  sessionId: string
  title: string
  messageCount: number
  /** epoch millis (file mtime) */
  lastActive: number
  gitBranch: string | null
  /** WSL distro the session lives in; null = Windows */
  distro: string | null
}
```

```ts
    deleteSession: (projectId: string, sessionId: string, distro?: string | null) =>
      invoke<void>('claude_session_delete', { projectId, sessionId, distro }),
```

- [ ] **Step 2: `sessions-panel.tsx`** — resume in the session's distro, delete with distro, and show a WSL tag:

In `onOpen`:

```ts
    void createProjectTerminal(projectId, {
      name: s.title.slice(0, 40) || 'Claude',
      startupCommand: `claude --resume ${s.sessionId}`,
      claudeSessionId: s.sessionId,
      shell: s.distro ? `wsl:${s.distro}` : undefined,
    })
```

In `onDelete`:

```ts
      await ipc.claude.deleteSession(projectId, s.sessionId, s.distro)
```

In the meta line (`{timeAgo(...)} · {s.messageCount} msg…`), append:

```tsx
                {s.distro ? ` · WSL ${s.distro}` : ''}
```

(insert after the `gitBranch` segment, before the `open` segment).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ipc.ts src/components/right-sidebar/sessions-panel.tsx
git commit -m "feat(wsl): resume/delete WSL Claude sessions from the sessions panel"
```

### Task 9: Install attention hooks inside running distros

**Files:**
- Modify: `src-tauri/src/claude/hooks.rs` (`install` takes a command string; add `wsl_hook_command`)
- Modify: `src-tauri/src/commands.rs` (`claude_hooks_enable`/`disable` become async and fan out to running distros)
- Modify: `src/components/settings-modal.tsx` (hooks help text)
- Test: hooks.rs unit tests (the file has existing tests around install/uninstall — extend them)

- [ ] **Step 1: Refactor `hooks.rs`.** Change `install(path: &Path, spool: &Path)` to `install(path: &Path, command: &str)`; rename the private `hook_command` to a public `native_hook_command(spool: &Path) -> Option<String>` (same body), and add:

```rust
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
```

Update `install`'s body to use the passed `command` instead of computing it, and update any existing hooks.rs tests that call `install(path, spool)` to pass a literal command string containing `--hook-sink` (the MARKER), e.g. `install(&path, "\"C:\\app.exe\" --hook-sink \"C:\\spool\"")`. Add a test:

```rust
#[cfg(windows)]
#[test]
fn wsl_hook_command_translates_exe_path_and_keeps_windows_spool() {
    // Can't control current_exe in a test; instead verify the format helper
    // pieces: translation + quoting via a direct format check.
    let exe_wsl = crate::wsl::win_to_wsl_path(r"C:\Apps\tw\tw.exe").unwrap();
    assert_eq!(exe_wsl, "/mnt/c/Apps/tw/tw.exe");
}
```

- [ ] **Step 2: Update `commands.rs`:**

```rust
#[tauri::command]
pub async fn claude_hooks_enable(app: AppHandle) -> AppResult<()> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Msg(e.to_string()))?;
    let settings = claude_settings_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let spool = crate::claude::hooks::spool_dir(&data_dir);
        let cmd = crate::claude::hooks::native_hook_command(&spool)
            .ok_or_else(|| AppError::Msg("cannot resolve app path".to_string()))?;
        crate::claude::hooks::install(&settings, &cmd).map_err(AppError::Msg)?;
        // Best-effort: running distros get the interop command so an in-WSL
        // Claude reports through the same spool.
        #[cfg(windows)]
        if let Some(wsl_cmd) = crate::claude::hooks::wsl_hook_command(&spool) {
            for d in crate::wsl::list_distros().into_iter().filter(|d| d.running) {
                if let Some(home) = crate::wsl::distro_home(&d.name) {
                    let p = crate::wsl::unc_path(&d.name, &home)
                        .join(".claude")
                        .join("settings.json");
                    let _ = crate::claude::hooks::install(&p, &wsl_cmd);
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))?
}

#[tauri::command]
pub async fn claude_hooks_disable(app: AppHandle) -> AppResult<()> {
    let settings = claude_settings_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::claude::hooks::uninstall(&settings).map_err(AppError::Msg)?;
        #[cfg(windows)]
        for d in crate::wsl::list_distros().into_iter().filter(|d| d.running) {
            if let Some(home) = crate::wsl::distro_home(&d.name) {
                let p = crate::wsl::unc_path(&d.name, &home)
                    .join(".claude")
                    .join("settings.json");
                let _ = crate::claude::hooks::uninstall(&p);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Msg(e.to_string()))?
}
```

(`claude_hooks_status` stays sync and Windows-home-only — it's the source of truth for the toggle.)

- [ ] **Step 3: Settings help text.** In `settings-modal.tsx`, extend the `ClaudeHooksToggle` description paragraph's text with one sentence:

```
 Hooks are also installed into any running WSL distro so Claude Code inside WSL reports too.
```

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/claude/hooks.rs src-tauri/src/commands.rs src/components/settings-modal.tsx
git commit -m "feat(wsl): install Claude attention hooks into running distros"
```

### Task 10: Distro-aware CLI/module presence checks

**Files:**
- Modify: `src-tauri/src/commands.rs` (`binary_exists`, `python_module_exists` gain `distro`)
- Modify: `src/lib/ipc.ts` (pass-through params)
- Modify: `src/state/apikeys.ts` (`cliPresent` targets the effective launch shell)

- [ ] **Step 1: Rust:**

```rust
/// PATH lookup for a CLI binary, used by the prompt-then-install launch flow.
/// `distro: Some(..)` checks inside that WSL distro ("" = default distro).
#[tauri::command]
pub async fn binary_exists(name: String, distro: Option<String>) -> bool {
    match distro {
        #[cfg(windows)]
        Some(d) => tauri::async_runtime::spawn_blocking(move || {
            crate::wsl::binary_in_distro(&d, &name)
        })
        .await
        .unwrap_or(false),
        _ => crate::apikeys::binary_on_path(&name),
    }
}

/// Import probe for a Python module. `distro` as in `binary_exists`.
#[tauri::command]
pub async fn python_module_exists(module: String, distro: Option<String>) -> bool {
    match distro {
        #[cfg(windows)]
        Some(d) => tauri::async_runtime::spawn_blocking(move || {
            crate::wsl::python_module_in_distro(&d, &module)
        })
        .await
        .unwrap_or(false),
        _ => crate::apikeys::python_module_importable(&module),
    }
}
```

- [ ] **Step 2: `ipc.ts`:**

```ts
    /** PATH lookup for a CLI binary (prompt-then-install launch flow). */
    binaryExists: (name: string, distro?: string) =>
      invoke<boolean>('binary_exists', { name, distro }),
    /** Import probe for a Python module (prompt-then-install launch flow). */
    pythonModuleExists: (module: string, distro?: string) =>
      invoke<boolean>('python_module_exists', { module, distro }),
```

- [ ] **Step 3: `apikeys.ts`** — check presence where the terminal will actually run (the launcher uses the default shell):

```ts
import { useSettings } from './settings'  // already imported

/** Distro the default shell runs in, if it's a WSL shell ('' = default distro). */
function defaultShellDistro(): string | undefined {
  const shell = useSettings.getState().terminal.defaultShell
  return shell.startsWith('wsl:') ? shell.slice('wsl:'.length) : undefined
}

function cliPresent(check: PresenceCheck): Promise<boolean> {
  const distro = defaultShellDistro()
  return check.kind === 'binary'
    ? ipc.apikeys.binaryExists(check.name, distro)
    : ipc.apikeys.pythonModuleExists(check.module, distro)
}
```

(No call-site changes: `cliPresent(check)` signature is unchanged.)

- [ ] **Step 4: Run tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src/lib/ipc.ts src/state/apikeys.ts
git commit -m "feat(wsl): distro-aware CLI and python-module presence checks"
```

---

## Wave 4 — Phase 3: projects on the WSL filesystem + docs

### Task 11: WSL-rooted projects default to their distro's shell

**Files:**
- Create: `src/lib/wsl-paths.ts`
- Create: `src/lib/wsl-paths.test.ts`
- Modify: `src/state/store.ts` (shell resolution in `createProjectTerminal`)

- [ ] **Step 1: Write the failing test** `src/lib/wsl-paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { distroOfUncPath } from './wsl-paths'

describe('distroOfUncPath', () => {
  it('extracts the distro from wsl$ and wsl.localhost paths', () => {
    expect(distroOfUncPath('\\\\wsl$\\Ubuntu\\home\\u\\proj')).toBe('Ubuntu')
    expect(distroOfUncPath('\\\\wsl.localhost\\Debian\\srv')).toBe('Debian')
  })
  it('returns null for non-WSL paths', () => {
    expect(distroOfUncPath('C:\\Users\\u\\proj')).toBeNull()
    expect(distroOfUncPath('\\\\server\\share')).toBeNull()
    expect(distroOfUncPath('/home/u/proj')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test`
Expected: FAIL (module doesn't exist).

- [ ] **Step 3: Implement** `src/lib/wsl-paths.ts`:

```ts
/** Distro named in a \\wsl$\<distro>\… or \\wsl.localhost\<distro>\… path. */
export function distroOfUncPath(path: string): string | null {
  const m = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\/]+)/i.exec(path)
  return m ? m[1] : null
}
```

- [ ] **Step 4: Wire into `store.ts`.** In `createProjectTerminal`, projects rooted inside a distro get that distro's shell unless the caller was explicit (this outranks the global default — a cmd.exe default makes no sense for a `\\wsl$` project):

```ts
import { distroOfUncPath } from '../lib/wsl-paths'
```

```ts
  const project = useWorkspace.getState().projects.find((p) => p.id === projectId)
  const projectDistro = project ? distroOfUncPath(project.path) : null
  const shell =
    opts?.shell ??
    (projectDistro ? `wsl:${projectDistro}` : undefined) ??
    (useSettings.getState().terminal.defaultShell || undefined)
```

- [ ] **Step 5: Run tests**

Run: `npm run test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/wsl-paths.ts src/lib/wsl-paths.test.ts src/state/store.ts
git commit -m "feat(wsl): projects on the WSL filesystem default to their distro's shell"
```

### Task 12: README documentation + known limitations

**Files:**
- Modify: `README.md` (add a "WSL support" section; match the README's existing tone/format — read it first)

- [ ] **Step 1: Add a section** covering:
  - Choosing a WSL distro as the default shell (Settings → Terminal) or per-terminal (project context menu).
  - Env/API-key forwarding via WSLENV happens automatically.
  - Claude Code inside WSL: sessions from *running* distros appear in the Sessions panel (tagged `WSL <distro>`), resume opens a WSL terminal, attention hooks install into running distros when enabled.
  - Projects on `\\wsl$\<distro>\…` are supported; new terminals default to that distro.
  - Known limitations: file watching over `\\wsl$` is unreliable (search index may go stale — use Rebuild); `git push`/identity operations on `\\wsl$` projects may hit git's `safe.directory` ownership check; Claude account switching applies to Windows-side Claude only (in-WSL Claude uses the distro's own `~/.claude/.credentials.json`); WSL terminals get no OSC 133 shell integration yet (busy detection still works via window titles, e.g. Claude Code).

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(wsl): document WSL support and known limitations"
```

---

## Final verification (orchestrator, not a subagent)

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] `npm run typecheck && npm run test` — all green.
- [ ] `npm run build` — frontend builds.
- [ ] Manual end-to-end (use the `verify` skill): launch the app (`npm run tauri dev` or a debug build with `TW_DATA_DIR` set to an isolated dir), create a WSL Ubuntu terminal from the project context menu, confirm: prompt appears in `/mnt/c/...` project dir, `echo $ANTHROPIC_API_KEY`-style env forwarding works when a global provider key is enabled, resize/kill behave, and Settings → Terminal shows the distro dropdown.

## Explicitly out of scope (documented, not built)

- OSC 133 shell-integration injection into WSL shells (`--rcfile` translation) — follow-up.
- Syncing Claude account credentials into distros on account switch.
- Running git/fs/search *inside* the distro for `\\wsl$` projects (9P perf) — current UNC-based behavior is functional but slower.
