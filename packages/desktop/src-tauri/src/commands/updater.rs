use crate::types::UpdaterEnvironment;
use crate::updater::prepare_update_install as prepare_update_install_inner;
use crate::updater::relaunch_after_update_install as relaunch_after_update_install_inner;
use crate::updater::updater_environment as updater_environment_inner;

#[tauri::command]
pub fn updater_environment(_app: tauri::AppHandle) -> UpdaterEnvironment {
    updater_environment_inner()
}

#[tauri::command]
pub fn updater_prepare_install(app: tauri::AppHandle) -> Result<(), String> {
    prepare_update_install_inner(&app)
}

#[tauri::command]
pub fn updater_relaunch_after_install(app: tauri::AppHandle) -> Result<(), String> {
    relaunch_after_update_install_inner(&app)
}
