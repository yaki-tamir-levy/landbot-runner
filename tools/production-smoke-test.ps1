#Requires -Version 7.0
<#
    production-smoke-test.ps1 - post-deploy smoke test for a Supabase Edge
    Function (project BOT). Implements spec section 6D.

    Runs, at most, three checks:

      1. CORS      - OPTIONS preflight, when the function is expected to
                     support CORS.
      2. NegAuth   - POST with no secret header, expected to be rejected
                     (401/403 by default). Proves the auth gate is live.
      3. RealPost  - a genuine POST with payload and secret. Runs ONLY when a
                     payload file and a secret env name were both supplied AND
                     -ConfirmProductionSmoke was passed. This writes real
                     traffic to production, so it is opt-in twice over.

    The secret is read from an environment variable only. It is never printed,
    never written to the result file, and never placed on a command line.

    Usage (standalone):
        .\tools\production-smoke-test.ps1 `
            -Url https://<ref>.supabase.co/functions/v1/<name> `
            -TestCors -TestNegativeAuth `
            -SecretEnvName LANDBOT_WEBHOOK_SECRET `
            -ResultJsonPath .\deploy\reports\smoke.json

    Exit codes:
        0 = all executed checks passed
        1 = at least one check failed
        2 = bad input (no check could be run)
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Url,

    [switch]$TestCors,

    [switch]$TestNegativeAuth,

    [int[]]$NegativeAuthExpectedCodes = @(401, 403),

    # Path to a JSON body. Required for the real POST check.
    [string]$PostPayloadFile,

    # Name of the environment variable holding the shared secret. The value is
    # never echoed.
    [string]$SecretEnvName,

    [string]$SecretHeaderName = 'x-landbot-secret',

    # Must be passed explicitly before any real POST is sent to production.
    [switch]$ConfirmProductionSmoke,

    [string]$ResultJsonPath,

    [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
    param(
        [string]$Name,
        [string]$Method,
        [string]$Expected,
        [string]$Actual,
        [string]$Result,
        [string]$Detail = ''
    )
    $results.Add([ordered]@{
        name     = $Name
        method   = $Method
        url      = $Url
        expected = $Expected
        actual   = $Actual
        result   = $Result
        detail   = $Detail
    })
    Write-Host ("{0,-10} {1,-8} expected={2,-18} actual={3,-18} {4}" -f $Name, $Method, $Expected, $Actual, $Result)
    if ($Detail) { Write-Host ("           detail: " + $Detail) }
}

function Invoke-Probe {
    <#
        Issues a request and returns the status code without throwing on 4xx or
        5xx. Response bodies are never echoed: an Edge Function error body can
        contain data we do not want in the log.
    #>
    param(
        [string]$Method,
        [hashtable]$Headers = @{},
        [string]$Body
    )
    $params = @{
        Uri                 = $Url
        Method              = $Method
        Headers             = $Headers
        TimeoutSec          = $TimeoutSec
        SkipHttpErrorCheck  = $true
        MaximumRedirection  = 0
        ErrorAction         = 'Stop'
    }
    if ($PSBoundParameters.ContainsKey('Body') -and $Body) {
        $params['Body']        = $Body
        $params['ContentType'] = 'application/json'
    }
    try {
        $resp = Invoke-WebRequest @params
        return [pscustomobject]@{ Ok = $true; StatusCode = [int]$resp.StatusCode; Error = $null; Headers = $resp.Headers }
    }
    catch {
        return [pscustomobject]@{ Ok = $false; StatusCode = -1; Error = $_.Exception.Message; Headers = $null }
    }
}

Write-Host "SMOKE TEST target: $Url"
Write-Host ''

if (-not $TestCors -and -not $TestNegativeAuth -and -not $PostPayloadFile) {
    Write-Host 'SMOKE: no checks were requested. A deploy cannot be declared successful without a smoke test.'
    if ($ResultJsonPath) {
        $dir = Split-Path -Parent $ResultJsonPath
        if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($ResultJsonPath, '[]', (New-Object System.Text.UTF8Encoding($false)))
    }
    exit 2
}

# ---------------------------------------------------------------------------
# 1 - CORS preflight
# ---------------------------------------------------------------------------

if ($TestCors) {
    $h = @{
        'Origin'                         = 'https://example.invalid'
        'Access-Control-Request-Method'  = 'POST'
        'Access-Control-Request-Headers' = $SecretHeaderName
    }
    $r = Invoke-Probe -Method 'OPTIONS' -Headers $h
    if (-not $r.Ok) {
        Add-Result -Name 'cors' -Method 'OPTIONS' -Expected '200/204' -Actual 'transport error' -Result 'FAIL' -Detail $r.Error
    }
    elseif ($r.StatusCode -in @(200, 204)) {
        Add-Result -Name 'cors' -Method 'OPTIONS' -Expected '200/204' -Actual ([string]$r.StatusCode) -Result 'PASS'
    }
    else {
        Add-Result -Name 'cors' -Method 'OPTIONS' -Expected '200/204' -Actual ([string]$r.StatusCode) -Result 'FAIL'
    }
}

