<#
.SYNOPSIS
Best-effort MSI entrypoint for Veslo's managed WSL2 sandbox distro.

.DESCRIPTION
This wrapper is invoked by the Windows MSI after application files are
installed. It keeps MSI installation non-blocking from a product correctness
perspective: provisioning failures are logged for repair/onboarding, but the
Veslo app installation itself is not rolled back.

The actual runtime setup lives in windows-wsl2-sandbox-provision.ps1. This file
only locates the bundled helper, checks whether WSL is usable, and runs a quick
check-before-repair pass so app updates do not reinstall a healthy distro.
#>
[CmdletBinding()]
param(
    [string]$DistroName = "VesloSandbox",
    [string]$InstallDir = "",
    [string]$OpencodeVersion = "",
    [string]$OpencodeGithubRepo = "anomalyco/opencode"
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$env:WSL_UTF8 = "1"

function Write-InstallerLog([string]$Message) {
    $timestamp = (Get-Date).ToString("o")
    Write-Host "[$timestamp] $Message"
}

function ConvertTo-NativeArgument([string]$Argument) {
    if ($null -eq $Argument -or $Argument.Length -eq 0) {
        return '""'
    }
    if ($Argument -notmatch '[\s"]') {
        return $Argument
    }

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append([char]0x22)
    $backslashes = 0
    foreach ($char in $Argument.ToCharArray()) {
        if ($char -eq [char]0x5c) {
            $backslashes += 1
            continue
        }
        if ($char -eq [char]0x22) {
            if ($backslashes -gt 0) {
                [void]$builder.Append(('\' * ($backslashes * 2)))
                $backslashes = 0
            }
            [void]$builder.Append('\"')
            continue
        }
        if ($backslashes -gt 0) {
            [void]$builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        [void]$builder.Append($char)
    }
    if ($backslashes -gt 0) {
        [void]$builder.Append(('\' * ($backslashes * 2)))
    }
    [void]$builder.Append([char]0x22)
    return $builder.ToString()
}

function Invoke-HiddenNativeCommand([string]$FilePath, [string[]]$Arguments) {
    Write-InstallerLog ("> {0} {1}" -f $FilePath, ($Arguments -join " "))

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    try {
        $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    } catch {}

    $lines = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))
    $outputHandler = [System.Diagnostics.DataReceivedEventHandler]{
        param($sender, $eventArgs)
        if ($null -ne $eventArgs.Data) {
            [void]$lines.Add([string]$eventArgs.Data)
        }
    }
    $errorHandler = [System.Diagnostics.DataReceivedEventHandler]{
        param($sender, $eventArgs)
        if ($null -ne $eventArgs.Data) {
            [void]$lines.Add([string]$eventArgs.Data)
        }
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $process.add_OutputDataReceived($outputHandler)
    $process.add_ErrorDataReceived($errorHandler)
    try {
        [void]$process.Start()
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()
        $process.WaitForExit()
        $process.WaitForExit()
        $exitCode = $process.ExitCode
    } finally {
        $process.remove_OutputDataReceived($outputHandler)
        $process.remove_ErrorDataReceived($errorHandler)
        $process.Dispose()
    }

    $outputLines = @($lines.ToArray() | ForEach-Object { [string]$_ })
    foreach ($line in $outputLines) {
        if ($line) {
            Write-InstallerLog $line
        }
    }

    return [pscustomobject]@{
        ExitCode = [int]$exitCode
        Output = ($outputLines -join "`n")
    }
}

function Resolve-LocalAppData {
    $path = [Environment]::GetFolderPath("LocalApplicationData")
    if ($path -and $path.Trim()) {
        return $path
    }
    if ($env:LOCALAPPDATA -and $env:LOCALAPPDATA.Trim()) {
        return $env:LOCALAPPDATA
    }
    return [System.IO.Path]::GetTempPath()
}

$logRoot = Join-Path (Resolve-LocalAppData) "Veslo\logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$logPath = Join-Path $logRoot "wsl2-sandbox-installer.log"

try {
    Start-Transcript -Path $logPath -Append -Force | Out-Null
} catch {
    Write-Host "Failed to start transcript at ${logPath}: $($_.Exception.Message)"
}

function Finish-Installer([int]$ProvisionExitCode) {
    Write-InstallerLog "Provisioning wrapper finished with provisioner exit code $ProvisionExitCode. MSI exit remains 0."
    try {
        Stop-Transcript | Out-Null
    } catch {}
    exit 0
}

try {
    Write-InstallerLog "Veslo WSL2 sandbox installer wrapper started."
    Write-InstallerLog "Identity: $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
    Write-InstallerLog "Distro: $DistroName"

    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $provisionScript = Join-Path $scriptDir "windows-wsl2-sandbox-provision.ps1"
    $desktopPackageJson = Join-Path $scriptDir "package.json"
    if (-not (Test-Path $provisionScript)) {
        Write-InstallerLog "Provisioning helper is missing: $provisionScript"
        Finish-Installer 2
    }

    if (-not $OpencodeVersion.Trim() -and (Test-Path $desktopPackageJson)) {
        try {
            $desktopPackage = Get-Content $desktopPackageJson -Raw | ConvertFrom-Json
            if ($desktopPackage.opencodeVersion) {
                $OpencodeVersion = ([string]$desktopPackage.opencodeVersion).Trim()
                Write-InstallerLog "Resolved OpenCode version from bundled desktop package manifest: $OpencodeVersion"
            }
        } catch {
            Write-InstallerLog "Failed to read bundled desktop package manifest: $($_.Exception.Message)"
        }
    }

    $identityName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($identityName -match "\\SYSTEM$") {
        Write-InstallerLog "Skipping WSL provisioning under SYSTEM. WSL distros are per-user; Settings/onboarding repair must run under the target user."
        Finish-Installer 0
    }

    $wslCommand = Get-Command "wsl.exe" -ErrorAction SilentlyContinue
    if (-not $wslCommand) {
        Write-InstallerLog "wsl.exe was not found. Install WSL first, then run Veslo repair/onboarding."
        Finish-Installer 0
    }

    $wslStatus = Invoke-HiddenNativeCommand "wsl.exe" @("--status")
    if ($wslStatus.ExitCode -ne 0) {
        Write-InstallerLog "WSL is installed incompletely or needs a reboot. Not running distro import from MSI."
        Finish-Installer $wslStatus.ExitCode
    }

    $baseArgs = @(
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $provisionScript,
        "-DistroName",
        $DistroName,
        "-OpencodeGithubRepo",
        $OpencodeGithubRepo
    )
    if ($InstallDir.Trim()) {
        $baseArgs += @("-InstallDir", $InstallDir)
    }
    if ($OpencodeVersion.Trim()) {
        $baseArgs += @("-OpencodeVersion", $OpencodeVersion)
    }

    Write-InstallerLog "Checking existing managed WSL runtime."
    $checkResult = Invoke-HiddenNativeCommand "powershell.exe" @($baseArgs + @("-CheckOnly"))
    if ($checkResult.ExitCode -eq 0) {
        Write-InstallerLog "Managed WSL runtime already satisfies Veslo requirements."
        Finish-Installer 0
    }

    Write-InstallerLog "Managed WSL runtime is missing or incomplete; provisioning now."
    $provisionResult = Invoke-HiddenNativeCommand "powershell.exe" $baseArgs
    Finish-Installer $provisionResult.ExitCode
} catch {
    Write-InstallerLog "Unhandled wrapper error: $($_.Exception.Message)"
    Finish-Installer 1
}
