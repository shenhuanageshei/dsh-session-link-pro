# Registers (or unregisters) the "dsh" URL protocol handler for this package,
# so dsh://session/<id> links open the DeepSeek Harness web GUI at
# http://127.0.0.1:3080/s/<id>.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File register-protocol.ps1            # register
#   powershell -ExecutionPolicy Bypass -File register-protocol.ps1 -Uninstall # unregister
param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$pkgDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $pkgDir "dsh-open.cmd"
$key = "HKCU:\Software\Classes\dsh"

if (-not (Test-Path $launcher)) { throw "launcher not found: $launcher" }

if ($Uninstall) {
  if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }
  Write-Host "dsh:// protocol handler unregistered."
  exit 0
}

# Per-user protocol registration (HKCU): no admin rights needed.
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name "(default)" -Value "URL:DeepSeek Harness Session" -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
New-Item -Path "$key\shell\open\command" -Force | Out-Null
$command = "`"$launcher`" `"%1`""
New-ItemProperty -Path "$key\shell\open\command" -Name "(default)" -Value $command -PropertyType String -Force | Out-Null

Write-Host "dsh:// protocol handler registered:"
Write-Host "  $command"
Write-Host "Test: start dsh://session/session-test123"
