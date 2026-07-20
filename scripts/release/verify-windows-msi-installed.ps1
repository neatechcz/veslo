[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet(
    "clean",
    "clean-no-wsl",
    "upgrade",
    "normal-second-start",
    "forced-runtime-second-start",
    "foreign-listener",
    "updater"
  )]
  [string]$Scenario,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$MsiPath,

  [string]$BaselineMsiPath,

  [ValidatePattern("^\\d+\\.\\d+\\.\\d+$")]
  [string]$ExpectedBaselineVersion = "26.6.26",

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ReleaseTag,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[0-9a-fA-F]{7,40}$")]
  [string]$Commit,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SummaryPath,

  [ValidateRange(10000, 3600000)]
  [int]$TimeoutMs = 180000,

  [ValidateSet("Any", "Present", "Absent")]
  [string]$WebView2Expectation = "Any",

  [switch]$RequireNoWsl,

  [switch]$RequireRuntimeChainReady,

  [ValidateRange(1, 65535)]
  [int]$ExpectedPort = 8787,

  [string]$UpdaterLogPath = "C:\ProgramData\veslo-updater-msi.log",

  [datetime]$UpdaterLogNotBeforeUtc = [datetime]::MinValue
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:StartedProcessIds = @()
$script:LaunchedAppProcessIds = @()
$script:OwnedTemporaryDirectories = @()
$script:CurrentAppProcess = $null
$script:ForeignListener = $null

function Get-OptionalProperty {
  param(
    [object]$Value,
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if ($null -eq $Value) {
    return $null
  }

  $property = $Value.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }

  return $property.Value
}

function ConvertTo-RedactedText {
  param([AllowNull()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }

  $result = $Value
  $result = [regex]::Replace($result, "(?i)Bearer\\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]")
  $result = [regex]::Replace(
    $result,
    "(?i)((?:token|secret|password|api[-_]?key|authorization|credential)\\s*[:=]\\s*)([^\\s,;]+)",
    '$1[redacted]'
  )
  $result = [regex]::Replace($result, "(?i)[A-Z]:\\\\Users\\\\[^\\\\\\s]+", "[redacted-home]")
  if ($result.Length -gt 2000) {
    return $result.Substring(0, 2000) + "...[truncated]"
  }

  return $result
}

function Get-TextLogTail {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [int]$MaximumCharacters = 4096
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }

  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) {
      return $null
    }

    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
      $text = [System.Text.Encoding]::Unicode.GetString($bytes)
    } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
      $text = [System.Text.Encoding]::BigEndianUnicode.GetString($bytes)
    } else {
      $text = [System.Text.Encoding]::Default.GetString($bytes)
    }

    if ($text.Length -gt $MaximumCharacters) {
      $text = $text.Substring($text.Length - $MaximumCharacters)
    }
    return ConvertTo-RedactedText -Value $text.Trim()
  } catch {
    return $null
  }
}

function Get-ExactMsiPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($Path)) {
    throw "MsiPath must be an exact literal path to one MSI; wildcards are not allowed: $Path"
  }

  $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $resolved.Path -PathType Leaf)) {
    throw "MSI path is not a file: $($resolved.Path)"
  }
  if (-not $resolved.Path.EndsWith(".msi", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "MSI path must end in .msi: $($resolved.Path)"
  }

  return $resolved.Path
}

function Get-FileSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-MsiProperty {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Database,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $escapedName = $Name.Replace("'", "''")
  $tick = [char]96
  $sql = "SELECT $tick" + "Value$tick FROM $tick" + "Property$tick WHERE $tick" + "Property$tick = '$escapedName'"
  $view = $null
  try {
    $view = $Database.OpenView($sql)
    [void]$view.Execute()
    $record = $view.Fetch()
    if ($null -eq $record) {
      return $null
    }
    return $record.StringData(1)
  } finally {
    if ($null -ne $view) {
      try {
        [void]$view.Close()
      } catch {
        # Releasing the COM object below is sufficient when the view is already closed.
      }
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
    }
  }
}

function Get-MsiProperties {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $installer = $null
  $database = $null
  try {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase($Path, 0)
    return [ordered]@{
      productCode = Get-MsiProperty -Database $database -Name "ProductCode"
      productName = Get-MsiProperty -Database $database -Name "ProductName"
      productVersion = Get-MsiProperty -Database $database -Name "ProductVersion"
      allUsers = Get-MsiProperty -Database $database -Name "ALLUSERS"
    }
  } finally {
    if ($null -ne $database) {
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
    }
    if ($null -ne $installer) {
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
    }
  }
}

function Get-MsiCustomActions {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $installer = $null
  $database = $null
  $tableView = $null
  $view = $null
  try {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.OpenDatabase($Path, 0)
    $tableView = $database.OpenView('SELECT `Name` FROM `_Tables` WHERE `Name` = ''CustomAction''')
    [void]$tableView.Execute()
    $tableRecord = $tableView.Fetch()
    if ($null -eq $tableRecord) {
      return @()
    }
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($tableRecord)

    $view = $database.OpenView('SELECT `Action`, `Type`, `Source`, `Target` FROM `CustomAction`')
    [void]$view.Execute()
    $actions = @()
    while ($record = $view.Fetch()) {
      try {
        $actions += [PSCustomObject]@{
          action = $record.StringData(1)
          type = $record.StringData(2)
          source = $record.StringData(3)
          target = $record.StringData(4)
        }
      } finally {
        [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)
      }
    }
    return $actions
  } finally {
    if ($null -ne $tableView) {
      try {
        [void]$tableView.Close()
      } catch {
        # Releasing the COM object below is sufficient when the view is already closed.
      }
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($tableView)
    }
    if ($null -ne $view) {
      try {
        [void]$view.Close()
      } catch {
        # Releasing the COM object below is sufficient when the view is already closed.
      }
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
    }
    if ($null -ne $database) {
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
    }
    if ($null -ne $installer) {
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
    }
  }
}

function Test-RunningAsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Administrator {
  if (-not (Test-RunningAsAdministrator)) {
    throw "Installed-MSI verification must run from an elevated PowerShell session in a disposable Windows VM."
  }
}

function Stop-OwnedProcessTree {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  try {
    $Process.Refresh()
  } catch {
    return
  }
  if ($Process.HasExited) {
    return
  }

  & taskkill.exe /pid $Process.Id /t /f | Out-Null
  $script:StartedProcessIds += $Process.Id
  if (-not $Process.WaitForExit(10000)) {
    throw "Could not stop this verifier's $Label process tree (pid=$($Process.Id))."
  }
}

function Stop-OwnedProcessById {
  param(
    [AllowNull()][Nullable[int]]$ProcessId,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  if ($null -eq $ProcessId) {
    return
  }

  try {
    $process = Get-Process -Id $ProcessId.Value -ErrorAction Stop
  } catch {
    return
  }
  Stop-OwnedProcessTree -Process $process -Label $Label
}

function Test-FileUnlocked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  try {
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    $stream.Dispose()
    return $true
  } catch {
    return $false
  }
}

function WaitFor-MsiLogCompletion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LogPath,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds,

    [Parameter(Mandatory = $true)]
    [string]$Action
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    $tail = Get-TextLogTail -Path $LogPath
    if ($tail -match "MainEngineThread is returning ([0-9]+)" -and (Test-FileUnlocked -Path $LogPath)) {
      return [int]$Matches[1]
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "MSI $Action did not complete within $($TimeoutMilliseconds)ms. Verbose log: $LogPath"
}

