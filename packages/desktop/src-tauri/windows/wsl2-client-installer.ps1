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
    [switch]$MachineSetupOnly,
    [switch]$StartupContinuation
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$env:WSL_UTF8 = "1"
$NativeCommandTimeoutExitCode = 1460
$ClientInstallerScriptRevision = "startup-continuation-20260624"
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

function Resolve-ActiveSetupVersion {
    $scriptDir = Split-Path -Parent $ClientInstallerScriptPath
    $packageJson = Join-Path $scriptDir "package.json"
    if (Test-Path -LiteralPath $packageJson -PathType Leaf) {
        try {
            $pkg = Get-Content -LiteralPath $packageJson -Raw -ErrorAction Stop | ConvertFrom-Json
            $version = ([string]$pkg.version).Trim()
            if ($version -match "^(\d+)\.(\d+)\.(\d+)$") {
                return "$($Matches[1]),$($Matches[2]),$($Matches[3]),0"
            }
        } catch {
            Write-ClientInstallerLog "Failed to read package version for Active Setup: $($_.Exception.Message)"
        }
    }
    return "2026,6,24,0"
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

function New-ClientInstallerCommand([string[]]$ExtraArguments = @()) {
    $powershellCommand = Resolve-PowerShellExecutable
    if (-not $powershellCommand) {
        return $null
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
    if ($ExtraArguments -and $ExtraArguments.Count -gt 0) {
        $arguments += $ExtraArguments
    }

    return '"{0}" {1}' -f $powershellCommand, (($arguments | ForEach-Object { ConvertTo-NativeArgument ([string]$_) }) -join " ")
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
    Write-ClientInstallerLog "Native command finished with exit code $exitCode."

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

function Wait-WslUsable([int]$TimeoutSeconds = 300) {
    $deadline = (Get-Date).AddSeconds([Math]::Max(1, $TimeoutSeconds))
    $lastState = $null
    do {
        $lastState = Test-WslUsable
        Write-ClientInstallerLog $lastState.Reason
        if ($lastState.Ok) {
            return $lastState
        }
        if ((Get-Date) -lt $deadline) {
            Write-ClientInstallerLog "WSL is not usable yet; waiting 10 seconds before retrying startup continuation."
            Start-Sleep -Seconds 10
        }
    } while ((Get-Date) -lt $deadline)

    return $lastState
}

function Register-ClientInstallerRunOnce {
    $command = New-ClientInstallerCommand
    if (-not $command) {
        Write-ClientInstallerLog "Skipping RunOnce registration because powershell.exe was not found."
        return
    }

    $runOncePath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    New-Item -Path $runOncePath -Force | Out-Null
    New-ItemProperty -Path $runOncePath -Name "VesloWslRuntimeSetup" -Value $command -PropertyType String -Force | Out-Null
    Write-ClientInstallerLog "Registered RunOnce continuation for Veslo WSL runtime setup."
}

function Register-CurrentUserStartupRetry {
    $command = New-ClientInstallerCommand @("-StartupContinuation", "-SkipPrerequisiteInstall")
    if (-not $command) {
        Write-ClientInstallerLog "Skipping startup retry registration because powershell.exe was not found."
        return
    }

    $runOncePath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    New-Item -Path $runOncePath -Force | Out-Null
    New-ItemProperty -Path $runOncePath -Name "VesloWslRuntimeSetup" -Value $command -PropertyType String -Force | Out-Null
    Write-ClientInstallerLog "Registered current-user startup retry for Veslo WSL runtime setup."
}

function Register-MachineStartupContinuation {
    $command = New-ClientInstallerCommand @("-StartupContinuation", "-SkipPrerequisiteInstall")
    if (-not $command) {
        Write-ClientInstallerLog "Skipping machine startup continuation because powershell.exe was not found."
        return
    }

    $activeSetupPath = "HKLM:\Software\Microsoft\Active Setup\Installed Components\Neatech.Veslo.WslRuntimeSetup"
    try {
        New-Item -Path $activeSetupPath -Force | Out-Null
        New-ItemProperty -Path $activeSetupPath -Name "StubPath" -Value $command -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $activeSetupPath -Name "Version" -Value (Resolve-ActiveSetupVersion) -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $activeSetupPath -Name "IsInstalled" -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $activeSetupPath -Name "ComponentID" -Value "Veslo WSL runtime setup" -PropertyType String -Force | Out-Null
        Write-ClientInstallerLog "Registered machine Active Setup startup continuation for Veslo WSL runtime setup."
    } catch {
        Write-ClientInstallerLog "Failed to register machine startup continuation: $($_.Exception.Message)"
    }
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
    try {
        $statusResult = if ($RuntimeExitCode -eq 0) { "ready" } elseif ($restartContinuation) { "restart_required" } else { "failed" }
        $statusPath = Join-Path $logRoot "wsl2-runtime-setup-status.txt"
        Set-Content -LiteralPath $statusPath -Encoding UTF8 -Force -Value @(
            "result=$statusResult",
            "runtime_exit_code=$RuntimeExitCode",
            "process_exit_code=$installerExitCode",
            "machine_setup_only=$([bool]$MachineSetupOnly)",
            "identity=$([Security.Principal.WindowsIdentity]::GetCurrent().Name)",
            "timestamp=$((Get-Date).ToString('o'))",
            "log=$logPath"
        )
        Write-ClientInstallerLog "Wrote runtime setup status: $statusPath (result=$statusResult)"
    } catch {
        Write-ClientInstallerLog "Failed to write runtime setup status: $($_.Exception.Message)"
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
    # WSL cannot run as LocalSystem (WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED), so the
    # machine phase never calls wsl.exe. It runs the silent prerequisite install
    # (Windows features + WSL app package via DISM/AppX - both LocalSystem-safe
    # and not nested Windows Installer transactions) and propagates its result.
    # The per-user Veslo app imports the VesloSandbox distro after the restart.
    if (-not (Test-Path -LiteralPath $PrerequisiteScript -PathType Leaf)) {
        Write-ClientInstallerLog "Prerequisite installer helper is missing: $PrerequisiteScript"
        Finish-ClientInstaller 2
    }
    if ($SkipPrerequisiteInstall) {
        Write-ClientInstallerLog "Skip prerequisite install requested; nothing to do in machine setup."
        Finish-ClientInstaller 0
    }

    Register-MachineStartupContinuation
    Write-ClientInstallerLog "Running the silent WSL machine prerequisite install (no wsl.exe, LocalSystem-safe)."
    $prereqInstall = Invoke-LocalPowerShellScript -ScriptPath $PrerequisiteScript -ScriptArguments @("-Install") -TimeoutSeconds 3600
    Write-ClientInstallerLog "WSL prerequisite install finished with exit code $($prereqInstall.ExitCode)."
    Write-RecentPrerequisiteLogTail
    Finish-ClientInstaller $prereqInstall.ExitCode
}

function Invoke-StartupContinuation([string]$SandboxInstallerScript) {
    if (-not (Test-Path -LiteralPath $SandboxInstallerScript -PathType Leaf)) {
        Write-ClientInstallerLog "Sandbox installer wrapper is missing: $SandboxInstallerScript"
        Register-CurrentUserStartupRetry
        Finish-ClientInstaller 2
    }

    $wslState = Wait-WslUsable -TimeoutSeconds 300
    if (-not $wslState -or -not $wslState.Ok) {
        Write-ClientInstallerLog "WSL is still not usable from startup continuation; retrying on the next user logon and leaving app repair available."
        Register-CurrentUserStartupRetry
        $exitCode = 1
        if ($wslState) {
            $exitCode = [int]$wslState.ExitCode
        }
        Finish-ClientInstaller $exitCode
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

    Write-ClientInstallerLog "Startup continuation is provisioning the managed VesloSandbox runtime without elevation."
    $sandboxResult = Invoke-LocalPowerShellScript -ScriptPath $SandboxInstallerScript -ScriptArguments $sandboxArgs -TimeoutSeconds 3600
    if ($sandboxResult.ExitCode -ne 0) {
        Write-ClientInstallerLog "Startup continuation did not finish VesloSandbox provisioning; retrying on the next user logon and leaving app repair available."
        Register-CurrentUserStartupRetry
    }
    Finish-ClientInstaller $sandboxResult.ExitCode
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
    Write-ClientInstallerLog "Startup continuation: $([bool]$StartupContinuation)"
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

    if ($StartupContinuation) {
        if ($identityName -match "\\SYSTEM$") {
            Write-ClientInstallerLog "Startup continuation must run under the target Windows user, not LocalSystem."
            Finish-ClientInstaller 5
        }
        Invoke-StartupContinuation -SandboxInstallerScript $sandboxInstallerScript
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
