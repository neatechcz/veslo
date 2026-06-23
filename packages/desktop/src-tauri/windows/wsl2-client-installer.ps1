<#
.SYNOPSIS
Client installer entrypoint for Veslo's Windows WSL2 runtime setup.

.DESCRIPTION
This helper is invoked by Windows installers after application files are
installed. It owns the full client-side path: check WSL prerequisites, launch the
elevated prerequisite helper when Windows features are missing, register a
RunOnce continuation when a restart is required, and then run the managed
VesloSandbox provisioning wrapper.

The script returns the real runtime setup exit code so installer logs can
distinguish "app installed" from "runtime prepared". Package manager hooks may
allow restart-required continuations, but real WSL/VesloSandbox setup failures
should stay non-zero so installers and repair surfaces can stop silent broken
installs.
#>
[CmdletBinding()]
param(
    [string]$DistroName = "VesloSandbox",
    [string]$InstallDir = "",
    [string]$OpencodeVersion = "",
    [string]$OpencodeGithubRepo = "anomalyco/opencode",
    [switch]$SkipPrerequisiteInstall,
    [switch]$AllowRestartContinuationSuccess
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$env:WSL_UTF8 = "1"

function Write-ClientInstallerLog([string]$Message) {
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

function Invoke-HiddenNativeCommand([string]$FilePath, [string[]]$Arguments) {
    Write-ClientInstallerLog ("> {0} {1}" -f $FilePath, ($Arguments -join " "))

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
            Write-ClientInstallerLog $line
        }
    }

    return [pscustomobject]@{
        ExitCode = [int]$exitCode
        Output = ($outputLines -join "`n")
    }
}

function Invoke-LocalPowerShellScript([string]$ScriptPath, [string[]]$ScriptArguments) {
    $powershellCommand = Resolve-PowerShellExecutable
    if (-not $powershellCommand) {
        Write-ClientInstallerLog "powershell.exe was not found."
        return [pscustomobject]@{
            ExitCode = 127
            Output = "powershell.exe was not found."
        }
    }

    $arguments = @(
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $ScriptPath
    ) + $ScriptArguments
    return Invoke-HiddenNativeCommand $powershellCommand $arguments
}

