# Removes Qwen + Chatterbox files from Piper Hub repo (safe cleanup)
# Run from the repo root: powershell -ExecutionPolicy Bypass -File .\scripts\remove_qwen_chatterbox.ps1

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$REPO = Split-Path -Parent $ROOT

$toDelete = @(
  "tools\qwen3_tts_server.py",
  "tools\chatterbox_server.py",
  "tools\chatterbox_voice_demo.py",
  "src\services\chatterbox_manager.js"
)

foreach ($rel in $toDelete) {
  $p = Join-Path $REPO $rel
  if (Test-Path $p) {
    Write-Host "Deleting $rel"
    Remove-Item -Force $p
  } else {
    Write-Host "Not found (ok): $rel"
  }
}

Write-Host "Done. If you also have old Qwen/Chatterbox venv folders, you can delete them manually:"
Write-Host "  - venv_qwen"
Write-Host "  - venv_chatterbox"
