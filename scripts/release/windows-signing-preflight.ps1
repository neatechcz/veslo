Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$probeRoot = Join-Path $env:RUNNER_TEMP "veslo-signing-preflight-$PID"
$publishRoot = Join-Path $probeRoot "publish"
$probePath = Join-Path $publishRoot "VesloSigningPreflight.exe"

try {
  dotnet new console --name VesloSigningPreflight --output $probeRoot --framework net8.0 --force
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create the Artifact Signing preflight project."
  }

  Set-Content `
    -Path (Join-Path $probeRoot "Program.cs") `
    -Value 'Console.WriteLine("Veslo Artifact Signing preflight");' `
    -Encoding utf8NoBOM

  dotnet publish `
    (Join-Path $probeRoot "VesloSigningPreflight.csproj") `
    --configuration Release `
    --runtime win-x64 `
    --self-contained false `
    --output $publishRoot `
    -p:UseAppHost=true
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $probePath)) {
    throw "Failed to build the Artifact Signing preflight executable."
  }

  $initialSignature = Get-AuthenticodeSignature -FilePath $probePath
  if ($initialSignature.Status -ne "NotSigned") {
    throw "Artifact Signing preflight executable must start unsigned; got $($initialSignature.Status)."
  }

  & (Join-Path $PSScriptRoot "windows-sign.ps1") -TargetFile $probePath

  $signature = Get-AuthenticodeSignature -FilePath $probePath
  if ($signature.Status -ne "Valid") {
    $signature | Format-List * | Out-String | Write-Host
    throw "Artifact Signing preflight signature is not valid."
  }

  Write-Host "Artifact Signing preflight succeeded."
  Write-Host "Signer: $($signature.SignerCertificate.Subject)"
} finally {
  Remove-Item -Path $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