function Start-EncodedPowerShell {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Command,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Command))
  $hostExecutable = (Get-Process -Id $PID).Path
  $process = Start-Process -FilePath $hostExecutable -ArgumentList @(
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    $encodedCommand
  ) -PassThru -WindowStyle Hidden
  $script:StartedProcessIds += $process.Id
  return $process
}

function Invoke-MsiInstall {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$LogPath,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds
  )

  $encodedMsiPath = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Path))
  $encodedLogPath = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($LogPath))
  $command = @'
$ErrorActionPreference = "Stop"
$msiPath = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__MSI_PATH__"))
$logPath = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__LOG_PATH__"))
& msiexec.exe /i $msiPath /qn /norestart /L*V $logPath
exit $LASTEXITCODE
'@
  $command = $command.Replace("__MSI_PATH__", $encodedMsiPath)
  $command = $command.Replace("__LOG_PATH__", $encodedLogPath)
  $process = Start-EncodedPowerShell -Command $command -Label "msiexec install"

  if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    Stop-OwnedProcessTree -Process $process -Label "msiexec install"
    throw "MSI installation timed out after $($TimeoutMilliseconds)ms. Verbose log: $LogPath"
  }

  $process.Refresh()
  $msiExitCode = WaitFor-MsiLogCompletion -LogPath $LogPath -TimeoutMilliseconds $TimeoutMilliseconds -Action "installation"
  if ($process.ExitCode -ne 0 -or $msiExitCode -ne 0) {
    throw "MSI installation failed with launcher exit code $($process.ExitCode) and MSI exit code $msiExitCode. Verbose log: $LogPath"
  }

  return [ordered]@{
    mode = "msiexec-install"
    logPath = $LogPath
    launcherExitCode = $process.ExitCode
    msiExitCode = $msiExitCode
  }
}

function Invoke-MsiAdministrativeExtraction {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Destination,

    [Parameter(Mandatory = $true)]
    [string]$LogPath,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $encodedMsiPath = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Path))
  $encodedDestination = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Destination))
  $encodedLogPath = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($LogPath))
  $command = @'
$ErrorActionPreference = "Stop"
$msiPath = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__MSI_PATH__"))
$destination = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__DESTINATION__"))
$logPath = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__LOG_PATH__"))
& msiexec.exe /a $msiPath /qn ("TARGETDIR=" + $destination) /L*V $logPath
exit $LASTEXITCODE
'@
  $command = $command.Replace("__MSI_PATH__", $encodedMsiPath)
  $command = $command.Replace("__DESTINATION__", $encodedDestination)
  $command = $command.Replace("__LOG_PATH__", $encodedLogPath)
  $process = Start-EncodedPowerShell -Command $command -Label "msiexec administrative extraction"

  if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    Stop-OwnedProcessTree -Process $process -Label "msiexec administrative extraction"
    throw "MSI administrative extraction timed out after $($TimeoutMilliseconds)ms. Verbose log: $LogPath"
  }

  $process.Refresh()
  $msiExitCode = WaitFor-MsiLogCompletion -LogPath $LogPath -TimeoutMilliseconds $TimeoutMilliseconds -Action "administrative extraction"
  if ($process.ExitCode -ne 0 -or $msiExitCode -ne 0) {
    throw "MSI administrative extraction failed with launcher exit code $($process.ExitCode) and MSI exit code $msiExitCode. Verbose log: $LogPath"
  }
}

function Test-PathInsideRoot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Root
  )

  $normalizedPath = [System.IO.Path]::GetFullPath($Path).TrimEnd("\\")
  $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd("\\")
  return $normalizedPath.StartsWith($normalizedRoot + "\\", [System.StringComparison]::OrdinalIgnoreCase)
    -or [string]::Equals($normalizedPath, $normalizedRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

function New-OwnedTemporaryDirectory {
  $base = Join-Path ([System.IO.Path]::GetTempPath()) "veslo-msi-installed-verification"
  New-Item -ItemType Directory -Force -Path $base | Out-Null
  $directory = Join-Path $base ([guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $script:OwnedTemporaryDirectories += $directory
  return $directory
}

function Remove-OwnedTemporaryDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $base = Join-Path ([System.IO.Path]::GetTempPath()) "veslo-msi-installed-verification"
  if (-not (Test-PathInsideRoot -Path $Path -Root $base)) {
    throw "Refusing to remove a temporary directory outside the verifier-owned root: $Path"
  }
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
  }
}

function Get-PayloadFile {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [System.IO.FileInfo[]]$Files,

    [Parameter(Mandatory = $true)]
    [string]$LogicalName,

    [Parameter(Mandatory = $true)]
    [string[]]$Names
  )

  $matches = @($Files | Where-Object { $Names -contains $_.Name })
  if ($matches.Count -ne 1) {
    $found = if ($matches.Count) { $matches.FullName -join ", " } else { "none" }
    throw "Expected exactly one $LogicalName payload file ($($Names -join ' or ')); found: $found"
  }

  return $matches[0]
}

function Assert-FileIsInAppRoot {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.FileInfo]$File,

    [Parameter(Mandatory = $true)]
    [string]$AppRoot,

    [Parameter(Mandatory = $true)]
    [string]$LogicalName
  )

  $parent = Split-Path -Parent $File.FullName
  if (-not [string]::Equals($parent, $AppRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$LogicalName must be installed beside veslo.exe. Found: $($File.FullName)"
  }
}

function Assert-WslSandboxPayloadExcluded {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [System.IO.FileInfo[]]$Files
  )

  $excludedNames = @(
    "windows-wsl2-sandbox-provision.ps1",
    "wsl2-prerequisite-installer.ps1",
    "wsl2-client-installer.ps1",
    "wsl2-sandbox-installer.ps1"
  )
  $unexpected = @($Files | Where-Object { $excludedNames -contains $_.Name })
  if ($unexpected.Count -gt 0) {
    throw "MSI payload contains excluded WSL sandbox setup files: $($unexpected.FullName -join ', ')"
  }
}

function Assert-WslSandboxCustomActionsExcluded {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [object[]]$CustomActions
  )

  $unexpected = @($CustomActions | Where-Object {
    ("$($_.action)`n$($_.source)`n$($_.target)") -match "(?i)(wsl|veslosandbox)"
  })
  if ($unexpected.Count -gt 0) {
    $details = $unexpected | ForEach-Object {
      "$($_.action) [source=$($_.source); target=$($_.target)]"
    }
    throw "MSI CustomAction table contains excluded WSL sandbox setup action(s): $($details -join ', ')"
  }
}

