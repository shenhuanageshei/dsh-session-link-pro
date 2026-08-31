@echo off
rem DeepSeek Harness dsh:// deep-link opener (registered as the "dsh" URL
rem protocol handler; see register-protocol.ps1).
rem
rem   dsh://session/<sessionId>  ->  http://127.0.0.1:3080/s/<sessionId>
rem
rem The web GUI (dsh web) must be running for the target session to open.
setlocal
set "u=%~1"
if "%u%"=="" exit /b 0
set "u=%u:dsh://session/=s/%"
>> "%TEMP%\dsh-open.log" echo %DATE% %TIME% raw=%~1 target=http://127.0.0.1:3080/%u%
start "" "http://127.0.0.1:3080/%u%"
endlocal
