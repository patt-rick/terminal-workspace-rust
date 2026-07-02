//! terminal-workspace-rust — Tauri 2 core.
//!
//! The Rust side owns PTY lifecycle, persistence, and (in later phases) git,
//! GitHub, and filesystem access. `run()` wires plugins, managed state, and the
//! command handlers the webview invokes.

mod claude;
mod commands;
mod error;
mod fs;
mod git;
mod github;
mod identity;
mod pty;
#[cfg(feature = "remote-access")]
mod remote;
mod settings;
mod state;

use github::GithubStore;
use identity::IdentityStore;
use pty::PtyManager;
use settings::SettingsStore;
use state::StateStore;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("resolve app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            app.manage(StateStore::load(data_dir.join("state.json")));
            app.manage(SettingsStore::new(data_dir.join("settings.json")));
            app.manage(GithubStore::new(data_dir.join("github.json")));
            app.manage(IdentityStore::new(data_dir.join("identity.json")));
            app.manage(PtyManager::new());
            #[cfg(feature = "remote-access")]
            app.manage(remote::RemoteServer::new(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::settings_get,
            commands::settings_set,
            commands::projects_snapshot,
            commands::projects_add,
            commands::projects_remove,
            commands::projects_rename,
            commands::projects_select,
            commands::projects_set_active,
            commands::project_open_in_terminal,
            commands::project_open_in_file_manager,
            commands::terminal_create,
            commands::terminal_attach,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_kill,
            commands::terminal_rename,
            commands::terminal_remove_record,
            commands::fs_list,
            commands::fs_read_text,
            commands::fs_write_text,
            commands::fs_create_file,
            commands::fs_create_folder,
            commands::fs_rename,
            commands::fs_remove,
            commands::fs_duplicate,
            commands::fs_save_temp_paste,
            commands::fs_export_text,
            commands::git_discover_repos,
            commands::git_selected_repo,
            commands::git_set_selected_repo,
            commands::git_dirty_flags,
            commands::git_info,
            commands::git_push,
            commands::git_diff,
            commands::github_get_settings,
            commands::github_set_client_id,
            commands::github_set_token,
            commands::github_sign_out,
            commands::github_device_start,
            commands::github_device_poll,
            commands::github_list_prs,
            commands::github_get_pr,
            commands::github_create_pr,
            commands::github_merge_pr,
            commands::github_comment_pr,
            commands::github_list_workflows,
            commands::github_list_runs,
            commands::github_get_run,
            commands::github_rerun_run,
            commands::github_rerun_failed,
            commands::github_cancel_run,
            commands::github_dispatch_workflow,
            commands::claude_sessions_list,
            commands::claude_session_delete,
            commands::identity_list_accounts,
            commands::identity_get_config,
            commands::identity_save_account,
            commands::identity_remove_account,
            commands::identity_set_config,
            commands::identity_resolve,
            commands::identity_apply,
            commands::identity_current,
            commands::identity_apply_global,
            commands::identity_detect_gh_accounts,
            #[cfg(feature = "remote-access")]
            commands::remote_start,
            #[cfg(feature = "remote-access")]
            commands::remote_stop,
            #[cfg(feature = "remote-access")]
            commands::remote_status,
            #[cfg(feature = "remote-access")]
            commands::remote_regenerate_code,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill every PTY (and its child processes) on quit; terminals are
            // recreated fresh from persisted state on next launch.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<PtyManager>().dispose_all();
                #[cfg(feature = "remote-access")]
                app_handle.state::<remote::RemoteServer>().stop();
            }
        });
}
