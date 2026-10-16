# 健康顧問 SKILL LLM 鏈路冒煙（需 .env.local 已配置 LLM 且服務已啟動）
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
  if ($Cond) { Write-Host "[PASS] $Name" -ForegroundColor Green }
  else { Write-Host "[FAIL] $Name  $Detail" -ForegroundColor Red; $script:failCount++ }
}

# ---- 1. symptom_triage 真實 LLM：結構化輸出 ----
$r1 = Invoke-HealthPost '/api/skill/skill.health.advisor/symptom_triage' @{ symptoms = '我有點發燒頭痛，持續兩天了'; duration = '兩天' }
$d1 = $r1.resp
Write-Host ("[triage 原始回應] " + ($d1 | ConvertTo-Json -Depth 8 -Compress))
if ($d1 -and $d1.code -eq 0) {
  $t = $d1.data
  Assert-True 'triage: mode 合法（structured/text）' ($t.mode -eq 'structured' -or $t.mode -eq 'text') "mode=$($t.mode)"
  if ($t.mode -eq 'structured') {
    $okUrgency = @('emergency', 'urgent_care', 'routine', 'self_care') -contains $t.urgency
    Assert-True 'triage: urgency 四檔合法' $okUrgency "urgency=$($t.urgency)"
    Assert-True 'triage: advice 非空' ($t.advice -and $t.advice.Trim().Length -gt 0)
    Assert-True 'triage: disclaimer 附帶' ($t.disclaimer -and $t.disclaimer.Trim().Length -gt 0)
  } else {
    Assert-True 'triage(text 降級): reply 非空' ($t.reply -and $t.reply.Trim().Length -gt 0)
  }
} else {
  Assert-True 'triage: code=0' $false "code=$($d1.code) msg=$($d1.message)"
}

# ---- 2. report_explain 真實 LLM ----
$r2 = Invoke-HealthPost '/api/skill/skill.health.advisor/report_explain' @{ reportText = '白細胞 11.5 ×10^9/L（參考 3.5-9.5），血紅蛋白 130 g/L（參考 115-150），血小板 90 ×10^9/L（參考 125-350）' }
$d2 = $r2.resp
Write-Host ("[report 原始回應] " + ($d2 | ConvertTo-Json -Depth 8 -Compress))
if ($d2 -and $d2.code -eq 0) {
  $t2 = $d2.data
  Assert-True 'report: mode 合法' ($t2.mode -eq 'structured' -or $t2.mode -eq 'text') "mode=$($t2.mode)"
  if ($t2.mode -eq 'structured') {
    Assert-True 'report: items ≥ 1' ($t2.items -and $t2.items.Count -ge 1) "count=$($t2.items.Count)"
    $statuses = @('normal', 'high', 'low', 'abnormal')
    $allOk = $true
    foreach ($it in $t2.items) { if ($statuses -notcontains $it.status) { $allOk = $false } }
    Assert-True 'report: 每項 status 合法' $allOk
    Assert-True 'report: summary 非空' ($t2.summary -and $t2.summary.Trim().Length -gt 0)
    Assert-True 'report: disclaimer 附帶' ($t2.disclaimer -and $t2.disclaimer.Trim().Length -gt 0)
  }
} else {
  Assert-True 'report: code=0' $false "code=$($d2.code) msg=$($d2.message)"
}

# ---- 3. med_info 真實 LLM ----
$r3 = Invoke-HealthPost '/api/skill/skill.health.advisor/med_info' @{ drugName = '阿莫西林' }
$d3 = $r3.resp
Write-Host ("[med 原始回應] " + ($d3 | ConvertTo-Json -Depth 8 -Compress))
if ($d3 -and $d3.code -eq 0) {
  $t3 = $d3.data
  Assert-True 'med: mode 合法' ($t3.mode -eq 'structured' -or $t3.mode -eq 'text') "mode=$($t3.mode)"
  if ($t3.mode -eq 'structured') {
    Assert-True 'med: category 非空' ($t3.category -and $t3.category.Trim().Length -gt 0)
    Assert-True 'med: commonUses ≥ 1' ($t3.commonUses -and $t3.commonUses.Count -ge 1)
    Assert-True 'med: disclaimer 附帶' ($t3.disclaimer -and $t3.disclaimer.Trim().Length -gt 0)
  }
} else {
  Assert-True 'med: code=0' $false "code=$($d3.code) msg=$($d3.message)"
}

Write-Host ''
Write-Host "==== LLM 冒煙完成（失敗 $failCount 項）====" -ForegroundColor $(if ($failCount -eq 0) { 'Green' } else { 'Yellow' })
exit $(if ($failCount -eq 0) { 0 } else { 1 })
