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

function Invoke-NativeCommand([string]$FilePath, [string[]]$Arguments) {
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
            Write-PrereqLog $line
        }
    }

    return [pscustomobject]@{
        ExitCode = [int]$exitCode
        Output = ($outputLines -join "`n")
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
