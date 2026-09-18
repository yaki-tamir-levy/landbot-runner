#Requires -Version 7.0
<#
    production-deploy.ps1 - Deployment Guard for Supabase Edge Functions (project BOT)

    Implements the flow required by BOT_Claude_Code_Production_Deploy_Spec.docx,
    sections 5-9:

        Approved source file -> SHA-256 guard -> CLI deploy -> Supabase
        verification -> Smoke test -> Success / needs rollback

    A deploy is NOT considered successful when the upload command returns. It is
    considered successful only after the function metadata was verified and the
    smoke test passed.

    SAFE BY DEFAULT: -Mode Preflight is the default and never touches production.
    An actual deploy requires -Mode Deploy explicitly.

    Usage:
        .\tools\production-deploy.ps1 -ConfigFile .\deploy\my-function.config.json
        .\tools\production-deploy.ps1 -ConfigFile .\deploy\my-function.config.json -Mode Deploy

    Exit codes:
        0 = SUCCESS (Mode Deploy) or PRECHECK_PASSED (Mode Preflight)
        2 = PRECHECK_FAILED   (config / hash / file / CLI guard stopped the run)
        3 = DEPLOY_FAILED     (CLI deploy returned a non-zero exit code)
        4 = VERIFY_FAILED     (function missing, not ACTIVE, or verify_jwt mismatch)
        5 = SMOKE_FAILED      (deploy landed but a smoke test failed - needs review)
        9 = UNEXPECTED_ERROR

    No secrets are ever written to the deployment report or to stdout.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigFile,

    [ValidateSet('Preflight', 'Deploy')]
    [string]$Mode = 'Preflight',

    [string]$ReportPath,

    # Required before any real POST smoke test is sent to production.
    [switch]$ConfirmProductionSmoke
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

$EXIT_OK              = 0
$EXIT_PRECHECK_FAILED = 2
$EXIT_DEPLOY_FAILED   = 3
$EXIT_VERIFY_FAILED   = 4
$EXIT_SMOKE_FAILED    = 5

$ScriptRoot = $PSScriptRoot
$RepoRoot   = Split-Path -Parent $ScriptRoot

# Known production project ref for BOT. Used as the default allow-list so that a
# typo in the config cannot deploy into a foreign project (spec section 7).
$DefaultAllowedProjectRefs = @('qcwimczsiuxkarwfiyai')

# Environment variable names whose values must never be echoed. Extendable per
# config via SecretEnvNames.
$DefaultSecretEnvNames = @(
    'LANDBOT_WEBHOOK_SECRET',
    'SUPABASE_ACCESS_TOKEN',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_DB_URL',
    'OPENAI_API_KEY'
)

# ---------------------------------------------------------------------------
# Report skeleton - every field required by spec section 9
# ---------------------------------------------------------------------------

$Report = [ordered]@{
    timestamp            = (Get-Date).ToString('o')
    mode                 = $Mode
    function_name        = $null
    project_ref          = $null
    source_file          = $null
    source_length        = $null
    source_sha256        = $null
    expected_sha256      = $null
    hash_match           = $null
    cli_version          = $null
    verify_jwt_expected  = $null
    deploy_exit_code     = $null
    deployed_version     = $null
    function_status      = $null
    verify_jwt_actual    = $null
    smoke_test_results   = @()
    final_status         = 'NOT_RUN'
    stop_reason          = $null
    entrypoint_path      = $null
    source_path_check    = $null
}

$script:SecretValues       = @()
$script:ResolvedReportPath = $null

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Get-SecretValues {
    param([string[]]$Names)
    $values = @()
    foreach ($n in $Names) {
        if ([string]::IsNullOrWhiteSpace($n)) { continue }
        $item = Get-Item -Path "env:$n" -ErrorAction SilentlyContinue
        if ($item -and -not [string]::IsNullOrWhiteSpace($item.Value)) {
            $values += $item.Value
        }
    }
    return $values
}

function Protect-Output {
    <#
        Replaces every known secret value with [REDACTED]. Applied to all
        captured CLI output before it is printed or stored (spec sections 6D,
        9 and 12).
    #>
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $out = $Text
    foreach ($s in $script:SecretValues) {
        if ([string]::IsNullOrWhiteSpace($s)) { continue }
        if ($s.Length -lt 6) { continue }
        $out = $out.Replace($s, '[REDACTED]')
    }
    return $out
}

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "=== $Text ==="
}