function Invoke-ElevatedPowerShellScript([string]$ScriptPath, [string[]]$ScriptArguments) {
    $powershellCommand = Resolve-PowerShellExecutable
    if (-not $powershellCommand) {
        Write-ClientInstallerLog "powershell.exe was not found; cannot launch elevated prerequisite installer."
        return [pscustomobject]@{
            ExitCode = 127
            Output = "powershell.exe was not found."
        }
    }

    $arguments = @(
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $ScriptPath
    ) + $ScriptArguments
    $argumentList = (($arguments | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join " ")
    Write-ClientInstallerLog ("> elevated {0} {1}" -f $powershellCommand, $argumentList)

    try {
        $process = Start-Process `
            -FilePath $powershellCommand `
            -ArgumentList $argumentList `
            -Verb RunAs `
            -WindowStyle Hidden `
            -Wait `
            -PassThru `
            -ErrorAction Stop
        return [pscustomobject]@{
            ExitCode = [int]$process.ExitCode
            Output = ""
        }
    } catch {
        Write-ClientInstallerLog "Elevated prerequisite installer did not complete: $($_.Exception.Message)"
        return [pscustomobject]@{
            ExitCode = 1223
            Output = $_.Exception.Message
        }
    }
}

function Test-WslUsable {
    $wslCommand = Resolve-WslExecutable
    if (-not $wslCommand) {
        return [pscustomobject]@{
            Ok = $false
            Reason = "wsl.exe is not available."
            ExitCode = 127
        }
    }

    Write-ClientInstallerLog "Resolved wsl.exe: $wslCommand"
    $status = Invoke-HiddenNativeCommand $wslCommand @("--status")
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

function Register-ClientInstallerRunOnce {
    $powershellCommand = Resolve-PowerShellExecutable
    if (-not $powershellCommand) {
        Write-ClientInstallerLog "Skipping RunOnce registration because powershell.exe was not found."
        return
    }

    $arguments = @(
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        $MyInvocation.MyCommand.Path,
        "-DistroName",
        $DistroName,
        "-OpencodeGithubRepo",
        $OpencodeGithubRepo
    )
    if ($InstallDir.Trim()) {
        $arguments += @("-InstallDir", $InstallDir)
    }
    if ($OpencodeVersion.Trim()) {
        $arguments += @("-OpencodeVersion", $OpencodeVersion)
    }

    $command = '"{0}" {1}' -f $powershellCommand, (($arguments | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join " ")
    $runOncePath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    New-Item -Path $runOncePath -Force | Out-Null
    New-ItemProperty -Path $runOncePath -Name "VesloWslRuntimeSetup" -Value $command -PropertyType String -Force | Out-Null
    Write-ClientInstallerLog "Registered RunOnce continuation for Veslo WSL runtime setup."
}

$logRoot = Join-Path (Resolve-LocalAppData) "Veslo\logs"
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
$logPath = Join-Path $logRoot "wsl2-client-installer.log"

try {
    Start-Transcript -Path $logPath -Append -Force | Out-Null
} catch {
    Write-Host "Failed to start transcript at ${logPath}: $($_.Exception.Message)"
}

function Finish-ClientInstaller([int]$RuntimeExitCode) {
    $installerExitCode = $RuntimeExitCode
    $restartContinuation = $RuntimeExitCode -eq 3010 -or $RuntimeExitCode -eq 1641
    if ($AllowRestartContinuationSuccess -and $restartContinuation) {
        $installerExitCode = 0
        Write-ClientInstallerLog "Windows restart is required; RunOnce continuation is registered, so this package-manager invocation will exit 0."
    }

    if ($RuntimeExitCode -eq 0) {
        Write-ClientInstallerLog "VESLO_RUNTIME_SETUP_RESULT=ready"
    } elseif ($restartContinuation) {
        Write-ClientInstallerLog "VESLO_RUNTIME_SETUP_RESULT=restart_required"
    } else {
        Write-ClientInstallerLog "VESLO_RUNTIME_SETUP_RESULT=failed"
    }
    Write-ClientInstallerLog "Client runtime installer finished with runtime exit code $RuntimeExitCode and process exit code $installerExitCode. Log: $logPath"
    try {
        Stop-Transcript | Out-Null
    } catch {}
    exit $installerExitCode
}

try {
    Write-ClientInstallerLog "Veslo client runtime installer started."
    $identityName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    Write-ClientInstallerLog "Identity: $identityName"
    if ($identityName -match "\\SYSTEM$") {
        Write-ClientInstallerLog "Cannot prepare Veslo WSL runtime under SYSTEM. WSL distros and RunOnce continuations are per-user; run installer or repair under the target Windows user."
        Finish-ClientInstaller 5
    }
    Write-ClientInstallerLog "Distro: $DistroName"
    Write-ClientInstallerLog "Skip prerequisite install: $([bool]$SkipPrerequisiteInstall)"

    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $prerequisiteScript = Join-Path $scriptDir "wsl2-prerequisite-installer.ps1"
    $sandboxInstallerScript = Join-Path $scriptDir "wsl2-sandbox-installer.ps1"

    if (-not (Test-Path -LiteralPath $sandboxInstallerScript -PathType Leaf)) {
        Write-ClientInstallerLog "Sandbox installer wrapper is missing: $sandboxInstallerScript"
        Finish-ClientInstaller 2
    }

    $wslState = Test-WslUsable
    Write-ClientInstallerLog $wslState.Reason

    if (-not $wslState.Ok -and -not $SkipPrerequisiteInstall) {
        if (-not (Test-Path -LiteralPath $prerequisiteScript -PathType Leaf)) {
            Write-ClientInstallerLog "Prerequisite installer helper is missing: $prerequisiteScript"
        } else {
            Write-ClientInstallerLog "Checking WSL prerequisite helper state."
            $prereqCheck = Invoke-LocalPowerShellScript $prerequisiteScript @("-CheckOnly")
            if ($prereqCheck.ExitCode -eq 0) {
                Write-ClientInstallerLog "Prerequisite helper reports WSL is usable."
            } else {
                Write-ClientInstallerLog "Launching elevated WSL prerequisite install from the installer flow."
                $prereqInstall = Invoke-ElevatedPowerShellScript $prerequisiteScript @("-Install")
                Write-ClientInstallerLog "Elevated WSL prerequisite install finished with exit code $($prereqInstall.ExitCode)."
                if ($prereqInstall.ExitCode -eq 3010 -or $prereqInstall.ExitCode -eq 1641) {
                    Register-ClientInstallerRunOnce
                    Finish-ClientInstaller $prereqInstall.ExitCode
                }
            }
        }

        $wslState = Test-WslUsable
        Write-ClientInstallerLog $wslState.Reason
    }

    if (-not $wslState.Ok) {
        if ($wslState.ExitCode -eq 3010 -or $wslState.ExitCode -eq 1641) {
            Register-ClientInstallerRunOnce
        }
        Write-ClientInstallerLog "WSL is still not usable. Veslo onboarding/Settings repair will retry without requiring manual PowerShell."
        Finish-ClientInstaller $wslState.ExitCode
    }

    $sandboxArgs = @(
        "-DistroName",
        $DistroName,
        "-OpencodeGithubRepo",
        $OpencodeGithubRepo
    )
    if ($InstallDir.Trim()) {
        $sandboxArgs += @("-InstallDir", $InstallDir)
    }
    if ($OpencodeVersion.Trim()) {
        $sandboxArgs += @("-OpencodeVersion", $OpencodeVersion)
    }

    Write-ClientInstallerLog "Running managed VesloSandbox provisioning wrapper."
    $sandboxResult = Invoke-LocalPowerShellScript $sandboxInstallerScript $sandboxArgs
    Finish-ClientInstaller $sandboxResult.ExitCode
} catch {
    Write-ClientInstallerLog "Unhandled client installer error: $($_.Exception.Message)"
    Finish-ClientInstaller 1
}
