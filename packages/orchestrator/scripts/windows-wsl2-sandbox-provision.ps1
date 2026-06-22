<#
.SYNOPSIS
Provisions the Veslo-managed WSL2 sandbox runtime (VesloSandbox) on Windows.

.DESCRIPTION
Creates the same environment the Veslo Windows sandbox runtime expects on a
fresh machine, per docs/sandbox/windows-wsl2-sandbox-runtime.md:

  1. Verifies WSL2 is installed and usable.
  2. Imports a pinned Ubuntu 22.04 LTS WSL rootfs as the managed distro
     (default name: VesloSandbox) - never touches personal distros.
  3. Creates the default "veslo" user and writes /etc/wsl.conf
     ([user] default=veslo, [interop] appendWindowsPath=false).
  4. Installs the sandbox runtime payload: bubblewrap, CA certificates.
  5. Installs the pinned Linux OpenCode binary to /usr/local/bin/opencode.
  6. Verifies everything with a real bwrap probe and an opencode version check.

The script is idempotent: re-running it repairs a partially provisioned
distro. Use -Force to delete and re-import the distro from scratch.

PowerShell 5.1 compatible - runs on any stock Windows 10/11 without extra
toolchain, so the installer/first-run onboarding can invoke it directly.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/windows-wsl2-sandbox-provision.ps1

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts/windows-wsl2-sandbox-provision.ps1 -Force -OpencodeVersion 1.17.4
#>
[CmdletBinding()]
param(
    [string]$DistroName = "VesloSandbox",
    [string]$InstallDir = "",
    [string]$OpencodeVersion = "",
    [string]$OpencodeGithubRepo = "anomalyco/opencode",
    [string]$RootfsUrl = "https://cloud-images.ubuntu.com/wsl/releases/22.04/current/ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz",
    [string]$RootfsSha256Url = "https://cloud-images.ubuntu.com/wsl/releases/22.04/current/SHA256SUMS",
    [switch]$Force,
    [switch]$SkipAptUpdate,
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Make wsl.exe emit UTF-8 instead of UTF-16 so PowerShell can parse its output.
$env:WSL_UTF8 = "1"

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail([string]$Message) {
    Write-Host "PROVISION FAILED: $Message" -ForegroundColor Red
    exit 1
}

function Normalize-WslOutput([string]$Text) {
    return ($Text -replace "`0", "").Trim()
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

    return [pscustomobject]@{
        ExitCode = [int]$exitCode
        Output = ((@($lines.ToArray()) | ForEach-Object { [string]$_ }) -join "`n")
    }
}

function Invoke-Wsl([string[]]$WslArgs) {
    $result = Invoke-HiddenNativeCommand "wsl.exe" $WslArgs
    return @{ ExitCode = $result.ExitCode; Output = (Normalize-WslOutput $result.Output) }
}

# Runs a bash script inside the distro as the given user. The script body is
# written to a temp file with LF endings and executed via its /mnt/c path, so
# no quoting survives the Windows -> WSL argv boundary.
function Invoke-DistroBash([string]$Distro, [string]$User, [string]$Script) {
    $tempFile = Join-Path $env:TEMP ("veslo-provision-" + [Guid]::NewGuid().ToString("N") + ".sh")
    $lf = "`n"
    $body = ($Script -replace "`r`n", "`n") + $lf
    [System.IO.File]::WriteAllText($tempFile, $body, (New-Object System.Text.UTF8Encoding($false)))
    try {
        $drive = $tempFile.Substring(0, 1).ToLower()
        $rest = $tempFile.Substring(2) -replace "\\", "/"
        $wslPath = "/mnt/$drive$rest"
        $result = Invoke-Wsl @("-d", $Distro, "-u", $User, "--exec", "bash", $wslPath)
        return $result
    } finally {
        Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue
    }
}

function Get-WslDistros {
    $result = Invoke-Wsl @("-l", "-q")
    if ($result.ExitCode -ne 0) { return @() }
    return @($result.Output -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Test-CommandInDistro([string]$Distro, [string]$User, [string]$Script, [string]$Label) {
    $result = Invoke-DistroBash -Distro $Distro -User $User -Script $Script
    if ($result.ExitCode -eq 0) {
        Write-Host "OK   $Label" -ForegroundColor Green
        if ($result.Output) { Write-Host "     $($result.Output)" }
        return $true
    }
    Write-Host "FAIL $Label" -ForegroundColor Red
    if ($result.Output) { Write-Host "     $($result.Output)" }
    return $false
}

function Test-ProvisionedRuntime([string]$Distro, [string]$ExpectedOpencodeVersion) {
    Write-Step "Checking Veslo WSL2 runtime requirements"
    $ok = $true
    $distros = Get-WslDistros
    if ($distros -notcontains $Distro) {
        Write-Host "FAIL managed distro '$Distro' is not installed" -ForegroundColor Red
        if ($distros.Count -gt 0) {
            Write-Host "     Installed WSL distros: $($distros -join ', ')"
        } else {
            Write-Host "     No WSL distros are installed."
        }
        return $false
    }
    Write-Host "OK   managed distro '$Distro' exists" -ForegroundColor Green

    $ok = (Test-CommandInDistro $Distro "root" "uname -m" "kernel/architecture probe") -and $ok
    $ok = (Test-CommandInDistro $Distro "root" "command -v bash && bash --version | head -n1" "bash is available") -and $ok
    $ok = (Test-CommandInDistro $Distro "root" "id -u veslo >/dev/null && getent passwd veslo | cut -d: -f1,6,7" "veslo user exists") -and $ok
    $ok = (Test-CommandInDistro $Distro "root" "grep -q '^default=veslo$' /etc/wsl.conf && grep -q '^appendWindowsPath=false$' /etc/wsl.conf && cat /etc/wsl.conf" "wsl.conf has Veslo defaults") -and $ok
    $ok = (Test-CommandInDistro $Distro "root" "command -v bwrap && bwrap --version" "bubblewrap is installed") -and $ok
    $ok = (Test-CommandInDistro $Distro "root" "command -v opencode && opencode --version | grep -F '$ExpectedOpencodeVersion'" "OpenCode $ExpectedOpencodeVersion is installed") -and $ok
    $ok = (Test-CommandInDistro $Distro "veslo" "test -w /home/veslo && test -d /home/veslo && echo /home/veslo-writable" "veslo home is usable") -and $ok

    $dnsScript = @'
set -euo pipefail
target="$(readlink -f /etc/resolv.conf 2>/dev/null || true)"
echo "resolv.conf-target=${target:-/etc/resolv.conf}"
test -r /etc/resolv.conf
'@
    $ok = (Test-CommandInDistro $Distro "veslo" $dnsScript "resolv.conf is readable") -and $ok

    $bwrapProbe = @'
set -euo pipefail
BWRAP="$(command -v bwrap)"
BWRAP_ARGS=(
  --new-session --die-with-parent
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts
  --cap-drop ALL --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run
  --ro-bind /usr /usr --ro-bind-try /bin /bin --ro-bind-try /lib /lib
  --ro-bind-try /lib64 /lib64 --ro-bind /etc /etc
)
RESOLV_TARGET="$(readlink -f /etc/resolv.conf 2>/dev/null || true)"
if [ -n "$RESOLV_TARGET" ] && [ "$RESOLV_TARGET" != "/etc/resolv.conf" ] && [ -e "$RESOLV_TARGET" ]; then
  case "$RESOLV_TARGET" in
    /etc/*|/usr/*|/bin/*|/lib/*|/lib64/*) ;;
    *)
      dir="$(dirname "$RESOLV_TARGET")"
      current=""
      IFS='/' read -r -a parts <<< "${dir#/}"
      for part in "${parts[@]}"; do
        [ -z "$part" ] && continue
        current="$current/$part"
        BWRAP_ARGS+=(--dir "$current")
      done
      BWRAP_ARGS+=(--ro-bind "$RESOLV_TARGET" "$RESOLV_TARGET")
      ;;
  esac
fi
"$BWRAP" "${BWRAP_ARGS[@]}" -- /bin/sh -lc 'echo veslo-bwrap-ok'
"$BWRAP" "${BWRAP_ARGS[@]}" -- /bin/sh -lc 'getent hosts models.dev >/dev/null || getent hosts github.com >/dev/null; echo veslo-dns-ok'
'@
    $ok = (Test-CommandInDistro $Distro "veslo" $bwrapProbe "bubblewrap sandbox probe passes") -and $ok
    return $ok
}

function Resolve-OpencodeVersion {
    if ($OpencodeVersion.Trim()) { return $OpencodeVersion.Trim() }
    # Pinned in packages/orchestrator/package.json ("opencodeVersion"). Falls
    # back to the version documented in docs/sandbox when the script is copied
    # out of the repo (e.g. bundled with an installer).
    $packageJson = Join-Path $PSScriptRoot "..\package.json"
    if (Test-Path $packageJson) {
        try {
            $pkg = Get-Content $packageJson -Raw | ConvertFrom-Json
            if ($pkg.opencodeVersion) { return ([string]$pkg.opencodeVersion).Trim() }
        } catch {}
    }
    return "1.17.4"
}

# --- 1. Preconditions ---------------------------------------------------------

if (-not ([Environment]::OSVersion.Platform -eq "Win32NT")) {
    Fail "This script must run on Windows."
}

Write-Step "Checking WSL availability"
$wslStatus = Invoke-Wsl @("--status")
if ($wslStatus.ExitCode -ne 0) {
    Fail @"
WSL does not appear to be installed or usable.
Install it first (requires admin rights and a reboot):

    wsl --install --no-distribution

Then re-run this script.
"@
}

$expectedOpencodeVersion = Resolve-OpencodeVersion
if (-not $InstallDir.Trim()) {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Veslo\wsl\$DistroName"
}

Write-Host "Distro:            $DistroName"
Write-Host "Install dir:       $InstallDir"
Write-Host "OpenCode version:  $expectedOpencodeVersion (linux x64 baseline)"

if ($CheckOnly) {
    $ok = Test-ProvisionedRuntime -Distro $DistroName -ExpectedOpencodeVersion $expectedOpencodeVersion
    if ($ok) {
        Write-Host ""
        Write-Host "PASS - $DistroName has everything Veslo needs." -ForegroundColor Green
        exit 0
    }
    Write-Host ""
    Write-Host "FAIL - $DistroName is missing required Veslo runtime pieces. Re-run without -CheckOnly to provision/repair it." -ForegroundColor Red
    exit 1
}

# --- 2. Import the managed distro ----------------------------------------------

$distros = Get-WslDistros
$distroExists = $distros -contains $DistroName

if ($distroExists -and $Force) {
    Write-Step "Removing existing $DistroName (-Force)"
    $unregister = Invoke-Wsl @("--unregister", $DistroName)
    if ($unregister.ExitCode -ne 0) {
        Fail "Failed to unregister ${DistroName}: $($unregister.Output)"
    }
    $distroExists = $false
}

if (-not $distroExists) {
    Write-Step "Downloading Ubuntu 22.04 WSL rootfs"
    $downloadDir = Join-Path $env:TEMP "veslo-wsl-provision"
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    $rootfsFile = Join-Path $downloadDir (Split-Path $RootfsUrl -Leaf)

    if (-not (Test-Path $rootfsFile)) {
        Invoke-WebRequest -Uri $RootfsUrl -OutFile $rootfsFile -UseBasicParsing
    } else {
        Write-Host "Reusing cached rootfs: $rootfsFile"
    }

    Write-Step "Verifying rootfs checksum"
    $sumsFile = Join-Path $downloadDir "SHA256SUMS"
    Invoke-WebRequest -Uri $RootfsSha256Url -OutFile $sumsFile -UseBasicParsing
    $rootfsName = Split-Path $RootfsUrl -Leaf
    $expectedLine = (Get-Content $sumsFile | Where-Object { $_ -match [regex]::Escape($rootfsName) } | Select-Object -First 1)
    if (-not $expectedLine) {
        Fail "SHA256SUMS does not list $rootfsName - refusing to import an unverified rootfs."
    }
    $expectedHash = ($expectedLine -split "\s+")[0].Trim("\*").ToLower()
    $actualHash = (Get-FileHash -Path $rootfsFile -Algorithm SHA256).Hash.ToLower()
    if ($expectedHash -ne $actualHash) {
        Remove-Item $rootfsFile -Force
        Fail "Rootfs checksum mismatch (expected $expectedHash, got $actualHash). The cached download was removed; re-run to retry."
    }
    Write-Host "Checksum OK: $actualHash"

    Write-Step "Importing $DistroName (WSL2)"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $import = Invoke-Wsl @("--import", $DistroName, $InstallDir, $rootfsFile, "--version", "2")
    if ($import.ExitCode -ne 0) {
        Fail "wsl --import failed: $($import.Output)"
    }
} else {
    Write-Step "$DistroName already exists - running in repair mode (use -Force to re-import)"
}

# --- 3. In-distro base setup (user, wsl.conf, packages) ------------------------

Write-Step "Configuring user, wsl.conf and packages inside $DistroName"
$aptUpdateLine = "apt-get update"
if ($SkipAptUpdate) { $aptUpdateLine = "echo 'skipping apt-get update (-SkipAptUpdate)'" }

$setupScript = @'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

if ! id -u veslo >/dev/null 2>&1; then
  useradd -m -s /bin/bash veslo
fi

# appendWindowsPath=false matters: with it on, WSL resolves the Windows
# opencode shim from /mnt/c/... which is not a valid Linux runtime for bwrap.
cat > /etc/wsl.conf <<'EOF'
[user]
default=veslo
[interop]
appendWindowsPath=false
EOF

__APT_UPDATE__
apt-get install -y --no-install-recommends bubblewrap ca-certificates

command -v bwrap >/dev/null
echo "bwrap: $(bwrap --version)"
'@
$setupScript = $setupScript -replace "__APT_UPDATE__", $aptUpdateLine

$setup = Invoke-DistroBash -Distro $DistroName -User "root" -Script $setupScript
if ($setup.ExitCode -ne 0) {
    Fail "In-distro setup failed:`n$($setup.Output)"
}
Write-Host $setup.Output

# --- 4. Install the pinned Linux OpenCode runtime ------------------------------

Write-Step "Checking OpenCode runtime inside $DistroName"
$checkOpencodeScript = @'
if command -v opencode >/dev/null 2>&1; then
  opencode --version 2>/dev/null || true
fi
'@
$checkOpencode = Invoke-DistroBash -Distro $DistroName -User "root" -Script $checkOpencodeScript
$installedVersion = ""
if ($checkOpencode.ExitCode -eq 0 -and $checkOpencode.Output) {
    $match = [regex]::Match($checkOpencode.Output, "\d+\.\d+\.\d+(?:-[\w.-]+)?")
    if ($match.Success) { $installedVersion = $match.Value }
}

if ($installedVersion -eq $expectedOpencodeVersion) {
    Write-Host "OpenCode $installedVersion already installed."
} else {
    if ($installedVersion) {
        Write-Host "OpenCode $installedVersion installed, expected $expectedOpencodeVersion - reinstalling."
    }
    Write-Step "Downloading OpenCode $expectedOpencodeVersion (linux x64 baseline)"
    $assetName = "opencode-linux-x64-baseline.tar.gz"
    $assetUrl = "https://github.com/$OpencodeGithubRepo/releases/download/v$expectedOpencodeVersion/$assetName"
    $downloadDir = Join-Path $env:TEMP "veslo-wsl-provision"
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    $assetFile = Join-Path $downloadDir "opencode-$expectedOpencodeVersion-$assetName"
    if (-not (Test-Path $assetFile)) {
        Invoke-WebRequest -Uri $assetUrl -OutFile $assetFile -UseBasicParsing
    } else {
        Write-Host "Reusing cached asset: $assetFile"
    }

    Write-Step "Installing OpenCode to /usr/local/bin/opencode"
    $drive = $assetFile.Substring(0, 1).ToLower()
    $rest = $assetFile.Substring(2) -replace "\\", "/"
    $assetWslPath = "/mnt/$drive$rest"

    $installScript = @'
set -euo pipefail
ASSET="__ASSET__"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
tar -xzf "$ASSET" -C "$WORKDIR"
BIN="$(find "$WORKDIR" -type f -name opencode | head -n1)"
if [ -z "$BIN" ]; then
  echo "opencode binary not found inside the release tarball" >&2
  exit 1
fi
install -m 0755 "$BIN" /usr/local/bin/opencode
/usr/local/bin/opencode --version
'@
    $installScript = $installScript -replace "__ASSET__", $assetWslPath
    $install = Invoke-DistroBash -Distro $DistroName -User "root" -Script $installScript
    if ($install.ExitCode -ne 0) {
        Fail "OpenCode install failed:`n$($install.Output)"
    }
    Write-Host $install.Output
}

# --- 5. Restart the distro so /etc/wsl.conf (default user) applies -------------

Write-Step "Restarting $DistroName to apply wsl.conf"
Invoke-Wsl @("--terminate", $DistroName) | Out-Null

# --- 6. Verification ------------------------------------------------------------

Write-Step "Verifying provisioned runtime"
$verifyScript = @'
set -euo pipefail
echo "user: $(id -un)"
echo "arch: $(uname -m)"
BWRAP="$(command -v bwrap)"
echo "bwrap: $BWRAP ($(bwrap --version))"
OPENCODE="$(command -v opencode)"
echo "opencode: $OPENCODE ($(opencode --version))"

# Real bwrap probe with the same mount profile the engine launch uses,
# including the resolv.conf target bind so DNS works inside the sandbox.
BWRAP_ARGS=(
  --new-session --die-with-parent
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts
  --cap-drop ALL --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run
  --ro-bind /usr /usr --ro-bind-try /bin /bin --ro-bind-try /lib /lib
  --ro-bind-try /lib64 /lib64 --ro-bind /etc /etc
)
RESOLV_TARGET="$(readlink -f /etc/resolv.conf 2>/dev/null || true)"
if [ -n "$RESOLV_TARGET" ] && [ "$RESOLV_TARGET" != "/etc/resolv.conf" ] && [ -e "$RESOLV_TARGET" ]; then
  case "$RESOLV_TARGET" in
    /etc/*|/usr/*|/bin/*|/lib/*|/lib64/*) ;;
    *)
      dir="$(dirname "$RESOLV_TARGET")"
      current=""
      IFS='/' read -r -a parts <<< "${dir#/}"
      for part in "${parts[@]}"; do
        [ -z "$part" ] && continue
        current="$current/$part"
        BWRAP_ARGS+=(--dir "$current")
      done
      BWRAP_ARGS+=(--ro-bind "$RESOLV_TARGET" "$RESOLV_TARGET")
      ;;
  esac
fi
"$BWRAP" "${BWRAP_ARGS[@]}" -- /bin/sh -lc 'echo veslo-bwrap-ok'
"$BWRAP" "${BWRAP_ARGS[@]}" -- /bin/sh -lc 'getent hosts models.dev >/dev/null || getent hosts github.com >/dev/null; echo veslo-dns-ok'
"$BWRAP" "${BWRAP_ARGS[@]}" -- "$OPENCODE" --version
echo "veslo-provision-verify-ok"
'@
$verify = Invoke-DistroBash -Distro $DistroName -User "veslo" -Script $verifyScript
if ($verify.ExitCode -ne 0 -or ($verify.Output -notmatch "veslo-provision-verify-ok")) {
    Fail "Verification failed:`n$($verify.Output)"
}
Write-Host $verify.Output

$verifyVersion = [regex]::Match($verify.Output, "opencode: .*\((\d+\.\d+\.\d+[^)]*)\)")
if ($verifyVersion.Success -and $verifyVersion.Groups[1].Value -ne $expectedOpencodeVersion) {
    Fail "OpenCode version mismatch after install: expected $expectedOpencodeVersion, got $($verifyVersion.Groups[1].Value)"
}

Write-Host ""
Write-Host "PASS - $DistroName is provisioned (Ubuntu 22.04, bwrap, opencode $expectedOpencodeVersion)." -ForegroundColor Green
Write-Host "Next: from packages/orchestrator run the smoke test to validate the full launch path:"
Write-Host "    pnpm exec bun scripts/windows-wsl2-sandbox-smoke.ts"
