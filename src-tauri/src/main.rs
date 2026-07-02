// Prevents an extra console window on Windows in release; does nothing on other platforms.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Claude-hook sink mode: `terminal-workspace --hook-sink <spool-dir>` copies
    // stdin to a spool file and exits, without starting the app. This is the
    // command Claude Code invokes on Notification/Stop hook events.
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--hook-sink") {
        if let Some(dir) = args.next() {
            app_lib::hook_sink(std::path::Path::new(&dir));
        }
        return;
    }
    app_lib::run();
}