function Get-ManifestEvidence {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$MsiProductVersion
  )

  try {
    $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    throw "Could not parse installed versions manifest ${Path}: $($_.Exception.Message)"
  }

  $requiredKeys = @(
    "veslo-code",
    "veslo-server",
    "veslo-code-router",
    "veslo-orchestrator",
    "chrome-devtools-mcp",
    "opencode-managed-deps"
  )
  $components = [ordered]@{}
  foreach ($key in $requiredKeys) {
    $entry = Get-OptionalProperty -Value $manifest -Name $key
    $version = [string](Get-OptionalProperty -Value $entry -Name "version")
    $hash = [string](Get-OptionalProperty -Value $entry -Name "sha256")
    if ([string]::IsNullOrWhiteSpace($version) -or $hash -notmatch "^[a-fA-F0-9]{64}$") {
      throw "Versions manifest is missing a valid version and SHA-256 for $key."
    }
    $components[$key] = [ordered]@{
      version = $version
      sha256 = $hash.ToLowerInvariant()
    }
  }

  if ($MsiProductVersion -match "^(\\d{2})\\.(\\d+)\\.(\\d+)$") {
    $expectedServerVersion = "20$($Matches[1]).$($Matches[2]).$($Matches[3])"
    if ($components["veslo-server"].version -ne $expectedServerVersion) {
      throw "Versions manifest veslo-server version $($components['veslo-server'].version) does not match MSI ProductVersion $MsiProductVersion."
    }
  }

  return [ordered]@{
    fileName = Split-Path -Leaf $Path
    sha256 = Get-FileSha256 -Path $Path
    components = $components
  }
}

function Get-PayloadRequirements {
  return [ordered]@{
    "desktop" = @("veslo.exe")
    "veslo-code" = @("veslo-code.exe")
    "opencode" = @("opencode.exe")
    "veslo-server" = @("veslo-server.exe")
    "veslo-code-router" = @("veslo-code-router.exe")
    "veslo-orchestrator" = @("veslo-orchestrator.exe")
    "chrome-devtools-mcp" = @("chrome-devtools-mcp.exe")
    "veslo-node" = @("veslo-node.exe", "Bin_veslo_node.exe")
    "versions-manifest" = @("versions.json", "versions.json.exe")
    "opencode-managed-deps" = @("opencode-managed-deps.json", "opencode-managed-deps.json.exe")
  }
}

function Get-ExtractedMsiPayloadSnapshot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$MsiProperties,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds,

    [switch]$RequireNoWslSandboxPayload
  )

  $workRoot = New-OwnedTemporaryDirectory
  $payloadRoot = Join-Path $workRoot "payload"
  $logPath = Join-Path $workRoot "msiexec-admin-extract.log"
  try {
    Invoke-MsiAdministrativeExtraction -Path $Path -Destination $payloadRoot -LogPath $logPath -TimeoutMilliseconds $TimeoutMilliseconds
    $allFiles = @(Get-ChildItem -LiteralPath $payloadRoot -Recurse -File -Force)
    if ($RequireNoWslSandboxPayload) {
      Assert-WslSandboxPayloadExcluded -Files $allFiles
    }
    $desktopFile = Get-PayloadFile -Files $allFiles -LogicalName "Veslo desktop executable" -Names @("veslo.exe")
    $appRoot = Split-Path -Parent $desktopFile.FullName
    $files = [ordered]@{}
    foreach ($requirement in (Get-PayloadRequirements).GetEnumerator()) {
      $file = Get-PayloadFile -Files $allFiles -LogicalName $requirement.Key -Names $requirement.Value
      Assert-FileIsInAppRoot -File $file -AppRoot $appRoot -LogicalName $requirement.Key
      $files[$requirement.Key] = [ordered]@{
        name = $file.Name
        sha256 = Get-FileSha256 -Path $file.FullName
      }
    }

    return [ordered]@{
      manifest = Get-ManifestEvidence -Path (Join-Path $appRoot $files["versions-manifest"].name) -MsiProductVersion $MsiProperties.productVersion
      files = $files
      wslSandboxPayloadExcluded = [bool]$RequireNoWslSandboxPayload
    }
  } finally {
    if ($workRoot -and (Test-Path -LiteralPath $workRoot)) {
      Remove-OwnedTemporaryDirectory -Path $workRoot
    }
  }
}

function Get-RegistryInstallLocations {
  param(
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$MsiProperties
  )

  $locations = @()
  $roots = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) {
      continue
    }
    foreach ($key in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue) {
      $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $entry) {
        continue
      }
      $keyName = Split-Path -Leaf $key.PSPath
      $displayName = [string](Get-OptionalProperty -Value $entry -Name "DisplayName")
      if (-not [string]::Equals($keyName, $MsiProperties.productCode, [System.StringComparison]::OrdinalIgnoreCase) -and
          -not [string]::Equals($displayName, $MsiProperties.productName, [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
      }
      $location = [string](Get-OptionalProperty -Value $entry -Name "InstallLocation")
      if (-not [string]::IsNullOrWhiteSpace($location)) {
        $locations += $location
      }
    }
  }

  return @($locations | Select-Object -Unique)
}

function Get-InstalledApp {
  param(
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$MsiProperties
  )

  $roots = @()
  $roots += Get-RegistryInstallLocations -MsiProperties $MsiProperties
  foreach ($programFiles in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ([string]::IsNullOrWhiteSpace($programFiles) -or [string]::IsNullOrWhiteSpace($MsiProperties.productName)) {
      continue
    }
    $roots += Join-Path $programFiles $MsiProperties.productName
  }

  foreach ($root in @($roots | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
    $candidate = Join-Path $root "veslo.exe"
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      continue
    }
    $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
    $isInProgramFiles = $false
    foreach ($programFiles in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
      if (-not [string]::IsNullOrWhiteSpace($programFiles) -and (Test-PathInsideRoot -Path $resolved -Root $programFiles)) {
        $isInProgramFiles = $true
        break
      }
    }
    if (-not $isInProgramFiles) {
      throw "Installed Veslo executable is not under Program Files: $resolved"
    }
    return [ordered]@{
      appRoot = Split-Path -Parent $resolved
      executable = $resolved
      underProgramFiles = $true
    }
  }

  throw "Could not resolve installed veslo.exe under Program Files from MSI product metadata."
}

function Get-InstalledPayloadSnapshot {
  param(
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$InstalledApp,

    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$MsiProperties
  )

  $files = [ordered]@{}
  foreach ($requirement in (Get-PayloadRequirements).GetEnumerator()) {
    $matches = @()
    foreach ($name in $requirement.Value) {
      $candidate = Join-Path $InstalledApp.appRoot $name
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $matches += Get-Item -LiteralPath $candidate
      }
    }
    if ($matches.Count -ne 1) {
      throw "Installed Veslo payload is missing or ambiguous for $($requirement.Key)."
    }
    $file = $matches[0]
    $files[$requirement.Key] = [ordered]@{
      name = $file.Name
      sha256 = Get-FileSha256 -Path $file.FullName
    }
  }

  return [ordered]@{
    manifest = Get-ManifestEvidence -Path (Join-Path $InstalledApp.appRoot $files["versions-manifest"].name) -MsiProductVersion $MsiProperties.productVersion
    files = $files
  }
}

function Assert-PayloadMatchesMsi {
  param(
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$Expected,

    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$Installed
  )

  foreach ($logicalName in $Expected.files.Keys) {
    $expectedFile = $Expected.files[$logicalName]
    $installedFile = $Installed.files[$logicalName]
    if ($null -eq $installedFile -or $expectedFile.sha256 -ne $installedFile.sha256) {
      throw "Installed payload SHA-256 mismatch for $logicalName; the installed binary is stale or differs from the exact MSI."
    }
  }
  if ($Expected.manifest.sha256 -ne $Installed.manifest.sha256) {
    throw "Installed versions manifest differs from the exact MSI."
  }
}

