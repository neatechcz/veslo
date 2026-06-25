use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};

use crate::platform::configure_hidden;
use crate::types::ExecResult;

const WSL_PREREQUISITE_INSTALLER: &str = "wsl2-prerequisite-installer.ps1";
const WSL_PROVISIONER: &str = "windows-wsl2-sandbox-provision.ps1";

fn existing_path(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.is_file())
}

fn repo_relative_candidates(file_name: &str) -> Vec<PathBuf> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    vec![
        cwd.join(file_name),
        cwd.join("resources").join(file_name),
        cwd.join("packages")
            .join("desktop")
            .join("src-tauri")
            .join("resources")
            .join(file_name),
        cwd.join("packages")
            .join("orchestrator")
            .join("scripts")
            .join(file_name),
        cwd.join("..")
            .join("orchestrator")
            .join("scripts")
            .join(file_name),
        cwd.join("..")
            .join("..")
            .join("orchestrator")
            .join("scripts")
            .join(file_name),
    ]
}

fn resolve_resource_file(app: &AppHandle, file_name: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(file_name));
        candidates.push(resource_dir.join("resources").join(file_name));
    }
    candidates.extend(repo_relative_candidates(file_name));
    existing_path(candidates)
}

fn command_output_result(command: &mut Command, context: &str) -> Result<ExecResult, String> {
    let output = command
        .output()
        .map_err(|error| format!("Failed to run {context}: {error}"))?;

    let status = output.status.code().unwrap_or(-1);
    Ok(ExecResult {
        ok: output.status.success(),
        status,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

fn wsl_prerequisite_log_path() -> PathBuf {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("Veslo")
        .join("logs")
        .join("wsl2-prerequisite-installer.log")
}

fn append_prerequisite_log_tail(result: &mut ExecResult) {
    let log_path = wsl_prerequisite_log_path();
    let Ok(raw) = std::fs::read_to_string(&log_path) else {
        return;
    };
    let lines = raw.lines().collect::<Vec<_>>();
    if lines.is_empty() {
        return;
    }

    let start = lines
        .iter()
        .rposition(|line| line.contains("Windows PowerShell transcript start"))
        .unwrap_or_else(|| lines.len().saturating_sub(260));
    let mut tail = lines[start..].join("\n");
    if !tail.is_empty() {
        tail.push('\n');
    }
    if !result.stdout.trim().is_empty() {
        result.stdout.push_str("\n\n");
    }
    result.stdout.push_str(&format!(
        "Latest WSL prerequisite helper transcript from {}:\n{}",
        log_path.display(),
        tail
    ));
}

fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn elevated_powershell_command(script_path: &Path, script_args: &[&str]) -> String {
    let mut args = vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-WindowStyle".to_string(),
        "Hidden".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-File".to_string(),
        script_path.to_string_lossy().to_string(),
    ];
    args.extend(script_args.iter().map(|arg| (*arg).to_string()));
    let ps_args = args
        .iter()
        .map(|arg| powershell_single_quote(arg))
        .collect::<Vec<_>>()
        .join(", ");

    format!(
        "$ErrorActionPreference = 'Stop'; \
         try {{ \
           $arguments = @({ps_args}); \
           $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -Verb RunAs -Wait -PassThru; \
           $exitCode = if ($null -eq $process.ExitCode) {{ 1 }} else {{ [int]$process.ExitCode }}; \
           Write-Output ('Elevated WSL prerequisite installer exit code: ' + $exitCode); \
           exit $exitCode; \
         }} catch {{ \
           Write-Error $_.Exception.Message; \
           exit 1223; \
         }}"
    )
}

fn read_opencode_version_from_package_json(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    value
        .get("opencodeVersion")
        .and_then(|version| version.as_str())
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(ToString::to_string)
}

fn resolve_packaged_opencode_version(app: &AppHandle) -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("package.json"));
        candidates.push(resource_dir.join("resources").join("package.json"));
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    candidates.push(cwd.join("package.json"));
    candidates.push(cwd.join("packages").join("desktop").join("package.json"));
    candidates.push(cwd.join("..").join("package.json"));
    candidates.push(
        cwd.join("..")
            .join("..")
            .join("desktop")
            .join("package.json"),
    );

    candidates
        .into_iter()
        .find_map(|path| read_opencode_version_from_package_json(&path))
}