# ---------------------------------------------------------------------------
# 2 - negative auth: no secret header must be rejected
# ---------------------------------------------------------------------------

if ($TestNegativeAuth) {
    $expected = ($NegativeAuthExpectedCodes -join '/')
    $r = Invoke-Probe -Method 'POST' -Headers @{} -Body '{}'
    if (-not $r.Ok) {
        Add-Result -Name 'neg-auth' -Method 'POST' -Expected $expected -Actual 'transport error' -Result 'FAIL' -Detail $r.Error
    }
    elseif ($NegativeAuthExpectedCodes -contains $r.StatusCode) {
        Add-Result -Name 'neg-auth' -Method 'POST' -Expected $expected -Actual ([string]$r.StatusCode) -Result 'PASS'
    }
    else {
        Add-Result -Name 'neg-auth' -Method 'POST' -Expected $expected -Actual ([string]$r.StatusCode) -Result 'FAIL' `
                   -Detail 'A request without the shared secret was not rejected.'
    }
}

# ---------------------------------------------------------------------------
# 3 - real POST (opt-in twice: payload+secret supplied AND confirmed)
# ---------------------------------------------------------------------------

if ($PostPayloadFile) {
    if (-not $ConfirmProductionSmoke) {
        Add-Result -Name 'real-post' -Method 'POST' -Expected '2xx' -Actual 'skipped' -Result 'SKIPPED' `
                   -Detail 'A payload was supplied but -ConfirmProductionSmoke was not passed. No real traffic was sent.'
    }
    elseif (-not (Test-Path -LiteralPath $PostPayloadFile -PathType Leaf)) {
        Add-Result -Name 'real-post' -Method 'POST' -Expected '2xx' -Actual 'no payload file' -Result 'FAIL' `
                   -Detail "Payload file not found: $PostPayloadFile"
    }
    elseif (-not $SecretEnvName) {
        Add-Result -Name 'real-post' -Method 'POST' -Expected '2xx' -Actual 'no secret name' -Result 'FAIL' `
                   -Detail 'SecretEnvName was not supplied. Secrets are read from the environment only.'
    }
    else {
        $secretItem = Get-Item -Path "env:$SecretEnvName" -ErrorAction SilentlyContinue
        if (-not $secretItem -or [string]::IsNullOrWhiteSpace($secretItem.Value)) {
            Add-Result -Name 'real-post' -Method 'POST' -Expected '2xx' -Actual 'no secret value' -Result 'FAIL' `
                       -Detail "Environment variable $SecretEnvName is not set. Set it in the shell, not in a config file."
        }
        else {
            $body = Get-Content -LiteralPath $PostPayloadFile -Raw -Encoding UTF8
            $h = @{ $SecretHeaderName = $secretItem.Value }
            $r = Invoke-Probe -Method 'POST' -Headers $h -Body $body
            # $h is dropped here; the secret value is never added to a result.
            if (-not $r.Ok) {
                Add-Result -Name 'real-post' -Method 'POST' -Expected '2xx' -Actual 'transport error' -Result 'FAIL' -Detail $r.Error
            }
            elseif ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) {
                Add-Result -Name 'real-post' -Method 'POST' -Expected '2xx' -Actual ([string]$r.StatusCode) -Result 'PASS' `
                           -Detail "secret sent via header '$SecretHeaderName' (value not logged)"
            }
            else {
                Add-Result -Name 'real-post' -Method 'POST' -Expected '2xx' -Actual ([string]$r.StatusCode) -Result 'FAIL'
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

if ($ResultJsonPath) {
    $dir = Split-Path -Parent $ResultJsonPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $json = ($results | ConvertTo-Json -Depth 6 -AsArray)
    [System.IO.File]::WriteAllText($ResultJsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ''
    Write-Host "SMOKE RESULTS written: $ResultJsonPath"
}

$failed  = @($results | Where-Object { $_.result -eq 'FAIL' })
$ran     = @($results | Where-Object { $_.result -ne 'SKIPPED' })

Write-Host ''
if ($failed.Count -gt 0) {
    Write-Host ("SMOKE: FAIL ({0} of {1} checks failed)" -f $failed.Count, $ran.Count)
    exit 1
}
if ($ran.Count -eq 0) {
    Write-Host 'SMOKE: FAIL (no check actually ran)'
    exit 2
}
Write-Host ("SMOKE: PASS ({0} checks)" -f $ran.Count)
exit 0
