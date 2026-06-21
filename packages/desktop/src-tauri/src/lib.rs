mod bootstrap_diagnostics;
mod bun_env;
mod commands;
mod config;
mod debug_logs_forwarder;
mod engine;
mod env_guard;
mod error_monitoring;
mod fs;
mod opencode_router;
mod opkg;
mod orchestrator;
mod paths;
mod platform;
mod process_supervisor;
#[cfg(test)]
mod single_window_config_tests;
mod supervised_process;
mod types;
mod updater;
mod utils;
mod veslo_server;
mod workspace;

pub use types::*;

use bootstrap_diagnostics::{
    clear_bootstrap_diagnostics_cloud_context, record_bootstrap_diagnostic,
    set_bootstrap_diagnostics_cloud_context,
};
use commands::access_proofs::{access_proof_ai_clear, access_proof_ai_read, access_proof_ai_write};
use commands::clipboard::clipboard_file_paths;
use commands::command_files::{
    opencode_command_delete, opencode_command_list, opencode_command_write,
};
use commands::config::{read_opencode_config, write_opencode_config};
use commands::den_auth::{den_auth_snapshot_read, den_auth_snapshot_write};
use commands::engine::{
    engine_doctor, engine_info, engine_install, engine_restart, engine_start, engine_stop,
};
use commands::engine_sse::{engine_sse_subscribe, engine_sse_unsubscribe, EngineSseRegistry};
use commands::misc::{
    app_build_info, log_ui_event, obsidian_is_available, open_in_obsidian, opencode_db_migrate,
    opencode_db_update_session_directory, opencode_mcp_auth, read_obsidian_mirror_file,
    reset_opencode_cache, reset_veslo_state, write_obsidian_mirror_file,
};
use commands::opencode_router::{
    opencodeRouter_config_set, opencodeRouter_info, opencodeRouter_start, opencodeRouter_status,
    opencodeRouter_stop,
};
use commands::opkg::{import_skill, opkg_install};
use commands::orchestrator::{
    orchestrator_engines_list, orchestrator_instance_dispose, orchestrator_start_detached,
    orchestrator_status, orchestrator_workspace_activate, spawn_engine_event_poller,
};
use commands::pending_session_drafts::{
    pending_session_drafts_delete, pending_session_drafts_get, pending_session_drafts_list,
    pending_session_drafts_put,
};
use commands::scheduler::{scheduler_delete_job, scheduler_list_jobs};
use commands::session_reader::{opencode_db_read_sessions, opencode_db_read_transcript};
use commands::skills::{
    install_global_skill_template, install_skill_template, list_local_skills,
    list_local_skills_scoped, read_local_skill, read_local_skill_at_path, uninstall_skill,
    uninstall_skill_at_path, write_local_skill, write_local_skill_at_path,
};
use commands::updater::{updater_environment, updater_prepare_install};
use commands::veslo_server::{veslo_server_info, veslo_server_restart};
#[cfg(all(debug_assertions, feature = "e2e"))]
use commands::window::e2e_position_main_window;
use commands::window::set_window_decorations;
use commands::workspace::{
    workspace_add_authorized_root, workspace_bootstrap, workspace_copy_into_folder,
    workspace_create, workspace_create_remote, workspace_export_config, workspace_forget,
    workspace_import_config, workspace_private_root, workspace_set_active,
    workspace_update_display_name, workspace_update_remote, workspace_veslo_read,
    workspace_veslo_write,
};
use commands::wsl_sandbox::{wsl_prerequisites_repair, wsl_sandbox_repair};
use engine::manager::EngineManager;
use opencode_router::manager::OpenCodeRouterManager;
use orchestrator::manager::OrchestratorManager;
use tauri::{Emitter, Manager, WebviewWindowBuilder};
use veslo_server::manager::VesloServerManager;
use workspace::watch::WorkspaceWatchState;

fn register_debug_logs_forwarder(app_handle: &tauri::AppHandle) {
    use std::sync::Arc;
    use std::time::Duration;

    let spool_dir = paths::app_local_data_dir_override()
        .or_else(|| tauri::Manager::path(app_handle).app_local_data_dir().ok())
        .map(|dir| dir.join("desktop-debug-log-spool"));

    let Some(spool_dir) = spool_dir else {
        eprintln!("[debug-logs-forwarder] no app local data dir resolved, forwarding disabled");
        return;
    };

    let forwarder = Arc::new(debug_logs_forwarder::DebugLogsForwarder::new(spool_dir));
    debug_logs_forwarder::spawn_flush_task(
        forwarder.clone(),
        app_handle.clone(),
        Duration::from_secs(5),
    );
    tauri::Manager::manage(app_handle, forwarder);
}

