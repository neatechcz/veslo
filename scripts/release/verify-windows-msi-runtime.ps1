[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateNotNullOrEmpty()]
  [string]$MsiPath,

  [ValidateRange(1000, 3600000)]
  [int]$TimeoutMs = 900000,

  [string]$SummaryPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$script:StartedProcessIds = @()
$script:MsiExtractionFinished = $false

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

    if ($text.Length -le $MaximumCharacters) {
      return $text.Trim()
    }

    return $text.Substring($text.Length - $MaximumCharacters).Trim()
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

function Stop-OwnedProcessTree {
  param(
    [Parameter(Mandatory = $true)]
    [System.Diagnostics.Process]$Process,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $Process.Refresh()
  if ($Process.HasExited) {
    return
  }

  & taskkill.exe /pid $Process.Id /t /f | Out-Null
  $script:StartedProcessIds += $Process.Id
  if (-not $Process.WaitForExit(5000)) {
    throw "Could not stop this verifier's $Label process tree (pid=$($Process.Id))."
  }
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
    [int]$TimeoutMilliseconds
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  do {
    $tail = Get-TextLogTail -Path $LogPath
    if ($tail -match 'MainEngineThread is returning ([0-9]+)' -and (Test-FileUnlocked -Path $LogPath)) {
      return [int]$Matches[1]
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  $tail = Get-TextLogTail -Path $LogPath
  $detail = if ($tail) { [Environment]::NewLine + "msiexec verbose log tail:" + [Environment]::NewLine + $tail } else { "" }
  throw "MSI administrative extraction did not complete within $($TimeoutMilliseconds)ms.$detail"
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
  $encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($command))
  $hostExecutable = (Get-Process -Id $PID).Path
  $process = Start-Process -FilePath $hostExecutable -ArgumentList @("-NoProfile", "-NonInteractive", "-EncodedCommand", $encodedCommand) -PassThru -WindowStyle Hidden
  $script:StartedProcessIds += $process.Id

  if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    try {
      Stop-OwnedProcessTree -Process $process -Label "msiexec"
    } catch {
      # The isolated host can already be gone after its child was terminated.
    }
    throw "MSI administrative extraction timed out after $($TimeoutMilliseconds)ms."
  }

  $process.Refresh()
  $msiExitCode = WaitFor-MsiLogCompletion -LogPath $LogPath -TimeoutMilliseconds $TimeoutMilliseconds
  $script:MsiExtractionFinished = $true
  if ($process.ExitCode -ne 0 -or $msiExitCode -ne 0) {
    $tail = Get-TextLogTail -Path $LogPath
    $detail = if ($tail) { [Environment]::NewLine + "msiexec verbose log tail:" + [Environment]::NewLine + $tail } else { "" }
    throw "MSI administrative extraction failed with launcher exit code $($process.ExitCode) and MSI exit code $msiExitCode.$detail"
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

function Get-FileSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Resolve-HostNodeExecutable {
  $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
  if ($null -eq $node -or -not $node.Source -or -not (Test-Path -LiteralPath $node.Source -PathType Leaf)) {
    throw "Could not resolve a host Node.js executable from PATH."
  }

  return $node.Source
}

function Get-WindowsAuthenticodeSha256 {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $helperPath = Join-Path $PSScriptRoot "windows-authenticode-hash.mjs"
  if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf)) {
    throw "Windows Authenticode hash helper is missing: $helperPath"
  }

  $nodeExecutable = Resolve-HostNodeExecutable
  $output = @(& $nodeExecutable $helperPath --file $Path 2>&1)
  $exitCode = $LASTEXITCODE
  $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine

  if ($exitCode -ne 0) {
    throw "Windows Authenticode hash helper failed with exit code $exitCode.$([Environment]::NewLine)$text"
  }

  $hash = $text.Trim()
  if ($hash -notmatch '^[a-fA-F0-9]{64}$') {
    throw "Windows Authenticode hash helper returned an invalid SHA-256 for ${Path}: $hash"
  }

  return $hash.ToLowerInvariant()
}

function Assert-PackagedVersions {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.FileInfo]$ManifestFile,

    [Parameter(Mandatory = $true)]
    [hashtable]$FilesByLogicalName,

    [string]$MsiProductVersion
  )

  try {
    $manifest = Get-Content -LiteralPath $ManifestFile.FullName -Raw | ConvertFrom-Json
  } catch {
    throw "Could not parse packaged versions manifest $($ManifestFile.FullName): $($_.Exception.Message)"
  }

  $manifestBindings = @(
    [PSCustomObject]@{ Key = "veslo-code"; FileKey = "veslo-code"; UsesAuthenticodeHash = $true }
    [PSCustomObject]@{ Key = "veslo-server"; FileKey = "veslo-server"; UsesAuthenticodeHash = $true }
    [PSCustomObject]@{ Key = "veslo-code-router"; FileKey = "veslo-code-router"; UsesAuthenticodeHash = $true }
    [PSCustomObject]@{ Key = "veslo-orchestrator"; FileKey = "veslo-orchestrator"; UsesAuthenticodeHash = $true }
    [PSCustomObject]@{ Key = "chrome-devtools-mcp"; FileKey = "chrome-devtools-mcp"; UsesAuthenticodeHash = $true }
    [PSCustomObject]@{ Key = "opencode-managed-deps"; FileKey = "opencode-managed-deps"; UsesAuthenticodeHash = $false }
  )

  $versions = [ordered]@{}
  foreach ($entry in $manifestBindings) {
    $manifestEntry = $manifest.PSObject.Properties[$entry.Key].Value
    $expectedHash = [string]$manifestEntry.sha256
    $version = [string]$manifestEntry.version
    if (-not $expectedHash -or $expectedHash -notmatch '^[a-fA-F0-9]{64}$') {
      throw "Packaged versions manifest is missing a SHA-256 for $($entry.Key)."
    }
    if (-not $version) {
      throw "Packaged versions manifest is missing a version for $($entry.Key)."
    }

    $file = $FilesByLogicalName[$entry.FileKey]
    if ($null -eq $file) {
      throw "Packaged payload is missing the file required by manifest entry $($entry.Key)."
    }

    if ($entry.UsesAuthenticodeHash) {
      $actualHash = Get-WindowsAuthenticodeSha256 -Path $file.FullName
    } else {
      $actualHash = Get-FileSha256 -Path $file.FullName
    }
    if (-not [string]::Equals($actualHash, $expectedHash.ToLowerInvariant(), [System.StringComparison]::Ordinal)) {
      throw "Packaged versions manifest SHA-256 mismatch for $($entry.Key): $actualHash vs $expectedHash"
    }
    $versions[$entry.Key] = $version
  }

  if ($MsiProductVersion -match '^(\d{2})\.(\d+)\.(\d+)$') {
    $expectedServerVersion = "20$($Matches[1]).$($Matches[2]).$($Matches[3])"
    if ($versions["veslo-server"] -ne $expectedServerVersion) {
      throw "Packaged veslo-server version $($versions['veslo-server']) does not match MSI ProductVersion $MsiProductVersion."
    }
  }

  return [ordered]@{
    path = $ManifestFile.FullName
    versions = $versions
  }
}

