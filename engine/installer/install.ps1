param(
    [string]$ExePath = "",
    [string[]]$ExtensionId = @(),
    # Dev/test: register the build output where it is instead of copying it to %LOCALAPPDATA%.
    [switch]$InPlace,
    [switch]$Dev
)

$ErrorActionPreference = "Stop"

$HostName = "app.ghostpip.engine"
$StoreExtensionIds = @(
    "aobdinpjpmbnmbikjkmolfgeoooabfaa"
)
# Unpacked/dev builds use the ID pinned by the manifest "key"; include it only when -Dev is passed.
$DevExtensionId = "iphdokhjjgakpbmhemjjgglcdgjfedea"
$DefaultExtensionIds = if ($Dev) { $StoreExtensionIds + $DevExtensionId } else { $StoreExtensionIds }
$InstallerDir = $PSScriptRoot
$EngineDir = Split-Path -Parent $InstallerDir
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\GhostPiP"
$InstalledExe = Join-Path $InstallDir "GhostPiP.Engine.exe"
$ManifestPath = Join-Path $InstallDir "$HostName.json"

function Stop-GhostPiPEngine {
    $Procs = @(Get-Process GhostPiP.Engine -ErrorAction SilentlyContinue)
    if ($Procs.Count -eq 0) { return }

    try { & taskkill.exe /IM GhostPiP.Engine.exe *> $null } catch {}
    $Deadline = [DateTime]::UtcNow.AddSeconds(3)
    while ([DateTime]::UtcNow -lt $Deadline) {
        if (-not (Get-Process GhostPiP.Engine -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 100
    }

    Get-Process GhostPiP.Engine -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 200
}

if ([string]::IsNullOrWhiteSpace($ExePath)) {
    $Candidates = @(
        (Join-Path $InstallerDir "GhostPiP.Engine.exe"),
        (Join-Path $EngineDir "GhostPiP.Engine.exe"),
        (Join-Path $EngineDir "bin\Release\net10.0-windows\win-x64\publish\GhostPiP.Engine.exe")
    )
    $ExePath = $Candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if ([string]::IsNullOrWhiteSpace($ExePath) -or -not (Test-Path -LiteralPath $ExePath)) {
    Write-Error ("GhostPiP.Engine.exe not found next to the installer. If your antivirus quarantined it, " +
        "restore it from quarantine (it is a false positive for unsigned builds) and run install.bat again.")
}

Stop-GhostPiPEngine

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$SourceFull = [System.IO.Path]::GetFullPath($ExePath)
if ($InPlace) {
    $InstalledExe = $SourceFull
} elseif ($SourceFull -ne [System.IO.Path]::GetFullPath($InstalledExe)) {
    Copy-Item -LiteralPath $SourceFull -Destination $InstalledExe -Force
}
Copy-Item -LiteralPath (Join-Path $InstallerDir "uninstall.ps1") -Destination (Join-Path $InstallDir "uninstall.ps1") -Force

$Ids = @($DefaultExtensionIds + $ExtensionId | Where-Object { $_ } | Select-Object -Unique)
$ManifestObj = [ordered]@{
    name = $HostName
    description = "GhostPiP Local Helper Engine"
    path = $InstalledExe
    type = "stdio"
    allowed_origins = @($Ids | ForEach-Object { "chrome-extension://$_/" })
}
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ManifestPath, ($ManifestObj | ConvertTo-Json -Depth 4) + "`n", $Utf8NoBom)

$RegistryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Naver\Naver Whale\NativeMessagingHosts\$HostName",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)
foreach ($RegKey in $RegistryKeys) {
    if (-not (Test-Path -LiteralPath $RegKey)) {
        New-Item -Path $RegKey -Force | Out-Null
    }
    Set-Item -LiteralPath $RegKey -Value $ManifestPath
}

# Windows 11 hides new tray icons in the overflow menu; pin the engine icon if Windows already knows it.
$TrayRoot = "HKCU:\Control Panel\NotifyIconSettings"
if (Test-Path -LiteralPath $TrayRoot) {
    Get-ChildItem -LiteralPath $TrayRoot | ForEach-Object {
        $Entry = Get-ItemProperty -LiteralPath $_.PSPath
        if ($Entry.ExecutablePath -and $Entry.ExecutablePath -like "*\GhostPiP.Engine.exe") {
            Set-ItemProperty -LiteralPath $_.PSPath -Name IsPromoted -Value 1 -Type DWord
        }
    }
}

Write-Output "Installed $HostName -> $InstalledExe"
