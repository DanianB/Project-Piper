# start-piper.ps1 — Piper Supervisor (Qwen3 + optional Chatterbox)
# PowerShell 5.1 compatible. ASCII-only.

$ErrorActionPreference = 'Continue'
$PiperDir = Split-Path -Parent $PSCommandPath

# ---- Qwen host/port defaults (robust) ----
if (-not $QwenHost -or $QwenHost -eq "") { $QwenHost = "127.0.0.1" }
if (-not $QwenPort -or $QwenPort -eq 0) { $QwenPort = 5005 }

# Ensure imitation fallback reference audio is available to the Qwen server
$env:QWEN3_DEFAULT_REF_AUDIO = "E:\AI\Voice\voice.mp3"

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

# ---- Qwen venv python discovery ----
$RepoQwenPython = Join-Path $PiperDir '.venv-qwen\Scripts\python.exe'
$ParentQwenPython = Join-Path (Split-Path -Parent $PiperDir) '.venv-qwen\Scripts\python.exe'
$RepoPython311 = Join-Path $PiperDir '.venv311\Scripts\python.exe'
$ParentPython311 = Join-Path (Split-Path -Parent $PiperDir) '.venv311\Scripts\python.exe'

if ($env:PIPER_QWEN_PYTHON -and (Test-Path $env:PIPER_QWEN_PYTHON)) { $QwenPython = $env:PIPER_QWEN_PYTHON }
elseif (Test-Path $RepoQwenPython) { $QwenPython = $RepoQwenPython }
elseif (Test-Path $ParentQwenPython) { $QwenPython = $ParentQwenPython }
elseif (Test-Path $RepoPython311) { $QwenPython = $RepoPython311 }
elseif (Test-Path $ParentPython311) { $QwenPython = $ParentPython311 }
else { $QwenPython = $RepoQwenPython }

# ---- Node ----
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$EntryAbs = Join-Path $PiperDir 'src\server.js'
$OffExitCode = 99

if (-not (Test-Path $PiperDir)) { PauseExit 1 ("ERROR: PiperDir not found: {0}" -f $PiperDir) }
if (-not (Test-Path $NodeExe)) { PauseExit 1 ("ERROR: node.exe not found: {0}" -f $NodeExe) }
if (-not (Test-Path $EntryAbs)) { PauseExit 1 ("ERROR: Entry not found: {0}" -f $EntryAbs) }

# ---- Ports: kill stale listeners (optional) ----
if (-not $env:PIPER_KILL_QWEN_PORT) { $env:PIPER_KILL_QWEN_PORT = "1" }
if (-not $env:PIPER_KILL_PORT_3000) { $env:PIPER_KILL_PORT_3000 = "1" }

if ($env:PIPER_KILL_QWEN_PORT -eq "1") {
  try {
    Get-NetTCPConnection -LocalPort 5005 -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.OwningProcess) { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
  }
  catch {}
}

if ($env:PIPER_KILL_PORT_3000 -eq "1") {
  try {
    Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.OwningProcess) { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
  }
  catch {}
}

# ---- Qwen3 TTS server ----
$QwenEnabled = $true
$QwenUrl = 'http://127.0.0.1:5005'
$env:QWEN3_TTS_URL = $QwenUrl
$QwenScript = Join-Path $PiperDir 'tools\qwen3_tts_server.py'

# Stability defaults (still CUDA)
if (-not $env:QWEN3_DEVICE) { $env:QWEN3_DEVICE = "cuda" }
if (-not $env:QWEN3_DTYPE) { $env:QWEN3_DTYPE = "float32" }
if (-not $env:QWEN3_ATTN) { $env:QWEN3_ATTN = "eager" }
if (-not $env:QWEN3_WARMUP) { $env:QWEN3_WARMUP = "0" }

# Clear stale TLS env vars
foreach ($v in @('SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE')) {
  $p = [Environment]::GetEnvironmentVariable($v)
  if ($p -and -not (Test-Path $p)) { [Environment]::SetEnvironmentVariable($v, $null, 'Process') }
}

