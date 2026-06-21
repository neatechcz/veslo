<#
.SYNOPSIS
Installs the Windows WSL feature prerequisites required by VesloSandbox.

.DESCRIPTION
This helper owns phase 1 of the Windows sandbox setup. It installs WSL without
installing a default Linux distribution, sets WSL 2 as the default for future
imports when possible, and reports when Windows must be restarted before phase 2
can import Veslo's per-user managed distro.
#>
[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$Install
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$env:WSL_UTF8 = "1"

if (-not $CheckOnly -and -not $Install) {
    $CheckOnly = $true
}

function Resolve-PrereqLogRoot {
    if ($env:ProgramData -and $env:ProgramData.Trim()) {
        return (Join-Path $env:ProgramData "Veslo\logs")
    }
    if ($env:LOCALAPPDATA -and $env:LOCALAPPDATA.Trim()) {
        return (Join-Path $env:LOCALAPPDATA "Veslo\logs")
    }
    return [System.IO.Path]::GetTempPath()
}

$logRoot = Resolve-PrereqLogRoot
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$logPath = Join-Path $logRoot "wsl2-prerequisite-installer.log"

try {
    Start-Transcript -Path $logPath -Append -Force | Out-Null
} catch {
    Write-Host "Failed to start transcript at ${logPath}: $($_.Exception.Message)"
}

function Write-PrereqLog([string]$Message) {
    $timestamp = (Get-Date).ToString("o")
    Write-Host "[$timestamp] $Message"
}

function Finish-Prereq([int]$ExitCode) {
    Write-PrereqLog "WSL prerequisite helper finished with exit code $ExitCode. Log: $logPath"
    try {
        Stop-Transcript | Out-Null
    } catch {}
    exit $ExitCode
}

function Test-IsAdministrator {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Invoke-NativeCommand([string]$FilePath, [string[]]$Arguments) {
    Write-PrereqLog ("> {0} {1}" -f $FilePath, ($Arguments -join " "))
    $output = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) {
        $exitCode = if ($?) { 0 } else { 1 }
    }
    foreach ($line in @($output)) {
        if ($null -ne $line) {
            Write-PrereqLog ([string]$line)
        }
    }
    return [pscustomobject]@{
        ExitCode = [int]$exitCode
        Output = ((@($output) | ForEach-Object { [string]$_ }) -join "`n")
    }
}

function Test-WslUsable {
    $wslCommand = Get-Command "wsl.exe" -ErrorAction SilentlyContinue
    if (-not $wslCommand) {
        return [pscustomobject]@{
            Ok = $false
            Reason = "wsl.exe is not available."
            ExitCode = 127
        }
    }

    $status = Invoke-NativeCommand "wsl.exe" @("--status")
    if ($status.ExitCode -eq 0) {
        return [pscustomobject]@{
            Ok = $true
            Reason = "WSL is available."
            ExitCode = 0
        }
    }

    return [pscustomobject]@{
        Ok = $false
        Reason = "wsl.exe --status failed. WSL is missing, incomplete, or waiting for restart."
        ExitCode = $status.ExitCode
    }
}

function Enable-WslFeaturesWithDism {
    Write-PrereqLog "Falling back to DISM feature enablement."
    $wslFeature = Invoke-NativeCommand "dism.exe" @(
        "/online",
        "/enable-feature",
        "/featurename:Microsoft-Windows-Subsystem-Linux",
        "/all",
        "/norestart"
    )
    $vmFeature = Invoke-NativeCommand "dism.exe" @(
        "/online",
        "/enable-feature",
        "/featurename:VirtualMachinePlatform",
        "/all",
        "/norestart"
    )
    if ($wslFeature.ExitCode -ne 0 -and $wslFeature.ExitCode -ne 3010) {
        return $wslFeature.ExitCode
    }
    if ($vmFeature.ExitCode -ne 0 -and $vmFeature.ExitCode -ne 3010) {
        return $vmFeature.ExitCode
    }
    return 3010
}

try {
    Write-PrereqLog "Veslo WSL prerequisite helper started."
    Write-PrereqLog "Identity: $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
    Write-PrereqLog "Mode: $(if ($Install) { "install" } else { "check" })"

    $current = Test-WslUsable
    Write-PrereqLog $current.Reason
    if ($current.Ok) {
        if ($Install) {
            $setDefault = Invoke-NativeCommand "wsl.exe" @("--set-default-version", "2")
            if ($setDefault.ExitCode -ne 0) {
                Write-PrereqLog "Unable to set WSL 2 as default now; continuing because WSL itself is usable."
            }
        }
        Finish-Prereq 0
    }

    if ($CheckOnly) {
        Finish-Prereq 10
    }

    if (-not (Test-IsAdministrator)) {
        Write-PrereqLog "Administrator privileges are required to enable WSL Windows features."
        Finish-Prereq 740
    }

    $wslCommand = Get-Command "wsl.exe" -ErrorAction SilentlyContinue
    if ($wslCommand) {
        $installResult = Invoke-NativeCommand "wsl.exe" @("--install", "--no-distribution")
        if ($installResult.ExitCode -ne 0) {
            $fallbackPattern = "unknown|invalid|unrecognized|unsupported|usage"
            if ($installResult.Output -notmatch $fallbackPattern) {
                Write-PrereqLog "wsl --install failed without a recognized legacy syntax error."
                Finish-Prereq $installResult.ExitCode
            }
            $fallbackExit = Enable-WslFeaturesWithDism
            if ($fallbackExit -ne 0 -and $fallbackExit -ne 3010) {
                Finish-Prereq $fallbackExit
            }
        }
    } else {
        $fallbackExit = Enable-WslFeaturesWithDism
        if ($fallbackExit -ne 0 -and $fallbackExit -ne 3010) {
            Finish-Prereq $fallbackExit
        }
    }

    $wslCommand = Get-Command "wsl.exe" -ErrorAction SilentlyContinue
    if ($wslCommand) {
        $setDefault = Invoke-NativeCommand "wsl.exe" @("--set-default-version", "2")
        if ($setDefault.ExitCode -ne 0) {
            Write-PrereqLog "WSL default version could not be set before restart. Veslo will retry after Windows restarts."
        }
    } else {
        Write-PrereqLog "wsl.exe is still unavailable after feature enablement. Windows restart is required."
        Finish-Prereq 3010
    }

    $afterInstall = Test-WslUsable
    Write-PrereqLog $afterInstall.Reason
    if ($afterInstall.Ok) {
        Finish-Prereq 0
    }

    Write-PrereqLog "Windows restart is likely required before VesloSandbox can be imported."
    Finish-Prereq 3010
} catch {
    Write-PrereqLog "Unhandled prerequisite helper error: $($_.Exception.Message)"
    Finish-Prereq 1
}
