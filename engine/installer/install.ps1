param(
    [string]$ExePath = ""
)

$ErrorActionPreference = "Stop"

$HostName = "app.ghostpip.engine"
$ExtensionId = "iphdokhjjgakpbmhemjjgglcdgjfedea"
$InstallerDir = $PSScriptRoot
$EngineDir = Split-Path -Parent $InstallerDir

if ([string]::IsNullOrWhiteSpace($ExePath)) {
    $Candidates = @(
        (Join-Path $InstallerDir "GhostPiP.Engine.exe"),
        (Join-Path $EngineDir "GhostPiP.Engine.exe"),
        (Join-Path $EngineDir "bin\Release\net8.0-windows\win-x64\publish\GhostPiP.Engine.exe"),
        (Join-Path $EngineDir "bin\Release\net8.0-windows\win-x64\GhostPiP.Engine.exe"),
        (Join-Path $EngineDir "bin\Release\net8.0-windows\GhostPiP.Engine.exe"),
        (Join-Path $EngineDir "bin\Debug\net8.0-windows\win-x64\GhostPiP.Engine.exe"),
        (Join-Path $EngineDir "bin\Debug\net8.0-windows\GhostPiP.Engine.exe")
    )
    foreach ($Candidate in $Candidates) {
        if (Test-Path -LiteralPath $Candidate) {
            $ExePath = $Candidate
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($ExePath)) {
        $ExePath = $Candidates[0]
    }
}

$ResolvedExePath = [System.IO.Path]::GetFullPath($ExePath)
$ManifestPath = [System.IO.Path]::GetFullPath((Join-Path $InstallerDir "$HostName.json"))

$ManifestObj = [ordered]@{
    name = $HostName
    description = "GhostPiP Local Helper Engine"
    path = $ResolvedExePath
    type = "stdio"
    allowed_origins = @(
        "chrome-extension://$ExtensionId/"
    )
}

$Json = $ManifestObj | ConvertTo-Json -Depth 4
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ManifestPath, $Json + "`n", $Utf8NoBom)

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

Write-Output "Registered $HostName -> $ManifestPath (exe: $ResolvedExePath)"
