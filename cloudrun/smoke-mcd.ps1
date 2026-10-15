# 麥當勞 SKILL（skill.food.mcdonalds）端點冒煙測試（2026-10-14 真實下單版）
# 全鏈路：查店（真實）→ 菜單（真實）→ 試算+下單（真實訂單）→ 查單 → 取消（真實取消）
# 注意：第 4 步會在麥當勞側真實創建未支付訂單，第 6 步立即取消，不留殘餘
# 服務位址：跟隨 $env:PORT（與 dev-start.ps1 預設 8787 一致），可覆寫
$h = "http://127.0.0.1:$(if ($env:PORT) { $env:PORT } else { 8787 })"
$ownerHeaders = @{ 'x-wx-openid' = 'smoke-mcd' }

function Send-Json($Uri, $Headers, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Headers $Headers -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Headers, $Json) {
  try { Send-Json $Uri $Headers $Json | ConvertTo-Json -Depth 8 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'--- 1. search_mcd_store（北京國貿座標；斷言 source=mcd_realtime + stores 非空）---'
$store = Send-Json "$h/api/skill/skill.food.mcdonalds/search_mcd_store" $null '{"city":"北京市","keyword":"国贸","lat":39.9087,"lng":116.4575,"limit":3}'
$store | ConvertTo-Json -Depth 6 -Compress
if ($store.data.source -eq 'mcd_realtime' -and $store.data.stores.Count -ge 1) {
  "ASSERT OK: search = mcd_realtime + $($store.data.stores.Count) 家（首店 $($store.data.stores[0].name)）"
} else { "ASSERT FAIL: source=$($store.data.source)" }
$storeId = $store.data.stores[0].storeId

'--- 2. query_mcd_menu（首店；斷言 categories 非空，記錄首品 code）---'
$menu = Send-Json "$h/api/skill/skill.food.mcdonalds/query_mcd_menu" $null ('{{"storeId":"{0}"}}' -f $storeId)
"source = $($menu.data.source), 分類數 = $($menu.data.categories.Count)"
$menu.data.categories | ForEach-Object { "  [$($_.name)] $($_.meals.Count) 品（首碼 $($_.meals[0].code)）" }
$firstCode = $menu.data.categories[0].meals[0].code

'--- 3. place_mcd_order 無身份（應 401）---'
(Try-Send "$h/api/skill/skill.food.mcdonalds/place_mcd_order" $null ('{{"storeId":"{0}"}}' -f $storeId))

'--- 4. place_mcd_order（自動選人氣熱賣；真實訂單！斷言 orderId + 金額 + pending_external）---'
$order = Send-Json "$h/api/skill/skill.food.mcdonalds/place_mcd_order" $ownerHeaders ('{{"storeId":"{0}","items":[{{"productCode":"{1}","quantity":1}}]}}' -f $storeId, $firstCode)
$order | ConvertTo-Json -Depth 8 -Compress
if ($order.data.orderId -and $order.data.amountCent -gt 0 -and $order.data.status -eq 'pending_external') {
  "ASSERT OK: place = 真實訂單 $($order.data.mcdOrderId) 金額 $($order.data.amountCent) 分 取餐 $($order.data.takeWay)"
} else { "ASSERT FAIL" }

'--- 5. query_mcd_order（斷言雙狀態可查）---'
(Try-Send "$h/api/skill/skill.food.mcdonalds/query_mcd_order" $ownerHeaders ('{{"orderId":"{0}"}}' -f $order.data.orderId))

'--- 6. cancel_mcd_order（真實取消，不留殘餘）---'
(Try-Send "$h/api/skill/skill.food.mcdonalds/cancel_mcd_order" $ownerHeaders ('{{"orderId":"{0}","reasonCode":3}}' -f $order.data.orderId))

'--- 7. cancel 再取消（應 404 已取消）---'
(Try-Send "$h/api/skill/skill.food.mcdonalds/cancel_mcd_order" $ownerHeaders ('{{"orderId":"{0}"}}' -f $order.data.orderId))

'--- 8. place_mcd_order 自動選品路徑（不傳 items；驗證 autoPicked 標註後同樣取消）---'
$order2 = Send-Json "$h/api/skill/skill.food.mcdonalds/place_mcd_order" $ownerHeaders ('{{"storeId":"{0}"}}' -f $storeId)
$order2 | ConvertTo-Json -Depth 8 -Compress
if ($order2.data.autoPicked -eq $true -and $order2.data.orderId) {
  "ASSERT OK: autoPicked = true（自動選 $($order2.data.items[0].productName)）"
} else { "ASSERT FAIL" }
(Try-Send "$h/api/skill/skill.food.mcdonalds/cancel_mcd_order" $ownerHeaders ('{{"orderId":"{0}","reasonCode":1}}' -f $order2.data.orderId))