function Invoke-DocumentRuntimeProbe {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.FileInfo]$ServerFile,

    [Parameter(Mandatory = $true)]
    [string]$ProbePath
  )

  $nodeExecutable = Resolve-HostNodeExecutable
  $output = @(& $nodeExecutable $ProbePath --binary $ServerFile.FullName --json 2>&1)
  $exitCode = $LASTEXITCODE
  $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine

  if ($exitCode -ne 0) {
    throw "Compiled document-runtime probe failed with exit code $exitCode.$([Environment]::NewLine)$text"
  }

  try {
    return $text | ConvertFrom-Json
  } catch {
    throw "Compiled document-runtime probe did not return JSON: $text"
  }
}

function Invoke-ChromeDevtoolsProbe {
  param(
    [Parameter(Mandatory = $true)]
    [System.IO.FileInfo]$ChromeFile,

    [Parameter(Mandatory = $true)]
    [System.IO.FileInfo]$BundledNodeFile,

    [Parameter(Mandatory = $true)]
    [System.IO.FileInfo]$PackageEntrypoint,

    [Parameter(Mandatory = $true)]
    [string]$AppRoot,

    [Parameter(Mandatory = $true)]
    [string]$WorkRoot,

    [Parameter(Mandatory = $true)]
    [int]$TimeoutMilliseconds
  )

  $stdoutPath = Join-Path $WorkRoot "chrome-devtools-mcp.stdout.log"
  $stderrPath = Join-Path $WorkRoot "chrome-devtools-mcp.stderr.log"
  $cleanPath = "$AppRoot;$env:SystemRoot\System32"
  $encodedChromePath = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($ChromeFile.FullName))
  $encodedStdoutPath = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($stdoutPath))
  $encodedStderrPath = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($stderrPath))
  $encodedCleanPath = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cleanPath))
  $command = @'