#[tauri::command]
pub fn wsl_prerequisites_repair(
    app: AppHandle,
    check_only: Option<bool>,
) -> Result<ExecResult, String> {
    if !cfg!(windows) {
        return Ok(ExecResult {
            ok: false,
            status: 1,
            stdout: String::new(),
            stderr: "WSL prerequisite repair is only available on Windows.".to_string(),
        });
    }

    let installer = resolve_resource_file(&app, WSL_PREREQUISITE_INSTALLER).ok_or_else(|| {
        format!("Bundled WSL prerequisite installer not found: {WSL_PREREQUISITE_INSTALLER}")
    })?;

    if check_only.unwrap_or(false) {
        let mut command = Command::new("powershell.exe");
        configure_hidden(&mut command);
        command
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-WindowStyle")
            .arg("Hidden")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&installer)
            .arg("-CheckOnly");

        return command_output_result(&mut command, "WSL prerequisite checker");
    }

    let elevated_command = elevated_powershell_command(&installer, &["-Install"]);
    let mut command = Command::new("powershell.exe");
    configure_hidden(&mut command);
    command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(elevated_command);

    let mut result = command_output_result(&mut command, "elevated WSL prerequisite installer")?;
    append_prerequisite_log_tail(&mut result);
    Ok(result)
}

#[tauri::command]
pub fn wsl_sandbox_repair(
    app: AppHandle,
    check_only: Option<bool>,
    force: Option<bool>,
) -> Result<ExecResult, String> {
    if !cfg!(windows) {
        return Ok(ExecResult {
            ok: false,
            status: 1,
            stdout: String::new(),
            stderr: "WSL sandbox repair is only available on Windows.".to_string(),
        });
    }

    let provisioner = resolve_resource_file(&app, WSL_PROVISIONER)
        .ok_or_else(|| format!("Bundled WSL sandbox provisioner not found: {WSL_PROVISIONER}"))?;

    let mut command = Command::new("powershell.exe");
    configure_hidden(&mut command);
    command
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-WindowStyle")
        .arg("Hidden")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&provisioner);

    if check_only.unwrap_or(false) {
        command.arg("-CheckOnly");
    }
    if force.unwrap_or(false) {
        command.arg("-Force");
    }
    if let Some(version) = resolve_packaged_opencode_version(&app) {
        command.arg("-OpencodeVersion").arg(version);
    }

    command_output_result(&mut command, "WSL sandbox provisioner")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_opencode_version_from_desktop_package_manifest() {
        let root = tempfile::tempdir().expect("tempdir");
        let package_json = root.path().join("package.json");
        std::fs::write(
            &package_json,
            r#"{"name":"@neatech/veslo","opencodeVersion":"1.17.4"}"#,
        )
        .expect("write package");

        assert_eq!(
            read_opencode_version_from_package_json(&package_json).as_deref(),
            Some("1.17.4"),
        );
    }

    #[test]
    fn powershell_single_quote_escapes_embedded_quotes() {
        assert_eq!(
            powershell_single_quote(r"C:\Users\O'Brien\script.ps1"),
            r"'C:\Users\O''Brien\script.ps1'",
        );
    }

    #[test]
    fn elevated_prerequisite_command_uses_runas_and_install_mode() {
        let command = elevated_powershell_command(
            Path::new(r"C:\Program Files\Veslo\resources\wsl2-prerequisite-installer.ps1"),
            &["-Install"],
        );

        assert!(command.contains("Start-Process"));
        assert!(command.contains("-Verb RunAs"));
        assert!(command.contains("-WindowStyle Hidden"));
        assert!(command.contains("'-NonInteractive'"));
        assert!(command.contains("'-WindowStyle'"));
        assert!(command.contains("'Hidden'"));
        assert!(command.contains("wsl2-prerequisite-installer.ps1"));
        assert!(command.contains("'-Install'"));
    }
}
