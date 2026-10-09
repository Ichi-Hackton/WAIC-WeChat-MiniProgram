# 演出票務 SKILL（skill.ticket.show）端點冒煙測試
# 前置：cloudrun 目錄 npm run build 後以 PORT=8788 啟動 dist/server.js
$h = 'http://127.0.0.1:8788'
# 模擬微信雲托管注入的調用方身份（寫操作鑒權必需，見 server.ts x-wx-openid）
$ownerHeaders = @{ 'x-wx-openid' = 'smoke-ticket-owner' }
$otherHeaders = @{ 'x-wx-openid' = 'smoke-ticket-other' }

function Send-Json($Uri, $Headers, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Headers $Headers -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Headers, $Json) {
  try { Send-Json $Uri $Headers $Json | ConvertTo-Json -Depth 8 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'--- 1. search_events 關鍵詞「周杰倫」---'
(Try-Send "$h/api/skill/skill.ticket.show/search_events" $null '{"keyword":"周杰倫"}')

'--- 2. search_events 全空入參（應 400）---'
(Try-Send "$h/api/skill/skill.ticket.show/search_events" $null '{}')

'--- 3. search_events 城市過濾「上海」（話劇+演唱會）---'
(Try-Send "$h/api/skill/skill.ticket.show/search_events" $null '{"city":"上海"}')

'--- 4. list_sessions ev_004（話劇場次與票檔餘票 + bindings 映射）---'
$sessions = Send-Json "$h/api/skill/skill.ticket.show/list_sessions" $null '{"eventId":"ev_004"}'
$sessions | ConvertTo-Json -Depth 8 -Compress

'--- 5. list_sessions 不存在的演出（應 404 業務失敗）---'
(Try-Send "$h/api/skill/skill.ticket.show/list_sessions" $null '{"eventId":"ev_999"}')

'--- 6. create_order 無身份（應 401）---'
$firstSession = $sessions.data.firstAvailableSessionId
$firstTier = $sessions.data.firstAvailableTierId
(Try-Send "$h/api/skill/skill.ticket.show/create_order" $null ('{{"eventId":"ev_004","sessionId":"{0}","tierId":"{1}","quantity":2,"viewerName":"測試","viewerIdNo":"110101199001011234"}}' -f $firstSession, $firstTier))

'--- 7. create_order 正常下單（首個有票場次 / 票檔 x2，金額 = 票價 x2）---'
$order = Send-Json "$h/api/skill/skill.ticket.show/create_order" $ownerHeaders ('{{"eventId":"ev_004","sessionId":"{0}","tierId":"{1}","quantity":2,"viewerName":"測試","viewerIdNo":"110101199001011234"}}' -f $firstSession, $firstTier)
$order | ConvertTo-Json -Depth 8 -Compress

'--- 8. create_order 超量 quantity=99（應 400 參數校驗）---'
(Try-Send "$h/api/skill/skill.ticket.show/create_order" $ownerHeaders ('{{"eventId":"ev_004","sessionId":"{0}","tierId":"{1}","quantity":99,"viewerName":"測試","viewerIdNo":"110101199001011234"}}' -f $firstSession, $firstTier))

'--- 9. 下單後再查 list_sessions（該票檔庫存應已扣減 2）---'
(Try-Send "$h/api/skill/skill.ticket.show/list_sessions" $null '{"eventId":"ev_004"}')

'--- 10. 他人身份取消該訂單（應 403 防越權）---'
(Try-Send "$h/api/skill/skill.ticket.show/cancel_order" $otherHeaders ('{{"orderId":"{0}"}}' -f $order.data.orderId))

'--- 11. list_orders（僅本人的 1 張訂單）---'
$list = Send-Json "$h/api/skill/skill.ticket.show/list_orders" $ownerHeaders '{}'
$list | ConvertTo-Json -Depth 8 -Compress

'--- 12. cancel_order 本人取消（庫存恢復）---'
(Try-Send "$h/api/skill/skill.ticket.show/cancel_order" $ownerHeaders ('{{"orderId":"{0}"}}' -f $order.data.orderId))

'--- 13. cancel_order 再取消同單（應 404 已不存在）---'
(Try-Send "$h/api/skill/skill.ticket.show/cancel_order" $ownerHeaders ('{{"orderId":"{0}"}}' -f $order.data.orderId))

'--- 14. 取消後再查 list_sessions（該票檔庫存應已恢復）---'
(Try-Send "$h/api/skill/skill.ticket.show/list_sessions" $null '{"eventId":"ev_004"}')
