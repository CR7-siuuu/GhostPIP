$ErrorActionPreference = "Stop"

$HostName = "app.ghostpip.engine"
$InstallerDir = $PSScriptRoot
$ManifestPath = [System.IO.Path]::GetFullPath((Join-Path $InstallerDir "$HostName.json"))

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

if (Test-Path -LiteralPath $ManifestPath) {
    Remove-Item -LiteralPath $ManifestPath -Force
}

Write-Output "Unregistered $HostName"
