param(
  [switch]$NoDev
)

$ErrorActionPreference = "Stop"
$root = Join-Path $HOME "CMPRI-Engineering"
if (-not (Test-Path -LiteralPath (Join-Path $root "package.json"))) {
  if (Test-Path -LiteralPath (Join-Path (Get-Location) "package.json")) {
    $root = (Get-Location).Path
  } else {
    throw "CMPRI project not found. Expected $root"
  }
}

Set-Location -LiteralPath $root
Write-Host "Installing the CMPRI v1.0 integrated source dependencies..."
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }

Write-Host "Running the CMPRI v1.0 production build..."
npm run build
if ($LASTEXITCODE -ne 0) { throw "CMPRI v1.0 build failed." }

Write-Host "CMPRI v1.0 build passed."
if (-not $NoDev) {
  npm run dev
}
