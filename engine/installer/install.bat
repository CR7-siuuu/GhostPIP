@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
echo [GhostPiP] 엔진 등록이 완료되었습니다.
pause