function Get-WebView2State {
  $runtimeId = "{F1E7B0A0-7A8C-45A1-9F57-AFA69CF9CBA2}"
  $paths = @(
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\EdgeUpdate\Clients\$runtimeId",
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$runtimeId",
    "Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\EdgeUpdate\Clients\$runtimeId"
  )
  $versions = @()
  foreach ($path in $paths) {
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }
    $entry = Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue
    $version = [string](Get-OptionalProperty -Value $entry -Name "pv")
    if (-not [string]::IsNullOrWhiteSpace($version)) {
      $versions += $version
    }
  }
  $versions = @($versions | Select-Object -Unique)
  return [ordered]@{
    present = $versions.Count -gt 0
    versions = $versions
  }
}

function Assert-WebView2Expectation {
  param(
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$State,

    [Parameter(Mandatory = $true)]
    [string]$Expectation
  )

  if ($Expectation -eq "Present" -and -not $State.present) {
    throw "WebView2 runtime is required for this VM scenario but was not detected."
  }
  if ($Expectation -eq "Absent" -and $State.present) {
    throw "This VM scenario requires WebView2 to be absent, but version(s) were detected."
  }
}

function Invoke-WslCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $output = @(& $Executable @Arguments 2>&1)
  return [ordered]@{
    exitCode = $LASTEXITCODE
    output = ConvertTo-RedactedText -Value (($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine)
  }
}

function Get-WslState {
  $wsl = Get-Command wsl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $featureState = $null
  try {
    $featureState = [string](Get-WindowsOptionalFeature -Online -FeatureName "Microsoft-Windows-Subsystem-Linux" -ErrorAction Stop).State
  } catch {
    $featureState = "unavailable"
  }

  if ($null -eq $wsl) {
    return [ordered]@{
      commandPresent = $false
      optionalFeatureState = $featureState
      distros = @()
      status = $null
      list = $null
    }
  }

  $status = Invoke-WslCommand -Executable $wsl.Source -Arguments @("--status")
  $list = Invoke-WslCommand -Executable $wsl.Source -Arguments @("--list", "--quiet")
  $distros = @()
  if ($list.exitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($list.output)) {
    $distros = @($list.output -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  }
  return [ordered]@{
    commandPresent = $true
    optionalFeatureState = $featureState
    distros = $distros
    status = $status
    list = $list
  }
}

function Assert-NoWsl {
  param(
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$State
  )

  $featureDisabled = $State.optionalFeatureState -match "^Disabled"
  if (-not $featureDisabled -or $State.distros.Count -ne 0) {
    throw "This scenario requires a no-WSL VM. WSL optional feature must be disabled and no distributions may be installed."
  }
}

function Get-HostRuntimeState {
  $found = @()
  foreach ($name in @("node.exe", "node", "npm.cmd", "npm", "npx.cmd", "npx", "bun.exe", "bun")) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
      $found += $name
    }
  }
  return [ordered]@{
    present = $found.Count -gt 0
    commands = @($found | Select-Object -Unique)
  }
}

function Assert-NoHostRuntimes {
  param(
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$State
  )

  if ($State.present) {
    throw "This clean VM scenario requires no host Node, npm, npx, or Bun on PATH. Detected: $($State.commands -join ', ')."
  }
}

function Get-SystemEvidence {
  $os = Get-CimInstance -ClassName Win32_OperatingSystem
  return [ordered]@{
    windows = [ordered]@{
      caption = [string]$os.Caption
      version = [string]$os.Version
      buildNumber = [string]$os.BuildNumber
      architecture = [string]$os.OSArchitecture
    }
    webView2 = Get-WebView2State
    wsl = Get-WslState
    hostRuntimes = Get-HostRuntimeState
  }
}

function Resolve-AppLocalDataDirectory {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "LOCALAPPDATA is required to locate the production Veslo app-local-data directory."
  }
  return Join-Path $env:LOCALAPPDATA "com.neatech.veslo"
}

function Get-ProductionProfileDirectories {
  $directories = @(Resolve-AppLocalDataDirectory)
  if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
    $directories += Join-Path $env:APPDATA "com.neatech.veslo"
  }
  return @($directories | Select-Object -Unique)
}

function Assert-FreshAppProfile {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Paths
  )

  $existing = @($Paths | Where-Object { Test-Path -LiteralPath $_ })
  if ($existing.Count -ne 0) {
    throw "This clean VM scenario requires no existing Veslo app data. Existing path: $($existing -join ', ')"
  }
}

function Assert-NoInstalledVesloRuntimeProcess {
  $runtimeNames = @(
    "veslo.exe",
    "veslo-server.exe",
    "veslo-orchestrator.exe",
    "veslo-code-router.exe",
    "veslo-code.exe"
  )
  $filter = ($runtimeNames | ForEach-Object { "Name = '$_'" }) -join " OR "
  $processes = @(
    Get-CimInstance -ClassName Win32_Process -Filter $filter -ErrorAction SilentlyContinue |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) }
  )
  if ($processes.Count -ne 0) {
    $found = @($processes | ForEach-Object { "$($_.Name) (pid=$($_.ProcessId))" }) -join ", "
    throw "An existing Veslo runtime process is running: $found. The verifier will not terminate an unowned process."
  }
}

function Start-InstalledApp {
  param(
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$InstalledApp
  )

  $cleanPath = "$($InstalledApp.appRoot);$env:SystemRoot\System32;$env:SystemRoot"
  $workingDirectory = New-OwnedTemporaryDirectory
  $encodedAppPath = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($InstalledApp.executable))
  $encodedPath = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cleanPath))
  $encodedWorkingDirectory = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($workingDirectory))
  $command = @'
$ErrorActionPreference = "Stop"
$appPath = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__APP_PATH__"))
$cleanPath = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__CLEAN_PATH__"))
$workingDirectory = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__WORKING_DIRECTORY__"))
foreach ($name in @([Environment]::GetEnvironmentVariables().Keys)) {
  $text = [string]$name
  # The installed-MSI gate must observe production defaults, never a parent
  # shell's development override. The desktop passes inherited environment to
  # its sidecars, so clearing only the currently known individual variables is
  # not sufficient (for example VESLO_DOCUMENT_RUNTIME_MODULE).
  if ($text -match "^(E2E_|VESLO_|VITE_|OPENCODE_)" -or
      $text -match "^(OPENAI_|ANTHROPIC_|OPENROUTER_|GOOGLE_|GEMINI_|MISTRAL_|GROQ_|COHERE_|TOGETHER_|DEEPSEEK_|XAI_|AZURE_)" -or
      $text -match "(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)") {
    [Environment]::SetEnvironmentVariable($text, $null, "Process")
  }
}
$env:PATH = $cleanPath
$process = Start-Process -FilePath $appPath -WorkingDirectory $workingDirectory -PassThru
[Console]::Out.WriteLine($process.Id)
'@
  $command = $command.Replace("__APP_PATH__", $encodedAppPath)
  $command = $command.Replace("__CLEAN_PATH__", $encodedPath)
  $command = $command.Replace("__WORKING_DIRECTORY__", $encodedWorkingDirectory)
  $hostExecutable = (Get-Process -Id $PID).Path
  $output = @(& $hostExecutable -NoProfile -NonInteractive -EncodedCommand ([Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($command))) 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not launch the installed Veslo desktop process with the clean production PATH."
  }
  $pidText = @($output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -match "^\\d+$" } | Select-Object -Last 1)
  if ($pidText.Count -ne 1) {
    throw "Could not determine the PID of the installed Veslo desktop process."
  }
  $process = Get-Process -Id ([int]$pidText[0]) -ErrorAction Stop
  $script:StartedProcessIds += $process.Id
  $script:LaunchedAppProcessIds += $process.Id
  $script:CurrentAppProcess = $process
  return $process
}

