@echo off
title Office Printer and Reader on http://127.0.0.1:3070  (close this window to stop it)
cd /d "%~dp0"
rem Uses php from the PATH, or the one PHP_BIN names. openssl and a certificate list: the Reader fetches Gutenberg
rem books over https. The list is taken from extras\cacert.pem beside php.exe when there is one.
if defined PHP_BIN (set "PHP=%PHP_BIN%") else (set "PHP=php.exe")
for %%P in ("%PHP%") do set "PHPDIR=%%~dp$PATH:P"
if not defined PHPDIR for %%P in ("%PHP%") do set "PHPDIR=%%~dpP"
set "CAFILE="
if exist "%PHPDIR%extras\cacert.pem" set "CAFILE=-d openssl.cafile=%PHPDIR%extras\cacert.pem"
"%PHP%" -d "extension_dir=%PHPDIR%ext" -d extension=openssl %CAFILE% -S 127.0.0.1:3070 serve-printer.php
echo.
echo Office Printer and Reader stopped. If it says "Failed to listen", something else already holds port 3070:
echo close that window and run this again. If it says php is not recognised, install PHP 8.2+ or set PHP_BIN.
pause