$ErrorActionPreference = "Stop"
$chromePath = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__CHROME_PATH__"))
$stdoutPath = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__STDOUT_PATH__"))
$stderrPath = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__STDERR_PATH__"))
$env:Path = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("__CLEAN_PATH__"))
Remove-Item Env:VESLO_CHROME_DEVTOOLS_MCP_NODE_PATH -ErrorAction SilentlyContinue
& $chromePath --help 1> $stdoutPath 2> $stderrPath
exit $LASTEXITCODE
'@
  $command = $command.Replace("__CHROME_PATH__", $encodedChromePath)
  $command = $command.Replace("__STDOUT_PATH__", $encodedStdoutPath)
  $command = $command.Replace("__STDERR_PATH__", $encodedStderrPath)
  $command = $command.Replace("__CLEAN_PATH__", $encodedCleanPath)
  $encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($command))
  $hostExecutable = (Get-Process -Id $PID).Path
  $process = Start-Process -FilePath $hostExecutable -ArgumentList @("-NoProfile", "-NonInteractive", "-EncodedCommand", $encodedCommand) -PassThru -WindowStyle Hidden
  $script:StartedProcessIds += $process.Id
  if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    Stop-OwnedProcessTree -Process $process -Label "Chrome DevTools MCP"
    throw "Chrome DevTools MCP bundled-runtime probe timed out after $($TimeoutMilliseconds)ms."
  }

  $process.Refresh()
  $exitCode = $process.ExitCode
  $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
  $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
  if ($exitCode -ne 0) {
    throw "Chrome DevTools MCP bundled-runtime probe failed with exit code $exitCode.$([Environment]::NewLine)$stdout$([Environment]::NewLine)$stderr"
  }
  if ($stdout -notmatch 'Options:' -or $stdout -notmatch '--version') {
    throw "Chrome DevTools MCP bundled-runtime probe did not load its vendored CLI entrypoint.$([Environment]::NewLine)$stdout$([Environment]::NewLine)$stderr"
  }

  return [ordered]@{
    command = "$($ChromeFile.Name) --help"
    exitCode = $exitCode
    path = $cleanPath
    bundledNode = $BundledNodeFile.FullName
    vendoredEntrypoint = $PackageEntrypoint.FullName
  }
}