function WaitFor-MainWindow {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    try {
      $Process.Refresh()
      if ($Process.HasExited) {
        throw "Installed Veslo desktop process exited before it exposed a main window."
      }
      if ($Process.MainWindowHandle -ne [IntPtr]::Zero) {
        return [ordered]@{
          processId = $Process.Id
          exists = $true
        }
      }
    } catch {
      throw $_
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Installed Veslo desktop process did not expose a main window within $($TimeoutMilliseconds)ms."
}

function Read-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  try {
    return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch {
    return $null
  }
}

function Assert-ServerProcessBelongsToInstalledApp {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,

    [Parameter(Mandatory = $true)]
    [hashtable]$InstalledApp
  )

  $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  $path = [string]$process.ExecutablePath
  $expected = Join-Path $InstalledApp.appRoot "veslo-server.exe"
  if (-not [string]::Equals($path, $expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime descriptor does not point to the bundled veslo-server.exe beside the installed desktop application."
  }
}

function Invoke-LocalVesloJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [Parameter(Mandatory = $true)]
    [string]$Path,

    [AllowNull()][string]$ClientToken
  )

  $url = $BaseUrl.TrimEnd("/") + $Path
  try {
    $request = [System.Net.HttpWebRequest]::Create($url)
    $request.Method = "GET"
    $request.Timeout = 5000
    $request.ReadWriteTimeout = 5000
    if (-not [string]::IsNullOrWhiteSpace($ClientToken)) {
      $request.Headers["Authorization"] = "Bearer $ClientToken"
    }
    $response = $request.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      try {
        return $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
      } finally {
        $reader.Dispose()
      }
    } finally {
      $response.Dispose()
    }
  } catch {
    throw "Local Veslo server request $Path failed: $($_.Exception.GetType().Name)"
  }
}

function Get-AuthenticatedRuntimeEvidence {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppLocalDataDirectory,

    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$InstalledApp,

    [switch]$RequireRuntimeReady
  )

  $descriptorPath = Join-Path $AppLocalDataDirectory "veslo-server-runtime.json"
  $statePath = Join-Path $AppLocalDataDirectory "veslo-server-state.json"
  $descriptor = Read-JsonFile -Path $descriptorPath
  $state = Read-JsonFile -Path $statePath
  if ($null -eq $descriptor -or $null -eq $state) {
    throw "Installed Veslo runtime descriptor or persisted state is not available yet."
  }

  $baseUrl = [string](Get-OptionalProperty -Value $state -Name "baseUrl")
  $clientToken = [string](Get-OptionalProperty -Value $state -Name "clientToken")
  $descriptorBaseUrl = [string](Get-OptionalProperty -Value $descriptor -Name "baseUrl")
  $descriptorPid = Get-OptionalProperty -Value $descriptor -Name "pid"
  if ([string]::IsNullOrWhiteSpace($baseUrl) -or [string]::IsNullOrWhiteSpace($clientToken) -or
      [string]::IsNullOrWhiteSpace($descriptorBaseUrl) -or $null -eq $descriptorPid) {
    throw "Installed Veslo runtime state is missing the local endpoint, client credential, or descriptor PID."
  }
  if (-not [string]::Equals($baseUrl.TrimEnd("/"), $descriptorBaseUrl.TrimEnd("/"), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Persisted Veslo server state and runtime descriptor disagree on the local endpoint."
  }

  try {
    $uri = [Uri]$baseUrl
  } catch {
    throw "Runtime descriptor contains an invalid local server URL."
  }
  if (-not $uri.IsLoopback) {
    throw "Installed Veslo runtime descriptor must point at a loopback server."
  }

  $serverPid = [int]$descriptorPid
  Assert-ServerProcessBelongsToInstalledApp -ProcessId $serverPid -InstalledApp $InstalledApp
  $health = Invoke-LocalVesloJson -BaseUrl $baseUrl -Path "/health" -ClientToken $null
  $status = Invoke-LocalVesloJson -BaseUrl $baseUrl -Path "/status" -ClientToken $clientToken
  $documentRuntime = Invoke-LocalVesloJson -BaseUrl $baseUrl -Path "/document-runtime/status" -ClientToken $clientToken

  if ((Get-OptionalProperty -Value $health -Name "ok") -ne $true -or [int](Get-OptionalProperty -Value $health -Name "pid") -ne $serverPid) {
    throw "Bundled Veslo server did not return a matching healthy runtime identity."
  }
  $descriptorInstanceId = [string](Get-OptionalProperty -Value $descriptor -Name "instanceId")
  $healthInstanceId = [string](Get-OptionalProperty -Value $health -Name "instanceId")
  if (-not [string]::IsNullOrWhiteSpace($descriptorInstanceId) -and $descriptorInstanceId -ne $healthInstanceId) {
    throw "Bundled Veslo server health identity does not match the runtime descriptor."
  }
  if ((Get-OptionalProperty -Value $status -Name "ok") -ne $true) {
    throw "Authenticated Veslo server status did not report ok."
  }

  $runtimeChain = Get-OptionalProperty -Value $status -Name "runtimeChain"
  $runtimeChainStatus = [string](Get-OptionalProperty -Value $runtimeChain -Name "status")
  if ($runtimeChainStatus -notin @("server_running", "runtime_chain_ready")) {
    throw "Authenticated Veslo server readiness is unhealthy: $runtimeChainStatus"
  }
  if ($RequireRuntimeReady -and $runtimeChainStatus -ne "runtime_chain_ready") {
    throw "This scenario requires runtime_chain_ready, but the bundled runtime reported $runtimeChainStatus."
  }

  $documentRuntimeStatus = [string](Get-OptionalProperty -Value $documentRuntime -Name "status")
  $documentRuntimeProvider = [string](Get-OptionalProperty -Value $documentRuntime -Name "providerMode")
  if ($documentRuntimeStatus -notin @("missing", "ready")) {
    throw "Installed document runtime must be missing or ready, never provider-blocked. Actual status: $documentRuntimeStatus"
  }
  if ($documentRuntimeProvider -ne "bundled") {
    throw "Installed document runtime must use the bundled provider. Actual provider mode: $documentRuntimeProvider"
  }

  return [ordered]@{
    descriptor = [ordered]@{
      schemaVersion = Get-OptionalProperty -Value $descriptor -Name "schemaVersion"
      type = Get-OptionalProperty -Value $descriptor -Name "type"
      instanceId = $descriptorInstanceId
      port = Get-OptionalProperty -Value $descriptor -Name "port"
      pid = $serverPid
      baseUrl = $baseUrl.TrimEnd("/")
    }
    health = [ordered]@{
      ok = $true
      pid = $serverPid
      instanceId = $healthInstanceId
      version = Get-OptionalProperty -Value $health -Name "version"
    }
    authenticatedStatus = [ordered]@{
      ok = $true
      runtimeChainStatus = $runtimeChainStatus
      workspaceCount = Get-OptionalProperty -Value $status -Name "workspaceCount"
    }
    documentRuntime = [ordered]@{
      status = $documentRuntimeStatus
      providerMode = $documentRuntimeProvider
    }
  }
}