# OFF flag
$OffFlagPath = Join-Path $PiperDir 'data\OFF.flag'
if (Test-Path $OffFlagPath) { try { Remove-Item -Force $OffFlagPath } catch {} }

# Start Qwen and log its output
$QwenProc = $null

function Stop-QwenIfRunning() {
  try {
    if ($QwenProc -and -not $QwenProc.HasExited) {
      Stop-Process -Id $QwenProc.Id -Force -ErrorAction SilentlyContinue
    }
  }
  catch {}
}

# Ensure Qwen is killed if this supervisor exits for any reason
$global:__piper_cleaned = $false
Register-EngineEvent PowerShell.Exiting -Action {
  if (-not $global:__piper_cleaned) {
    $global:__piper_cleaned = $true
    try { Stop-QwenIfRunning } catch {}
  }
} | Out-Null

if ($QwenEnabled) {
  if (-not (Test-Path $QwenPython)) { PauseExit 1 ("ERROR: Qwen python not found: {0}" -f $QwenPython) }
  if (-not (Test-Path $QwenScript)) { PauseExit 1 ("ERROR: Qwen script not found: {0}" -f $QwenScript) }

  $LogDir = Join-Path $PiperDir 'data\logs'
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
  $QwenOut = Join-Path $LogDir 'qwen.out.log'
  $QwenErr = Join-Path $LogDir 'qwen.err.log'

  Write-Host ("Starting Qwen3 TTS via: {0}" -f $QwenPython)
  Write-Host ("Logging: {0} and {1}" -f $QwenOut, $QwenErr)

  # NOTE: -NoNewWindow cannot be used with -WindowStyle. Keep Hidden.
  $QwenProc = Start-Process `
    -FilePath $QwenPython `
    -ArgumentList @("$QwenScript") `
    -WorkingDirectory $PiperDir `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $QwenOut `
    -RedirectStandardError $QwenErr

  Start-Sleep -Milliseconds 500
  if ($QwenProc.HasExited) {
    Write-Host "WARNING: Qwen exited immediately. See logs:"
    Write-Host ("  {0}" -f $QwenErr)
  }
  else {
    $health = Wait-ForUrl ($QwenUrl + '/health') 60
    if ($null -ne $health) {

      # New server reports tts_loaded/clone_loaded; older one reports model_loaded.
      $ttsLoaded = $false
      $cloneLoaded = $false

      if ($null -ne $health.tts_loaded) { $ttsLoaded = [bool]$health.tts_loaded }
      elseif ($null -ne $health.model_loaded) { $ttsLoaded = [bool]$health.model_loaded }

      if ($null -ne $health.clone_loaded) { $cloneLoaded = [bool]$health.clone_loaded }

      Write-Host ("Qwen health: device={0} dtype={1} tts_loaded={2} clone_loaded={3}" -f $health.device, $health.dtype, $ttsLoaded, $cloneLoaded)

      # Warm up both models to avoid first-speak stalls (loads TTS + Clone models).
      try {
        Write-Host "Warming up Qwen models..."
        $warm = Invoke-RestMethod -Uri ($QwenUrl + "/warmup") -Method Get -TimeoutSec 180
        Write-Host ("Qwen warmup: ok={0} tts_loaded={1} clone_loaded={2}" -f $warm.ok, $warm.tts_loaded, $warm.clone_loaded)
      }
      catch {
        Write-Warning ("Qwen warmup failed: {0}" -f $_.Exception.Message)
      }

    }
    else {
      Write-Host "WARNING: Qwen did not become healthy in time. TTS may fail. Check logs:"
      Write-Host ("  {0}" -f $QwenErr)
    }

  }

  Write-Host ''
}

# Chatterbox disabled by default
$env:CHATTERBOX_AUTOSTART = 'false'

# Supervisor loop
while ($true) {
  if (Test-Path $OffFlagPath) {
    Write-Host 'OFF flag present. Supervisor stopping.'
    Stop-QwenIfRunning
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
    Stop-QwenIfRunning
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