function Write-Line {
    param([string]$Text)
    Write-Host (Protect-Output $Text)
}

function Save-Report {
    param([string]$Path)
    try {
        $dir = Split-Path -Parent $Path
        if ($dir -and -not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        $json = ($Report | ConvertTo-Json -Depth 8)
        $json = Protect-Output $json
        [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "REPORT written: $Path"
    }
    catch {
        Write-Host ("WARNING: could not write report to " + $Path + ": " + $_.Exception.Message)
    }
}

function Stop-Run {
    <# Terminal exit path. Always writes the deployment report first. #>
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][int]$Code,
        [Parameter(Mandatory = $true)][string]$Reason
    )
    $Report.final_status = $Status
    $Report.stop_reason  = $Reason
    Write-Host ''
    Write-Host "STOP: $Status"
    Write-Line "REASON: $Reason"
    Save-Report -Path $script:ResolvedReportPath
    Write-Host "EXIT CODE: $Code"
    exit $Code
}

function Invoke-Native {
    <#
        Runs a native executable, capturing stdout+stderr and the exit code
        without throwing. Returns a PSCustomObject.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $pushed = $false
    try {
        if ($WorkingDirectory) {
            Push-Location -LiteralPath $WorkingDirectory
            $pushed = $true
        }
        $output = & $FilePath @Arguments 2>&1 | ForEach-Object { $_.ToString() }
        $code   = $LASTEXITCODE
        return [pscustomobject]@{
            ExitCode = $code
            Output   = ($output -join [Environment]::NewLine)
        }
    }
    finally {
        # Working directory is restored even on exception (spec section 6B).
        if ($pushed) { Pop-Location }
        $ErrorActionPreference = $prev
    }
}

# ---------------------------------------------------------------------------
# STEP 0 - Configuration (spec section 5)
# ---------------------------------------------------------------------------

$stamp = (Get-Date).ToString('yyyyMMdd_HHmmss')
if ($ReportPath) {
    $script:ResolvedReportPath = $ReportPath
}
else {
    $script:ResolvedReportPath = Join-Path $RepoRoot ('deploy\reports\deploy_report_{0}.json' -f $stamp)
}

Write-Step 'STEP 0 - configuration'
Write-Host "Mode        : $Mode"
Write-Host "Config file : $ConfigFile"
Write-Host "Report file : $script:ResolvedReportPath"

if (-not (Test-Path -LiteralPath $ConfigFile -PathType Leaf)) {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason "Config file not found: $ConfigFile"
}

try {
    $cfg = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
}
catch {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason ('Config file is not valid JSON: ' + $_.Exception.Message)
}

$cfgNames = @($cfg.PSObject.Properties.Name)

# Extra secret names from the config, so redaction covers them too.
$secretEnvNames = $DefaultSecretEnvNames
if ($cfgNames -contains 'SecretEnvNames' -and $cfg.SecretEnvNames) {
    $secretEnvNames = @($secretEnvNames) + @($cfg.SecretEnvNames)
}
if ($cfgNames -contains 'SmokeTest' -and $cfg.SmokeTest -and $cfg.SmokeTest.SecretEnvName) {
    $secretEnvNames = @($secretEnvNames) + @($cfg.SmokeTest.SecretEnvName)
}
$script:SecretValues = Get-SecretValues -Names ($secretEnvNames | Select-Object -Unique)

# --- required fields -------------------------------------------------------

$required = @(
    'FunctionName',
    'ProjectRef',
    'ProjectRoot',
    'FunctionFile',
    'ExpectedSha256',
    'VerifyJwt',
    'SmokeTestUrl'
)

$missing = @()
foreach ($field in $required) {
    if ($cfgNames -notcontains $field) {
        $missing += $field
        continue
    }
    $val = $cfg.$field
    # VerifyJwt is a boolean: $false is a legal value, only null counts as missing.
    if ($field -eq 'VerifyJwt') {
        if ($null -eq $val) { $missing += $field }
        continue
    }
    if ($null -eq $val -or ([string]$val).Trim() -eq '') { $missing += $field }
}

if ($missing.Count -gt 0) {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason ('MISSING_REQUIRED_INPUT: ' + ($missing -join ', ') + ' (spec section 5)')
}

