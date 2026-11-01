@echo off
rem 双击打开本机职位看板。关掉这个黑色窗口，看板就停。
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 没有找到 Node.js。请先安装 Node.js 22 或更高版本，安装时勾选 Add to PATH，然后重新双击本文件。
  pause
  exit /b 1
)
echo 正在打开职位看板。关掉这个窗口就会停止。
node job-board\server.mjs --open
if errorlevel 1 pause