pub(crate) fn stop_managed_services(app_handle: &tauri::AppHandle) -> Vec<u32> {
    let mut pids = Vec::new();

    if let Ok(mut engine) = app_handle.state::<EngineManager>().inner.lock() {
        if !engine.child_exited {
            if let Some(child) = engine.child.as_ref() {
                pids.push(child.pid());
            }
        }
        EngineManager::stop_locked(&mut engine);
    }
    if let Ok(mut orchestrator) = app_handle.state::<OrchestratorManager>().inner.lock() {
        if !orchestrator.child_exited {
            if let Some(child) = orchestrator.child.as_ref() {
                pids.push(child.pid());
            }
        }
        OrchestratorManager::stop_locked(&mut orchestrator);
    }
    if let Ok(mut veslo_server) = app_handle.state::<VesloServerManager>().inner.lock() {
        if !veslo_server.child_exited {
            if let Some(child) = veslo_server.child.as_ref() {
                pids.push(child.pid());
            }
        }
        VesloServerManager::stop_locked(&mut veslo_server);
    }
    // VSLO-86 — clear persisted state.json on shutdown so the next boot
    // doesn't try to attach to dead port/token from this run.
    let _ = crate::veslo_server::clear_persisted_veslo_server_info(app_handle);
    if let Ok(mut opencode_router) = app_handle.state::<OpenCodeRouterManager>().inner.lock() {
        if !opencode_router.child_exited {
            if let Some(child) = opencode_router.child.as_ref() {
                pids.push(child.pid());
            }
        }
        OpenCodeRouterManager::stop_locked(&mut opencode_router);
    }

    pids.sort_unstable();
    pids.dedup();
    pids
}

/// Best-effort dev-mode cleanup: kill veslo-* sidecars whose process group
/// differs from ours. A `pnpm dev` Ctrl+C does not always reap orchestrator/
/// veslo-server/veslo-code-router; orphans bind ports and leave a stale
/// veslo-server-state.json that breaks the next dev session. Release builds
/// keep the original tauri-plugin-single-instance behavior — we don't want a
/// shipped Veslo killing unrelated user processes.
#[cfg(all(debug_assertions, not(windows)))]
fn kill_orphan_sidecars() {
    use std::process::Command;

    let my_pid = std::process::id().to_string();
    let my_pgid = match Command::new("ps")
        .args(["-o", "pgid=", "-p", &my_pid])
        .output()
    {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => return,
    };
    if my_pgid.is_empty() {
        return;
    }

    let output = match Command::new("pgrep")
        .args([
            "-f",
            "veslo-server|veslo-orchestrator|veslo-code-router|veslo-code",
        ])
        .output()
    {
        Ok(o) => o,
        Err(_) => return,
    };
    let pids: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty() && line != &my_pid)
        .collect();

    for pid in pids {
        let other_pgid = Command::new("ps")
            .args(["-o", "pgid=", "-p", &pid])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        if other_pgid.is_empty() || other_pgid == my_pgid {
            continue;
        }
        eprintln!("[veslo] killing orphan sidecar pid={pid} pgid={other_pgid}");
        let _ = Command::new("kill").arg(&pid).status();
    }
}

#[cfg(not(all(debug_assertions, not(windows))))]
fn kill_orphan_sidecars() {}