if ($cfg.VerifyJwt -isnot [bool]) {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason ("VerifyJwt must be a JSON boolean (true/false), got: '" + $cfg.VerifyJwt + "'")
}

$FunctionName    = [string]$cfg.FunctionName
$ProjectRef      = [string]$cfg.ProjectRef
$ProjectRootCfg  = [string]$cfg.ProjectRoot
$FunctionFileCfg = [string]$cfg.FunctionFile
$ExpectedSha     = ([string]$cfg.ExpectedSha256).Trim()
$VerifyJwt       = [bool]$cfg.VerifyJwt
$SmokeTestUrl    = [string]$cfg.SmokeTestUrl

$Report.function_name       = $FunctionName
$Report.project_ref         = $ProjectRef
$Report.expected_sha256     = $ExpectedSha
$Report.verify_jwt_expected = $VerifyJwt

Write-Host "Function    : $FunctionName"
Write-Host "Project ref : $ProjectRef"
Write-Host "verify_jwt  : $VerifyJwt (expected)"

# ---------------------------------------------------------------------------
# STEP A - Preflight (spec section 6A, guards in section 7)
# ---------------------------------------------------------------------------

Write-Step 'STEP A - preflight'

# A1 - project ref must be explicit and expected -----------------------------
$allowed = $DefaultAllowedProjectRefs
if ($cfgNames -contains 'AllowedProjectRefs' -and $cfg.AllowedProjectRefs) {
    $allowed = @($cfg.AllowedProjectRefs)
}
if ($allowed -notcontains $ProjectRef) {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason ("UNEXPECTED_PROJECT_REF: '" + $ProjectRef + "' is not in the allow-list (" + ($allowed -join ', ') + ')')
}
Write-Host 'A1 project ref allow-list       : PASS'

# A2 - ProjectRoot exists ----------------------------------------------------
if (-not [System.IO.Path]::IsPathRooted($ProjectRootCfg)) {
    $ProjectRootCfg = Join-Path $RepoRoot $ProjectRootCfg
}
if (-not (Test-Path -LiteralPath $ProjectRootCfg -PathType Container)) {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason "PROJECT_ROOT_MISSING: not a directory: $ProjectRootCfg"
}
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRootCfg).Path
Write-Host "A2 ProjectRoot exists           : PASS  ($ProjectRoot)"

# A3 - FunctionFile exists and is a file -------------------------------------
if (-not [System.IO.Path]::IsPathRooted($FunctionFileCfg)) {
    $FunctionFileCfg = Join-Path $RepoRoot $FunctionFileCfg
}
if (-not (Test-Path -LiteralPath $FunctionFileCfg -PathType Leaf)) {
    $Report.source_file = $FunctionFileCfg
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason "FUNCTION_FILE_MISSING: not a file: $FunctionFileCfg"
}
$FunctionFile = (Resolve-Path -LiteralPath $FunctionFileCfg).Path
$Report.source_file = $FunctionFile
Write-Host "A3 FunctionFile exists          : PASS  ($FunctionFile)"

# A4 - the approved file must be the file the CLI will actually bundle --------
# This is exactly the failure the guard exists to prevent (spec section 16):
# the CLI deploys <ProjectRoot>\supabase\functions\<name>\index.ts, so if the
# approved artifact lives anywhere else, something other than the approved
# artifact reaches production.
$expectedSourcePath = Join-Path $ProjectRoot ('supabase\functions\{0}\index.ts' -f $FunctionName)
$allowMismatch = $false
if ($cfgNames -contains 'AllowSourcePathMismatch') { $allowMismatch = [bool]$cfg.AllowSourcePathMismatch }

if ($FunctionFile -ieq $expectedSourcePath) {
    $Report.source_path_check = 'MATCH'
    Write-Host 'A4 source path is CLI entrypoint: PASS'
}
elseif ($allowMismatch) {
    $Report.source_path_check = 'MISMATCH_ALLOWED'
    Write-Host 'A4 source path is CLI entrypoint: WARN (AllowSourcePathMismatch=true)'
    Write-Host "   expected: $expectedSourcePath"
    Write-Host "   approved: $FunctionFile"
}
else {
    $Report.source_path_check = 'MISMATCH'
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason ("SOURCE_PATH_MISMATCH: the CLI would deploy '" + $expectedSourcePath +
                      "' but the approved artifact is '" + $FunctionFile +
                      "'. Copy the approved file into place, or set AllowSourcePathMismatch=true if this is deliberate.")
}

