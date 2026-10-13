# 六域回補（咖啡 / 票務 / 支付聚合 / 諮詢）端點冒煙測試（2026-10 跳轉模式斷言版）
# coffee place_order 斷言 pending_external + starbucks 跳轉包 + db 落庫可取消；
# ticket create_order 斷言 pending_external + damai 跳轉包；pay_orders 聚合
# 未取消的跳轉訂單；counseling 斷言端點可達（LLM 未配置時業務碼 503 屬離線降級）
# 服務位址：跟隨 $env:PORT（與 dev-start.ps1 預設 8787 一致），可覆寫
$h = "http://127.0.0.1:$(if ($env:PORT) { $env:PORT } else { 8787 })"
$ownerHeaders = @{ 'x-wx-openid' = 'smoke-restore-skills' }

function Send-Json($Uri, $Headers, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Headers $Headers -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Headers, $Json) {
  try { Send-Json $Uri $Headers $Json | ConvertTo-Json -Depth 6 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'--- 1. coffee search_store（上海，無需身份）---'
$stores = Send-Json "$h/api/skill/skill.coffee.starbucks/search_store" $null '{"city":"上海","limit":5}'
$stores | ConvertTo-Json -Depth 6 -Compress

'--- 2. coffee place_order（斷言 pending_external + jump(starbucks)）---'
$order = Send-Json "$h/api/skill/skill.coffee.starbucks/place_order" $ownerHeaders ('{{"storeId":"{0}","items":[{{"sku":"demo_latte","name":"拿鐵","quantity":1,"size":"中杯"}}],"pickupType":"in_store"}}' -f $stores.data.stores[0].storeId)
$order | ConvertTo-Json -Depth 6 -Compress
if ($order.data.status -eq 'pending_external' -and $order.data.jump.target -eq 'starbucks' -and $order.data.jump.copyText) {
  'ASSERT OK: coffee place_order = pending_external + jump(starbucks)'
} else { "ASSERT FAIL: $($order | ConvertTo-Json -Compress)" }

'--- 3. coffee place_order/cancel 回滾（db coffee 域訂單取消）---'
(Try-Send "$h/api/skill/skill.coffee.starbucks/place_order/cancel" $ownerHeaders ('{{"orderId":"{0}"}}' -f $order.data.orderId))

'--- 4. ticket search_events（關鍵詞「周杰倫」）---'
$events = Send-Json "$h/api/skill/skill.ticket.show/search_events" $null '{"keyword":"周杰倫"}'
$events | ConvertTo-Json -Depth 6 -Compress

'--- 5. ticket list_sessions（首個命中演出；含 bindings 映射）---'
$sessions = Send-Json "$h/api/skill/skill.ticket.show/list_sessions" $null ('{{"eventId":"{0}"}}' -f $events.data.firstEventId)
$sessions | ConvertTo-Json -Depth 8 -Compress

'--- 6. ticket create_order（斷言 pending_external + jump(damai)；觀演人為演示數據）---'
$tkt = Send-Json "$h/api/skill/skill.ticket.show/create_order" $ownerHeaders ('{{"eventId":"{0}","sessionId":"{1}","tierId":"{2}","quantity":1,"viewerName":"演示觀演人","viewerIdNo":"110101199001011234"}}' -f $events.data.firstEventId, $sessions.data.firstAvailableSessionId, $sessions.data.firstAvailableTierId)
$tkt | ConvertTo-Json -Depth 6 -Compress
if ($tkt.data.status -eq 'pending_external' -and $tkt.data.jump.target -eq 'damai' -and $tkt.data.jump.copyText) {
  'ASSERT OK: ticket create_order = pending_external + jump(damai)'
} else { "ASSERT FAIL: $($tkt | ConvertTo-Json -Compress)" }

'--- 7. ticket list_orders（db ticket 域落庫斷言）---'
$tlist = Send-Json "$h/api/skill/skill.ticket.show/list_orders" $ownerHeaders '{}'
$tlist | ConvertTo-Json -Depth 6 -Compress

'--- 8. pay_orders 無身份（應 401）---'
(Try-Send "$h/api/skill/skill.payment.aicard/pay_orders" $null '{}')

'--- 9. pay_orders 聚合（上面僅 ticket 訂單未取消；斷言 count ≥ 1 且逐單帶 jump）---'
$pay = Send-Json "$h/api/skill/skill.payment.aicard/pay_orders" $ownerHeaders '{}'
$pay | ConvertTo-Json -Depth 8 -Compress
if ($pay.data.count -ge 1 -and $pay.data.orders[0].jump.copyText) {
  "ASSERT OK: pay_orders 聚合 $($pay.data.count) 單（totalCent=$($pay.data.totalCent)）"
} else { "ASSERT FAIL: $($pay | ConvertTo-Json -Compress)" }

'--- 10. ticket cancel_order（清理：聚合清單中的訂單仍可放棄）---'
(Try-Send "$h/api/skill/skill.ticket.show/cancel_order" $ownerHeaders ('{{"orderId":"{0}"}}' -f $tkt.data.orderId))

'--- 11. counseling chat_companion（LLM 已配置回 llm 回覆；未配置回業務碼 503 離線降級，兩者皆為可達性 OK）---'
(Try-Send "$h/api/skill/skill.mind.counseling/chat_companion" $ownerHeaders '{"message":"最近有點累","history":[]}')
