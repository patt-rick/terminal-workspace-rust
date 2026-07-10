//! terminal-workspace-rust — Tauri 2 core.
//!
//! The Rust side owns PTY lifecycle, persistence, and (in later phases) git,
//! GitHub, and filesystem access. `run()` wires plugins, managed state, and the
//! command handlers the webview invokes.

mod apikeys;
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
mod search;
mod settings;
mod state;

use apikeys::ApiKeyStore;
use github::GithubStore;
use identity::IdentityStore;
use pty::PtyManager;
use settings::SettingsStore;
use state::StateStore;
use tauri::Manager;

/// `--hook-sink` mode entry (see main.rs): copy stdin into the spool dir.
pub fn hook_sink(spool: &std::path::Path) {
    claude::hooks::run_sink(spool);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
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
            // TW_DATA_DIR overrides the app-data location (state/settings/etc).
            // Lets a second, fully isolated instance run for testing without
            // touching the installed app's data.
            let data_dir = match std::env::var_os("TW_DATA_DIR") {
                Some(dir) => std::path::PathBuf::from(dir),
                None => app
                    .path()
                    .app_data_dir()
                    .expect("resolve app data dir"),
            };
            std::fs::create_dir_all(&data_dir).ok();
            app.manage(StateStore::load(data_dir.join("state.json")));
            app.manage(SettingsStore::new(data_dir.join("settings.json")));
            app.manage(GithubStore::new(data_dir.join("github.json")));
            app.manage(IdentityStore::new(data_dir.join("identity.json")));
            app.manage(ApiKeyStore::new(data_dir.join("keys.json")));
            app.manage(claude::accounts::ClaudeAccountStore::new(
                data_dir.join("claude-accounts.json"),
            ));
            app.manage(commands::ClaudeOauthFlow::default());
            app.manage(PtyManager::new());
            app.manage(search::SearchStore::default());
            // Claude hook events (Notification/Stop) land in the spool dir; the
            // watcher routes them to terminals as attention events. Cheap no-op
            // polling when hooks aren't installed.
            #[cfg(feature = "remote-access")]
            claude::hooks::start_watcher(
                app.handle().clone(),
                claude::hooks::spool_dir(&data_dir),
            );
            #[cfg(feature = "remote-access")]
            {
                app.manage(remote::RemoteServer::new(app.handle().clone()));
                // Headless/dev auto-start for testing: set TW_REMOTE_AUTOSTART=<port>
                // to start remote access at launch and print the URL + pairing code.
                if let Ok(port) = std::env::var("TW_REMOTE_AUTOSTART") {
                    let handle = app.handle().clone();
                    let port: u16 = port.parse().unwrap_or(8899);
                    // Dev autostart binds localhost only (no tunnel) for LAN testing.
                    tauri::async_runtime::spawn(async move {
                        let server = handle.state::<remote::RemoteServer>();
                        match server.start(port, remote::MODE_LOCAL, false).await {
                            Ok(info) => {
                                eprintln!("REMOTE_READY url={} code={}", info.url, info.pairing_code)
                            }
                            Err(e) => eprintln!("REMOTE_START_FAILED {e}"),
                        }
                    });
                }
            }
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
            commands::terminal_remote_size,
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
            commands::search_query,
            commands::search_index_status,
            commands::search_rebuild,
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
            commands::claude_hooks_status,
            commands::claude_hooks_enable,
            commands::claude_hooks_disable,
            commands::claude_accounts_list,
            commands::claude_accounts_add_via_oauth,
            commands::claude_accounts_login_cancel,
            commands::claude_accounts_import_cli,
            commands::claude_accounts_switch,
            commands::claude_accounts_switch_to_apikey,
            commands::claude_accounts_remove,
            commands::claude_accounts_usage,
            commands::identity_list_accounts,
            commands::identity_get_config,
            commands::identity_save_account,
            commands::identity_remove_account,
            commands::identity_set_config,
            commands::identity_resolve,
            commands::identity_apply,
            commands::identity_unmap,
            commands::identity_push_preflight,
            commands::identity_current,
            commands::identity_apply_global,
            commands::identity_detect_gh_accounts,
            commands::identity_align_gh,
            commands::apikeys_list,
            commands::apikeys_save,
            commands::apikeys_remove,
            commands::apikeys_set_enabled,
            commands::apikeys_test,
            commands::apikeys_detect_env,
            commands::apikeys_import_env,
            commands::binary_exists,
            commands::python_module_exists,
            #[cfg(feature = "remote-access")]
            commands::remote_start,
            #[cfg(feature = "remote-access")]
            commands::remote_stop,
            #[cfg(feature = "remote-access")]
            commands::remote_status,
            #[cfg(feature = "remote-access")]
            commands::remote_regenerate_code,
            #[cfg(feature = "remote-access")]
            commands::remote_detect_tailscale,
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