# A5 - length and SHA-256 ----------------------------------------------------
$fileInfo = Get-Item -LiteralPath $FunctionFile
$Report.source_length = $fileInfo.Length
$actualSha = (Get-FileHash -LiteralPath $FunctionFile -Algorithm SHA256).Hash
$Report.source_sha256 = $actualSha

Write-Host "A5 source length                : $($fileInfo.Length) bytes"
Write-Host "   source sha256                : $actualSha"
Write-Host "   expected sha256              : $ExpectedSha"

# A6 - hash guard, case-insensitive ------------------------------------------
$hashMatch = ($actualSha -ieq $ExpectedSha)
$Report.hash_match = $hashMatch
if (-not $hashMatch) {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason ("HASH_MISMATCH: file sha256 '" + $actualSha + "' does not match ExpectedSha256 '" +
                      $ExpectedSha + "'. Nothing was deployed.")
}
Write-Host 'A6 sha256 guard                 : PASS'

# A7 - CLI present -----------------------------------------------------------
$cliName = 'supabase'
if ($cfgNames -contains 'SupabaseCliPath' -and $cfg.SupabaseCliPath) { $cliName = [string]$cfg.SupabaseCliPath }

$cliCmd = Get-Command $cliName -ErrorAction SilentlyContinue
if (-not $cliCmd) {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason ("SUPABASE_CLI_NOT_FOUND: '" + $cliName + "' is not on PATH")
}

$ver = Invoke-Native -FilePath $cliName -Arguments @('--version')
if ($ver.ExitCode -ne 0) {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason "SUPABASE_CLI_VERSION_FAILED: exit $($ver.ExitCode)"
}
$cliVersion = ($ver.Output -split "`n" | Where-Object { $_ -match '^\s*\d+\.\d+' } | Select-Object -First 1)
if (-not $cliVersion) { $cliVersion = ($ver.Output -split "`n" | Select-Object -First 1) }
$Report.cli_version = ([string]$cliVersion).Trim()
Write-Host "A7 supabase CLI                 : PASS  (v$($Report.cli_version))"

# A8 - the flags this script relies on must exist in the installed CLI -------
$help = Invoke-Native -FilePath $cliName -Arguments @('functions', 'deploy', '--help')
if ($help.ExitCode -ne 0) {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason "CLI_HELP_FAILED: 'functions deploy --help' exit $($help.ExitCode)"
}
$requiredFlags = @('--project-ref', '--no-verify-jwt')
$missingFlags = @()
foreach ($f in $requiredFlags) {
    if ($help.Output -notmatch [regex]::Escape($f)) { $missingFlags += $f }
}
if ($missingFlags.Count -gt 0) {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED `
             -Reason ('CLI_FLAG_MISSING: installed CLI does not support ' + ($missingFlags -join ', '))
}
Write-Host ('A8 required CLI flags present   : PASS  (' + ($requiredFlags -join ', ') + ')')

Write-Host ''
Write-Host 'PREFLIGHT: PASS'

if ($Mode -eq 'Preflight') {
    $Report.final_status = 'PRECHECK_PASSED'
    $Report.stop_reason  = 'Preflight mode: stopped before the CLI deploy by design. No production change was made.'
    Write-Host ''
    Write-Host 'STOP: PRECHECK_PASSED (preflight mode - no deploy attempted)'
    Save-Report -Path $script:ResolvedReportPath
    Write-Host "EXIT CODE: $EXIT_OK"
    exit $EXIT_OK
}

# ---------------------------------------------------------------------------
# STEP B - Deploy (spec section 6B)
# ---------------------------------------------------------------------------

Write-Step 'STEP B - deploy'

$deployArgs = @('functions', 'deploy', $FunctionName, '--project-ref', $ProjectRef)
if (-not $VerifyJwt) { $deployArgs += '--no-verify-jwt' }
if ($cfgNames -contains 'UseApiBundling' -and [bool]$cfg.UseApiBundling) { $deployArgs += '--use-api' }
if ($cfgNames -contains 'ImportMap' -and $cfg.ImportMap) { $deployArgs += @('--import-map', [string]$cfg.ImportMap) }

# Hard rule: exactly one named function, never --prune (spec sections 4 and 6B).
if ($deployArgs -contains '--prune') {
    Stop-Run -Status 'PRECHECK_FAILED' -Code $EXIT_PRECHECK_FAILED -Reason 'INTERNAL_GUARD: --prune is forbidden'
}

Write-Host "Command     : $cliName $($deployArgs -join ' ')"
Write-Host "Working dir : $ProjectRoot"
Write-Host ''

$deploy = Invoke-Native -FilePath $cliName -Arguments $deployArgs -WorkingDirectory $ProjectRoot
$Report.deploy_exit_code = $deploy.ExitCode
Write-Line $deploy.Output
Write-Host ''
Write-Host "Deploy exit code: $($deploy.ExitCode)"

if ($deploy.ExitCode -ne 0) {
    Stop-Run -Status 'DEPLOY_FAILED' -Code $EXIT_DEPLOY_FAILED `
             -Reason "DEPLOY_EXIT_NONZERO: supabase functions deploy returned $($deploy.ExitCode)"
}

