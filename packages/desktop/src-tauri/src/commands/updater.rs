use crate::types::UpdaterEnvironment;
use crate::updater::prepare_update_install as prepare_update_install_inner;
use crate::updater::updater_environment as updater_environment_inner;

#[tauri::command]
pub fn updater_environment(_app: tauri::AppHandle) -> UpdaterEnvironment {
    updater_environment_inner()
}

#[tauri::command]
pub fn updater_prepare_install(app: tauri::AppHandle) -> Result<(), String> {
    prepare_update_install_inner(&app)
}
