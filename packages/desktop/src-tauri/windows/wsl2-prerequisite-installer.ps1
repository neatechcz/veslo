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
$NativeCommandTimeoutExitCode = 1460
$PrerequisiteInstallerScriptRevision = "silent-features-kernel-msix-20260624"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

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

function Resolve-DismExecutable {
    return Resolve-SystemExecutable "dism.exe" "dism.exe"
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
    Write-PrereqLog ("> isolated {0} {1}" -f $FilePath, ($Arguments -join " "))
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
        Write-PrereqLog "Failed to start isolated native command job: $($_.Exception.Message)"
        return [pscustomobject]@{
            ExitCode = 1
            Output = $_.Exception.Message
        }
    }

    try {
        Write-PrereqLog "Waiting up to $TimeoutSeconds seconds for isolated native command job $($job.Id)."
        $completedJob = Wait-Job -Job $job -Timeout $TimeoutSeconds
        if (-not $completedJob) {
            Write-PrereqLog "Native command timed out after $TimeoutSeconds seconds in isolated job $($job.Id); stopping job."
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
            Write-PrereqLog $line
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

function Invoke-NativeCommand([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 600) {
    if ((Split-Path -Leaf $FilePath) -ieq "wsl.exe") {
        return Invoke-IsolatedNativeCommand -FilePath $FilePath -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds
    }

    Write-PrereqLog ("> {0} {1}" -f $FilePath, ($Arguments -join " "))

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
            Write-PrereqLog "Native command timed out after $TimeoutSeconds seconds; terminating process tree for PID $($process.Id)."
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
            Write-PrereqLog $line
        }
    }

    return [pscustomobject]@{
        ExitCode = [int]$exitCode
        Output = ($outputLines -join "`n")
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

    Write-PrereqLog "Resolved wsl.exe: $wslCommand"
    $status = Invoke-NativeCommand -FilePath $wslCommand -Arguments @("--status") -TimeoutSeconds 45
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
    Write-PrereqLog "Trying DISM feature enablement."
    $dismCommand = Resolve-DismExecutable
    if (-not $dismCommand) {
        Write-PrereqLog "dism.exe was not found; cannot enable WSL Windows features."
        return 127
    }

    Write-PrereqLog "Resolved dism.exe: $dismCommand"
    $restartRequired = $false
    $wslFeature = Invoke-NativeCommand -FilePath $dismCommand -Arguments @(
        "/online",
        "/enable-feature",
        "/featurename:Microsoft-Windows-Subsystem-Linux",
        "/all",
        "/norestart"
    ) -TimeoutSeconds 900
    if ($wslFeature.ExitCode -ne 0 -and $wslFeature.ExitCode -ne 3010) {
        Write-PrereqLog "DISM failed to enable Microsoft-Windows-Subsystem-Linux with exit code $($wslFeature.ExitCode)."
        return $wslFeature.ExitCode
    }
    if ($wslFeature.ExitCode -eq 3010) {
        $restartRequired = $true
    }

    $vmFeature = Invoke-NativeCommand -FilePath $dismCommand -Arguments @(
        "/online",
        "/enable-feature",
        "/featurename:VirtualMachinePlatform",
        "/all",
        "/norestart"
    ) -TimeoutSeconds 900
    if ($vmFeature.ExitCode -ne 0 -and $vmFeature.ExitCode -ne 3010) {
        Write-PrereqLog "DISM failed to enable VirtualMachinePlatform with exit code $($vmFeature.ExitCode)."
        return $vmFeature.ExitCode
    }
    if ($vmFeature.ExitCode -eq 3010) {
        $restartRequired = $true
    }

    if ($restartRequired) {
        return 3010
    }
    return 0
}

function Invoke-EnableWindowsOptionalFeature([string]$FeatureName) {
    Write-PrereqLog "Enabling Windows optional feature via PowerShell: $FeatureName"
    try {
        $result = Enable-WindowsOptionalFeature `
            -Online `
            -FeatureName $FeatureName `
            -All `
            -NoRestart `
            -ErrorAction Stop
        $restartNeeded = $false
        if ($result -and $result.PSObject.Properties["RestartNeeded"]) {
            $restartNeeded = [bool]$result.RestartNeeded
        }
        $state = ""
        if ($result -and $result.PSObject.Properties["State"]) {
            $state = [string]$result.State
        }
        Write-PrereqLog "Enable-WindowsOptionalFeature finished for $FeatureName. State: $state RestartNeeded: $restartNeeded"
        return [pscustomobject]@{
            ExitCode = 0
            RestartNeeded = $restartNeeded
        }
    } catch {
        Write-PrereqLog "Enable-WindowsOptionalFeature failed for ${FeatureName}: $($_.Exception.Message)"
        return [pscustomobject]@{
            ExitCode = 1
            RestartNeeded = $false
        }
    }
}

function Enable-WslFeaturesWithPowerShell {
    Write-PrereqLog "Trying PowerShell optional feature enablement."
    if (-not (Get-Command Enable-WindowsOptionalFeature -ErrorAction SilentlyContinue)) {
        Write-PrereqLog "Enable-WindowsOptionalFeature is not available in this PowerShell session."
        return 127
    }

    $restartRequired = $false
    $wslFeature = Invoke-EnableWindowsOptionalFeature "Microsoft-Windows-Subsystem-Linux"
    if ($wslFeature.ExitCode -ne 0) {
        return $wslFeature.ExitCode
    }
    if ($wslFeature.RestartNeeded) {
        $restartRequired = $true
    }

    $vmFeature = Invoke-EnableWindowsOptionalFeature "VirtualMachinePlatform"
    if ($vmFeature.ExitCode -ne 0) {
        return $vmFeature.ExitCode
    }
    if ($vmFeature.RestartNeeded) {
        $restartRequired = $true
    }

    if ($restartRequired) {
        return 3010
    }
    return 0
}

function Enable-WslFeaturesWithPowerShellThenDism {
    $powerShellExit = Enable-WslFeaturesWithPowerShell
    if ($powerShellExit -eq 0 -or $powerShellExit -eq 3010) {
        return $powerShellExit
    }

    Write-PrereqLog "PowerShell optional feature enablement failed with exit code $powerShellExit; falling back to DISM feature enablement."
    return Enable-WslFeaturesWithDism
}

function Install-WslAppPackage {
    # Stage the modern "Windows Subsystem for Linux" app package for all users so
    # a single Windows restart is enough to make WSL usable. On current Windows
    # builds the System32 wsl.exe is only a stub until the optional feature is
    # active (post-restart), so `wsl --install` / `wsl --update` cannot fetch the
    # WSL app before the restart. Provisioning the MSIX bundle here stages it now;
    # it activates together with the features on the next boot, which avoids the
    # second install pass (and second restart) the feature-only path needs.
    if (-not (Get-Command Add-AppxProvisionedPackage -ErrorAction SilentlyContinue)) {
        Write-PrereqLog "Add-AppxProvisionedPackage is unavailable; cannot stage the WSL app package (will rely on a post-restart pass instead)."
        return $false
    }

    try {
        $headers = @{ "User-Agent" = "Veslo-Installer"; "Accept" = "application/vnd.github+json" }
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/microsoft/WSL/releases/latest" -Headers $headers -TimeoutSec 120
        $asset = $release.assets |
            Where-Object { $_.name -match "\.msixbundle$" } |
            Select-Object -First 1
        if (-not $asset) {
            Write-PrereqLog "No .msixbundle asset found in the latest microsoft/WSL release; skipping WSL app staging."
            return $false
        }

        $downloadDir = Join-Path $env:TEMP "veslo-wsl-prereq"
        New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
        $bundlePath = Join-Path $downloadDir $asset.name
        Write-PrereqLog "Downloading WSL app package: $($asset.browser_download_url)"
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $bundlePath -UseBasicParsing -TimeoutSec 1800

        Write-PrereqLog "Provisioning WSL app package for all users: $bundlePath"
        Add-AppxProvisionedPackage -Online -PackagePath $bundlePath -SkipLicense -ErrorAction Stop | Out-Null
        Write-PrereqLog "WSL app package staged successfully; it will activate after the next Windows restart."
        return $true
    } catch {
        Write-PrereqLog "Failed to stage WSL app package: $($_.Exception.Message). WSL will be completed after the restart instead."
        return $false
    }
}

function Install-WslKernelMsi {
    # Install the WSL2 kernel update package quietly. This is the silent,
    # unattended equivalent of `wsl --update` and is exactly what the WSL
    # "install on server" docs use for headless setup. `msiexec /quiet` shows no
    # window and needs no extra elevation when we already run elevated, unlike
    # `wsl --install`/`wsl --update`, which spawn an interactive, self-elevating
    # console even from an elevated/LocalSystem context.
    try {
        $downloadDir = Join-Path $env:TEMP "veslo-wsl-prereq"
        New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
        $msiPath = Join-Path $downloadDir "wsl_update_x64.msi"
        $kernelUrl = "https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi"
        Write-PrereqLog "Downloading WSL2 kernel update package: $kernelUrl"
        Invoke-WebRequest -Uri $kernelUrl -OutFile $msiPath -UseBasicParsing -TimeoutSec 900

        $msiexec = Resolve-SystemExecutable "msiexec.exe" "msiexec.exe"
        if (-not $msiexec) {
            Write-PrereqLog "msiexec.exe was not found; cannot install the WSL2 kernel update."
            return $false
        }

        Write-PrereqLog "Installing WSL2 kernel update silently."
        $result = Invoke-NativeCommand -FilePath $msiexec -Arguments @("/i", $msiPath, "/quiet", "/norestart") -TimeoutSeconds 900
        if ($result.ExitCode -eq 0 -or $result.ExitCode -eq 3010) {
            Write-PrereqLog "WSL2 kernel update installed (exit code $($result.ExitCode))."
            return $true
        }
        Write-PrereqLog "WSL2 kernel update install returned exit code $($result.ExitCode)."
        return $false
    } catch {
        Write-PrereqLog "Failed to install WSL2 kernel update: $($_.Exception.Message)."
        return $false
    }
}

try {
    Write-PrereqLog "Veslo WSL prerequisite helper started."
    Write-PrereqLog "Script revision: $PrerequisiteInstallerScriptRevision"
    Write-PrereqLog "Script path: $($MyInvocation.MyCommand.Path)"
    Write-PrereqLog "Identity: $([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
    Write-PrereqLog "Mode: $(if ($Install) { "install" } else { "check" })"

    $current = Test-WslUsable
    Write-PrereqLog $current.Reason
    if ($current.Ok) {
        if ($Install) {
            $wslCommand = Resolve-WslExecutable
            if ($wslCommand) {
                $setDefault = Invoke-NativeCommand -FilePath $wslCommand -Arguments @("--set-default-version", "2") -TimeoutSeconds 120
                if ($setDefault.ExitCode -ne 0) {
                    Write-PrereqLog "Unable to set WSL 2 as default now; continuing because WSL itself is usable."
                }
            } else {
                Write-PrereqLog "Unable to resolve wsl.exe for default-version setup; continuing because WSL status already passed."
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

    # Fully silent machine setup. We deliberately do NOT call `wsl --install` or
    # `wsl --update`: on current Windows builds those are interactive,
    # self-elevating commands that open a console window (ending in "Press any
    # key to exit...") and request their own UAC prompt even when launched from
    # an elevated/LocalSystem context. Enabling the optional features, installing
    # the WSL2 kernel MSI with `msiexec /quiet`, and provisioning the WSL app
    # package are all silent machine operations an elevated context can perform.
    Write-PrereqLog "Enabling WSL Windows optional features (silent)."
    $featureExit = Enable-WslFeaturesWithPowerShellThenDism
    if ($featureExit -ne 0 -and $featureExit -ne 3010) {
        Write-PrereqLog "Enabling WSL Windows optional features failed with exit code $featureExit."
        Finish-Prereq $featureExit
    }
    $restartRequired = ($featureExit -eq 3010)

    Write-PrereqLog "Installing the WSL2 kernel update package (silent)."
    [void](Install-WslKernelMsi)

    Write-PrereqLog "Staging the modern WSL app package (silent)."
    [void](Install-WslAppPackage)

    $wslCommand = Resolve-WslExecutable
    if ($wslCommand) {
        $setDefault = Invoke-NativeCommand -FilePath $wslCommand -Arguments @("--set-default-version", "2") -TimeoutSeconds 120
        if ($setDefault.ExitCode -ne 0) {
            Write-PrereqLog "WSL default version could not be set yet; Veslo will set it after the restart."
        }
    }

    $afterInstall = Test-WslUsable
    Write-PrereqLog $afterInstall.Reason
    if ($afterInstall.Ok -and -not $restartRequired) {
        Finish-Prereq 0
    }

    Write-PrereqLog "Windows restart is required to finish WSL setup."
    Finish-Prereq 3010
} catch {
    Write-PrereqLog "Unhandled prerequisite helper error: $($_.Exception.Message)"
    Finish-Prereq 1
}
