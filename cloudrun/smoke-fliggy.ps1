# 飛豬 SKILL（skill.travel.fliggy）端點冒煙測試（2026-10-14 真實數據版）
# 前提：飛豬 FlyAI MCP 內置公共 Key（體驗模式）——無需任何用戶憑證，
#   搜到的即為飛豬官方商品庫真實數據（體驗模式價格脫敏如 ¥5xx）
# 鏈路：參數校驗（400）→ 酒店搜索（真實）→ AI 行程推薦（真實 LLM 生成）
# 服務位址：跟隨 $env:PORT（與 dev-start.ps1 預設 8787 一致），可覆寫
$h = "http://127.0.0.1:$(if ($env:PORT) { $env:PORT } else { 8787 })"

function Send-Json($Uri, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Json) {
  try { Send-Json $Uri $Json | ConvertTo-Json -Depth 8 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'--- F1. search_hotels 缺 destName（應 400）---'
(Try-Send "$h/api/skill/skill.travel.fliggy/search_hotels" '{"poiName":"西湖"}')

'--- F2. search_hotels 杭州西湖明天入住一晚（斷言真實數據 + 體驗模式 notice）---'
$tomorrow = (Get-Date).AddDays(1).ToString('yyyy-MM-dd')
$dayAfter = (Get-Date).AddDays(2).ToString('yyyy-MM-dd')
$hotels = Send-Json "$h/api/skill/skill.travel.fliggy/search_hotels" ('{{"destName":"杭州","poiName":"西湖","checkInDate":"{0}","checkOutDate":"{1}","limit":4}}' -f $tomorrow, $dayAfter)
$hotels | ConvertTo-Json -Depth 6 -Compress
if ($hotels.data.source -eq 'fliggy_mcp_realtime' -and $hotels.data.hotels.Count -ge 1) {
  "ASSERT OK: hotels = $($hotels.data.hotels.Count) 家真實數據（首店 $($hotels.data.hotels[0].name) $($hotels.data.hotels[0].priceText)）"
  "notice = $($hotels.data.notice)"
} else { "ASSERT FAIL: source=$($hotels.data.source)" }

'--- F3. search_hotels 星級篩選（4,5 星 + 價格上限；驗證篩選參數透傳）---'
$filtered = Send-Json "$h/api/skill/skill.travel.fliggy/search_hotels" ('{{"destName":"三亞","hotelStars":"4,5","maxPrice":800,"limit":3,"checkInDate":"{0}","checkOutDate":"{1}"}}' -f $tomorrow, $dayAfter)
"source = $($filtered.data.source), 家數 = $($filtered.data.hotels.Count)"
$filtered.data.hotels | ForEach-Object { "  [$($_.star)] $($_.name) $($_.priceText)（$($_.interestsPoi)）" }

'--- F4. ai_search 自然語言（斷言 LLM 生成推薦 + aiGenerated 合規標識）---'
$ai = Send-Json "$h/api/skill/skill.travel.fliggy/ai_search" '{"query":"杭州西湖附近性价比高的酒店，周末入住一晚"}'
"source = $($ai.data.source), aiGenerated = $($ai.data.aiGenerated)"
if ($ai.data.aiGenerated -eq $true -and $ai.data.answer) {
  $head = $ai.data.answer.Substring(0, [Math]::Min(120, $ai.data.answer.Length))
  "ASSERT OK: ai_search = $($ai.data.answer.Length) 字推薦文本（首 120 字：$head ...）"
} else { "ASSERT FAIL" }
