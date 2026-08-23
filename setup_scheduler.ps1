<#
  setup_scheduler.ps1  —  register / remove the AEMO collector as a scheduled task
  (Windows Task Scheduler is the "cron" equivalent on Windows.)

  Install (default: every 5 minutes, forever):
      powershell -ExecutionPolicy Bypass -File .\setup_scheduler.ps1

  Custom interval (e.g. every 1 minute):
      powershell -ExecutionPolicy Bypass -File .\setup_scheduler.ps1 -IntervalMinutes 1

  Also collect the heavy WEM facility generation each run:
      powershell -ExecutionPolicy Bypass -File .\setup_scheduler.ps1 -Scada

  Remove the task:
      powershell -ExecutionPolicy Bypass -File .\setup_scheduler.ps1 -Uninstall
#>
param(
  [int]$IntervalMinutes = 5,
  [switch]$Scada,
  [switch]$Uninstall,
  [string]$TaskName = "AEMO Data Collector"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$collector = Join-Path $scriptDir "collect.js"

if ($Uninstall) {
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  } catch { Write-Host "No task named '$TaskName' was found." -ForegroundColor Yellow }
  return
}

# locate node.exe
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe not found on PATH. Install Node.js first." }
if (-not (Test-Path $collector)) { throw "collect.js not found next to this script ($collector)." }

$arguments = "`"$collector`""
if ($Scada) { $arguments += " --scada" }

$action  = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
             -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
             -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
             -ExecutionTimeLimit (New-TimeSpan -Minutes 4)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Fetches live AEMO NEM + WEM data and appends to .\data archives." -Force | Out-Null

# kick off one run immediately so data starts flowing now
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "Installed scheduled task '$TaskName'." -ForegroundColor Green
Write-Host ("  Runs every {0} minute(s), starting now, indefinitely." -f $IntervalMinutes)
Write-Host ("  Command : {0} {1}" -f $node, $arguments)
Write-Host ("  Archives: {0}\data\" -f $scriptDir)
Write-Host ""
Write-Host "Manage it with:"
Write-Host "  Get-ScheduledTask '$TaskName' | Get-ScheduledTaskInfo      # last run + result"
Write-Host "  Start-ScheduledTask '$TaskName'                            # run once now"
Write-Host "  Disable-ScheduledTask '$TaskName'                          # pause"
Write-Host "  powershell -File .\setup_scheduler.ps1 -Uninstall          # remove"