function WaitFor-AuthenticatedRuntimeEvidence {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppLocalDataDirectory,

    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$InstalledApp,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds,

    [switch]$RequireRuntimeReady
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  $lastFailure = "not attempted"
  do {
    try {
      return Get-AuthenticatedRuntimeEvidence -AppLocalDataDirectory $AppLocalDataDirectory -InstalledApp $InstalledApp -RequireRuntimeReady:$RequireRuntimeReady
    } catch {
      $lastFailure = ConvertTo-RedactedText -Value $_.Exception.Message
      Start-Sleep -Milliseconds 250
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Installed Veslo desktop did not reach authenticated server readiness within $($TimeoutMilliseconds)ms. Last observation: $lastFailure"
}

function Test-BootstrapEventIsRedacted {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Event
  )

  $serialized = $Event | ConvertTo-Json -Depth 16 -Compress
  if ($serialized -match "(?i)Bearer\\s+[A-Za-z0-9._~+/=-]+") {
    return $false
  }
  if ($serialized -match '"(?:clientToken|hostToken|token|secret|password|apiKey|credential)"\\s*:\\s*"(?!\\[redacted\\])[^\"]+') {
    return $false
  }
  return $true
}

function Get-FreshBootstrapReadyDiagnostic {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Event,

    [Parameter(Mandatory = $true)]
    [Int64]$NotBeforeTimestampNs
  )

  $payload = Get-OptionalProperty -Value $Event -Name "payload"
  if ([string](Get-OptionalProperty -Value $Event -Name "source") -ne "Veslo bootstrap" -or
      [string](Get-OptionalProperty -Value $Event -Name "stream") -ne "diagnostic" -or
      [string](Get-OptionalProperty -Value $payload -Name "eventType") -ne "desktop-bootstrap:ready") {
    return $null
  }
  $timestamp = Get-OptionalProperty -Value $Event -Name "timestamp"
  if ($null -eq $timestamp -or [Int64]$timestamp -lt $NotBeforeTimestampNs) {
    return $null
  }
  if (-not (Test-BootstrapEventIsRedacted -Event $Event)) {
    throw "desktop-bootstrap:ready contains unredacted secret material."
  }
  return $Event
}

function Find-BootstrapReadyDiagnostic {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppLocalDataDirectory,

    [Parameter(Mandatory = $true)]
    [Int64]$NotBeforeTimestampNs
  )

  $spool = Join-Path $AppLocalDataDirectory "desktop-debug-log-spool"
  if (-not (Test-Path -LiteralPath $spool -PathType Container)) {
    return $null
  }

  $markerPath = Join-Path $spool "desktop-bootstrap-ready.json"
  $markerEvent = $null
  if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
    try {
      $markerRaw = Get-Content -LiteralPath $markerPath -Raw -ErrorAction Stop
      if (-not [string]::IsNullOrWhiteSpace($markerRaw)) {
        $markerEvent = $markerRaw | ConvertFrom-Json -ErrorAction Stop
      }
    } catch {
      # The desktop may be replacing the marker. Retry on the next poll.
    }
  }
  if ($null -ne $markerEvent) {
    $freshMarker = Get-FreshBootstrapReadyDiagnostic -Event $markerEvent -NotBeforeTimestampNs $NotBeforeTimestampNs
    if ($null -ne $freshMarker) {
      return $freshMarker
    }
  }

  foreach ($file in Get-ChildItem -LiteralPath $spool -Filter "*.jsonl" -File -ErrorAction SilentlyContinue) {
    try {
      $lines = Get-Content -LiteralPath $file.FullName -ErrorAction Stop
    } catch {
      continue
    }
    foreach ($line in $lines) {
      if ([string]::IsNullOrWhiteSpace($line)) {
        continue
      }
      try {
        $event = $line | ConvertFrom-Json -ErrorAction Stop
      } catch {
        continue
      }
      $freshEvent = Get-FreshBootstrapReadyDiagnostic -Event $event -NotBeforeTimestampNs $NotBeforeTimestampNs
      if ($null -ne $freshEvent) {
        return $freshEvent
      }
    }
  }

  return $null
}

function WaitFor-BootstrapReadyDiagnostic {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppLocalDataDirectory,

    [Parameter(Mandatory = $true)]
    [Int64]$NotBeforeTimestampNs,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    $event = Find-BootstrapReadyDiagnostic -AppLocalDataDirectory $AppLocalDataDirectory -NotBeforeTimestampNs $NotBeforeTimestampNs
    if ($null -ne $event) {
      $payload = Get-OptionalProperty -Value $event -Name "payload"
      $serverStatus = [string](Get-OptionalProperty -Value $payload -Name "serverStatus")
      $runtimeReadiness = [string](Get-OptionalProperty -Value $payload -Name "runtimeReadiness")
      if ($serverStatus -ne "connected" -or $runtimeReadiness -ne "ready") {
        throw "desktop-bootstrap:ready must report connected serverStatus and ready runtimeReadiness."
      }
      return [ordered]@{
        eventType = "desktop-bootstrap:ready"
        timestamp = Get-OptionalProperty -Value $event -Name "timestamp"
        serverStatus = $serverStatus
        runtimeReadiness = $runtimeReadiness
        workspaceType = Get-OptionalProperty -Value $payload -Name "workspaceType"
        redacted = $true
      }
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Installed Veslo desktop did not write a redacted desktop-bootstrap:ready diagnostic within $($TimeoutMilliseconds)ms."
}

function Invoke-StartupEvidenceCycle {
  param(
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$InstalledApp,

    [Parameter(Mandatory = $true)]
    [string]$AppLocalDataDirectory,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds,

    [switch]$RequireRuntimeReady
  )

  Assert-NoInstalledVesloRuntimeProcess
  $launchStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() * 1000000
  $process = Start-InstalledApp -InstalledApp $InstalledApp
  $mainWindow = WaitFor-MainWindow -Process $process -TimeoutMilliseconds $TimeoutMilliseconds
  $runtime = WaitFor-AuthenticatedRuntimeEvidence -AppLocalDataDirectory $AppLocalDataDirectory -InstalledApp $InstalledApp -TimeoutMilliseconds $TimeoutMilliseconds -RequireRuntimeReady:$RequireRuntimeReady
  $bootstrap = WaitFor-BootstrapReadyDiagnostic -AppLocalDataDirectory $AppLocalDataDirectory -NotBeforeTimestampNs $launchStartedAt -TimeoutMilliseconds $TimeoutMilliseconds
  return [ordered]@{
    app = [ordered]@{
      processId = $process.Id
      path = $InstalledApp.executable
      underProgramFiles = $InstalledApp.underProgramFiles
      mainWindow = $mainWindow
    }
    runtime = $runtime
    bootstrap = $bootstrap
  }
}

function Stop-AppNormally {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds
  )

  $Process.Refresh()
  if ($Process.HasExited) {
    throw "Owned Veslo desktop process exited before normal shutdown could be tested."
  }
  if (-not $Process.CloseMainWindow()) {
    throw "Owned Veslo desktop process refused a normal close request."
  }
  if (-not $Process.WaitForExit($TimeoutMilliseconds)) {
    throw "Owned Veslo desktop process did not exit after a normal close request."
  }
  return [ordered]@{
    mode = "normal"
    processId = $Process.Id
    exited = $true
  }
}

