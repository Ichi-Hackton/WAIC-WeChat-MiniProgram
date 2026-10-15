# 瑞幸（skill.coffee.luckin）真實端點唯讀冒煙（2026-10-14，LUCKIN_MCP_TOKEN 已配置）
# 範圍嚴格限縮唯讀環節：queryShopList（查店）+ searchProductForMcp（搜商品）。
# ⚠️ 不觸 createOrder（Token 持有人賬號真實消費），下單需人工決策後手動驗證。
# 判別要點：連線層失敗（含 Token 無效 401）會「靜默降級 mock_deterministic」——
#   斷言必須鎖定 source='luckin_mcp_realtime'，否則結果為假綠。
# 防範：關鍵中文查詢詞先 hex 自證（工具鏈存在形近字篡改前科，如 貿→貸）
$h = "http://127.0.0.1:$(if ($env:PORT) { $env:PORT } else { 8787 })"

function Send-Json($Uri, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Json) {
  try { Send-Json $Uri $Json | ConvertTo-Json -Depth 8 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'--- R0. hex 自證：查詢詞「生椰」應為 e7949fe6a4b5（防工具鏈形近字篡改）---'
$kw = [Text.Encoding]::UTF8.GetString([byte[]](0xe7,0x94,0x9f,0xe6,0xa4,0xb5))
$hex = ([Text.Encoding]::UTF8.GetBytes($kw) | ForEach-Object { $_.ToString('x2') }) -join ''
if ($hex -eq 'e7949fe6a4b5') { "ASSERT OK: 查詢詞字節正確（$hex）" } else { "ASSERT FAIL: 查詢詞字節異常（$hex），中止"; exit 1 }

'--- R1. search_luckin_store 北京國貿座標（斷言 luckin_mcp_realtime + 真實門市 + deptId）---'
$stores = Send-Json "$h/api/skill/skill.coffee.luckin/search_luckin_store" '{"lng":116.4575,"lat":39.9087,"limit":3}'
$stores | ConvertTo-Json -Depth 6 -Compress
if ($stores.data.source -eq 'luckin_mcp_realtime' -and $stores.data.stores.Count -ge 1 -and $stores.data.stores[0].deptId) {
  "ASSERT OK: source = luckin_mcp_realtime，$($stores.data.stores.Count) 家真實門市（首店 $($stores.data.stores[0].name)，距離 $($stores.data.stores[0].distanceM)m）"
} else {
  "ASSERT FAIL: source=$($stores.data.source)（若為 mock_deterministic 代表 Token 無效或上游不可達，查服務日誌 [skill-luckin]）"
}
$deptId = $stores.data.stores[0].deptId

'--- R2. search_luckin_product（斷言真實商品命中 + productId/skuCode 可用於下單綁定）---'
$prod = Send-Json "$h/api/skill/skill.coffee.luckin/search_luckin_product" ('{{"deptId":"{0}","query":"{1}"}}' -f $deptId, $kw)
$prod | ConvertTo-Json -Depth 6 -Compress
if ($prod.data.source -eq 'luckin_mcp_realtime' -and $prod.data.products.Count -ge 1 -and $prod.data.products[0].productId) {
  "ASSERT OK: product = $($prod.data.products[0].name)（$($prod.data.products[0].priceText)，productId $($prod.data.products[0].productId)）"
} else { "ASSERT FAIL: source=$($prod.data.source)" }

'--- R3. search_luckin_store 缺座標（應 400）---'
(Try-Send "$h/api/skill/skill.coffee.luckin/search_luckin_store" '{"city":"北京市"}')

''
'--- 冒煙結束：唯讀環節驗證完畢；place_luckin_order 真實下單未觸發（需人工決策）---'