# ---------------------------------------------------------------------------
# STEP C - Verification (spec section 6C)
# ---------------------------------------------------------------------------

Write-Step 'STEP C - verification'

$list = Invoke-Native -FilePath $cliName -Arguments @('functions', 'list', '--project-ref', $ProjectRef, '-o', 'json')
if ($list.ExitCode -ne 0) {
    Write-Line $list.Output
    Stop-Run -Status 'VERIFY_FAILED' -Code $EXIT_VERIFY_FAILED `
             -Reason "VERIFY_LIST_FAILED: 'functions list' returned $($list.ExitCode). The deploy command succeeded but the result could not be verified."
}

# The CLI appends an upgrade notice after the JSON; keep only the JSON array.
$jsonText = $list.Output
$start = $jsonText.IndexOf('[')
$end   = $jsonText.LastIndexOf(']')
if ($start -lt 0 -or $end -le $start) {
    Stop-Run -Status 'VERIFY_FAILED' -Code $EXIT_VERIFY_FAILED `
             -Reason 'VERIFY_PARSE_FAILED: could not locate a JSON array in the CLI output'
}
$jsonText = $jsonText.Substring($start, $end - $start + 1)

try { $functions = $jsonText | ConvertFrom-Json }
catch {
    Stop-Run -Status 'VERIFY_FAILED' -Code $EXIT_VERIFY_FAILED `
             -Reason ('VERIFY_PARSE_FAILED: ' + $_.Exception.Message)
}

$fn = $functions | Where-Object { $_.slug -eq $FunctionName } | Select-Object -First 1
if (-not $fn) {
    Stop-Run -Status 'VERIFY_FAILED' -Code $EXIT_VERIFY_FAILED `
             -Reason ("FUNCTION_NOT_FOUND: '" + $FunctionName + "' does not exist in project '" + $ProjectRef + "' after deploy")
}

$Report.function_status   = $fn.status
$Report.deployed_version  = $fn.version
$Report.verify_jwt_actual = $fn.verify_jwt
$Report.entrypoint_path   = $fn.entrypoint_path

Write-Host "C1 function found               : PASS  (slug=$($fn.slug))"
Write-Host "C2 status                       : $($fn.status)"
Write-Host "C3 verify_jwt actual            : $($fn.verify_jwt)   expected: $VerifyJwt"
Write-Host "C4 deployed version             : $($fn.version)"
Write-Host "C5 entrypoint_path              : $($fn.entrypoint_path)"

if ($fn.status -ne 'ACTIVE') {
    Stop-Run -Status 'VERIFY_FAILED' -Code $EXIT_VERIFY_FAILED `
             -Reason ("FUNCTION_NOT_ACTIVE: status is '" + $fn.status + "', expected ACTIVE")
}
if ([bool]$fn.verify_jwt -ne $VerifyJwt) {
    Stop-Run -Status 'VERIFY_FAILED' -Code $EXIT_VERIFY_FAILED `
             -Reason ("VERIFY_JWT_MISMATCH: actual '" + $fn.verify_jwt + "' expected '" + $VerifyJwt + "'")
}

