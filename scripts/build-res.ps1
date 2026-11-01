$ErrorActionPreference = "Stop"

$EngineDir = Join-Path (Split-Path -Parent $PSScriptRoot) "engine"
$Rc = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\rc.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if (-not $Rc) {
    throw "rc.exe not found. Install the Windows 10/11 SDK."
}

Push-Location $EngineDir
try {
    & $Rc.FullName /nologo /fo GhostPiP.Engine.res GhostPiP.Engine.rc
    if ($LASTEXITCODE -ne 0) { throw "rc.exe failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
Write-Output "Built $(Join-Path $EngineDir 'GhostPiP.Engine.res')"
