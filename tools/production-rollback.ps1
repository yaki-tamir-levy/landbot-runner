#Requires -Version 7.0
<#
    production-rollback.ps1 - explicit rollback to an identified baseline
    (project BOT). Implements spec section 8.

    Rollback is a deliberate, separate action. It is never automatic, and it is
    never performed against code whose identity is unknown: BaselineFile and
    BaselineSha256 must both be present in the config, and the hash must match
    before anything is touched.

    What it does, in order:
      1. Reads the same config file used for the deploy.
      2. Verifies BaselineSha256 against BaselineFile.
      3. Backs up the current function source next to the reports.
      4. Copies the baseline over the function entrypoint the CLI will bundle.
      5. Re-verifies the hash of the file now in place.
      6. Hands off to production-deploy.ps1, which re-runs the full guard:
         preflight -> deploy -> verification -> smoke test.

    Nothing is deployed unless -ConfirmRollback is passed. Without it the
    script performs steps 1, 2 and reports what it would do.

    Note on 503 recovery: shipping a temporary 503 stub is a containment
    measure when bad code is already live. It is NOT a baseline and NOT a
    rollback. If you use it, that stub is not a valid BaselineFile.

    Usage:
        .\tools\production-rollback.ps1 -ConfigFile .\deploy\my-function.config.json
        .\tools\production-rollback.ps1 -ConfigFile .\deploy\my-function.config.json -ConfirmRollback

    Exit codes:
        0 = rollback deployed and verified, or dry run completed
        2 = precheck failed (missing baseline, hash mismatch, missing file)
        3/4/5 = passed through from production-deploy.ps1 (deploy/verify/smoke)
        9 = unexpected error
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigFile,

    # Required before the baseline is actually deployed.
    [switch]$ConfirmRollback,

    [switch]$ConfirmProductionSmoke
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$EXIT_OK              = 0
$EXIT_PRECHECK_FAILED = 2
$EXIT_UNEXPECTED      = 9

$ScriptRoot = $PSScriptRoot
$RepoRoot   = Split-Path -Parent $ScriptRoot
$stamp      = (Get-Date).ToString('yyyyMMdd_HHmmss')

function Fail {
    param([string]$Reason, [int]$Code = $EXIT_PRECHECK_FAILED)
    Write-Host ''
    Write-Host 'STOP: ROLLBACK_PRECHECK_FAILED'
    Write-Host "REASON: $Reason"
    Write-Host "EXIT CODE: $Code"
    exit $Code
}

Write-Host '=== ROLLBACK - step 0: configuration ==='
Write-Host "Config file : $ConfigFile"

if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) {
    Fail "Config file not found: $ConfigFile"
}

try { $cfg = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { Fail ('Config file is not valid JSON: ' + $_.Exception.Message) }

$cfgNames = @($cfg.PSObject.Properties.Name)

$missing = @()
foreach ($f in @('FunctionName', 'ProjectRoot', 'BaselineFile', 'BaselineSha256')) {
    if ($cfgNames -notcontains $f -or $null -eq $cfg.$f -or ([string]$cfg.$f).Trim() -eq '') { $missing += $f }
}
if ($missing.Count -gt 0) {
    Fail ('MISSING_REQUIRED_INPUT for rollback: ' + ($missing -join ', ') +
          '. A rollback needs an identified baseline (spec section 8).')
}

$FunctionName = [string]$cfg.FunctionName

$ProjectRootCfg = [string]$cfg.ProjectRoot
if (-not [System.IO.Path]::IsPathRooted($ProjectRootCfg)) { $ProjectRootCfg = Join-Path $RepoRoot $ProjectRootCfg }
if (-not (Test-Path -LiteralPath $ProjectRootCfg -PathType Container)) {
    Fail "PROJECT_ROOT_MISSING: not a directory: $ProjectRootCfg"
}
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRootCfg).Path

$BaselineFileCfg = [string]$cfg.BaselineFile
if (-not [System.IO.Path]::IsPathRooted($BaselineFileCfg)) { $BaselineFileCfg = Join-Path $RepoRoot $BaselineFileCfg }
if (-not (Test-Path -LiteralPath $BaselineFileCfg -PathType Leaf)) {
    Fail "BASELINE_FILE_MISSING: not a file: $BaselineFileCfg"
}
$BaselineFile = (Resolve-Path -LiteralPath $BaselineFileCfg).Path
$BaselineSha  = ([string]$cfg.BaselineSha256).Trim()

Write-Host "Function     : $FunctionName"
Write-Host "Baseline file: $BaselineFile"

# ---------------------------------------------------------------------------
# Step 1 - verify the baseline hash before anything is touched
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '=== ROLLBACK - step 1: baseline hash ==='

