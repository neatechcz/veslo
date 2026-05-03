Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProgressPreference = "SilentlyContinue"

$nugetPath = Join-Path $env:RUNNER_TEMP "nuget.exe"
$packageRoot = Join-Path $env:RUNNER_TEMP "artifact-signing-client"
$nugetUrl = "https://dist.nuget.org/win-x86-commandline/latest/nuget.exe"

Write-Host "Downloading NuGet CLI..."
Invoke-WebRequest -Uri $nugetUrl -OutFile $nugetPath

Write-Host "Installing Microsoft.ArtifactSigning.Client NuGet package..."
Remove-Item $packageRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $packageRoot | Out-Null
& $nugetPath install Microsoft.ArtifactSigning.Client -OutputDirectory $packageRoot -ExcludeVersion -NonInteractive
if ($LASTEXITCODE -ne 0) {
  throw "NuGet failed to install Microsoft.ArtifactSigning.Client with exit code $LASTEXITCODE."
}

$dlibCandidates = Get-ChildItem -Path $packageRoot -Filter Azure.CodeSigning.Dlib.dll -Recurse -File |
  Where-Object { $_.FullName -match '\\bin\\x64\\Azure\.CodeSigning\.Dlib\.dll$' } |
  Sort-Object FullName

if (-not $dlibCandidates) {
  throw "Microsoft.ArtifactSigning.Client installed, but Azure.CodeSigning.Dlib.dll was not found."
}

$dlibPath = $dlibCandidates[0].FullName
Write-Host "Artifact Signing dlib installed."
Write-Host "Azure dlib: $dlibPath"

if ($env:GITHUB_ENV) {
  "VESLO_ARTIFACT_SIGNING_DLIB_PATH=$dlibPath" >> $env:GITHUB_ENV
}
