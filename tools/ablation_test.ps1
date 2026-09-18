# ablation_test.ps1 - one fixed-question call to runtime-corrected-response.
# The secret is read from the repo .env (or an already-set environment variable), never inlined.
# Prints corrected_answer and corrector_decision only.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvFile  = Join-Path $RepoRoot '.env'

function Get-SecretValue {
    param([string]$Name, [string]$Path)

    $existing = [Environment]::GetEnvironmentVariable($Name)
    if ($existing -and $existing.Trim()) { return $existing.Trim() }

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "missing configuration: $Name not in environment and $Path not found"
    }

    foreach ($rawLine in [System.IO.File]::ReadAllLines($Path)) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith('#') -or ($line -notmatch '=')) { continue }
        $parts = $line -split '=', 2
        if ($parts[0].Trim() -eq $Name) {
            return $parts[1].Trim().Trim('"').Trim("'")
        }
    }

    throw "missing configuration: $Name not found in $Path"
}

$Secret     = Get-SecretValue -Name 'LANDBOT_WEBHOOK_SECRET' -Path $EnvFile
$RuntimeUrl = 'https://qcwimczsiuxkarwfiyai.supabase.co/functions/v1/runtime-corrected-response'

# Fixed ablation probe. Do not edit between ablation rounds.
$Question20 = 'כן, וזה מרגיש דפוק כי בזמן אמת אני לא קולטת מה קורה לי. רגע אחד אני בקטע שלו בטירוף, ואז פתאום בא לי להתרחק ממנו ומהכל, כאילו סתמי פשוט'
$PatientId  = '8880000001'
$SessionId  = [guid]::NewGuid().ToString()   # fresh id every run

$Payload = [ordered]@{
    question20 = $Question20
    patient_id = $PatientId
    session_id = $SessionId
}

$JsonBody = $Payload | ConvertTo-Json -Depth 4 -Compress
$Bytes    = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)

$Headers = @{
    'x-landbot-secret' = $Secret
}

try {
    $Response = Invoke-RestMethod -Uri $RuntimeUrl -Method Post `
        -Headers $Headers `
        -ContentType 'application/json; charset=utf-8' `
        -Body $Bytes
}
catch {
    Write-Host "request failed: $($_.Exception.Message)"
    $stream = $_.Exception.Response
    if ($stream -and $_.ErrorDetails.Message) {
        Write-Host "body: $($_.ErrorDetails.Message)"
    }
    exit 1
}

Write-Host "session_id: $SessionId"
Write-Host "corrector_decision: $($Response.corrector_decision)"
Write-Host "corrected_answer:"
Write-Host $Response.corrected_answer