$verificationRoot = $null
$exactMsiPath = $null
$extractionRoot = $null
$extractionLogPath = $null
$summaryOutputPath = $null
$failureLogPath = $null
$succeeded = $false
$failure = $null
$summary = [ordered]@{
  schemaVersion = 1
  ok = $false
  startedAt = [DateTime]::UtcNow.ToString("o")
  msi = $null
  extraction = $null
  payload = $null
  documentRuntimeProbe = $null
  chromeDevtoolsProbe = $null
  cleanup = [ordered]@{
    startedProcessIds = @()
    tempPayloadRemoved = $false
  }
  error = $null
}

try {
  $exactMsiPath = Get-ExactMsiPath -Path $MsiPath
  $defaultSummaryPath = "$exactMsiPath.runtime-verification.json"
  $summaryOutputPath = if ($SummaryPath) { [System.IO.Path]::GetFullPath($SummaryPath) } else { $defaultSummaryPath }
  $summaryDirectory = Split-Path -Parent $summaryOutputPath
  if ($summaryDirectory) {
    New-Item -ItemType Directory -Force -Path $summaryDirectory | Out-Null
  }

  $msiProperties = Get-MsiProperties -Path $exactMsiPath
  $msiCustomActions = @(Get-MsiCustomActions -Path $exactMsiPath)
  Assert-WslSandboxCustomActionsExcluded -CustomActions $msiCustomActions
  $summary.msi = [ordered]@{
    path = $exactMsiPath
    sha256 = Get-FileSha256 -Path $exactMsiPath
    productVersion = $msiProperties.productVersion
    allUsers = $msiProperties.allUsers
    customActionCount = $msiCustomActions.Count
    wslSandboxCustomActionsExcluded = $true
  }

  # The vendored Chrome package has deep paths. Keep this under the user's
  # private temp directory, but use a short root so MSI administrative
  # extraction remains below Windows' legacy path limit.
  $verificationBase = Join-Path ([System.IO.Path]::GetTempPath()) "v"
  New-Item -ItemType Directory -Force -Path $verificationBase | Out-Null
  $verificationRoot = Join-Path $verificationBase ([guid]::NewGuid().ToString("N").Substring(0, 8))
  $extractionRoot = Join-Path $verificationRoot "payload"
  $extractionLogPath = Join-Path $verificationRoot "msiexec-admin-extract.log"
  Invoke-MsiAdministrativeExtraction -Path $exactMsiPath -Destination $extractionRoot -LogPath $extractionLogPath -TimeoutMilliseconds $TimeoutMs

  $allFiles = @(Get-ChildItem -LiteralPath $extractionRoot -Recurse -File -Force)
  Assert-WslSandboxPayloadExcluded -Files $allFiles
  $desktopFile = Get-PayloadFile -Files $allFiles -LogicalName "Veslo desktop executable" -Names @("veslo.exe")
  $appRoot = Split-Path -Parent $desktopFile.FullName

  $requirements = [ordered]@{
    "veslo-code" = @("veslo-code.exe")
    "opencode" = @("opencode.exe")
    "veslo-server" = @("veslo-server.exe")
    "veslo-code-router" = @("veslo-code-router.exe")
    "veslo-orchestrator" = @("veslo-orchestrator.exe")
    "chrome-devtools-mcp" = @("chrome-devtools-mcp.exe")
    "veslo-node" = @("veslo-node.exe", "Bin_veslo_node.exe")
    "versions-manifest" = @("versions.json.exe")
    "opencode-managed-deps" = @("opencode-managed-deps.json.exe")
  }

  $payloadFiles = @{}
  foreach ($requirement in $requirements.GetEnumerator()) {
    $file = Get-PayloadFile -Files $allFiles -LogicalName $requirement.Key -Names $requirement.Value
    Assert-FileIsInAppRoot -File $file -AppRoot $appRoot -LogicalName $requirement.Key
    $payloadFiles[$requirement.Key] = $file
  }

  $entrypointSuffix = "\chrome-devtools-mcp-package\build\src\index.js"
  $entrypointMatches = @($allFiles | Where-Object { $_.FullName.EndsWith($entrypointSuffix, [System.StringComparison]::OrdinalIgnoreCase) })
  if ($entrypointMatches.Count -ne 1) {
    $found = if ($entrypointMatches.Count) { $entrypointMatches.FullName -join ", " } else { "none" }
    throw "Expected exactly one vendored Chrome DevTools MCP entrypoint; found: $found"
  }
  $packageEntrypoint = $entrypointMatches[0]
  if (-not $packageEntrypoint.FullName.StartsWith("$appRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Vendored Chrome DevTools MCP entrypoint is outside the Veslo payload: $($packageEntrypoint.FullName)"
  }

  $manifestResult = Assert-PackagedVersions -ManifestFile $payloadFiles["versions-manifest"] -FilesByLogicalName $payloadFiles -MsiProductVersion $msiProperties.productVersion
  $probePath = Join-Path $PSScriptRoot "probe-veslo-server-document-runtime.mjs"
  if (-not (Test-Path -LiteralPath $probePath -PathType Leaf)) {
    throw "Compiled document-runtime probe is missing: $probePath"
  }

  $summary.extraction = [ordered]@{
    appRoot = $appRoot
    fileCount = $allFiles.Count
  }
  $summary.payload = [ordered]@{
    desktop = $desktopFile.FullName
    files = [ordered]@{}
    wslSandboxPayloadExcluded = $true
    versionsManifest = $manifestResult
    chromeDevtoolsEntrypoint = $packageEntrypoint.FullName
  }
  foreach ($entry in $payloadFiles.GetEnumerator()) {
    $summary.payload.files[$entry.Key] = $entry.Value.FullName
  }

  $summary.documentRuntimeProbe = Invoke-DocumentRuntimeProbe -ServerFile $payloadFiles["veslo-server"] -ProbePath $probePath
  $summary.chromeDevtoolsProbe = Invoke-ChromeDevtoolsProbe -ChromeFile $payloadFiles["chrome-devtools-mcp"] -BundledNodeFile $payloadFiles["veslo-node"] -PackageEntrypoint $packageEntrypoint -AppRoot $appRoot -WorkRoot $verificationRoot -TimeoutMilliseconds $TimeoutMs

  $summary.ok = $true
  $succeeded = $true
} catch {
  $failure = $_
  $summary.error = $_.Exception.Message
} finally {
  if ($verificationRoot -and (Test-Path -LiteralPath $verificationRoot)) {
    if (-not $succeeded -and $extractionLogPath -and (Test-Path -LiteralPath $extractionLogPath)) {
      $failureLogPath = "$summaryOutputPath.msi-extract.log"
      Copy-Item -LiteralPath $extractionLogPath -Destination $failureLogPath -Force
    }
    if ($script:MsiExtractionFinished) {
      try {
        Remove-Item -LiteralPath $verificationRoot -Recurse -Force -ErrorAction Stop
        $summary.cleanup.tempPayloadRemoved = $true
      } catch {
        $summary.cleanup.error = $_.Exception.Message
      }
    } else {
      $summary.cleanup.error = "Temporary payload was retained because Windows Installer did not finish its own transaction."
    }
  }

  $summary.cleanup.startedProcessIds = @($script:StartedProcessIds | Select-Object -Unique)
  if ($failureLogPath) {
    $summary.extractionLog = $failureLogPath
  }
  $summary.finishedAt = [DateTime]::UtcNow.ToString("o")
  $summary.summaryPath = $summaryOutputPath

  $json = $summary | ConvertTo-Json -Depth 12
  if ($summaryOutputPath) {
    Set-Content -LiteralPath $summaryOutputPath -Value $json -Encoding UTF8
  }
  Write-Output $json
}

if ($null -ne $failure) {
  $logHint = if ($failureLogPath) { " Extraction log: $failureLogPath" } else { "" }
  throw "Windows MSI runtime verification failed: $($failure.Exception.Message)$logHint"
}
