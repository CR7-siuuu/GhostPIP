# GhostPiP Phase 0 - 사용자 데스크톱에서 직접 실행하는 실측 (약 1분)
# 반드시 "관리자가 아닌" 일반 PowerShell에서 실행하세요.
# 실행 중 마지막에 UAC 창이 한 번 뜹니다(예 선택).
$ErrorActionPreference = "Continue"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Write-Host "관리자 PowerShell에서 실행 중입니다. 일반 PowerShell을 새로 열어 다시 실행해 주세요." -ForegroundColor Red
    exit 1
}
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force out | Out-Null
$log = "out\user_results2.txt"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONWARNINGS = "ignore"
"== $(Get-Date -Format s)" | Out-File $log -Encoding utf8

function Run($title, [string[]]$pyArgs) {
    "== $title" | Tee-Object -Variable h | Out-Host
    $h | Out-File $log -Append -Encoding utf8
    $out = & python @pyArgs 2>&1 | ForEach-Object { "$_" }
    $out | Out-Host
    $out | Out-File $log -Append -Encoding utf8
}

Run "H7 restore native PiP" @("h7_restore.py", "native")
Run "H7 restore document PiP" @("h7_restore.py", "doc")
Run "H8 hold detection (UAC prompt: Yes)" @("h8_hold.py")
"`n완료. 결과: $PSScriptRoot\$log"
