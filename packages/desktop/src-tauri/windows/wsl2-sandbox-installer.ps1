<#
.SYNOPSIS
Installer entrypoint for Veslo's managed WSL2 sandbox distro.

.DESCRIPTION
This wrapper is invoked by the Windows installer after application files are
installed. It returns the real provisioning exit code so installer logs can
distinguish "app installed" from "runtime prepared"; package hooks decide
separately whether a restart-required continuation is acceptable.

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

function Resolve-SystemExecutable([string]$RelativePath, [string]$CommandName) {
    $roots = @()
    if ($env:WINDIR -and $env:WINDIR.Trim()) {
        $roots += $env:WINDIR.Trim()
    }
    if ($env:SystemRoot -and $env:SystemRoot.Trim() -and $roots -notcontains $env:SystemRoot.Trim()) {
        $roots += $env:SystemRoot.Trim()
    }

    foreach ($root in $roots) {
        $candidates = @(
            (Join-Path $root (Join-Path "Sysnative" $RelativePath)),
            (Join-Path $root (Join-Path "System32" $RelativePath))
        )
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return $candidate
            }
        }
    }

    $command = Get-Command $CommandName -ErrorAction SilentlyContinue
    if ($command -and $command.Source) {
        return $command.Source
    }

    return $null
}

function Resolve-WslExecutable {
    return Resolve-SystemExecutable "wsl.exe" "wsl.exe"
}

function Resolve-PowerShellExecutable {
    return Resolve-SystemExecutable "WindowsPowerShell\v1.0\powershell.exe" "powershell.exe"
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
    Write-InstallerLog "Provisioning wrapper finished with provisioner exit code $ProvisionExitCode."
    try {
        Stop-Transcript | Out-Null
    } catch {}
    exit $ProvisionExitCode
}

try {
    Write-InstallerLog "Veslo WSL2 sandbox installer wrapper started."
    $identityName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    Write-InstallerLog "Identity: $identityName"
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

    if ($identityName -match "\\SYSTEM$") {
        Write-InstallerLog "Cannot provision Veslo WSL runtime under SYSTEM. WSL distros are per-user; run installer or repair under the target Windows user."
        Finish-Installer 5
    }

    $wslCommand = Resolve-WslExecutable
    if (-not $wslCommand) {
        Write-InstallerLog "wsl.exe was not found. Install WSL first, then run Veslo repair/onboarding."
        Finish-Installer 127
    }
    Write-InstallerLog "Resolved wsl.exe: $wslCommand"

    $wslStatus = Invoke-HiddenNativeCommand $wslCommand @("--status")
    if ($wslStatus.ExitCode -ne 0) {
        Write-InstallerLog "WSL is installed incompletely or needs a reboot. Not running distro import from MSI."
        Finish-Installer $wslStatus.ExitCode
    }

    $powershellCommand = Resolve-PowerShellExecutable
    if (-not $powershellCommand) {
        Write-InstallerLog "powershell.exe was not found. Not running distro import from MSI."
        Finish-Installer 127
    }
    Write-InstallerLog "Resolved powershell.exe: $powershellCommand"

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
    $checkResult = Invoke-HiddenNativeCommand $powershellCommand @($baseArgs + @("-CheckOnly"))
    if ($checkResult.ExitCode -eq 0) {
        Write-InstallerLog "Managed WSL runtime already satisfies Veslo requirements."
        Finish-Installer 0
    }

    Write-InstallerLog "Managed WSL runtime is missing or incomplete; provisioning now."
    $provisionResult = Invoke-HiddenNativeCommand $powershellCommand $baseArgs
    Finish-Installer $provisionResult.ExitCode
} catch {
    Write-InstallerLog "Unhandled wrapper error: $($_.Exception.Message)"
    Finish-Installer 1
}
