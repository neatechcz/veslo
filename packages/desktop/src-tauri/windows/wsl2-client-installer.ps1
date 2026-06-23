<#
.SYNOPSIS
Client installer entrypoint for Veslo's Windows WSL2 runtime setup.

.DESCRIPTION
This helper is invoked by Windows installers after application files are
installed. It runs in one of two modes:

* -MachineSetupOnly (used by the MSI from an elevated, non-impersonated
  LocalSystem deferred custom action): it owns only the machine-wide part of
  setup and never prompts the user. Because it already runs elevated it enables
  the Windows WSL features AND stages the WSL app package in-process (no UAC /
  RunAs), so a single Windows restart is enough to make WSL usable. It does NOT
  import the per-user VesloSandbox distro; the Veslo app does that on first run
  via the windowless `wsl_sandbox_repair` command.

* default per-user mode (used by the NSIS per-user installer hook and as a
  fallback): WSL features are machine-wide and need elevation, so when WSL is
  missing it launches the prerequisite helper elevated once, registers a RunOnce
  continuation when Windows must restart, and then provisions the per-user
  VesloSandbox distro.

The script logs the real runtime setup exit code so installer logs can
distinguish "app installed" from "runtime prepared". Package manager hooks may
allow restart-required continuations or defer failed runtime setup to first-run
repair when the package format cannot show a useful custom error.
#>
[CmdletBinding()]
param(
    [string]$DistroName = "VesloSandbox",
    [string]$InstallDir = "",
    [string]$OpencodeVersion = "",
    [string]$OpencodeGithubRepo = "anomalyco/opencode",
    [switch]$SkipPrerequisiteInstall,
    [switch]$AllowRestartContinuationSuccess,
    [switch]$AllowDeferredRuntimeRepairSuccess,
    [switch]$MachineSetupOnly
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$env:WSL_UTF8 = "1"
$NativeCommandTimeoutExitCode = 1460
$ClientInstallerScriptRevision = "system-machine-setup-singlereboot-20260620"
$ClientInstallerScriptPath = if ($PSCommandPath -and $PSCommandPath.Trim()) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }

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

function Resolve-CommonAppData {
    $path = [Environment]::GetFolderPath("CommonApplicationData")
    if ($path -and $path.Trim()) {
        return $path
    }
    if ($env:ProgramData -and $env:ProgramData.Trim()) {
        return $env:ProgramData
    }
    return [System.IO.Path]::GetTempPath()
}

function Resolve-RuntimeDataRoot {
    # Machine setup runs as LocalSystem, so its log and restart marker live in
    # ProgramData where the per-user Veslo app can also read them. The per-user
    # flow keeps using LocalAppData (matching the NSIS hook log messages).
    if ($MachineSetupOnly) {
        return Resolve-CommonAppData
    }
    return Resolve-LocalAppData
}

function Resolve-RestartRequiredMarkerPath {
    return (Join-Path (Join-Path (Resolve-RuntimeDataRoot) "Veslo") "runtime-setup-restart-required.marker")
}

function Write-RestartRequiredMarker {
    $markerPath = Resolve-RestartRequiredMarkerPath
    try {
        $markerDir = Split-Path -Parent $markerPath
        New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
        $content = @(
            "VESLO_RUNTIME_SETUP_RESULT=restart_required",
            "Timestamp=$((Get-Date).ToString("o"))",
            "Log=$logPath"
        )
        Set-Content -LiteralPath $markerPath -Value $content -Encoding UTF8 -Force
        Write-ClientInstallerLog "Wrote restart-required marker: $markerPath"
    } catch {
        Write-ClientInstallerLog "Failed to write restart-required marker: $($_.Exception.Message)"
    }
}

function Clear-RestartRequiredMarker {
    $markerPath = Resolve-RestartRequiredMarkerPath
    try {
        if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
            Remove-Item -LiteralPath $markerPath -Force
            Write-ClientInstallerLog "Cleared restart-required marker: $markerPath"
        }
    } catch {
        Write-ClientInstallerLog "Failed to clear restart-required marker: $($_.Exception.Message)"
    }
}

