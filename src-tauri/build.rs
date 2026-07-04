use std::path::PathBuf;

// portable-pty prefers a sideloaded conpty.dll + OpenConsole.exe next to the
// executable over the OS ConPTY. Windows 10's in-box ConPTY predates years of
// renderer fixes (stale cells / cursor desync with cursor-heavy TUIs like
// Claude Code), so we ship the modern pair (MIT, microsoft/terminal build
// vendored by wezterm) the way VS Code and wezterm do. The bundler places them
// next to the installed exe (see tauri.conf.json resources); this copy covers
// `cargo run` / `tauri dev`, where the exe runs from target/{profile}.
fn copy_conhost() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    // OUT_DIR = target/{profile}/build/{crate}-{hash}/out
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return;
    };
    for name in ["conpty.dll", "OpenConsole.exe"] {
        let src = manifest.join("conhost").join(name);
        if src.exists() {
            let _ = std::fs::copy(&src, profile_dir.join(name));
        }
        println!("cargo:rerun-if-changed={}", src.display());
    }
}

fn main() {
    copy_conhost();
    tauri_build::build()
}