pub fn run() {
    kill_orphan_sidecars();
    let _sentry_guard = error_monitoring::init_error_monitoring();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let deep_link_urls: Vec<String> = argv
                .iter()
                .filter_map(|arg| {
                    let value = arg.trim();
                    if value.is_empty() {
                        return None;
                    }
                    let lower = value.to_ascii_lowercase();
                    if lower.starts_with("veslo://")
                        || lower.starts_with("https://")
                        || lower.starts_with("http://")
                    {
                        Some(value.to_string())
                    } else {
                        None
                    }
                })
                .collect();

            if !deep_link_urls.is_empty() {
                let _ = app.emit("deep-link://new-url", deep_link_urls);
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(all(debug_assertions, feature = "e2e"))]
    let builder = builder.plugin(tauri_plugin_pilot::init());

    #[cfg(debug_assertions)]
    let builder = builder.plugin(tauri_plugin_pilot::init());

    let app = builder
        .setup(|app| {
            let window_config = app.config().app.windows.first().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, "missing main window config")
            })?;

            WebviewWindowBuilder::from_config(app.handle(), window_config)?
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;

            Ok(())
        })
        .manage(EngineManager::default())
        .manage(OrchestratorManager::default())
        .manage(VesloServerManager::default())
        .manage(OpenCodeRouterManager::default())
        .manage(WorkspaceWatchState::default())
        .manage(EngineSseRegistry::default())
        .invoke_handler(tauri::generate_handler![
            engine_start,
            engine_stop,
            engine_info,
            engine_doctor,
            engine_install,
            engine_restart,
            access_proof_ai_read,
            access_proof_ai_write,
            access_proof_ai_clear,
            engine_sse_subscribe,
            engine_sse_unsubscribe,
            orchestrator_status,
            orchestrator_engines_list,
            orchestrator_workspace_activate,
            orchestrator_instance_dispose,
            orchestrator_start_detached,
            // F4Ú8b — sandbox_doctor, sandbox_debug_probe, sandbox_stop,
            // sandbox_cleanup_veslo_containers IPC commands SMAZÁNY.
            veslo_server_info,
            veslo_server_restart,
            opencodeRouter_info,
            opencodeRouter_start,
            opencodeRouter_stop,
            opencodeRouter_status,
            opencodeRouter_config_set,
            workspace_bootstrap,
            workspace_set_active,
            workspace_copy_into_folder,
            workspace_create,
            workspace_private_root,
            workspace_create_remote,
            workspace_update_display_name,
            workspace_update_remote,
            workspace_forget,
            workspace_add_authorized_root,
            workspace_export_config,
            workspace_import_config,
            opencode_command_list,
            opencode_command_write,
            opencode_command_delete,
            workspace_veslo_read,
            workspace_veslo_write,
            opkg_install,
            import_skill,
            install_skill_template,
            install_global_skill_template,
            list_local_skills,
            list_local_skills_scoped,
            read_local_skill,
            read_local_skill_at_path,
            uninstall_skill,
            uninstall_skill_at_path,
            write_local_skill,
            write_local_skill_at_path,
            read_opencode_config,
            write_opencode_config,
            updater_environment,
            updater_prepare_install,
            app_build_info,
            log_ui_event,
            record_bootstrap_diagnostic,
            set_bootstrap_diagnostics_cloud_context,
            clear_bootstrap_diagnostics_cloud_context,
            obsidian_is_available,
            open_in_obsidian,
            write_obsidian_mirror_file,
            read_obsidian_mirror_file,
            den_auth_snapshot_read,
            den_auth_snapshot_write,
            reset_veslo_state,
            reset_opencode_cache,
            opencode_db_migrate,
            opencode_mcp_auth,
            opencode_db_update_session_directory,
            opencode_db_read_sessions,
            opencode_db_read_transcript,
            scheduler_list_jobs,
            scheduler_delete_job,
            wsl_prerequisites_repair,
            wsl_sandbox_repair,
            pending_session_drafts_list,
            pending_session_drafts_get,
            pending_session_drafts_put,
            pending_session_drafts_delete,
            clipboard_file_paths,
            #[cfg(all(debug_assertions, feature = "e2e"))]
            e2e_position_main_window,
            set_window_decorations
        ])
        .build(tauri::generate_context!())
        .expect("error while building Veslo");

    register_debug_logs_forwarder(app.handle());

    // F2Ú7: background poller that watches orchestrator engine snapshots and
    // emits `veslo://engine-event` on state transitions. Runs on a dedicated
    // OS thread for the lifetime of the app process.
    spawn_engine_event_poller(app.handle().clone());

    // F2Ú7 (dev only): auto-spawn orchestrator daemon shortly after app boot
    // so the per-workspace pool is available without explicit user action.
    // No-op if the frontend onboarding starts an engine first.
    #[cfg(debug_assertions)]
    commands::engine::spawn_orchestrator_dev_autostart(app.handle().clone());

    // Best-effort cleanup on app exit. Without this, background sidecars can keep
    // running after the UI quits (especially during dev), leading to multiple
    // orchestrator/veslo-code/veslo-server processes and stale ports.
    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            stop_managed_services(&app_handle);
        }
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } => {
            stop_managed_services(&app_handle);
        }
        _ => {}
    });
}
