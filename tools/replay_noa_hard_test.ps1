# replay_noa_hard_test.ps1
# מריץ את רצף ההודעות של הקובץ הזה דרך המסלול החי
# runtime-corrected-response, ולא דרך סימולטור.
# מטופל: $PatientName = נועה
# טלפון:  $PatientPhone = 8880000001
# הכותרת הזו נגזרה מהקוד עצמו. אם השורות למטה משתנות - לעדכן גם כאן.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvFile  = Join-Path $RepoRoot '.env'

function Get-SecretValue {
    param([string]$Name, [string]$Path)
    if (Test-Path env:$Name) { return (Get-Item env:$Name).Value }
    if (-not (Test-Path $Path)) {
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

$Secret       = Get-SecretValue -Name 'LANDBOT_WEBHOOK_SECRET' -Path $EnvFile
$SupabaseUrl  = 'https://qcwimczsiuxkarwfiyai.supabase.co'
$AnonKey      = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjd2ltY3pzaXV4a2Fyd2ZpeWFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTM1OTEwMzgsImV4cCI6MjA2OTE2NzAzOH0.zpMcORTD1voqZFj5QaPUc-EXf1juqnlTTP00jV6_TvI'
$RuntimeUrl   = "$SupabaseUrl/functions/v1/runtime-corrected-response"
$RpcUrl       = "$SupabaseUrl/rest/v1/rpc"

$PatientPhone = '8880000001'
$PatientName  = 'נועה'

# תרחיש קשה: נועה מבקשת במפורש טכניקה מעשית לעצור את ההתרחקות שלה,
# ודוחה עוד שיקוף אחרי שכבר ביקשה פתרון בפירוש פעמיים
$Messages = @(
    'היי, אחרי השיחה הקודמת חשבתי על זה המון, ואני מבינה את הדפוס. עכשיו אני צריכה משהו מעשי - איך אני עוצרת את עצמי ברגע שאני מתחילה להתרחק?',
    'זה יפה אבל זה לא עונה לי. אני שואלת ספציפית: מה אני עושה ברגע ההוא, בפועל, כשאני מרגישה שאני רוצה לברוח?',
    'שוב את משקפת ולא עונה. שאלתי שאלה קונקרטית. מה הצעד הראשון שאני עושה?',
    'תודה, זה כבר יותר קרוב. ואם זה לא עובד באמצע השיחה איתו?',
    'בסדר, אז מה אם אני כבר באמצע לענות יבש - איך אני עוצרת את עצמי שם, באמצע?'
)


function Invoke-Rpc {
    param([string]$FunctionName, [hashtable]$Body)
    $json = $Body | ConvertTo-Json -Depth 4 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Uri "$RpcUrl/$FunctionName" -Method Post `
        -Headers @{ apikey = $AnonKey; Authorization = "Bearer $AnonKey" } `
        -ContentType 'application/json; charset=utf-8' -Body $bytes
}

Write-Host "=== פותח שיחה חדשה עבור $PatientPhone ==="
$ConversationId = Invoke-Rpc -FunctionName 'start_conversation_v2' -Body @{
    p_phone  = $PatientPhone
    p_name   = $PatientName
    p_source = 'C'
}
Write-Host "session_id: $ConversationId"
Write-Host ""

$turnNumber = 0
foreach ($question in $Messages) {
    $turnNumber++
    Write-Host "--- תור $turnNumber ---"
    Write-Host "מטופל: $question"

    $payload = [ordered]@{
        question20 = $question
        patient_id = $PatientPhone
        session_id = $ConversationId
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 4 -Compress))

    $response = Invoke-RestMethod -Uri $RuntimeUrl -Method Post `
        -Headers @{ 'x-landbot-secret' = $Secret } `
        -ContentType 'application/json; charset=utf-8' -Body $bytes

    $answer = $response.corrected_answer
    Write-Host "מלווה: $answer"
    Write-Host "החלטת מתקן: $($response.corrector_decision)"
    Write-Host ""

    Invoke-Rpc -FunctionName 'insert_conversation_v2' -Body @{
        p_phone          = $PatientPhone
        p_conversation_id = $ConversationId
        p_question       = $question
        p_answer         = $answer
    } | Out-Null

    Start-Sleep -Milliseconds 500
}

Write-Host "=== סיום. session_id לבדיקה נוספת: $ConversationId ==="
