# 健康顧問 SKILL 本地冒煙（2026-10 健康顧問域）
# 用法：在 cloudrun/ 目錄下執行 .\scripts\smoke-health.ps1 [-BaseUrl http://127.0.0.1:8787]
param(
  [string]$BaseUrl = 'http://127.0.0.1:8787'
)

$ErrorActionPreference = 'Continue'

function Invoke-HealthPost {
  param([string]$Path, [hashtable]$Body)
  $json = $Body | ConvertTo-Json -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  try {
    $r = Invoke-RestMethod -Uri "$BaseUrl$Path" -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes
    return @{ http = 200; resp = $r }
  } catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    return @{ http = $code; resp = $null }
  }
}

$failCount = 0

function Assert-True {
  param([string]$Name, [bool]$Cond, [string]$Detail = '')
  if ($Cond) {
    Write-Host "[PASS] $Name" -ForegroundColor Green
  } else {
    Write-Host "[FAIL] $Name  $Detail" -ForegroundColor Red
    $script:failCount++
  }
}

# ---- 1. 急症守衛：症狀分診入口 ----
$r1 = Invoke-HealthPost '/api/skill/skill.health.advisor/symptom_triage' @{ symptoms = '突然胸痛呼吸困難' }
$d1 = $r1.resp
Assert-True '急症守衛(triage): HTTP 200' ($r1.http -eq 200) "http=$($r1.http)"
Assert-True '急症守衛(triage): code=0' ($d1 -and $d1.code -eq 0) "code=$($d1.code)"
Assert-True '急症守衛(triage): mode=guard' ($d1 -and $d1.data.mode -eq 'guard') "mode=$($d1.data.mode)"
Assert-True '急症守衛(triage): 文案含 120' ($d1 -and ($d1.data.advice -match '120')) "advice=$($d1.data.advice)"

# ---- 2. 急症守衛：藥品入口（誤服）----
$r2 = Invoke-HealthPost '/api/skill/skill.health.advisor/med_info' @{ drugName = '誤服了整瓶安眠藥' }
$d2 = $r2.resp
Assert-True '急症守衛(med): mode=guard' ($d2 -and $d2.data.mode -eq 'guard') "mode=$($d2.data.mode)"

# ---- 3. 急症守衛：報告入口（檢出急症詞）----
$r3 = Invoke-HealthPost '/api/skill/skill.health.advisor/report_explain' @{ reportText = '檢查說我意識不清暈過去了' }
$d3 = $r3.resp
Assert-True '急症守衛(report): mode=guard' ($d3 -and $d3.data.mode -eq 'guard') "mode=$($d3.data.mode)"

# ---- 4. 輸入校驗：空值 → HTTP 400 ----
$r4 = Invoke-HealthPost '/api/skill/skill.health.advisor/symptom_triage' @{ symptoms = '   ' }
Assert-True '空 symptoms → HTTP 400' ($r4.http -eq 400) "http=$($r4.http)"
$r5 = Invoke-HealthPost '/api/skill/skill.health.advisor/report_explain' @{ reportText = '' }
Assert-True '空 reportText → HTTP 400' ($r5.http -eq 400) "http=$($r5.http)"
$r6 = Invoke-HealthPost '/api/skill/skill.health.advisor/med_info' @{ drugName = '' }
Assert-True '空 drugName → HTTP 400' ($r6.http -eq 400) "http=$($r6.http)"

Write-Host ''
Write-Host "==== 基礎冒煙完成（失敗 $failCount 項）====" -ForegroundColor $(if ($failCount -eq 0) { 'Green' } else { 'Yellow' })
exit $(if ($failCount -eq 0) { 0 } else { 1 })
