# start-piper.ps1 — Piper Supervisor (XTTS Curie + Piper Hub)
# PowerShell 5.1 compatible. ASCII-only.
#
# Env overrides:
#   PIPER_XTTS_PYTHON       = full path to python.exe for XTTS venv
#   XTTS_MODEL_DIR          = folder containing best_model.pth + config.json (+ vocab.json)
#   XTTS_REFS_DIR           = folder containing reference .wav files (can be nested)
#   XTTS_DEFAULT_REF        = default ref name/path (e.g., "serious_neutral")
#   XTTS_PORT               = default 5055
#   XTTS_FP16               = "1" or "0" (default 1)
#   PIPER_DISABLE_XTTS      = "1" to skip starting XTTS
#   PIPER_KILL_PORT_3000    = "1" kill anything on 3000 (default 1)
#   PIPER_KILL_XTTS_PORT    = "1" kill anything on XTTS_PORT (default 1)

$ErrorActionPreference = 'Continue'
$PiperDir = Split-Path -Parent $PSCommandPath

function PauseExit([int]$code, [string]$msg) {
  Write-Host $msg
  Write-Host 'Press ENTER to exit...'
  Read-Host | Out-Null
  exit $code
}

function Wait-ForUrl([string]$url, [int]$timeoutSec) {
  if (-not $timeoutSec) { $timeoutSec = 30 }
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try { return Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 2 }
    catch { Start-Sleep -Milliseconds 250 }
  }
  return $null
}

# ---- Node ----
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$EntryAbs = Join-Path $PiperDir 'src\server.js'
$OffExitCode = 99

if (-not (Test-Path $PiperDir)) { PauseExit 1 ("ERROR: PiperDir not found: {0}" -f $PiperDir) }
if (-not (Test-Path $NodeExe)) { PauseExit 1 ("ERROR: node.exe not found: {0}" -f $NodeExe) }
if (-not (Test-Path $EntryAbs)) { PauseExit 1 ("ERROR: Entry not found: {0}" -f $EntryAbs) }

# ---- Ports: kill stale listeners (optional) ----
if (-not $env:PIPER_KILL_PORT_3000) { $env:PIPER_KILL_PORT_3000 = "1" }
if (-not $env:PIPER_KILL_XTTS_PORT) { $env:PIPER_KILL_XTTS_PORT = "1" }

if ($env:PIPER_KILL_PORT_3000 -eq "1") {
  try {
    Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.OwningProcess) { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
  } catch {}
}

# ---- XTTS server (optional) ----
$XttsProc = $null
$XttsPort = $env:XTTS_PORT
if (-not $XttsPort -or $XttsPort.Trim() -eq "") { $XttsPort = "5055" }
$XttsUrl = "http://127.0.0.1:$XttsPort"
$env:XTTS_URL = $XttsUrl