function WaitFor-OwnedProcessExit {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,

    [Parameter(Mandatory = $true)]
    [string]$Label,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    try {
      $process = Get-Process -Id $ProcessId -ErrorAction Stop
      $process.Refresh()
      if ($process.HasExited) {
        return $true
      }
    } catch {
      return $true
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "Owned $Label process (pid=$ProcessId) did not exit within $($TimeoutMilliseconds)ms."
}

function Start-ForeignListener {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds
  )

  $existing = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($existing.Count -ne 0) {
    throw "Cannot create the foreign-listener scenario because port $Port is already occupied. The verifier will not terminate an unowned listener."
  }

  $workRoot = New-OwnedTemporaryDirectory
  $readyPath = Join-Path $workRoot "listener-ready.txt"
  $encodedReadyPath = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($readyPath))
  $command = @'
$ErrorActionPreference = "Stop"
$readyPath = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__READY_PATH__"))
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, __PORT__)
$listener.Start()
Set-Content -LiteralPath $readyPath -Value "ready" -Encoding ASCII
try {
  while ($true) {
    Start-Sleep -Seconds 1
  }
} finally {
  $listener.Stop()
}
'@
  $command = $command.Replace("__READY_PATH__", $encodedReadyPath)
  $command = $command.Replace("__PORT__", [string]$Port)
  $process = Start-EncodedPowerShell -Command $command -Label "foreign listener"
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    if ((Test-Path -LiteralPath $readyPath -PathType Leaf) -and -not $process.HasExited) {
      return [ordered]@{
        process = $process
        port = $Port
        workRoot = $workRoot
      }
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)

  Stop-OwnedProcessTree -Process $process -Label "foreign listener"
  throw "Foreign listener did not bind 127.0.0.1:$Port within $($TimeoutMilliseconds)ms."
}

function Assert-ForeignListenerStillRunning {
  param(
    [Parameter(Mandatory = $true)]
    [System.Collections.IDictionary]$Listener
  )

  $process = Get-Process -Id $Listener.process.Id -ErrorAction Stop
  $process.Refresh()
  if ($process.HasExited) {
    throw "The foreign listener process was terminated during Veslo startup."
  }
  $connections = @(Get-NetTCPConnection -LocalPort $Listener.port -State Listen -ErrorAction SilentlyContinue)
  if (-not ($connections | Where-Object { $_.OwningProcess -eq $Listener.process.Id })) {
    throw "The foreign listener no longer owns its expected port after Veslo startup."
  }
}

function Get-UpdaterLogEvidence {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [datetime]$NotBeforeUtc
  )

  if ($NotBeforeUtc -eq [datetime]::MinValue) {
    throw "Updater scenario requires -UpdaterLogNotBeforeUtc captured before the real in-app updater transaction."
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Updater scenario requires the production updater MSI log at $Path."
  }
  $tail = Get-TextLogTail -Path $Path -MaximumCharacters 8192
  if ($tail -notmatch "MainEngineThread is returning 0") {
    throw "Production updater MSI log does not show a successful Windows Installer transaction: $Path"
  }
  $item = Get-Item -LiteralPath $Path
  $notBefore = $NotBeforeUtc.ToUniversalTime()
  if ($item.LastWriteTimeUtc -lt $notBefore) {
    throw "Production updater MSI log predates the declared updater transaction: $Path"
  }
  return [ordered]@{
    path = $item.FullName
    notBeforeUtc = $notBefore.ToString("o")
    lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString("o")
    succeeded = $true
  }
}

$summaryOutputPath = $null
$failure = $null
$succeeded = $false
$summary = [ordered]@{
  schemaVersion = 1
  ok = $false
  scenario = $Scenario
  startedAt = [DateTime]::UtcNow.ToString("o")
  release = [ordered]@{
    tag = $ReleaseTag
    commit = $Commit.ToLowerInvariant()
  }
  system = $null
  msi = [ordered]@{
    candidate = $null
    baseline = $null
  }
  install = [ordered]@{
    baseline = $null
    candidate = $null
    updater = $null
  }
  installed = $null
  startups = @()
  foreignListener = $null
  cleanup = [ordered]@{
    startedProcessIds = @()
    launchedAppProcessIds = @()
    temporaryDirectoriesRemoved = @()
  }
  error = $null
}

