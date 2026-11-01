$ErrorActionPreference = "Stop"

$HostName = "app.ghostpip.engine"
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\GhostPiP"

Get-Process GhostPiP.Engine -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

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
