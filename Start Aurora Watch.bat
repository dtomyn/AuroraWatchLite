@echo off
title Aurora Watch
rem Bypass applies to this one run only and changes no system setting.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
if errorlevel 1 pause