try {
  $summaryOutputPath = [System.IO.Path]::GetFullPath($SummaryPath)
  $summaryDirectory = Split-Path -Parent $summaryOutputPath
  if (-not [string]::IsNullOrWhiteSpace($summaryDirectory)) {
    New-Item -ItemType Directory -Force -Path $summaryDirectory | Out-Null
  }

  $candidateMsiPath = Get-ExactMsiPath -Path $MsiPath
  # Both /a and /i are Windows Installer transactions. Refuse before either
  # one starts so an accidental non-elevated local invocation cannot leave a
  # service-owned msiexec process behind.
  Assert-Administrator
  $candidateProperties = Get-MsiProperties -Path $candidateMsiPath
  $candidateMsiCustomActions = @(Get-MsiCustomActions -Path $candidateMsiPath)
  Assert-WslSandboxCustomActionsExcluded -CustomActions $candidateMsiCustomActions
  $summary.system = Get-SystemEvidence
  Assert-WebView2Expectation -State $summary.system.webView2 -Expectation $WebView2Expectation
  if ($RequireNoWsl -or $Scenario -eq "clean-no-wsl") {
    Assert-NoWsl -State $summary.system.wsl
  }

  $profileDirectories = Get-ProductionProfileDirectories
  $appLocalDataDirectory = Resolve-AppLocalDataDirectory
  if ($Scenario -in @("clean", "clean-no-wsl")) {
    Assert-FreshAppProfile -Paths $profileDirectories
    Assert-NoHostRuntimes -State $summary.system.hostRuntimes
  }

  $summary.msi.candidate = [ordered]@{
    path = $candidateMsiPath
    sha256 = Get-FileSha256 -Path $candidateMsiPath
    productCode = $candidateProperties.productCode
    productName = $candidateProperties.productName
    productVersion = $candidateProperties.productVersion
    allUsers = $candidateProperties.allUsers
    customActionCount = $candidateMsiCustomActions.Count
    wslSandboxCustomActionsExcluded = $true
    expectedPayload = Get-ExtractedMsiPayloadSnapshot -Path $candidateMsiPath -MsiProperties $candidateProperties -TimeoutMilliseconds $TimeoutMs -RequireNoWslSandboxPayload
  }

  if ($Scenario -eq "upgrade") {
    if ([string]::IsNullOrWhiteSpace($BaselineMsiPath)) {
      throw "Upgrade scenario requires -BaselineMsiPath for the supported baseline MSI."
    }
    Assert-NoInstalledVesloRuntimeProcess
    $baselinePath = Get-ExactMsiPath -Path $BaselineMsiPath
    $baselineProperties = Get-MsiProperties -Path $baselinePath
    if ($baselineProperties.productVersion -ne $ExpectedBaselineVersion) {
      throw "Upgrade scenario requires baseline MSI ProductVersion $ExpectedBaselineVersion; received $($baselineProperties.productVersion)."
    }
    $summary.msi.baseline = [ordered]@{
      path = $baselinePath
      sha256 = Get-FileSha256 -Path $baselinePath
      productCode = $baselineProperties.productCode
      productName = $baselineProperties.productName
      productVersion = $baselineProperties.productVersion
      allUsers = $baselineProperties.allUsers
      expectedPayload = Get-ExtractedMsiPayloadSnapshot -Path $baselinePath -MsiProperties $baselineProperties -TimeoutMilliseconds $TimeoutMs
    }
    $baselineLogPath = "$summaryOutputPath.baseline-msiexec-install.log"
    $summary.install.baseline = Invoke-MsiInstall -Path $baselinePath -LogPath $baselineLogPath -TimeoutMilliseconds $TimeoutMs
    $baselineInstalledApp = Get-InstalledApp -MsiProperties $baselineProperties
    $baselineInstalledPayload = Get-InstalledPayloadSnapshot -InstalledApp $baselineInstalledApp -MsiProperties $baselineProperties
    Assert-PayloadMatchesMsi -Expected $summary.msi.baseline.expectedPayload -Installed $baselineInstalledPayload
    $candidateLogPath = "$summaryOutputPath.msiexec-install.log"
    $summary.install.candidate = Invoke-MsiInstall -Path $candidateMsiPath -LogPath $candidateLogPath -TimeoutMilliseconds $TimeoutMs
  } elseif ($Scenario -ne "updater") {
    Assert-NoInstalledVesloRuntimeProcess
    $candidateLogPath = "$summaryOutputPath.msiexec-install.log"
    $summary.install.candidate = Invoke-MsiInstall -Path $candidateMsiPath -LogPath $candidateLogPath -TimeoutMilliseconds $TimeoutMs
  } else {
    $summary.install.updater = Get-UpdaterLogEvidence -Path $UpdaterLogPath -NotBeforeUtc $UpdaterLogNotBeforeUtc
  }

  $installedApp = Get-InstalledApp -MsiProperties $candidateProperties
  $installedPayload = Get-InstalledPayloadSnapshot -InstalledApp $installedApp -MsiProperties $candidateProperties
  Assert-PayloadMatchesMsi -Expected $summary.msi.candidate.expectedPayload -Installed $installedPayload
  $summary.installed = [ordered]@{
    app = $installedApp
    payload = $installedPayload
    appLocalDataDirectory = ConvertTo-RedactedText -Value $appLocalDataDirectory
    profileDirectories = @($profileDirectories | ForEach-Object { ConvertTo-RedactedText -Value $_ })
  }

  if ($Scenario -eq "foreign-listener") {
    $script:ForeignListener = Start-ForeignListener -Port $ExpectedPort -TimeoutMilliseconds $TimeoutMs
  }

  $firstStartup = Invoke-StartupEvidenceCycle -InstalledApp $installedApp -AppLocalDataDirectory $appLocalDataDirectory -TimeoutMilliseconds $TimeoutMs -RequireRuntimeReady:$RequireRuntimeChainReady
  $summary.startups += $firstStartup

  if ($Scenario -eq "foreign-listener") {
    Assert-ForeignListenerStillRunning -Listener $script:ForeignListener
    if ([int]$firstStartup.runtime.descriptor.port -eq $ExpectedPort) {
      throw "Veslo reused the foreign listener port instead of taking the safe fallback branch."
    }
    $summary.foreignListener = [ordered]@{
      port = $script:ForeignListener.port
      processId = $script:ForeignListener.process.Id
      survivedStartup = $true
      vesloRuntimePort = $firstStartup.runtime.descriptor.port
    }
  }

  if ($Scenario -eq "normal-second-start") {
    $firstServerProcessId = [int]$firstStartup.runtime.descriptor.pid
    $summary.normalShutdown = Stop-AppNormally -Process $script:CurrentAppProcess -TimeoutMilliseconds $TimeoutMs
    $summary.normalShutdown.serverProcessId = $firstServerProcessId
    $summary.normalShutdown.serverExited = WaitFor-OwnedProcessExit -ProcessId $firstServerProcessId -Label "bundled Veslo server" -TimeoutMilliseconds $TimeoutMs
    $script:CurrentAppProcess = $null
    $summary.startups += Invoke-StartupEvidenceCycle -InstalledApp $installedApp -AppLocalDataDirectory $appLocalDataDirectory -TimeoutMilliseconds $TimeoutMs -RequireRuntimeReady:$RequireRuntimeChainReady
  }

  if ($Scenario -eq "forced-runtime-second-start") {
    $forcedProcessId = $script:CurrentAppProcess.Id
    $forcedServerProcessId = [int]$firstStartup.runtime.descriptor.pid
    Stop-OwnedProcessTree -Process $script:CurrentAppProcess -Label "forced owned Veslo runtime"
    $summary.forcedShutdown = [ordered]@{
      mode = "taskkill-own-process-tree"
      processId = $forcedProcessId
      serverProcessId = $forcedServerProcessId
      serverExited = WaitFor-OwnedProcessExit -ProcessId $forcedServerProcessId -Label "bundled Veslo server" -TimeoutMilliseconds $TimeoutMs
      exited = $true
    }
    $script:CurrentAppProcess = $null
    $summary.startups += Invoke-StartupEvidenceCycle -InstalledApp $installedApp -AppLocalDataDirectory $appLocalDataDirectory -TimeoutMilliseconds $TimeoutMs -RequireRuntimeReady:$RequireRuntimeChainReady
  }

  $summary.ok = $true
  $succeeded = $true
} catch {
  $failure = $_
  $summary.error = ConvertTo-RedactedText -Value $_.Exception.Message
} finally {
  if ($null -ne $script:CurrentAppProcess) {
    try {
      Stop-OwnedProcessTree -Process $script:CurrentAppProcess -Label "installed Veslo desktop"
    } catch {
      $summary.cleanup.appCleanupError = ConvertTo-RedactedText -Value $_.Exception.Message
    }
  }
  if ($null -ne $script:ForeignListener) {
    try {
      Stop-OwnedProcessTree -Process $script:ForeignListener.process -Label "foreign listener"
    } catch {
      $summary.cleanup.foreignListenerCleanupError = ConvertTo-RedactedText -Value $_.Exception.Message
    }
  }
  foreach ($directory in @($script:OwnedTemporaryDirectories | Select-Object -Unique)) {
    try {
      if (Test-Path -LiteralPath $directory) {
        Remove-OwnedTemporaryDirectory -Path $directory
        $summary.cleanup.temporaryDirectoriesRemoved += $directory
      }
    } catch {
      $summary.cleanup.temporaryDirectoryCleanupError = ConvertTo-RedactedText -Value $_.Exception.Message
    }
  }

  $summary.cleanup.startedProcessIds = @($script:StartedProcessIds | Select-Object -Unique)
  $summary.cleanup.launchedAppProcessIds = @($script:LaunchedAppProcessIds | Select-Object -Unique)
  $summary.finishedAt = [DateTime]::UtcNow.ToString("o")
  $summary.summaryPath = $summaryOutputPath
  $json = $summary | ConvertTo-Json -Depth 20
  if ($summaryOutputPath) {
    Set-Content -LiteralPath $summaryOutputPath -Value $json -Encoding UTF8
  }
  Write-Output $json
}

if (-not $succeeded) {
  throw "Installed Windows MSI verification failed: $($summary.error) Evidence: $summaryOutputPath"
}
