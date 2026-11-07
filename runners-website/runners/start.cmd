@echo off
cd /d "%~dp0"
echo Runners local preview: http://127.0.0.1:4173
echo Press Ctrl+C to stop the server.
python -m http.server 4173 --bind 127.0.0.1
exit /b %errorlevel%