function Write-RecentPrerequisiteLogTail {
    $prereqLogPath = Join-Path (Join-Path (Resolve-CommonAppData) "Veslo\logs") "wsl2-prerequisite-installer.log"
    if (-not (Test-Path -LiteralPath $prereqLogPath -PathType Leaf)) {
        Write-ClientInstallerLog "WSL prerequisite helper log not found at $prereqLogPath."
        return
    }

    Write-ClientInstallerLog "Latest WSL prerequisite helper transcript from ${prereqLogPath}:"
    try {
        Start-Sleep -Milliseconds 500
        $lines = @(Get-Content -LiteralPath $prereqLogPath -ErrorAction Stop)
        if ($lines.Count -eq 0) {
            return
        }

        $startIndex = [Math]::Max(0, $lines.Count - 260)
        for ($i = $lines.Count - 1; $i -ge 0; $i--) {
            if ($lines[$i] -match "Windows PowerShell transcript start") {
                $startIndex = $i
                break
            }
        }

        for ($i = $startIndex; $i -lt $lines.Count; $i++) {
            $line = [string]$lines[$i]
            if ($line) {
                Write-ClientInstallerLog "prereq> $line"
            }
        }
    } catch {
        Write-ClientInstallerLog "Failed to read WSL prerequisite helper log tail: $($_.Exception.Message)"
    }
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

function Stop-HiddenNativeProcessTree([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) {
        return
    }
    try {
        if ($Process.HasExited) {
            return
        }
    } catch {
        return
    }

    $taskkillCommand = Resolve-SystemExecutable "taskkill.exe" "taskkill.exe"
    if ($taskkillCommand) {
        try {
            $killInfo = New-Object System.Diagnostics.ProcessStartInfo
            $killInfo.FileName = $taskkillCommand
            $killInfo.Arguments = "/PID $($Process.Id) /T /F"
            $killInfo.UseShellExecute = $false
            $killInfo.CreateNoWindow = $true
            $killProcess = New-Object System.Diagnostics.Process
            $killProcess.StartInfo = $killInfo
            try {
                [void]$killProcess.Start()
                [void]$killProcess.WaitForExit(10000)
            } finally {
                $killProcess.Dispose()
            }
        } catch {}
    }

    try {
        if (-not $Process.HasExited) {
            $Process.Kill()
        }
    } catch {}
    try {
        [void]$Process.WaitForExit(10000)
    } catch {}
}

function Invoke-IsolatedNativeCommand([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 600) {
    Write-ClientInstallerLog ("> isolated {0} {1}" -f $FilePath, ($Arguments -join " "))
    $argumentsJson = ConvertTo-Json @($Arguments) -Compress
    $job = $null
    try {
        $job = Start-Job -ScriptBlock {
            param([string]$InnerFilePath, [string]$InnerArgumentsJson)
            $ErrorActionPreference = "Continue"
            $ProgressPreference = "SilentlyContinue"
            $env:WSL_UTF8 = "1"
            $innerArguments = @()
            if ($InnerArgumentsJson) {
                $parsedArguments = ConvertFrom-Json $InnerArgumentsJson
                if ($null -ne $parsedArguments) {
                    $innerArguments = @($parsedArguments | ForEach-Object { [string]$_ })
                }
            }

            $outputLines = @()
            $exitCode = 0
            try {
                $commandOutput = & $InnerFilePath @innerArguments 2>&1
                foreach ($line in @($commandOutput)) {
                    if ($null -ne $line) {
                        $outputLines += [string]$line
                    }
                }
                if ($null -ne $global:LASTEXITCODE) {
                    $exitCode = [int]$global:LASTEXITCODE
                }
            } catch {
                $outputLines += $_.Exception.Message
                $exitCode = 1
            }

            [pscustomobject]@{
                ExitCode = [int]$exitCode
                Output = ($outputLines -join "`n")
            }
        } -ArgumentList $FilePath, $argumentsJson
    } catch {
        Write-ClientInstallerLog "Failed to start isolated native command job: $($_.Exception.Message)"
        return [pscustomobject]@{
            ExitCode = 1
            Output = $_.Exception.Message
        }
    }

    try {
        Write-ClientInstallerLog "Waiting up to $TimeoutSeconds seconds for isolated native command job $($job.Id)."
        $completedJob = Wait-Job -Job $job -Timeout $TimeoutSeconds
        if (-not $completedJob) {
            Write-ClientInstallerLog "Native command timed out after $TimeoutSeconds seconds in isolated job $($job.Id); stopping job."
            try {
                Stop-Job -Job $job -Force -ErrorAction SilentlyContinue
            } catch {
                try {
                    Stop-Job -Job $job -ErrorAction SilentlyContinue
                } catch {}
            }
            return [pscustomobject]@{
                ExitCode = [int]$NativeCommandTimeoutExitCode
                Output = "Timed out after $TimeoutSeconds seconds."
            }
        }

        $jobOutput = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
        $result = $jobOutput | Where-Object { $_ -and $_.PSObject.Properties["ExitCode"] } | Select-Object -Last 1
        if (-not $result) {
            $textOutput = ($jobOutput | ForEach-Object { [string]$_ }) -join "`n"
            return [pscustomobject]@{
                ExitCode = 1
                Output = $textOutput
            }
        }

        $outputLines = @(([string]$result.Output) -split "`r?`n" | Where-Object { $_ })
        foreach ($line in $outputLines) {
            Write-ClientInstallerLog $line
        }
        return [pscustomobject]@{
            ExitCode = [int]$result.ExitCode
            Output = ($outputLines -join "`n")
        }
    } finally {
        if ($job) {
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-HiddenNativeCommand([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 600) {
    if ((Split-Path -Leaf $FilePath) -ieq "wsl.exe") {
        return Invoke-IsolatedNativeCommand -FilePath $FilePath -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds
    }

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
    $exitCode = $NativeCommandTimeoutExitCode
    try {
        [void]$process.Start()
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()
        $timeoutMilliseconds = [Math]::Max(1, $TimeoutSeconds) * 1000
        if ($process.WaitForExit($timeoutMilliseconds)) {
            $process.WaitForExit()
            $exitCode = $process.ExitCode
        } else {
            Write-ClientInstallerLog "Native command timed out after $TimeoutSeconds seconds; terminating process tree for PID $($process.Id)."
            [void]$lines.Add("Timed out after $TimeoutSeconds seconds.")
            Stop-HiddenNativeProcessTree $process
        }
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

function Invoke-LocalPowerShellScript([string]$ScriptPath, [string[]]$ScriptArguments, [int]$TimeoutSeconds = 3600) {
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
    return Invoke-HiddenNativeCommand -FilePath $powershellCommand -Arguments $arguments -TimeoutSeconds $TimeoutSeconds
}

function Invoke-ElevatedPowerShellScript([string]$ScriptPath, [string[]]$ScriptArguments, [int]$TimeoutSeconds = 3600) {
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
            -PassThru `
            -ErrorAction Stop
        $timeoutMilliseconds = [Math]::Max(1, $TimeoutSeconds) * 1000
        if (-not $process.WaitForExit($timeoutMilliseconds)) {
            Write-ClientInstallerLog "Elevated prerequisite installer timed out after $TimeoutSeconds seconds; terminating process tree for PID $($process.Id)."
            Stop-HiddenNativeProcessTree $process
            return [pscustomobject]@{
                ExitCode = $NativeCommandTimeoutExitCode
                Output = "Timed out after $TimeoutSeconds seconds."
            }
        }
        $exitCode = 1
        if ($null -eq $process.ExitCode) {
            Write-ClientInstallerLog "Elevated prerequisite installer exited without an ExitCode; treating it as failure."
        } else {
            $exitCode = [int]$process.ExitCode
        }
        return [pscustomobject]@{
            ExitCode = $exitCode
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
    $status = Invoke-HiddenNativeCommand -FilePath $wslCommand -Arguments @("--status") -TimeoutSeconds 45
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
        $ClientInstallerScriptPath,
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

$logRoot = Join-Path (Resolve-RuntimeDataRoot) "Veslo\logs"
try {
    New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
} catch {
    $logRoot = Join-Path (Resolve-LocalAppData) "Veslo\logs"
    New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
}
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
        Write-ClientInstallerLog "Windows restart is required to finish WSL setup; this package-manager invocation will exit 0 and Veslo will continue after the restart."
    }

    if ($RuntimeExitCode -eq 0) {
        Clear-RestartRequiredMarker
        Write-ClientInstallerLog "VESLO_RUNTIME_SETUP_RESULT=ready"
    } elseif ($restartContinuation) {
        Write-RestartRequiredMarker
        Write-ClientInstallerLog "VESLO_RUNTIME_SETUP_RESULT=restart_required"
    } else {
        Clear-RestartRequiredMarker
        Write-ClientInstallerLog "VESLO_RUNTIME_SETUP_RESULT=failed"
    }

    if ($installerExitCode -ne 0 -and -not $restartContinuation -and $AllowDeferredRuntimeRepairSuccess) {
        Write-ClientInstallerLog "Runtime setup did not finish during package installation; first-run onboarding/Settings repair will retry with user-visible guidance, so this package-manager invocation will exit 0."
        $installerExitCode = 0
    }
    Write-ClientInstallerLog "Client runtime installer finished with runtime exit code $RuntimeExitCode and process exit code $installerExitCode. Log: $logPath"
    try {
        Stop-Transcript | Out-Null
    } catch {}
    exit $installerExitCode
}

# Machine-wide WSL setup that runs elevated (LocalSystem) from the MSI. It never
# prompts and never imports the per-user distro: it just enables the Windows WSL
# features and stages the WSL app package so a single restart makes WSL usable.
function Invoke-MachineWslSetup([string]$PrerequisiteScript) {
    $wslState = Test-WslUsable
    Write-ClientInstallerLog $wslState.Reason
    if ($wslState.Ok) {
        Write-ClientInstallerLog "WSL is already usable; no machine setup needed. The Veslo app will import the VesloSandbox distro per-user."
        Finish-ClientInstaller 0
    }

    if (-not $SkipPrerequisiteInstall) {
        if (-not (Test-Path -LiteralPath $PrerequisiteScript -PathType Leaf)) {
            Write-ClientInstallerLog "Prerequisite installer helper is missing: $PrerequisiteScript"
        } else {
            Write-ClientInstallerLog "WSL is not usable; running the WSL prerequisite install in-process (already elevated, no UAC prompt)."
            $prereqInstall = Invoke-LocalPowerShellScript -ScriptPath $PrerequisiteScript -ScriptArguments @("-Install") -TimeoutSeconds 3600
            Write-ClientInstallerLog "WSL prerequisite install finished with exit code $($prereqInstall.ExitCode)."
            Write-RecentPrerequisiteLogTail
            if ($prereqInstall.ExitCode -eq 3010 -or $prereqInstall.ExitCode -eq 1641) {
                Finish-ClientInstaller $prereqInstall.ExitCode
            }
        }

        $wslState = Test-WslUsable
        Write-ClientInstallerLog $wslState.Reason
    }

    if ($wslState.Ok) {
        Write-ClientInstallerLog "WSL is now usable without a restart. The Veslo app will import the VesloSandbox distro per-user."
        Finish-ClientInstaller 0
    }

    if ($wslState.ExitCode -eq 3010 -or $wslState.ExitCode -eq 1641) {
        Finish-ClientInstaller $wslState.ExitCode
    }

    Write-ClientInstallerLog "WSL is not usable yet and Windows likely needs a restart. Marking restart required; Veslo onboarding/Settings repair will retry without requiring manual PowerShell."
    Finish-ClientInstaller 3010
}

# Per-user WSL setup used by the NSIS per-user installer hook and the app. WSL
# features are machine-wide, so this elevates the prerequisite helper once (UAC)
# when WSL is missing, registers a RunOnce continuation when Windows must
# restart, and then provisions the per-user VesloSandbox distro.
function Invoke-UserWslSetup([string]$PrerequisiteScript, [string]$SandboxInstallerScript) {
    if (-not (Test-Path -LiteralPath $SandboxInstallerScript -PathType Leaf)) {
        Write-ClientInstallerLog "Sandbox installer wrapper is missing: $SandboxInstallerScript"
        Finish-ClientInstaller 2
    }

    $wslState = Test-WslUsable
    Write-ClientInstallerLog $wslState.Reason

    if (-not $wslState.Ok -and -not $SkipPrerequisiteInstall) {
        if (-not (Test-Path -LiteralPath $PrerequisiteScript -PathType Leaf)) {
            Write-ClientInstallerLog "Prerequisite installer helper is missing: $PrerequisiteScript"
        } else {
            Write-ClientInstallerLog "WSL status already failed; skipping redundant prerequisite check and launching elevated WSL prerequisite install from the installer flow."
            $prereqInstall = Invoke-ElevatedPowerShellScript -ScriptPath $PrerequisiteScript -ScriptArguments @("-Install") -TimeoutSeconds 3600
            Write-ClientInstallerLog "Elevated WSL prerequisite install finished with exit code $($prereqInstall.ExitCode)."
            Write-RecentPrerequisiteLogTail
            if ($prereqInstall.ExitCode -eq 3010 -or $prereqInstall.ExitCode -eq 1641) {
                Register-ClientInstallerRunOnce
                Finish-ClientInstaller $prereqInstall.ExitCode
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
    $sandboxResult = Invoke-LocalPowerShellScript -ScriptPath $SandboxInstallerScript -ScriptArguments $sandboxArgs -TimeoutSeconds 3600
    Finish-ClientInstaller $sandboxResult.ExitCode
}

try {
    Write-ClientInstallerLog "Veslo client runtime installer started."
    Write-ClientInstallerLog "Script revision: $ClientInstallerScriptRevision"
    Write-ClientInstallerLog "Script path: $ClientInstallerScriptPath"
    Write-ClientInstallerLog "Machine setup only: $([bool]$MachineSetupOnly)"
    $identityName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    Write-ClientInstallerLog "Identity: $identityName"
    Write-ClientInstallerLog "Distro: $DistroName"
    Write-ClientInstallerLog "Skip prerequisite install: $([bool]$SkipPrerequisiteInstall)"

    $scriptDir = Split-Path -Parent $ClientInstallerScriptPath
    $prerequisiteScript = Join-Path $scriptDir "wsl2-prerequisite-installer.ps1"
    $sandboxInstallerScript = Join-Path $scriptDir "wsl2-sandbox-installer.ps1"

    if ($MachineSetupOnly) {
        Invoke-MachineWslSetup -PrerequisiteScript $prerequisiteScript
    }

    if ($identityName -match "\\SYSTEM$") {
        Write-ClientInstallerLog "Cannot prepare Veslo WSL runtime under SYSTEM without -MachineSetupOnly. WSL distros and RunOnce continuations are per-user; run installer or repair under the target Windows user."
        Finish-ClientInstaller 5
    }

    Invoke-UserWslSetup -PrerequisiteScript $prerequisiteScript -SandboxInstallerScript $sandboxInstallerScript
} catch {
    Write-ClientInstallerLog "Unhandled client installer error: $($_.Exception.Message)"
    Finish-ClientInstaller 1
}
