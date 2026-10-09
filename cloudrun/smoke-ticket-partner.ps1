# 演出票務 SKILL 第三方渠道接入端到端冒煙測試
#
# 驗證鏈路：cloudrun (REST Provider 適配器) --HTTP/Bearer--> ticket-partner-mock (渠道網關)
# 前置：cloudrun 目錄已執行 npm run build（依賴 dist/server.js）
#
# 執行：pwsh -File smoke-ticket-partner.ps1（自動啟停兩個本地進程，埠 8789 / 8790）
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$partnerUrl = 'http://127.0.0.1:8790'
$serverUrl = 'http://127.0.0.1:8789'

function Send-Json($Uri, $Headers, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Headers $Headers -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}

# ---- 啟動渠道網關模擬（scripts/ticket-partner-mock.mjs）----
$partner = Start-Process node -ArgumentList "$root\scripts\ticket-partner-mock.mjs" -PassThru -WindowStyle Hidden
# ---- 啟動 cloudrun（配置大麥渠道指向本地網關）----
$env:PORT = '8789'
$env:TICKET_DAMAI_API_BASE = $partnerUrl
$env:TICKET_DAMAI_API_KEY = 'partner-test-key'
$server = Start-Process node -ArgumentList "$root\dist\server.js" -PassThru -WindowStyle Hidden

$failed = 0
function Check($Name, $Cond, $Detail) {
  if ($Cond) { Write-Host "PASS: $Name" -ForegroundColor Green }
  else { $script:failed += 1; Write-Host "FAIL: $Name → $($Detail | ConvertTo-Json -Depth 6 -Compress)" -ForegroundColor Red }
}

try {
  # 探活等待（最多 15s）
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-RestMethod "$partnerUrl/healthz" | Out-Null
      Invoke-RestMethod "$serverUrl/healthz" | Out-Null
      break
    } catch { Start-Sleep -Milliseconds 300 }
  }

  $ownerHeaders = @{ 'x-wx-openid' = 'smoke-ticket-partner' }

  '--- 1. search_events「林俊傑」：應經 REST Provider 從渠道網關真實調用取得 ev_d101 ---'
  $s1 = Send-Json "$serverUrl/api/skill/skill.ticket.show/search_events" $null '{"keyword":"林俊傑"}'
  $s1 | ConvertTo-Json -Depth 6 -Compress
  Check '渠道演出 ev_d101 命中' ($s1.code -eq 0 -and $s1.data.events.Count -ge 1 -and $s1.data.events[0].eventId -eq 'ev_d101') $s1
  Check '渠道數據完整性（深圳 / minPriceCent=68000 / provider=damai）' ($s1.data.events[0].city -eq '深圳' -and $s1.data.events[0].minPriceCent -eq 68000 -and $s1.data.events[0].provider -eq 'damai') $s1.data.events[0]

  '--- 2. list_sessions ev_d101：場次與票檔庫存應為渠道網關即時數據（inventory=30）---'
  $s2 = Send-Json "$serverUrl/api/skill/skill.ticket.show/list_sessions" $null '{"eventId":"ev_d101"}'
  $s2 | ConvertTo-Json -Depth 8 -Compress
  $firstSession = $s2.data.firstAvailableSessionId
  $firstTier = $s2.data.firstAvailableTierId
  Check '渠道場次數=2 且庫存透傳（30）' ($s2.code -eq 0 -and $s2.data.sessions.Count -eq 2 -and $s2.data.sessions[0].priceTiers[0].inventory -eq 30) $s2.data.sessions[0]

  '--- 3. create_order ev_d101 x2：下單前雲端經渠道再核實，金額 = 680 元 x2 ---'
  $s3 = Send-Json "$serverUrl/api/skill/skill.ticket.show/create_order" $ownerHeaders ('{{"eventId":"ev_d101","sessionId":"{0}","tierId":"{1}","quantity":2,"viewerName":"渠道測試","viewerIdNo":"110101199001011234"}}' -f $firstSession, $firstTier)
  $s3 | ConvertTo-Json -Depth 8 -Compress
  Check '渠道演出下單成功（amountCent=136000）' ($s3.code -eq 0 -and $s3.data.amountCent -eq 136000 -and $s3.data.status -eq 'pending_payment') $s3

  '--- 4. search_events「周杰倫」：渠道無此演出（404→空），演示目錄兜底聚合 ev_001 ---'
  $s4 = Send-Json "$serverUrl/api/skill/skill.ticket.show/search_events" $null '{"keyword":"周杰倫"}'
  $s4 | ConvertTo-Json -Depth 6 -Compress
  $hit = @($s4.data.events | Where-Object { $_.eventId -eq 'ev_001' })
  Check '演示目錄兜底聚合（ev_001 在結果中）' ($s4.code -eq 0 -and $hit.Count -eq 1) $s4

  '--- 5. cancel_order：歸屬鑒權取消渠道演出訂單 ---'
  $s5 = Send-Json "$serverUrl/api/skill/skill.ticket.show/cancel_order" $ownerHeaders ('{{"orderId":"{0}"}}' -f $s3.data.orderId)
  $s5 | ConvertTo-Json -Depth 4 -Compress
  Check '渠道訂單取消成功' ($s5.code -eq 0 -and $s5.data.ok -eq $true) $s5
}
finally {
  # 清理：無論成敗均停掉兩個本地進程
  foreach ($p in @($server, $partner)) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item Env:PORT -ErrorAction SilentlyContinue
  Remove-Item Env:TICKET_DAMAI_API_BASE -ErrorAction SilentlyContinue
  Remove-Item Env:TICKET_DAMAI_API_KEY -ErrorAction SilentlyContinue
}

if ($failed -gt 0) { Write-Host "$failed FAILED" -ForegroundColor Red; exit 1 }
Write-Host 'ALL PASS' -ForegroundColor Green