$baselineActual = (Get-FileHash -LiteralPath $BaselineFile -Algorithm SHA256).Hash
Write-Host "baseline sha256   : $baselineActual"
Write-Host "BaselineSha256    : $BaselineSha"

if ($baselineActual -ine $BaselineSha) {
    Fail ("BASELINE_HASH_MISMATCH: '" + $baselineActual + "' does not match BaselineSha256 '" + $BaselineSha +
          "'. The baseline is not identified. Nothing was touched.")
}
Write-Host 'baseline hash     : PASS'

# ---------------------------------------------------------------------------
# Step 2 - target entrypoint
# ---------------------------------------------------------------------------

$targetPath = Join-Path $ProjectRoot ('supabase\functions\{0}\index.ts' -f $FunctionName)
$targetDir  = Split-Path -Parent $targetPath

Write-Host ''
Write-Host '=== ROLLBACK - step 2: target ==='
Write-Host "target entrypoint : $targetPath"

if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) {
    Fail "TARGET_DIR_MISSING: $targetDir"
}

if (-not $ConfirmRollback) {
    Write-Host ''
    Write-Host '=== DRY RUN - no file was copied, nothing was deployed ==='
    Write-Host 'The baseline is identified and would be copied over the entrypoint above,'
    Write-Host 'then deployed through tools\production-deploy.ps1 with the full guard.'
    Write-Host 'Re-run with -ConfirmRollback to execute.'
    Write-Host "EXIT CODE: $EXIT_OK"
    exit $EXIT_OK
}

# ---------------------------------------------------------------------------
# Step 3 - back up what is there now, then put the baseline in place
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '=== ROLLBACK - step 3: swap in the baseline ==='

$backupDir = Join-Path $RepoRoot 'deploy\reports'
if (-not (Test-Path -LiteralPath $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }

if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
    $backupPath = Join-Path $backupDir ("pre_rollback_{0}_{1}.index.ts" -f $FunctionName, $stamp)
    Copy-Item -LiteralPath $targetPath -Destination $backupPath -Force
    $preSha = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
    Write-Host "pre-rollback backup: $backupPath"
    Write-Host "pre-rollback sha256: $preSha"
}
else {
    Write-Host 'pre-rollback backup: none (entrypoint did not exist)'
}

Copy-Item -LiteralPath $BaselineFile -Destination $targetPath -Force

$inPlaceSha = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash
if ($inPlaceSha -ine $BaselineSha) {
    Fail ("COPY_VERIFY_FAILED: the file now at the entrypoint hashes to '" + $inPlaceSha +
          "', not the baseline '" + $BaselineSha + "'. Nothing was deployed.")
}
Write-Host "in-place sha256    : $inPlaceSha"
Write-Host 'in-place hash      : PASS'

# ---------------------------------------------------------------------------
# Step 4 - deploy the baseline through the same guard
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host '=== ROLLBACK - step 4: deploy baseline through production-deploy.ps1 ==='

# A config for the deploy guard where the approved artifact IS the baseline.
$rollbackCfg = [ordered]@{}
foreach ($p in $cfg.PSObject.Properties) { $rollbackCfg[$p.Name] = $p.Value }
$rollbackCfg['FunctionFile']   = $targetPath
$rollbackCfg['ExpectedSha256'] = $BaselineSha

$tmpCfgPath = Join-Path $backupDir ("rollback_config_{0}_{1}.json" -f $FunctionName, $stamp)
$tmpJson    = ($rollbackCfg | ConvertTo-Json -Depth 8)
[System.IO.File]::WriteAllText($tmpCfgPath, $tmpJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "generated config   : $tmpCfgPath"

$deployScript = Join-Path $ScriptRoot 'production-deploy.ps1'
if (-not (Test-Path -LiteralPath $deployScript -PathType Leaf)) {
    Fail "DEPLOY_SCRIPT_MISSING: $deployScript" $EXIT_UNEXPECTED
}

$reportPath = Join-Path $backupDir ("rollback_report_{0}_{1}.json" -f $FunctionName, $stamp)

$deployArgs = @{
    ConfigFile = $tmpCfgPath
    Mode       = 'Deploy'
    ReportPath = $reportPath
}
if ($ConfirmProductionSmoke) { $deployArgs['ConfirmProductionSmoke'] = $true }

& $deployScript @deployArgs
$code = $LASTEXITCODE

Write-Host ''
Write-Host '=== ROLLBACK RESULT ==='
if ($code -eq 0) {
    Write-Host 'ROLLBACK: SUCCESS (baseline deployed, verified and smoke tested)'
}
else {
    Write-Host "ROLLBACK: FAILED - production-deploy.ps1 exited with $code. See $reportPath"
}
Write-Host "EXIT CODE: $code"
exit $code
