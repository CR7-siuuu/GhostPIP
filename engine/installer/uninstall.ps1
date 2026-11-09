$ErrorActionPreference = "Stop"

$HostName = "app.ghostpip.engine"
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\GhostPiP"

$Procs = @(Get-Process GhostPiP.Engine -ErrorAction SilentlyContinue)
if ($Procs.Count -gt 0) {
    try { & taskkill.exe /IM GhostPiP.Engine.exe *> $null } catch {}
    $Deadline = [DateTime]::UtcNow.AddSeconds(3)
    while ([DateTime]::UtcNow -lt $Deadline) {
        if (-not (Get-Process GhostPiP.Engine -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 100
    }
    Get-Process GhostPiP.Engine -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

$RegistryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Naver\Naver Whale\NativeMessagingHosts\$HostName",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)
foreach ($RegKey in $RegistryKeys) {
    if (Test-Path -LiteralPath $RegKey) {
        Remove-Item -LiteralPath $RegKey -Recurse -Force
    }
}

if (Test-Path -LiteralPath $InstallDir) {
    Start-Sleep -Milliseconds 200
    Remove-Item -LiteralPath $InstallDir -Recurse -Force
}

Write-Output "Uninstalled $HostName"
