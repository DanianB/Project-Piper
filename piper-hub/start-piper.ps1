# start-piper.ps1 — Piper Supervisor (HARDENED)
# - Must be launched with: powershell.exe -File "D:\AI\piper-hub\start-piper.ps1"
# - Auto restarts on exit code 0 (RESET)
# - Exits supervisor on exit code 99 (OFF)
# - Keeps window open if startup fails so you can read errors
# ---- Chatterbox auto-start configuration ----
$env:CHATTERBOX_AUTOSTART = "true"
$env:CHATTERBOX_CONDA_ENV = "chatterbox"
$env:CHATTERBOX_HOST = "127.0.0.1"
$env:CHATTERBOX_PORT = "4123"
$env:CHATTERBOX_PROMPT_WAV = "D:\AI\piper-tts\voices\Piper-Default-Voice.wav"
$env:TTS_LOG_VOICE_PATHS = "1"

# If conda is NOT on PATH, uncomment and adjust this line:
# $env:CHATTERBOX_START_CMD = "C:\Users\Danian\Documents\miniconda\Scripts\conda.exe run -n chatterbox python tools\chatterbox_server.py"

$ErrorActionPreference = 'Continue'

# ---- Conda availability for Chatterbox ----
$env:CONDA_EXE = "C:\Users\Danian\Documents\miniconda\Scripts\conda.exe"
$env:CONDA_DEFAULT_ENV = "base"
$env:PATH = "C:\Users\Danian\Documents\miniconda\Scripts;C:\Users\Danian\Documents\miniconda;$env:PATH"


# ---- Config ----
$PiperDir     = 'D:\AI\piper-hub'
$NodeExe      = 'C:\Program Files\nodejs\node.exe'
$Entry        = '.\src\server.js'   # <-- UPDATED: new modular entrypoint
$OffExitCode  = 99

function PauseExit([int]$code, [string]$msg) {
  Write-Host $msg
  Write-Host "Press ENTER to exit..."
  Read-Host | Out-Null
  exit $code
}

try { $Host.UI.RawUI.WindowTitle = 'Piper Supervisor' } catch {}

Write-Host '=== Piper Supervisor ==='
Write-Host ("Time:       {0}" -f (Get-Date))
Write-Host ("Script:     {0}" -f $PSCommandPath)
Write-Host ("PS Version: {0}" -f $($PSVersionTable.PSVersion))
Write-Host ("Workdir:    {0}" -f $PiperDir)
Write-Host ("Node:       {0}" -f $NodeExe)
Write-Host ("Entry:      {0}" -f $Entry)
Write-Host ("OFF code:   {0}" -f $OffExitCode)
Write-Host ''

if (-not (Test-Path $PiperDir)) { PauseExit 1 ("ERROR: PiperDir not found: {0}" -f $PiperDir) }
if (-not (Test-Path $NodeExe))  { PauseExit 1 ("ERROR: node.exe not found: {0}" -f $NodeExe) }

# Ensure entry file exists (helps catch path issues early)
$EntryAbs = Join-Path $PiperDir ($Entry -replace '^\.\[\\/]', '')
if (-not (Test-Path $EntryAbs)) {
  PauseExit 1 ("ERROR: Entry not found: {0}" -f $EntryAbs)
}

try {
  Write-Host -NoNewline 'Node version: '
  & $NodeExe -v
} catch {
  Write-Host ("Node version check failed: {0}" -f $_.Exception.Message)
}
Write-Host ''

# If the shortcut didn't pass -File correctly, this script can still run,
# but we want to ensure it doesn't “drop into a prompt” silently after a fast exit.
$firstLaunch = $true

# ---- OFF flag (global stop) ----
$OffFlagPath = Join-Path $PiperDir "data\OFF.flag"

# If you manually started the supervisor, that implies "turn on",
# so clear any previous OFF flag.
if (Test-Path $OffFlagPath) {
  try {
    Remove-Item -Force $OffFlagPath
    Write-Host ("🧹 Cleared OFF flag: {0}" -f $OffFlagPath)
  } catch {
    Write-Host ("⚠ Could not clear OFF flag: {0}" -f $_.Exception.Message)
  }
}

# ---- Supervisor loop (AUTO RESTART + OFF GUARD) ----
while ($true) {

  # If OFF flag exists (set by UI Off button), stop supervising immediately.
  if (Test-Path $OffFlagPath) {
    Write-Host ("🛑 OFF flag present ({0}). Supervisor stopping." -f $OffFlagPath)
    exit 0
  }

  Set-Location -Path $PiperDir
  Write-Host ("▶ Starting Piper... {0}" -f (Get-Date))

  $code = 1
  try {
    & $NodeExe $Entry
    $code = $LASTEXITCODE
  } catch {
    Write-Host ("🔥 Node launch error: {0}" -f $_.Exception.Message)
    $code = 1
  }

  Write-Host ("⏹ Piper stopped (exit code {0})." -f $code)

  if ($code -eq $OffExitCode) {
    Write-Host '🛑 OFF requested (exit 99). Supervisor stopping.'
    exit 0
  }

  if ($code -eq 0) {
    Write-Host '🔁 Restart requested. Relaunching...'
    Start-Sleep -Milliseconds 600
    Write-Host ''
    continue
  }

  Write-Host '⚠ Piper exited unexpectedly. Press ENTER to restart.'
  Read-Host | Out-Null
  Write-Host ''
}
