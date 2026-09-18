<#
  log_append.ps1 - append one entry to docs\SESSION_LOG.md
  Usage (from the repo root, in PowerShell):
    .\tools\log_append.ps1 -Title "RLS verified" -Body @'
    line one
    line two
    '@
  Or pipe a here-string:
    Get-Content note.txt -Raw | .\tools\log_append.ps1 -Title "Something"
#>

param(
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$false, ValueFromPipeline=$true)][string]$Body = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logPath  = Join-Path $repoRoot 'docs\SESSION_LOG.md'

if (-not (Test-Path $logPath)) {
  throw "Log file not found: $logPath"
}

$before = (Get-Content $logPath | Measure-Object -Line).Lines
$stamp  = Get-Date -Format 'yyyy-MM-dd HH:mm'

$entry = "`r`n### [$stamp] $Title`r`n$Body`r`n"

Add-Content -Path $logPath -Value $entry -Encoding UTF8

$after = (Get-Content $logPath | Measure-Object -Line).Lines

Write-Host "APPENDED to $logPath"
Write-Host "Title : $Title"
Write-Host "Lines : $before -> $after"
