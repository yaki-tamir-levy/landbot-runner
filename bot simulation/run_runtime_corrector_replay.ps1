param(
    [string]$RuntimeCorrectorModel = "gpt-5.4",
    [string]$Root = "C:\Users\User\Documents\landbot-runner-clean\bot simulation",
    [string]$OutputRoot = "",
    [int]$MaxApiAttempts = 6,
    [int]$BaseRetrySeconds = 5,
    [int]$DelayBetweenStepsSeconds = 3
)

$ErrorActionPreference = "Stop"

$PromptFile = Join-Path $Root "prompt20.rtf"
$PrePatientFile = Join-Path $Root "pre_patient20.rtf"
$PatientFile = Join-Path $Root "patient20.rtf"
$RequestBodyFile = Join-Path $Root "Request Body.rtf"
$QuestionsFile = Join-Path $Root "replay_questions_dina.rtf"
$RuntimeCorrectorPromptFile = Join-Path $Root "runtime_corrector_system_prompt.rtf"

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $Root "runtime_corrector_runs"
}

function NowStamp {
    return (Get-Date).ToString("yyyyMMdd_HHmmss")
}

function Write-Status {
    param([string]$Message)
    Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $Message)
}

function Get-OpenAIKey {
    $key = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "User")
    if ([string]::IsNullOrWhiteSpace($key)) { $key = $env:OPENAI_API_KEY }
    if ([string]::IsNullOrWhiteSpace($key)) { $key = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "Machine") }
    if ([string]::IsNullOrWhiteSpace($key)) { throw "OPENAI_API_KEY is missing from User, Process, and Machine environment variables." }
    return $key
}

function Assert-RequiredFile {
    param([string]$Path, [string]$Name, [int]$MinBytes = 1)
    if (-not (Test-Path -LiteralPath $Path)) { throw "Required file missing: $Name at $Path" }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -lt $MinBytes) { throw "Required file is too small: $Name at $Path length=$($item.Length)" }
}

function Assert-NoNul {
    param([string]$Path, [string]$Name)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes -contains 0) { throw "$Name contains NUL bytes: $Path" }
}

function Get-StringSha256 {
    param([AllowNull()][string]$Text)
    if ($null -eq $Text) { $Text = "" }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha.ComputeHash($bytes)
        return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
    }
    finally {
        $sha.Dispose()
    }
}

function Get-TextEncodingFromBytes {
    param(
        [byte[]]$Bytes,
        [int]$DefaultCodePage = 65001
    )

    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
        return New-Object System.Text.UTF8Encoding($true)
    }

    if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE) {
        return [System.Text.Encoding]::Unicode
    }

    if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFE -and $Bytes[1] -eq 0xFF) {
        return [System.Text.Encoding]::BigEndianUnicode
    }

    $prefixLength = [Math]::Min($Bytes.Length, 4096)
    $prefix = [System.Text.Encoding]::ASCII.GetString($Bytes, 0, $prefixLength)
    if ($prefix -match '\\ansicpg(\d+)') {
        return [System.Text.Encoding]::GetEncoding([int]$Matches[1])
    }

    return [System.Text.Encoding]::GetEncoding($DefaultCodePage)
}

