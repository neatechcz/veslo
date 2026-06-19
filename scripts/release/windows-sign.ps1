param(
  [Parameter(Mandatory = $true)]
  [string]$TargetFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-SignToolPath {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $sdkRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (-not (Test-Path $sdkRoot)) {
    throw "Windows SDK SignTool directory not found at $sdkRoot."
  }

  $candidates = Get-ChildItem -Path $sdkRoot -Filter signtool.exe -Recurse -File |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object FullName -Descending

  if (-not $candidates) {
    throw "signtool.exe not found under $sdkRoot."
  }

  return $candidates[0].FullName
}

function Resolve-DlibPath {
  if ($env:VESLO_ARTIFACT_SIGNING_DLIB_PATH -and (Test-Path $env:VESLO_ARTIFACT_SIGNING_DLIB_PATH)) {
    return $env:VESLO_ARTIFACT_SIGNING_DLIB_PATH
  }

  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\AzureCodeSigning\bin\x64\Azure.CodeSigning.Dlib.dll"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\MicrosoftTrustedSigningClientTools\x64\Azure.CodeSigning.Dlib.dll")
  ) | Where-Object { $_ -and (Test-Path $_) }

  if (-not $candidates) {
    $searchRoots = @(
      (Join-Path ${env:ProgramFiles(x86)} "Windows Kits"),
      (Join-Path $env:LOCALAPPDATA "Microsoft")
    ) | Where-Object { $_ -and (Test-Path $_) }

    foreach ($root in $searchRoots) {
      $match = Get-ChildItem -Path $root -Filter Azure.CodeSigning.Dlib.dll -Recurse -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($match) {
        $candidates = @($match.FullName)
        break
      }
    }
  }

  if (-not $candidates) {
    throw "Azure.CodeSigning.Dlib.dll was not found. Install Artifact Signing Client Tools first."
  }

  return $candidates[0]
}

function Read-PositiveIntEnv {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [int]$DefaultValue
  )

  $raw = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $DefaultValue
  }

  $parsed = 0
  if (-not [int]::TryParse($raw, [ref]$parsed) -or $parsed -lt 1) {
    throw "$Name must be a positive integer. Got: $raw"
  }

  return $parsed
}

function Invoke-SignToolWithTimeout {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [Parameter(Mandatory = $true)]
    [string]$TargetPath,
    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)]
    [int]$MaxAttempts
  )

  $timeoutMs = $TimeoutSeconds * 1000

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if ($MaxAttempts -gt 1) {
      Write-Host "Signing attempt $attempt of $MaxAttempts"
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    foreach ($argument in $Arguments) {
      [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo

    [void]$process.Start()
    $completed = $process.WaitForExit($timeoutMs)

    if (-not $completed) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      $message = "signtool timed out after $timeoutSeconds seconds for $TargetPath"
      if ($attempt -lt $MaxAttempts) {
        Write-Warning "$message; retrying."
        Start-Sleep -Seconds 5
        continue
      }
      throw "$message."
    }

    if ($process.ExitCode -eq 0) {
      return
    }

    $message = "signtool failed for $TargetPath with exit code $($process.ExitCode)"
    if ($attempt -lt $MaxAttempts) {
      Write-Warning "$message; retrying."
      Start-Sleep -Seconds 5
      continue
    }

    throw "$message."
  }
}

$targetPath = [System.IO.Path]::GetFullPath($TargetFile)
if (-not (Test-Path $targetPath)) {
  throw "Target file does not exist: $targetPath"
}

$targetName = [System.IO.Path]::GetFileName($targetPath)
if ($targetName -like "versions.json*" -or $targetName -like "opencode-managed-deps.json*") {
  Write-Host "Skipping signing for non-executable sidecar manifest: $targetPath"
  exit 0
}

$metadataPath = $env:VESLO_WINDOWS_SIGNING_METADATA_PATH
if (-not $metadataPath -or -not (Test-Path $metadataPath)) {
  throw "VESLO_WINDOWS_SIGNING_METADATA_PATH is missing or does not point to a file."
}

$signtoolPath = Resolve-SignToolPath
$dlibPath = Resolve-DlibPath
$description = if ($env:VESLO_WINDOWS_SIGNING_DESCRIPTION) {
  $env:VESLO_WINDOWS_SIGNING_DESCRIPTION
} else {
  "Veslo by Neatech"
}

Write-Host "Signing $targetPath"
Write-Host "Using signtool: $signtoolPath"
Write-Host "Using Azure dlib: $dlibPath"
Write-Host "Using metadata: $metadataPath"

$timeoutSeconds = Read-PositiveIntEnv -Name "VESLO_WINDOWS_SIGNING_TIMEOUT_SECONDS" -DefaultValue 300
$maxAttempts = Read-PositiveIntEnv -Name "VESLO_WINDOWS_SIGNING_MAX_ATTEMPTS" -DefaultValue 3

$signArguments = @(
  "sign",
  "/v",
  "/debug",
  "/fd",
  "SHA256",
  "/tr",
  "http://timestamp.acs.microsoft.com",
  "/td",
  "SHA256",
  "/d",
  $description,
  "/dlib",
  $dlibPath,
  "/dmdf",
  $metadataPath,
  $targetPath
)

Invoke-SignToolWithTimeout `
  -FilePath $signtoolPath `
  -Arguments $signArguments `
  -TargetPath $targetPath `
  -TimeoutSeconds $timeoutSeconds `
  -MaxAttempts $maxAttempts