function Stop-XttsIfRunning() {
  try {
    if ($XttsProc -and -not $XttsProc.HasExited) {
      Stop-Process -Id $XttsProc.Id -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

$global:__piper_cleaned = $false
Register-EngineEvent PowerShell.Exiting -Action {
  if (-not $global:__piper_cleaned) {
    $global:__piper_cleaned = $true
    try { Stop-XttsIfRunning } catch {}
  }
} | Out-Null

if ($env:PIPER_DISABLE_XTTS -ne "1") {
  if ($env:PIPER_KILL_XTTS_PORT -eq "1") {
    try {
      Get-NetTCPConnection -LocalPort ([int]$XttsPort) -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.OwningProcess) { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
      }
    } catch {}
  }

  $XttsPython = $env:PIPER_XTTS_PYTHON
  if (-not $XttsPython -or $XttsPython.Trim() -eq "") {
    # Default (your setup)
    $XttsPython = "E:\AI\CurieXTTS\venv_xtts\Scripts\python.exe"
  }
  if (-not (Test-Path $XttsPython)) { PauseExit 1 ("ERROR: XTTS python not found: {0}" -f $XttsPython) }

  $XttsModelDir = $env:XTTS_MODEL_DIR
  if (-not $XttsModelDir -or $XttsModelDir.Trim() -eq "") { $XttsModelDir = "E:\AI\piper_voice_curie" }
  $XttsRefsDir = $env:XTTS_REFS_DIR
  if (-not $XttsRefsDir -or $XttsRefsDir.Trim() -eq "") { $XttsRefsDir = Join-Path $XttsModelDir "refs" }

  $env:XTTS_MODEL_DIR = $XttsModelDir
  $env:XTTS_REFS_DIR  = $XttsRefsDir

  if (-not $env:XTTS_FP16) { $env:XTTS_FP16 = "1" }

  # Choose a safe default ref if you have one (matches your training ref names)
  if (-not $env:XTTS_DEFAULT_REF -or $env:XTTS_DEFAULT_REF.Trim() -eq "") {
    $env:XTTS_DEFAULT_REF = "serious_neutral"
  }

  $LogDir = Join-Path $PiperDir 'data\logs'
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
  $XttsOut = Join-Path $LogDir 'xtts.out.log'
  $XttsErr = Join-Path $LogDir 'xtts.err.log'

  $XttsScript = Join-Path $PiperDir 'tools\xtts_server.py'
  if (-not (Test-Path $XttsScript)) { PauseExit 1 ("ERROR: xtts_server.py not found: {0}" -f $XttsScript) }

  Write-Host ("Starting XTTS via: {0}" -f $XttsPython)
  Write-Host ("XTTS URL: {0}" -f $XttsUrl)
  Write-Host ("Model: {0}" -f $XttsModelDir)
  Write-Host ("Refs:  {0}" -f $XttsRefsDir)
  Write-Host ("Logging: {0} and {1}" -f $XttsOut, $XttsErr)

  $XttsProc = Start-Process `
    -FilePath $XttsPython `
    -ArgumentList @("$XttsScript") `
    -WorkingDirectory $PiperDir `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $XttsOut `
    -RedirectStandardError $XttsErr

  Start-Sleep -Milliseconds 600
  if ($XttsProc.HasExited) {
    Write-Host "WARNING: XTTS exited immediately. See logs:"
    Write-Host ("  {0}" -f $XttsErr)
  } else {
    $health = Wait-ForUrl ($XttsUrl + '/health') 90
    if ($null -ne $health -and $health.ready -eq $true) {
      Write-Host ("XTTS health: device={0} ready={1}" -f $health.device, $health.ready)
    } else {
      Write-Host "WARNING: XTTS did not become healthy in time. Check logs:"
      Write-Host ("  {0}" -f $XttsErr)
    }
  }

  Write-Host ''
}

# OFF flag
$OffFlagPath = Join-Path $PiperDir 'data\OFF.flag'
if (Test-Path $OffFlagPath) { try { Remove-Item -Force $OffFlagPath } catch {} }

# Supervisor loop
while ($true) {
  if (Test-Path $OffFlagPath) {
    Write-Host 'OFF flag present. Supervisor stopping.'
    Stop-XttsIfRunning
    exit 0
  }

  Set-Location -Path $PiperDir
  Write-Host ("Starting Piper... {0}" -f (Get-Date))

  $code = 1
  try { & $NodeExe $EntryAbs; $code = $LASTEXITCODE }
  catch { Write-Host ("Node launch error: {0}" -f $_.Exception.Message); $code = 1 }

  Write-Host ("Piper stopped (exit code {0})." -f $code)

  if ($code -eq $OffExitCode) {
    Write-Host 'OFF requested (exit 99). Supervisor stopping.'
    Stop-XttsIfRunning
    exit 0
  }

  if ($code -eq 0) {
    Write-Host 'Restart requested. Relaunching...'
    Start-Sleep -Milliseconds 600
    Write-Host ''
    continue
  }

  Write-Host 'Piper exited unexpectedly. Press ENTER to restart.'
  Read-Host | Out-Null
  Write-Host ''
}