function ConvertFrom-RtfToPlainTextFallback {
    param([string]$Rtf)
    if ([string]::IsNullOrWhiteSpace($Rtf)) { return "" }

    $s = $Rtf
    $s = [regex]::Replace($s, '\{\\\*(?:[^{}]|\{[^{}]*\})*\}', '', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    $s = [regex]::Replace($s, '\{\\fonttbl(?:[^{}]|\{[^{}]*\})*\}', '', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    $s = [regex]::Replace($s, '\{\\colortbl(?:[^{}]|\{[^{}]*\})*\}', '', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    $s = [regex]::Replace($s, "\\u(-?\d+)(?:\\'[0-9a-fA-F]{2}|.)?", {
        param($m)
        $n = [int]$m.Groups[1].Value
        if ($n -lt 0) { $n += 65536 }
        return [string][char]$n
    })
    $enc1255 = [System.Text.Encoding]::GetEncoding(1255)
    $s = [regex]::Replace($s, "\\'([0-9a-fA-F]{2})", {
        param($m)
        $b = [Convert]::ToByte($m.Groups[1].Value, 16)
        return $enc1255.GetString([byte[]]@($b))
    })
    $s = $s -replace '\\par[d]?\b', "`n"
    $s = $s -replace '\\line\b', "`n"
    $s = $s -replace '\\tab\b', "`t"
    $s = $s -replace '\\\\', [string][char]92
    $s = $s -replace '\\\{', '{'
    $s = $s -replace '\\\}', '}'
    $s = [regex]::Replace($s, '\\[a-zA-Z]+-?\d*\s?', '')
    $s = [regex]::Replace($s, '\\[^a-zA-Z0-9]', '')
    $s = $s.Replace('{', '').Replace('}', '')
    return $s.Trim()
}

function Test-HebrewMojibake {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $false }

    $replacementChar = [string][char]0xFFFD
    $latinCapitalAWithTilde = [string][char]0x00C3
    $latinCapitalAWithCircumflex = [string][char]0x00C2
    $multiplicationSign = [string][char]0x00D7
    $divisionSign = [string][char]0x00F7

    if ($Text.Contains($replacementChar) -or $Text.Contains($latinCapitalAWithTilde) -or $Text.Contains($latinCapitalAWithCircumflex)) {
        return $true
    }

    if (($Text.Contains($multiplicationSign) -or $Text.Contains($divisionSign)) -and $Text -notmatch '[\u0590-\u05FF]') {
        return $true
    }

    if ($Text -match '\?{3,}' -and $Text -notmatch '[\u0590-\u05FF]') {
        return $true
    }

    return $false
}

function Read-RtfOrText {
    param([string]$Path, [int]$DefaultCodePage = 1255)
    if (-not (Test-Path -LiteralPath $Path)) { throw "File not found: $Path" }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0) { return "" }
    if ($bytes -contains 0) { throw "File contains NUL bytes: $Path" }

    $prefixLength = [Math]::Min($bytes.Length, 16)
    $prefix = [System.Text.Encoding]::ASCII.GetString($bytes, 0, $prefixLength)
    $isRtf = $prefix.TrimStart().StartsWith("{\rtf")

    if ($isRtf) {
        Add-Type -AssemblyName System.Windows.Forms
        $box = New-Object System.Windows.Forms.RichTextBox
        try {
            $box.LoadFile($Path, [System.Windows.Forms.RichTextBoxStreamType]::RichText)
            $text = [string]$box.Text
        }
        finally {
            $box.Dispose()
        }

        if ($text.Contains([char]0)) { throw "Decoded RTF contains NUL characters: $Path" }
        if (-not [string]::IsNullOrWhiteSpace($text) -and -not (Test-HebrewMojibake -Text $text)) { return $text }

        $encoding = Get-TextEncodingFromBytes -Bytes $bytes -DefaultCodePage $DefaultCodePage
        $fallbackText = ConvertFrom-RtfToPlainTextFallback -Rtf ($encoding.GetString($bytes))
        if ($fallbackText.Contains([char]0)) { throw "Decoded RTF fallback contains NUL characters: $Path" }
        return $fallbackText
    }

    $plainEncoding = Get-TextEncodingFromBytes -Bytes $bytes -DefaultCodePage 65001
    $plainText = $plainEncoding.GetString($bytes)
    if ($plainText.Contains([char]0)) { throw "Decoded text contains NUL characters: $Path" }
    return $plainText
}

function ConvertTo-ReplayQuestions {
    param([string]$Text)
    if ($Text.Contains([char]0)) { throw "Decoded replay questions contain NUL characters." }
    if (Test-HebrewMojibake -Text $Text) { throw "Replay questions decode validation failed. Decoded text appears to contain mojibake." }

    $questions = @(
        $Text -split "\r?\n" |
            ForEach-Object { $_.Trim() } |
            Where-Object {
                -not [string]::IsNullOrWhiteSpace($_) -and
                $_ -ne "---" -and
                $_ -notmatch '^[\s\-=_*.,;:]+$'
            }
    )

    if ($questions.Count -lt 1) { throw "Replay question validation failed. No decoded patient questions found." }
    return $questions
}

function ConvertTo-RtfEscapedUnicode {
    param([AllowEmptyString()][string]$Text)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("{\rtf1\ansi\ansicpg1255\deff0\uc1")
    [void]$sb.Append("{\fonttbl{\f0 Arial;}}")
    [void]$sb.Append("\viewkind4\pard\rtlpar\qr\f0\fs24 ")

    foreach ($ch in $Text.ToCharArray()) {
        $code = [int][char]$ch
        switch ($ch) {
            "\" { [void]$sb.Append("\\") }
            "{" { [void]$sb.Append("\{") }
            "}" { [void]$sb.Append("\}") }
            "`r" {}
            "`n" { [void]$sb.Append("\par ") }
            "`t" { [void]$sb.Append("\tab ") }
            default {
                if ($code -ge 32 -and $code -le 126) {
                    [void]$sb.Append($ch)
                }
                else {
                    if ($code -gt 32767) { $code -= 65536 }
                    [void]$sb.Append("\u")
                    [void]$sb.Append($code)
                    [void]$sb.Append("?")
                }
            }
        }
    }

    [void]$sb.Append("}")
    return $sb.ToString()
}

function Save-ConversationRtf {
    param([string]$Path, [string]$Text)
    $rtf = ConvertTo-RtfEscapedUnicode -Text $Text
    [System.IO.File]::WriteAllText($Path, $rtf, (New-Object System.Text.UTF8Encoding($false)))
}

function Add-DebugSection {
    param([string]$Path, [string]$Title, [AllowNull()][string]$Content)
    if ($null -eq $Content) { $Content = "" }
    @"

============================================================
$Title
============================================================
$Content

"@ | Out-File -LiteralPath $Path -Append -Encoding UTF8
}

function Write-Utf8NoBom {
    param([string]$Path, [AllowNull()][string]$Text)
    if ($null -eq $Text) { $Text = "" }
    [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Append-Utf8NoBom {
    param([string]$Path, [AllowNull()][string]$Text)
    if ($null -eq $Text) { $Text = "" }
    [System.IO.File]::AppendAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-ResponseText {
    param($Response)
    if ($null -ne $Response.output_text -and -not [string]::IsNullOrWhiteSpace([string]$Response.output_text)) {
        return [string]$Response.output_text
    }

    $parts = @()
    if ($null -ne $Response.output) {
        foreach ($item in $Response.output) {
            if ($null -ne $item.content) {
                foreach ($content in $item.content) {
                    if ($null -ne $content.text -and -not [string]::IsNullOrWhiteSpace([string]$content.text)) {
                        $parts += [string]$content.text
                    }
                }
            }
        }
    }

    if ($parts.Count -gt 0) { return ($parts -join "`n").Trim() }
    return ($Response | ConvertTo-Json -Depth 50)
}

function Get-HttpStatusCodeFromError {
    param($ErrorRecord)
    try {
        if ($null -ne $ErrorRecord.Exception.Response.StatusCode) {
            return [int]$ErrorRecord.Exception.Response.StatusCode
        }
    }
    catch {}
    return $null
}

function Get-RetryAfterSeconds {
    param($ErrorRecord, [int]$Attempt)
    $message = [string]$ErrorRecord.Exception.Message
    if ($message -match 'try again in\s+([0-9]+(?:\.[0-9]+)?)s') {
        return [int][Math]::Ceiling(([double]$Matches[1]) + 2)
    }

    $seconds = $BaseRetrySeconds * [Math]::Pow(2, ($Attempt - 1))
    return [int][Math]::Min($seconds, 120)
}

function Invoke-OpenAIWithRetry {
    param(
        [string]$ApiKey,
        [string]$JsonBody,
        [string]$Label,
        [string]$DebugFile
    )

    $apiResponse = $null
    $attempt = 0

    while ($null -eq $apiResponse -and $attempt -lt $MaxApiAttempts) {
        $attempt++
        Write-Status "Sending $Label to OpenAI - attempt $attempt of $MaxApiAttempts"
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

        try {
            $apiResponse = Invoke-RestMethod `
                -Uri "https://api.openai.com/v1/responses" `
                -Method POST `
                -Headers @{ "Authorization" = "Bearer $ApiKey" } `
                -ContentType "application/json; charset=utf-8" `
                -Body ([System.Text.Encoding]::UTF8.GetBytes($JsonBody)) `
                -TimeoutSec 120

            $stopwatch.Stop()
            Write-Status ("Received {0} after {1} seconds" -f $Label, [math]::Round($stopwatch.Elapsed.TotalSeconds, 1))
        }
        catch {
            $stopwatch.Stop()
            $statusCode = Get-HttpStatusCodeFromError -ErrorRecord $_
            $errorText = ($_ | Out-String)
            $isRateLimit = ($statusCode -eq 429 -or $errorText -match 'rate_limit_exceeded' -or $errorText -match 'Rate limit reached')

            Add-DebugSection -Path $DebugFile -Title "$Label - API ERROR - ATTEMPT $attempt" -Content @"
HTTP status: $statusCode
Rate limit detected: $isRateLimit

$errorText
"@

            if ($isRateLimit -and $attempt -lt $MaxApiAttempts) {
                $waitSeconds = Get-RetryAfterSeconds -ErrorRecord $_ -Attempt $attempt
                Write-Status "Rate limit detected for $Label. Waiting $waitSeconds seconds before retrying."
                Start-Sleep -Seconds $waitSeconds
                continue
            }

            throw
        }
    }

    if ($null -eq $apiResponse) { throw "OpenAI API did not return a response for $Label after $MaxApiAttempts attempts." }
    return $apiResponse
}

function ConvertFrom-StrictJsonObject {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { throw "Corrector returned empty text." }

    $clean = $Text.Trim()
    if (-not ($clean.StartsWith("{") -and $clean.EndsWith("}"))) {
        throw "Corrector response is not a single JSON object."
    }

    try {
        return ($clean | ConvertFrom-Json)
    }
    catch {
        throw "Corrector response is invalid JSON: $($_.Exception.Message)"
    }
}

function Assert-NoFutureContamination {
    param(
        [object[]]$VisibleHistory,
        [int]$CurrentTurn
    )

    foreach ($item in $VisibleHistory) {
        if ($null -eq $item.turn_number) { throw "No-look-ahead guard failed: history item missing turn_number." }
        if ([int]$item.turn_number -gt $CurrentTurn) {
            throw "No-look-ahead guard failed: turn $($item.turn_number) is greater than current turn $CurrentTurn."
        }
    }

    $currentPatient = @($VisibleHistory | Where-Object { [int]$_.turn_number -eq $CurrentTurn -and [string]$_.role -eq "patient" })
    if ($currentPatient.Count -ne 1) {
        throw "No-look-ahead guard failed: expected exactly one current patient message for turn $CurrentTurn, found $($currentPatient.Count)."
    }

    $futureBot = @($VisibleHistory | Where-Object { [int]$_.turn_number -ge $CurrentTurn -and [string]$_.role -eq "bot" })
    if ($futureBot.Count -ne 0) {
        throw "No-look-ahead guard failed: current/future bot response exists in corrector history for turn $CurrentTurn."
    }
}

function Get-RuntimeCorrectorReasonCodeEnum {
    return @(
        "REPEATS_REJECTED_IDEA",
        "VIOLATES_USER_CONSTRAINT",
        "REDUNDANT_SUMMARY",
        "NO_FORWARD_PROGRESS",
        "UNSUPPORTED_INFERENCE",
        "OVER_ANALYSIS",
        "OVERLY_TASK_ORIENTED",
        "TOO_LONG",
        "CONTINUITY_ERROR",
        "MISSES_DIRECT_REQUEST",
        "TONE_MISMATCH",
        "OTHER"
    )
}

function New-RuntimeCorrectorStructuredOutputFormat {
    $reasonCodeEnum = @(Get-RuntimeCorrectorReasonCodeEnum)

    return [ordered]@{
        type = "json_schema"
        name = "runtime_corrector_response"
        strict = $true
        schema = [ordered]@{
            type = "object"
            additionalProperties = $false
            required = @("action", "final_response", "reason_codes")
            properties = [ordered]@{
                action = [ordered]@{
                    type = "string"
                    enum = @("PASS", "REWRITE")
                }
                final_response = [ordered]@{
                    type = "string"
                }
                reason_codes = [ordered]@{
                    type = "array"
                    minItems = 1
                    items = [ordered]@{
                        type = "string"
                        enum = $reasonCodeEnum
                    }
                }
            }
        }
    }
}

function Invoke-RuntimeCorrector {
    param(
        [string]$ApiKey,
        [string]$Model,
        [string]$SystemPrompt,
        [object[]]$VisibleHistory,
        [string]$CandidateResponse,
        [int]$TurnNumber,
        [string]$DebugFile
    )

    Assert-NoFutureContamination -VisibleHistory $VisibleHistory -CurrentTurn $TurnNumber

    $payload = [ordered]@{
        experiment = "runtime_corrector_replay"
        no_look_ahead_contract = "history contains accepted turns before current turn plus current patient message only"
        response_format_instruction = "Return one valid JSON object only with action, final_response, and reason_codes. No Markdown and no text outside JSON."
        current_turn = $TurnNumber
        visible_history = $VisibleHistory
        candidate_response = $CandidateResponse
    }

    $userText = $payload | ConvertTo-Json -Depth 20
    Add-DebugSection -Path $DebugFile -Title "STEP $TurnNumber - CORRECTOR PAYLOAD NO-LOOK-AHEAD EVIDENCE" -Content @"
current_turn: $TurnNumber
visible_history_items: $($VisibleHistory.Count)
max_visible_turn: $((@($VisibleHistory | ForEach-Object { [int]$_.turn_number }) | Measure-Object -Maximum).Maximum)
payload_sha256: $(Get-StringSha256 -Text $userText)
api_visible_json_instruction_in_input: true
full_questions_file_included: false
judge_scores_included: false
future_turns_included: false
"@

    $body = [ordered]@{
        model = $Model
        store = $false
        instructions = $SystemPrompt
        input = $userText
        max_output_tokens = 1200
        temperature = 0
        text = @{
            format = New-RuntimeCorrectorStructuredOutputFormat
        }
    } | ConvertTo-Json -Depth 30

    Add-DebugSection -Path $DebugFile -Title "STEP $TurnNumber - CORRECTOR REQUEST BODY" -Content $body
    $response = Invoke-OpenAIWithRetry -ApiKey $ApiKey -JsonBody $body -Label "runtime corrector step $TurnNumber" -DebugFile $DebugFile
    Add-DebugSection -Path $DebugFile -Title "STEP $TurnNumber - RAW CORRECTOR RESPONSE" -Content ($response | ConvertTo-Json -Depth 100)
    return Get-ResponseText -Response $response
}

function New-RunBotReplayCompatibleCandidateRequest {
    param(
        $Template,
        [string]$CandidateModel,
        [string]$FinalInstructions,
        [string]$Summarized20,
        [string]$Tzvira,
        [string]$Response20,
        [string]$Question20
    )

    # Mirrored from run_bot_replay.ps1 candidate generation:
    # replace @summarized20, @tzvira, @response20, and @question20 in the active
    # Request Body.rtf input template, then POST the replay-shaped body to /v1/responses.
    # run_bot_replay.ps1 has no reusable per-turn function, so this isolated adapter
    # preserves its effective request semantics without modifying protected files.
    $inputText = [string]$Template.input
    $inputText = $inputText.Replace("@summarized20", $Summarized20)
    $inputText = $inputText.Replace("@tzvira", $Tzvira)
    $inputText = $inputText.Replace("@response20", $Response20)
    $inputText = $inputText.Replace("@question20", $Question20)

    $bodyObject = [ordered]@{
        model = $CandidateModel
        store = [bool]$Template.store
        instructions = $FinalInstructions
        input = $inputText
        max_output_tokens = [int]$Template.max_output_tokens
        temperature = [double]$Template.temperature

        metadata = [ordered]@{
            patient_id = [string]$Template.metadata.patient_id
            session_id = [string]$Template.metadata.session_id
        }
    }

    return [pscustomobject]@{
        InputText = $inputText
        BodyObject = $bodyObject
        JsonBody = ($bodyObject | ConvertTo-Json -Depth 100)
    }
}

function Invoke-RunBotReplayCompatibleCandidate {
    param(
        [string]$ApiKey,
        $Template,
        [string]$CandidateModel,
        [string]$FinalInstructions,
        [string]$Summarized20,
        [string]$Tzvira,
        [string]$Response20,
        [string]$Question20,
        [int]$TurnNumber,
        [int]$AcceptedCompletedTurns,
        [string]$DebugFile
    )

    $request = New-RunBotReplayCompatibleCandidateRequest `
        -Template $Template `
        -CandidateModel $CandidateModel `
        -FinalInstructions $FinalInstructions `
        -Summarized20 $Summarized20 `
        -Tzvira $Tzvira `
        -Response20 $Response20 `
        -Question20 $Question20

    Add-DebugSection -Path $DebugFile -Title "STEP $TurnNumber - CANDIDATE SOURCE" -Content @"
candidate_generation_mode: run_bot_replay_ps1_compatible_adapter
candidate_endpoint_path_identity: POST https://api.openai.com/v1/responses
candidate_from_existing_replay_compatible_mechanism: true
source_logic_mirrored_from: run_bot_replay.ps1 per-turn Request Body.rtf replacement and Responses API call
protected_runner_reused_directly: false
protected_runner_reuse_reason: run_bot_replay.ps1 is a whole-run script and cannot accept corrected per-turn accepted history without modifying protected files.
candidate_model_known: true
candidate_model_source: Request Body.rtf template.model because run_bot_replay.ps1 sends this field as the Responses API model
candidate_model: $CandidateModel
accepted_history_turn_count_before_candidate_generation: $AcceptedCompletedTurns
future_questions_included: false
future_bot_turns_included: false
"@

    Add-DebugSection -Path $DebugFile -Title "STEP $TurnNumber - CANDIDATE INPUT FROM ACCEPTED HISTORY ONLY" -Content $request.InputText
    Add-DebugSection -Path $DebugFile -Title "STEP $TurnNumber - RUN_BOT_REPLAY_COMPATIBLE_CANDIDATE_REQUEST_BODY" -Content $request.JsonBody

    try {
        $response = Invoke-OpenAIWithRetry -ApiKey $ApiKey -JsonBody $request.JsonBody -Label "run_bot_replay-compatible candidate step $TurnNumber" -DebugFile $DebugFile
        Add-DebugSection -Path $DebugFile -Title "STEP $TurnNumber - RAW RUN_BOT_REPLAY_COMPATIBLE_CANDIDATE_RESPONSE" -Content ($response | ConvertTo-Json -Depth 100)
        return $response
    }
    catch {
        Add-DebugSection -Path $DebugFile -Title "STEP $TurnNumber - FATAL CANDIDATE GENERATION ERROR" -Content @"
Candidate generation through the run_bot_replay.ps1-compatible mechanism failed.
No direct OpenAI therapist fallback or alternate generation architecture was used.

$($_ | Out-String)
"@
        throw
    }
}

function Validate-CorrectorResult {
    param(
        [string]$RawText,
        [string]$CandidateResponse
    )

    $allowedActions = @("PASS", "REWRITE")
    $allowedReasonCodes = @(Get-RuntimeCorrectorReasonCodeEnum)

    $parsed = ConvertFrom-StrictJsonObject -Text $RawText

    foreach ($field in @("action", "final_response", "reason_codes")) {
        if ($null -eq $parsed.PSObject.Properties[$field]) { throw "Corrector JSON missing required field: $field" }
    }

    $action = [string]$parsed.action
    if ($allowedActions -notcontains $action) { throw "Corrector JSON has invalid action: $action" }

    if ($null -eq $parsed.final_response -or -not ($parsed.final_response -is [string])) {
        throw "Corrector JSON final_response must be a string."
    }

    $finalResponse = [string]$parsed.final_response
    $reasonCodes = @($parsed.reason_codes)
    if ($null -eq $parsed.reason_codes -or $reasonCodes.Count -lt 1) {
        throw "Corrector JSON reason_codes must be a non-empty array."
    }

    foreach ($code in $reasonCodes) {
        $codeText = [string]$code
        if ($allowedReasonCodes -notcontains $codeText) {
            throw "Corrector JSON has invalid reason_code: $codeText"
        }
    }

    if ($action -eq "PASS" -and $finalResponse -cne $CandidateResponse) {
        throw "Corrector PASS final_response must exactly equal candidate response."
    }

    if ($action -eq "REWRITE" -and [string]::IsNullOrWhiteSpace($finalResponse)) {
        throw "Corrector REWRITE final_response must not be empty."
    }

    return [pscustomobject]@{
        action = $action
        final_response = $finalResponse
        reason_codes = @($reasonCodes | ForEach-Object { [string]$_ })
    }
}

Write-Status "Starting Runtime Corrector replay experiment"

$apiKey = Get-OpenAIKey
$stamp = NowStamp
$RunDir = Join-Path $OutputRoot $stamp
New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

$OriginalCandidatesFile = Join-Path $RunDir "original_candidates.rtf"
$CorrectedConversationFile = Join-Path $RunDir "corrected_conversation.rtf"
$TraceFile = Join-Path $RunDir "runtime_corrector_trace.jsonl"
$DebugFile = Join-Path $RunDir "runtime_corrector_debug.txt"
$SummaryFile = Join-Path $RunDir "run_summary.json"

$requiredFiles = @(
    @{ Path = $PromptFile; Name = "prompt20.rtf"; MinBytes = 200 },
    @{ Path = $PrePatientFile; Name = "pre_patient20.rtf"; MinBytes = 20 },
    @{ Path = $PatientFile; Name = "patient20.rtf"; MinBytes = 20 },
    @{ Path = $RequestBodyFile; Name = "Request Body.rtf"; MinBytes = 20 },
    @{ Path = $QuestionsFile; Name = "replay_questions_dina.rtf"; MinBytes = 20 },
    @{ Path = $RuntimeCorrectorPromptFile; Name = "runtime_corrector_system_prompt.rtf"; MinBytes = 200 }
)

foreach ($entry in $requiredFiles) {
    Assert-RequiredFile -Path $entry.Path -Name $entry.Name -MinBytes $entry.MinBytes
    Assert-NoNul -Path $entry.Path -Name $entry.Name
}

$promptRawPrefix = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($RuntimeCorrectorPromptFile), 0, 6)
if (-not $promptRawPrefix.StartsWith("{\rtf1")) {
    throw "runtime_corrector_system_prompt.rtf is not a real RTF file with a {\rtf1 header."
}

$prompt20 = Read-RtfOrText -Path $PromptFile
$prePatient20 = Read-RtfOrText -Path $PrePatientFile
$patient20 = Read-RtfOrText -Path $PatientFile
$requestBodyText = Read-RtfOrText -Path $RequestBodyFile
$questionsText = Read-RtfOrText -Path $QuestionsFile
$runtimeCorrectorSystemPrompt = Read-RtfOrText -Path $RuntimeCorrectorPromptFile

try {
    $template = $requestBodyText | ConvertFrom-Json
}
catch {
    throw "Request Body.rtf is not valid JSON after RTF conversion: $($_.Exception.Message)"
}

if ($null -eq $template.metadata) { throw "Request Body.rtf metadata object is missing." }
if ([string]$template.metadata.patient_id -ne "@db_phone") { throw "Request Body.rtf metadata.patient_id must remain @db_phone." }
if ([string]$template.metadata.session_id -ne "@timestamp") { throw "Request Body.rtf metadata.session_id must remain @timestamp." }

$finalInstructions = [string]$template.instructions
$finalInstructions = $finalInstructions.Replace("@prompt20", $prompt20)
$finalInstructions = $finalInstructions.Replace("@pre_patient20", $prePatient20)
$finalInstructions = $finalInstructions.Replace("@patient20", $patient20)

$questions = @(ConvertTo-ReplayQuestions -Text $questionsText)
# This is not an independent model inference: run_bot_replay.ps1 sends
# Request Body.rtf template.model as the model field in its replay candidate call.
$candidateModel = [string]$template.model
$candidateGenerationMode = "run_bot_replay_ps1_compatible_adapter"
$candidateEndpointPathIdentity = "POST https://api.openai.com/v1/responses"
$candidateModelSource = "Request Body.rtf template.model because run_bot_replay.ps1 sends this field as the Responses API model"

$originalCandidatesText = @"
=== RUNTIME CORRECTOR ORIGINAL CANDIDATES START ===
Session: runtime_corrector_$stamp
Time: $(Get-Date)
Candidate model: $candidateModel
Candidate model source: $candidateModelSource
Candidate generation mode: $candidateGenerationMode
Candidate endpoint/path identity: $candidateEndpointPathIdentity
Candidate from existing replay/Webhook-compatible mechanism: true
Runtime corrector model: $RuntimeCorrectorModel
Questions: $($questions.Count)

"@

$correctedConversationText = @"
=== RUNTIME CORRECTOR CORRECTED CONVERSATION START ===
Session: runtime_corrector_$stamp
Time: $(Get-Date)
Candidate model: $candidateModel
Candidate model source: $candidateModelSource
Candidate generation mode: $candidateGenerationMode
Candidate endpoint/path identity: $candidateEndpointPathIdentity
Candidate from existing replay/Webhook-compatible mechanism: true
Runtime corrector model: $RuntimeCorrectorModel
Questions: $($questions.Count)

"@

Save-ConversationRtf -Path $OriginalCandidatesFile -Text $originalCandidatesText
Save-ConversationRtf -Path $CorrectedConversationFile -Text $correctedConversationText
Write-Utf8NoBom -Path $TraceFile -Text ""

@"
RUNTIME CORRECTOR REPLAY DEBUG
Run started: $(Get-Date)
Root: $Root
Run directory: $RunDir
Candidate model: $candidateModel
Candidate model source: $candidateModelSource
Candidate generation mode: $candidateGenerationMode
Candidate endpoint/path identity: $candidateEndpointPathIdentity
Candidate from existing replay/Webhook-compatible mechanism: true
Runtime corrector model: $RuntimeCorrectorModel
OpenAI key: NOT WRITTEN TO DEBUG
Questions count: $($questions.Count)
No-look-ahead construction: accepted history is built incrementally; corrector payload receives prior accepted turns plus current patient message only.
Full replay question file sent to corrector: false
Judge included: false
Protected production runner modified: false
Candidate adapter note: run_bot_replay.ps1 is a whole-run script with internal state, so this runner mirrors only its per-turn Request Body.rtf replacement and Responses API call while injecting accepted final history.

"@ | Out-File -LiteralPath $DebugFile -Encoding UTF8

Add-DebugSection -Path $DebugFile -Title "FINAL CANDIDATE INSTRUCTIONS AFTER REPLACEMENTS" -Content $finalInstructions
Add-DebugSection -Path $DebugFile -Title "RUNTIME CORRECTOR SYSTEM PROMPT PLAIN TEXT" -Content $runtimeCorrectorSystemPrompt

$tzvira = ""
$response20 = ""
$summarized20 = ""
$acceptedHistory = New-Object 'System.Collections.Generic.List[object]'
$candidateAggregateBuilder = New-Object System.Text.StringBuilder
$finalAggregateBuilder = New-Object System.Text.StringBuilder

$passCount = 0
$rewriteCount = 0
$fallbackCount = 0
$changedCount = 0
$step = 0

foreach ($q in $questions) {
    $step++
    Write-Status "STEP $step of $($questions.Count)"
    Write-Status "DINA: $q"

    if ($acceptedHistory.Count -ne (($step - 1) * 2)) {
        throw "Accepted-history invariant failed before turn ${step}: expected $(($step - 1) * 2) items, found $($acceptedHistory.Count)."
    }

    Add-DebugSection -Path $DebugFile -Title "STEP $step - ACCEPTED HISTORY LENGTH BEFORE TURN" -Content @"
accepted_history_items: $($acceptedHistory.Count)
accepted_completed_turns: $($step - 1)
current_turn: $step
"@

    $candidateResponse = Invoke-RunBotReplayCompatibleCandidate `
        -ApiKey $apiKey `
        -Template $template `
        -CandidateModel $candidateModel `
        -FinalInstructions $finalInstructions `
        -Summarized20 $summarized20 `
        -Tzvira $tzvira `
        -Response20 $response20 `
        -Question20 $q `
        -TurnNumber $step `
        -AcceptedCompletedTurns ($step - 1) `
        -DebugFile $DebugFile

    $candidateText = Get-ResponseText -Response $candidateResponse
    if ([string]::IsNullOrWhiteSpace($candidateText)) { $candidateText = "[EMPTY RESPONSE]" }
    [void]$candidateAggregateBuilder.AppendLine($candidateText)

    $visibleHistory = @()
    foreach ($item in $acceptedHistory) { $visibleHistory += $item }
    $visibleHistory += [pscustomobject]@{
        turn_number = $step
        role = "patient"
        text = $q
    }

    $validated = $null
    $fallbackReason = ""
    $fallback = $false
    $fallbackCategory = ""
    $rawCorrectorText = ""

    try {
        $rawCorrectorText = Invoke-RuntimeCorrector `
            -ApiKey $apiKey `
            -Model $RuntimeCorrectorModel `
            -SystemPrompt $runtimeCorrectorSystemPrompt `
            -VisibleHistory $visibleHistory `
            -CandidateResponse $candidateText `
            -TurnNumber $step `
            -DebugFile $DebugFile

        Add-DebugSection -Path $DebugFile -Title "STEP $step - EXTRACTED CORRECTOR TEXT" -Content $rawCorrectorText
        $validated = Validate-CorrectorResult -RawText $rawCorrectorText -CandidateResponse $candidateText
    }
    catch {
        $fallbackReason = $_.Exception.Message
        $fallback = $true
        $fallbackCategory = "CORRECTOR_API_OR_VALIDATION_FAILURE"
        $fallbackCount++
        Write-Status "WARNING: Runtime Corrector failed validation at step $step. Using candidate unchanged."
        Add-DebugSection -Path $DebugFile -Title "STEP $step - CORRECTOR FALLBACK" -Content @"
Reason:
$fallbackReason

Raw corrector text:
$rawCorrectorText
"@
    }

    if ($null -eq $validated) {
        $modelAction = $null
        $effectiveOutcome = "FALLBACK"
        $reasonCodes = @("OTHER")
        $finalText = $candidateText
    }
    else {
        $modelAction = $validated.action
        $effectiveOutcome = $modelAction
        $reasonCodes = @($validated.reason_codes)
        $finalText = [string]$validated.final_response

        if ($modelAction -eq "PASS") { $passCount++ }
        if ($modelAction -eq "REWRITE") { $rewriteCount++ }
    }

    $changed = ($finalText -cne $candidateText)
    if ($changed) { $changedCount++ }
    [void]$finalAggregateBuilder.AppendLine($finalText)

    Add-DebugSection -Path $DebugFile -Title "STEP $step - CORRECTOR DECISION" -Content @"
model_action: $modelAction
effective_outcome: $effectiveOutcome
reason_codes: $($reasonCodes -join ", ")
changed: $changed
fallback: $fallback
fallback_category: $fallbackCategory
fallback_reason: $fallbackReason
candidate_generation_mode: $candidateGenerationMode
candidate_from_existing_replay_compatible_mechanism: true
candidate_sha256: $(Get-StringSha256 -Text $candidateText)
final_sha256: $(Get-StringSha256 -Text $finalText)
"@

    $originalCandidatesText += @"
==============================
STEP $step

דינה:
$q

BOT CANDIDATE:
$candidateText

"@

    $correctedConversationText += @"
==============================
STEP $step

דינה:
$q

BOT:
$finalText

"@

    Save-ConversationRtf -Path $OriginalCandidatesFile -Text $originalCandidatesText
    Save-ConversationRtf -Path $CorrectedConversationFile -Text $correctedConversationText

    $traceObject = [ordered]@{
        turn_number = $step
        candidate_sha256 = Get-StringSha256 -Text $candidateText
        final_sha256 = Get-StringSha256 -Text $finalText
        action = $effectiveOutcome
        model_action = $modelAction
        effective_outcome = $effectiveOutcome
        fallback = [bool]$fallback
        fallback_category = $fallbackCategory
        fallback_reason = $fallbackReason
        reason_codes = @($reasonCodes)
        changed = [bool]$changed
        candidate_generation_mode = $candidateGenerationMode
        candidate_from_existing_replay_compatible_mechanism = $true
        candidate_endpoint_path_identity = $candidateEndpointPathIdentity
        accepted_history_turn_count_before_candidate_generation = ($step - 1)
        corrector_model = $RuntimeCorrectorModel
        timestamp = (Get-Date).ToString("o")
    }
    Append-Utf8NoBom -Path $TraceFile -Text (($traceObject | ConvertTo-Json -Compress -Depth 10) + "`n")

    $acceptedHistory.Add([pscustomobject]@{
        turn_number = $step
        role = "patient"
        text = $q
    })
    $acceptedHistory.Add([pscustomobject]@{
        turn_number = $step
        role = "bot"
        text = $finalText
    })

    # The next turn receives only the accepted final response, never the rejected candidate.
    $tzvira += @"

דינה: $q
המטפל: $finalText

"@
    $response20 = $finalText

    Add-DebugSection -Path $DebugFile -Title "STEP $step - ACCEPTED HISTORY AFTER UPDATE" -Content @"
accepted_history_items: $($acceptedHistory.Count)
accepted_response_is_candidate: $(-not $changed)
response20_sha256: $(Get-StringSha256 -Text $response20)
tzvira_sha256: $(Get-StringSha256 -Text $tzvira)
"@

    Write-Status ("Step {0} accepted: {1}, changed={2}, fallback={3}" -f $step, $effectiveOutcome, $changed, $fallback)

    if ($step -lt $questions.Count) {
        Start-Sleep -Seconds $DelayBetweenStepsSeconds
    }
}

$originalCandidatesText += @"

=== RUNTIME CORRECTOR ORIGINAL CANDIDATES END ===
Time: $(Get-Date)

"@

$correctedConversationText += @"

=== RUNTIME CORRECTOR CORRECTED CONVERSATION END ===
Time: $(Get-Date)

"@

Save-ConversationRtf -Path $OriginalCandidatesFile -Text $originalCandidatesText
Save-ConversationRtf -Path $CorrectedConversationFile -Text $correctedConversationText

$outcomeCountTotal = $passCount + $rewriteCount + $fallbackCount
if ($outcomeCountTotal -ne $questions.Count) {
    throw "Outcome count invariant failed: pass_count + rewrite_count + fallback_count = $outcomeCountTotal, total_turns = $($questions.Count)."
}

$summary = [ordered]@{
    run_started_timestamp = $stamp
    run_finished_at = (Get-Date).ToString("o")
    total_turns = $questions.Count
    pass_count = $passCount
    rewrite_count = $rewriteCount
    fallback_count = $fallbackCount
    changed_turn_count = $changedCount
    outcome_count_total = $outcomeCountTotal
    candidate_model = $candidateModel
    candidate_model_source = $candidateModelSource
    candidate_generation_mode = $candidateGenerationMode
    candidate_endpoint_path_identity = $candidateEndpointPathIdentity
    candidate_from_existing_replay_compatible_mechanism = $true
    corrector_model = $RuntimeCorrectorModel
    candidate_aggregate_sha256 = Get-StringSha256 -Text $candidateAggregateBuilder.ToString()
    final_aggregate_sha256 = Get-StringSha256 -Text $finalAggregateBuilder.ToString()
    output_paths = [ordered]@{
        run_dir = $RunDir
        original_candidates_rtf = $OriginalCandidatesFile
        corrected_conversation_rtf = $CorrectedConversationFile
        runtime_corrector_trace_jsonl = $TraceFile
        runtime_corrector_debug_txt = $DebugFile
        run_summary_json = $SummaryFile
    }
}

Write-Utf8NoBom -Path $SummaryFile -Text ($summary | ConvertTo-Json -Depth 10)
Add-DebugSection -Path $DebugFile -Title "RUN FINISHED" -Content @"
Finished: $(Get-Date)
PASS count: $passCount
REWRITE count: $rewriteCount
Fallback count: $fallbackCount
Changed-turn count: $changedCount
Candidate aggregate SHA-256: $($summary.candidate_aggregate_sha256)
Final aggregate SHA-256: $($summary.final_aggregate_sha256)
"@

Write-Status "Runtime Corrector replay finished"
Write-Host ""
Write-Host "Run directory:"
Write-Host $RunDir
Write-Host ""
Write-Host "Summary:"
Write-Host $SummaryFile
