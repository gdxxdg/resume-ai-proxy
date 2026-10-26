@echo off
chcp 65001 >nul
cd /d "%~dp0"
title resume-ai-proxy

echo ==========================================
echo    Resume AI Proxy
echo ==========================================
echo.
echo   Listening port : 3000 (default)
echo   Health check   : http://127.0.0.1:3000/health
echo.
echo   First run:
echo     1) copy .env.example to .env
echo     2) put your DEEPSEEK_API_KEY into .env
echo     3) run this file again
echo.
echo   Press Ctrl+C to stop.
echo.

node server.js

echo.
echo Server stopped.
pause
