@echo off
setlocal
title codex-kanban - keep this window open

set "TASKBOARD_ROOT=%~dp0"
set "TASKBOARD_NODE=%TASKBOARD_ROOT%.data\tools\node\node.exe"
set "TASKBOARD_CODEX=%TASKBOARD_ROOT%.data\tools\codex\node_modules\@openai\codex\bin\codex.js"

if not exist "%TASKBOARD_NODE%" (
  echo Taskboard portable Node.js was not found:
  echo   %TASKBOARD_NODE%
  exit /b 1
)

if not exist "%TASKBOARD_CODEX%" (
  echo Taskboard standalone Codex CLI was not found:
  echo   %TASKBOARD_CODEX%
  exit /b 1
)

set "CODEX_EXECUTABLE=%TASKBOARD_CODEX%"
set "CODEX_TASKBOARD_HOST=127.0.0.1"

cd /d "%TASKBOARD_ROOT%"

"%TASKBOARD_NODE%" "%TASKBOARD_CODEX%" login status >nul 2>&1
if errorlevel 1 (
  echo Codex CLI sign-in is required for AI Chat and automatic task claiming.
  echo Complete the OpenAI sign-in in your browser; Taskboard will start afterwards.
  "%TASKBOARD_NODE%" "%TASKBOARD_CODEX%" login
  if errorlevel 1 (
    echo Codex CLI sign-in did not complete. Taskboard was not started.
    exit /b 1
  )
)

echo.
echo codex-kanban is running. Keep this window open; minimizing it is safe.
"%TASKBOARD_NODE%" "%TASKBOARD_ROOT%scripts\codex-injector.mjs" --launch --watch --open
