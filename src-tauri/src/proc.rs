//! Process-spawn helpers.
//!
//! Release builds are a windowed app (`windows_subsystem = "windows"` in
//! main.rs), so any spawned console binary (`git`, `gh`, `tailscale`,
//! `cloudflared`, …) allocates its own console — a window that flashes on
//! screen. `CREATE_NO_WINDOW` suppresses the console; piping stdio does not.
//! Every background spawn must go through these helpers. Spawns that are
//! MEANT to show a window (open-in-terminal / explorer) use `Command::new`
//! directly.

use std::ffi::OsStr;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `std::process::Command` that never opens a console window on Windows.
pub fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Tokio flavor of [`hidden_command`].
#[cfg(feature = "remote-access")]
pub fn hidden_tokio_command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}
