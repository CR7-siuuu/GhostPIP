@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
echo [GhostPiP] 엔진 등록이 해제되었습니다.
pause
