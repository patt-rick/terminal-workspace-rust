use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The shell to launch when the caller doesn't specify one. POSIX honors $SHELL
/// (falling back to zsh); Windows has no $SHELL convention, so PowerShell — which
/// ships everywhere and is the better interactive shell than cmd.exe.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        env::var("WTERM_SHELL").unwrap_or_else(|_| "powershell.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

enum ShellKind {
    Zsh,
    Bash,
    Fish,
    Unknown,
}

fn detect(shell: &str) -> ShellKind {
    let name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if name.contains("zsh") {
        ShellKind::Zsh
    } else if name.contains("bash") {
        ShellKind::Bash
    } else if name.contains("fish") {
        ShellKind::Fish
    } else {
        ShellKind::Unknown
    }
}

/// Extra spawn args + env overrides that layer our OSC 133 prompt hooks onto the
/// user's shell without disturbing their own rc files.
pub struct Prepared {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

// FinalTerm OSC 133 markers from precmd/preexec hooks. The renderer uses the
// C..D span to drive the "terminal is working" indicator. `\e` / `\a` are
// written literally; the shell turns them into ESC / BEL at runtime.
const ZSH_INTEGRATION: &str = r#"
# wTerm shell integration (OSC 133).
__tw_preexec() { print -Pn '\e]133;C\a' }
__tw_precmd()  { print -Pn "\e]133;D;${?}\a" }
autoload -Uz add-zsh-hook 2>/dev/null
if typeset -f add-zsh-hook >/dev/null; then
  add-zsh-hook preexec __tw_preexec
  add-zsh-hook precmd  __tw_precmd
fi
"#;

const BASH_INTEGRATION: &str = r#"
# wTerm shell integration (OSC 133).
__tw_preexec() {
  [[ -n "$COMP_LINE" ]] && return
  [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return
  printf '\e]133;C\a'
}
__tw_precmd() {
  local ec=$?
  printf '\e]133;D;%s\a' "$ec"
}
trap '__tw_preexec' DEBUG
case "$PROMPT_COMMAND" in
  *__tw_precmd*) ;;
  *) PROMPT_COMMAND="__tw_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
"#;

const FISH_INTEGRATION: &str = r#"
# wTerm shell integration (OSC 133).
function __tw_preexec --on-event fish_preexec
    printf '\e]133;C\a'
end
function __tw_postexec --on-event fish_postexec
    printf '\e]133;D;%s\a' $status
end
"#;

fn cache_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = env::temp_dir().join("tw-shell-integration");
        let _ = fs::create_dir_all(&dir);
        dir
    })
}

fn write_once(name: &str, contents: &str) -> Option<PathBuf> {
    let path = cache_dir().join(name);
    if !path.exists() {
        fs::write(&path, contents).ok()?;
    }
    Some(path)
}

pub fn prepare(shell: &str) -> Prepared {
    match detect(shell) {
        ShellKind::Zsh => prepare_zsh(),
        ShellKind::Bash => prepare_bash(),
        ShellKind::Fish => prepare_fish(),
        ShellKind::Unknown => Prepared {
            args: Vec::new(),
            env: Vec::new(),
        },
    }
}

// zsh: point ZDOTDIR at a wrapper dir whose .zshenv/.zshrc source the user's
// real ones (via _TW_USER_ZDOTDIR), then layer our hooks on top.
fn prepare_zsh() -> Prepared {
    let dir = cache_dir().join("zsh");
    let _ = fs::create_dir_all(&dir);

    let zshenv = r#"# wTerm wrapper .zshenv
if [ -n "$_TW_USER_ZDOTDIR" ]; then
  __tw_our_zdotdir="$ZDOTDIR"
  ZDOTDIR="$_TW_USER_ZDOTDIR"
  [ -f "$ZDOTDIR/.zshenv" ] && . "$ZDOTDIR/.zshenv"
  ZDOTDIR="$__tw_our_zdotdir"
  unset __tw_our_zdotdir
fi
"#;
    let zshrc = format!(
        r#"# wTerm wrapper .zshrc
if [ -n "$_TW_USER_ZDOTDIR" ]; then
  ZDOTDIR="$_TW_USER_ZDOTDIR"
  [ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"
fi
{ZSH_INTEGRATION}
unset _TW_USER_ZDOTDIR
"#
    );
    let _ = fs::write(dir.join(".zshenv"), zshenv);
    let _ = fs::write(dir.join(".zshrc"), zshrc);

    let user_zdotdir = env::var("ZDOTDIR")
        .ok()
        .or_else(|| env::var("HOME").ok())
        .unwrap_or_default();

    Prepared {
        args: Vec::new(),
        env: vec![
            ("ZDOTDIR".to_string(), dir.to_string_lossy().to_string()),
            ("_TW_USER_ZDOTDIR".to_string(), user_zdotdir),
        ],
    }
}

fn prepare_bash() -> Prepared {
    let rc = format!(
        r#"# wTerm wrapper bashrc
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
{BASH_INTEGRATION}
"#
    );
    match write_once("bashrc", &rc) {
        Some(path) => Prepared {
            args: vec!["--rcfile".to_string(), path.to_string_lossy().to_string()],
            env: Vec::new(),
        },
        None => Prepared {
            args: Vec::new(),
            env: Vec::new(),
        },
    }
}

fn prepare_fish() -> Prepared {
    match write_once("integration.fish", FISH_INTEGRATION) {
        Some(path) => Prepared {
            args: vec![
                "--init-command".to_string(),
                format!("source {}", path.to_string_lossy()),
            ],
            env: Vec::new(),
        },
        None => Prepared {
            args: Vec::new(),
            env: Vec::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_shell_kinds() {
        assert!(matches!(detect("/bin/zsh"), ShellKind::Zsh));
        assert!(matches!(detect("/usr/bin/bash"), ShellKind::Bash));
        assert!(matches!(detect("/usr/local/bin/fish"), ShellKind::Fish));
        assert!(matches!(detect("powershell.exe"), ShellKind::Unknown));
    }

    #[test]
    fn bash_integration_carries_osc133() {
        let p = prepare_bash();
        assert_eq!(p.args.first().map(String::as_str), Some("--rcfile"));
        let rc = std::fs::read_to_string(&p.args[1]).unwrap();
        assert!(rc.contains("133;C"));
        assert!(rc.contains("133;D"));
    }
}
