# 瑞幸（skill.coffee.luckin）+ 滴滴（skill.ride.didi）端點冒煙測試（2026-10-14 降級模式）
# 前提：LUCKIN_MCP_TOKEN / DIDI_MCP_KEY 均未配置 → 驗證兩層降級協議：
#   查詢域 mock_deterministic、下單 401 鑑權、瑞幸 copy-only 跳轉卡、
#   滴滴模擬訂單（可完整演示 query / cancel 閉環）
# 服務位址：跟隨 $env:PORT（與 dev-start.ps1 預設 8787 一致），可覆寫
$h = "http://127.0.0.1:$(if ($env:PORT) { $env:PORT } else { 8787 })"
$lkHeaders = @{ 'x-wx-openid' = 'smoke-luckin' }
$ddHeaders = @{ 'x-wx-openid' = 'smoke-didi' }

function Send-Json($Uri, $Headers, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Headers $Headers -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Headers, $Json) {
  try { Send-Json $Uri $Headers $Json | ConvertTo-Json -Depth 8 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'===== 瑞幸（降級模式）====='

'--- L0. 前置檢查：LUCKIN_MCP_TOKEN 已配置時跳過 L 系列（place_luckin_order 含真實消費，嚴禁冒煙誤觸）---'
$l0 = Send-Json "$h/api/skill/skill.coffee.luckin/search_luckin_store" '{"lng":116.4575,"lat":39.9087,"limit":1}'
if ($l0.data.source -ne 'mock_deterministic') {
  "SKIP：瑞幸已走真實端點（source=$($l0.data.source)），L1-L6 降級冒煙跳過（真實鏈路另見 smoke-luckin-real.ps1，下單需人工決策）"
} else {

'--- L1. search_luckin_store（北京座標；斷言 mock 門店 + deptId 可用於後續）---'
$stores = Send-Json "$h/api/skill/skill.coffee.luckin/search_luckin_store" $null '{"lng":116.4575,"lat":39.9087,"city":"北京市","limit":3}'
$stores | ConvertTo-Json -Depth 6 -Compress
if ($stores.data.source -eq 'mock_deterministic' -and $stores.data.stores.Count -ge 1) {
  "ASSERT OK: stores = mock_deterministic + $($stores.data.stores.Count) 家（首店 $($stores.data.stores[0].name)）"
} else { "ASSERT FAIL: source=$($stores.data.source)" }
$deptId = $stores.data.stores[0].deptId

'--- L2. search_luckin_product（斷言「生椰」命中生椰拿鐵，拿 productId/skuCode）---'
$prod = Send-Json "$h/api/skill/skill.coffee.luckin/search_luckin_product" $null ('{{"deptId":"{0}","query":"生椰"}}' -f $deptId)
$prod | ConvertTo-Json -Depth 6 -Compress
if ($prod.data.products.Count -ge 1 -and $prod.data.products[0].name -match '生椰') {
  "ASSERT OK: product = $($prod.data.products[0].name)（productId $($prod.data.products[0].productId)）"
} else { "ASSERT FAIL" }

'--- L3. place_luckin_order 無身份（參數齊全；應 401——參數校驗先於身份為三端慣例）---'
(Try-Send "$h/api/skill/skill.coffee.luckin/place_luckin_order" $null ('{{"deptId":"{0}","productId":"1262","skuCode":"SP2077-00347","productName":"生椰拿鐵","quantity":1}}' -f $deptId))

'--- L4. place_luckin_order 平鋪單品欄位（斷言 copy-only 跳轉卡 + pending_external + 落庫）---'
$lkOrder = Send-Json "$h/api/skill/skill.coffee.luckin/place_luckin_order" $lkHeaders ('{{"deptId":"{0}","storeName":"北京市中心店","productId":"1262","skuCode":"SP2077-00347","productName":"生椰拿鐵","quantity":1}}' -f $deptId)
$lkOrder | ConvertTo-Json -Depth 8 -Compress
if ($lkOrder.data.orderId -and $lkOrder.data.status -eq 'pending_external' -and $lkOrder.data.jump) {
  "ASSERT OK: place = 降級跳轉卡（jump.target=$($lkOrder.data.jump.target) appId=$($lkOrder.data.jump.appId)）"
} else { "ASSERT FAIL" }

'--- L5. place_luckin_order/cancel（本地歸檔）---'
(Try-Send "$h/api/skill/skill.coffee.luckin/place_luckin_order/cancel" $lkHeaders ('{{"orderId":"{0}"}}' -f $lkOrder.data.orderId))

'--- L6. 再取消（冪等歸檔：mysql2 FOUND_ROWS 語義下重複取消安全，應 ok）---'
(Try-Send "$h/api/skill/skill.coffee.luckin/place_luckin_order/cancel" $lkHeaders ('{{"orderId":"{0}"}}' -f $lkOrder.data.orderId))

}

'===== 滴滴（降級模式）====='

'--- D0. 前置檢查：DIDI_MCP_KEY 已配置時跳過 D 系列（place_ride 含真實派單，嚴禁冒煙誤觸）---'
$d0 = Send-Json "$h/api/skill/skill.ride.didi/estimate_ride" '{"fromName":"三里屯","toName":"北京南站","fromCity":"北京市"}'
if ($d0.data.source -ne 'mock_deterministic') {
  "SKIP：滴滴已走真實端點（source=$($d0.data.source)），D1-D6 降級冒煙跳過（真實鏈路另見 smoke-didi-real.ps1，下單需人工決策）"
  return
}

'--- D1. estimate_ride（國貿→三里屯；斷言 mock 三檔車型 + traceId）---'
$est = Send-Json "$h/api/skill/skill.ride.didi/estimate_ride" $null '{"fromName":"国贸","toName":"三里屯","fromCity":"北京市"}'
$est | ConvertTo-Json -Depth 6 -Compress
if ($est.data.source -eq 'mock_deterministic' -and $est.data.traceId -and $est.data.options.Count -ge 3) {
  "ASSERT OK: estimate = $($est.data.options.Count) 檔車型（traceId $($est.data.traceId)）"
} else { "ASSERT FAIL" }
$cat = $est.data.options[0].productCategory

'--- D2. place_ride 無身份（應 401）---'
(Try-Send "$h/api/skill/skill.ride.didi/place_ride" $null ('{{"estimateTraceId":"{0}","productCategory":"{1}"}}' -f $est.data.traceId, $cat))

'--- D3. place_ride（斷言模擬訂單 + pending_external + 上游單號可查詢）---'
$ddOrder = Send-Json "$h/api/skill/skill.ride.didi/place_ride" $ddHeaders ('{{"estimateTraceId":"{0}","productCategory":"{1}","productName":"特惠快車","fromName":"国贸","toName":"三里屯"}}' -f $est.data.traceId, $cat)
$ddOrder | ConvertTo-Json -Depth 8 -Compress
if ($ddOrder.data.orderId -and $ddOrder.data.upstreamOrderId -match '^mock_didi_' -and $ddOrder.data.status -eq 'pending_external') {
  "ASSERT OK: place = 模擬訂單（上游 $($ddOrder.data.upstreamOrderId)）"
} else { "ASSERT FAIL" }

'--- D4. query_ride（斷言模擬狀態輪詢可用）---'
(Try-Send "$h/api/skill/skill.ride.didi/query_ride" $ddHeaders ('{{"orderId":"{0}"}}' -f $ddOrder.data.orderId))

'--- D5. place_ride/cancel（本地歸檔）---'
(Try-Send "$h/api/skill/skill.ride.didi/place_ride/cancel" $ddHeaders ('{{"orderId":"{0}","reason":"冒煙取消"}}' -f $ddOrder.data.orderId))

'--- D6. 再取消（冪等歸檔：重複取消安全，應 ok）---'
(Try-Send "$h/api/skill/skill.ride.didi/place_ride/cancel" $ddHeaders ('{{"orderId":"{0}"}}' -f $ddOrder.data.orderId))
