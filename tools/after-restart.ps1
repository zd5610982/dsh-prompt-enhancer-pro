# After you restart DeepSeek Harness, run this to get a one-line verdict.
#
#   powershell -ExecutionPolicy Bypass -File .\tools\after-restart.ps1
#   powershell -ExecutionPolicy Bypass -File .\tools\after-restart.ps1 -Port 21000
#
# It answers exactly the questions the plugin's cold-boot fix has to satisfy:
#   1. Did the plugin's loader entry activate, and when (compared with the last
#      web-boot crash — a crash NEWER than the last activation means this start
#      still failed)?
#   2. Does its HTTP route answer?
#   3. Did the browser half report an activation failure (contained, but
#      informative)?
#
# Exit code 0 = the cold boot is clean. Non-zero = send the output back.

# The port is a parameter because DeepSeek Harness may not listen on the default
# one: earlier versions of this script hard-coded 19387, so on any other port the
# route probe reported a false FAIL.
[CmdletBinding()]
param(
  [int] $Port = 19387
)

$ErrorActionPreference = 'Continue'

$env:DshPort = $Port
$bootLog   = Join-Path $env:USERPROFILE '.dsh\prompt-enhancer-boot.log'
$crashDir  = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\logs'
$statusUrl = "http://127.0.0.1:$Port/plugins/dsh-prompt-enhancer/status"

Write-Host '=== 1. plugin activation (from the boot log) ===' -ForegroundColor Cyan

$activationTime = $null
$clientFailure = $null
$mountFailure = $null

if (-not (Test-Path $bootLog)) {
  Write-Host '  FAIL boot log missing - the plugin never ran' -ForegroundColor Red
} else {
  $tail = Get-Content $bootLog -Tail 60

  # Every line starts with an ISO-8601 UTC stamp; take the newest mount.
  $mountedLine = $tail | Where-Object { $_ -match 'HTTP routes mounted' } | Select-Object -Last 1
  $enteredLine = $tail | Where-Object { $_ -match 'apply\(\) entered' } | Select-Object -Last 1
  $clientFailure = $tail | Where-Object { $_ -match 'CLIENT FAILURE' } | Select-Object -Last 1
  $mountFailure = $tail | Where-Object { $_ -match 'ROUTE MOUNT FAILED' } | Select-Object -Last 1

  if ($enteredLine) { Write-Host "  OK   apply() ran   : $enteredLine" -ForegroundColor Green }
  else { Write-Host '  FAIL apply() never ran' -ForegroundColor Red }

  if ($mountedLine) {
    Write-Host "  OK   route mounted : $mountedLine" -ForegroundColor Green
    if ($mountedLine -match '^(\S+?Z)') {
      try { $activationTime = [datetime]::Parse($matches[1]).ToLocalTime() } catch { $activationTime = $null }
    }
  } else {
    Write-Host '  WARN route not mounted (feature degraded)' -ForegroundColor Yellow
    if ($enteredLine -match '^(\S+?Z)') {
      try { $activationTime = [datetime]::Parse($matches[1]).ToLocalTime() } catch { $activationTime = $null }
    }
  }

  if ($clientFailure) {
    Write-Host '  WARN browser half failed (CONTAINED - boot was not aborted):' -ForegroundColor Yellow
    Write-Host "       $clientFailure"
  } else {
    Write-Host '  OK   no browser-half failure reported' -ForegroundColor Green
  }

  if ($mountFailure) {
    Write-Host '  WARN host route mount failed (CONTAINED):' -ForegroundColor Yellow
    Write-Host "       $mountFailure"
  }
}

Write-Host ''
Write-Host '=== 2. crash log from this start? ===' -ForegroundColor Cyan

$newestCrash = $null
if (Test-Path $crashDir) {
  $newestCrash = Get-ChildItem $crashDir -Filter 'crash-*-web-boot.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

$crashIsNewer = $false
if ($null -eq $newestCrash) {
  Write-Host '  OK   no web-boot crash log at all' -ForegroundColor Green
} elseif ($null -ne $activationTime) {
  if ($newestCrash.LastWriteTime -gt $activationTime) {
    $crashIsNewer = $true
    Write-Host "  FAIL a crash is NEWER than the last activation: $($newestCrash.Name)" -ForegroundColor Red
    Write-Host '  --- contents ---'
    Get-Content $newestCrash.FullName | ForEach-Object { "    $_" }
  } else {
    Write-Host "  OK   last crash ($($newestCrash.Name)) predates the last activation" -ForegroundColor Green
  }
} else {
  Write-Host "  ?    found $($newestCrash.Name), but no activation timestamp to compare" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=== 3. HTTP route ===' -ForegroundColor Cyan
$routeOk = $false
try {
  $response = Invoke-WebRequest -Uri $statusUrl -UseBasicParsing -TimeoutSec 8
  $routeOk = $true
  Write-Host "  OK   status $($response.StatusCode)" -ForegroundColor Green
  Write-Host "       $($response.Content)"
} catch {
  $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'no response' }
  Write-Host "  FAIL $statusUrl -> $code" -ForegroundColor Red
}

Write-Host ''
Write-Host '=== 4. is this evidence actually from a fresh start? ===' -ForegroundColor Cyan
# The boot log also collects offline test runs, so a recent activation line can
# come from a test rather than from the app. Only a genuinely recent app start
# may be reported as a verdict.
$freshWindowMinutes = 15
$isFresh = $false
if ($null -ne $activationTime) {
  $age = (Get-Date) - $activationTime
  if ($age.TotalMinutes -le $freshWindowMinutes) {
    $isFresh = $true
    Write-Host "  OK   last activation was $($age.TotalMinutes.ToString('0.0')) minutes ago" -ForegroundColor Green
  } else {
    Write-Host "  ?    last activation was $($age.TotalMinutes.ToString('0.0')) minutes ago - too old to prove a restart" -ForegroundColor Yellow
    Write-Host '       Start the app (or restart it), then run this script again within a few minutes.'
  }
} else {
  Write-Host '  ?    no activation recorded' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=== verdict ===' -ForegroundColor Cyan
if ($isFresh -and -not $crashIsNewer -and $routeOk) {
  Write-Host '  PASS - the cold boot is clean and the route answers.' -ForegroundColor Green
  Write-Host '  Now refresh the page in the GUI: the enhance control sits in the composer'
  Write-Host '  toolbar, just left of the model picker.'
  exit 0
}
if (-not $isFresh) {
  Write-Host '  INCONCLUSIVE - no fresh start detected, so nothing is proven yet.' -ForegroundColor Yellow
  exit 2
}
Write-Host '  NEEDS ATTENTION - send everything printed above back for diagnosis.' -ForegroundColor Red
exit 1