# Advisory only. The deployed bundle SHA is not the source SHA and must not be
# compared as if it were (spec section 6C).
$entryPattern = 'supabase/functions/' + [regex]::Escape($FunctionName) + '/index\.ts$'
if ($fn.entrypoint_path -and ($fn.entrypoint_path -notmatch $entryPattern)) {
    Write-Host "C6 entrypoint characteristic    : NOTE - deployed entrypoint does not end with supabase/functions/$FunctionName/index.ts"
}
else {
    Write-Host 'C6 entrypoint characteristic    : PASS'
}

Write-Host ''
Write-Host 'VERIFICATION: PASS'

# ---------------------------------------------------------------------------
# STEP D - Smoke test (spec section 6D)
# ---------------------------------------------------------------------------

Write-Step 'STEP D - smoke test'

$smokeScript = Join-Path $ScriptRoot 'production-smoke-test.ps1'
if (-not (Test-Path -LiteralPath $smokeScript -PathType Leaf)) {
    Stop-Run -Status 'SMOKE_FAILED' -Code $EXIT_SMOKE_FAILED `
             -Reason "SMOKE_SCRIPT_MISSING: $smokeScript"
}

$smokeResultPath = ($script:ResolvedReportPath -replace '\.json$', '') + '_smoke.json'

$smokeArgs = @{
    Url            = $SmokeTestUrl
    ResultJsonPath = $smokeResultPath
}
$st = $null
if ($cfgNames -contains 'SmokeTest') { $st = $cfg.SmokeTest }
if ($st) {
    $stNames = @($st.PSObject.Properties.Name)
    if ($stNames -contains 'TestCors' -and [bool]$st.TestCors) { $smokeArgs['TestCors'] = $true }
    if ($stNames -contains 'TestNegativeAuth' -and [bool]$st.TestNegativeAuth) { $smokeArgs['TestNegativeAuth'] = $true }
    if ($stNames -contains 'NegativeAuthExpectedCodes' -and $st.NegativeAuthExpectedCodes) {
        $smokeArgs['NegativeAuthExpectedCodes'] = [int[]]$st.NegativeAuthExpectedCodes
    }
    if ($stNames -contains 'SecretHeaderName' -and $st.SecretHeaderName) { $smokeArgs['SecretHeaderName'] = [string]$st.SecretHeaderName }
    if ($stNames -contains 'SecretEnvName' -and $st.SecretEnvName) { $smokeArgs['SecretEnvName'] = [string]$st.SecretEnvName }
    if ($stNames -contains 'PostPayloadFile' -and $st.PostPayloadFile) {
        $ppf = [string]$st.PostPayloadFile
        if (-not [System.IO.Path]::IsPathRooted($ppf)) { $ppf = Join-Path $RepoRoot $ppf }
        $smokeArgs['PostPayloadFile'] = $ppf
    }
}
if ($ConfirmProductionSmoke) { $smokeArgs['ConfirmProductionSmoke'] = $true }

& $smokeScript @smokeArgs
$smokeExit = $LASTEXITCODE

if (Test-Path -LiteralPath $smokeResultPath) {
    try {
        $Report.smoke_test_results = @(Get-Content -LiteralPath $smokeResultPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    catch {
        $Report.smoke_test_results = @(@{ name = 'parse'; result = 'FAIL'; detail = $_.Exception.Message })
    }
}

if ($smokeExit -ne 0) {
    Stop-Run -Status 'SMOKE_FAILED' -Code $EXIT_SMOKE_FAILED `
             -Reason 'SMOKE_TEST_FAILED: the function is deployed but did not pass the smoke test. Treat as Needs Review and consider rollback via tools\production-rollback.ps1.'
}

# ---------------------------------------------------------------------------
# Success
# ---------------------------------------------------------------------------

$Report.final_status = 'SUCCESS'
$Report.stop_reason  = $null

Write-Host ''
Write-Host '=== RESULT ==='
Write-Host 'FINAL STATUS: SUCCESS'
Write-Host "Function    : $FunctionName"
Write-Host "Project ref : $ProjectRef"
Write-Host "Version     : $($Report.deployed_version)"
Write-Host "sha256      : $($Report.source_sha256)"
Save-Report -Path $script:ResolvedReportPath
Write-Host "EXIT CODE: $EXIT_OK"
exit $EXIT_OK
