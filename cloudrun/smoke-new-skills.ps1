# 新 SKILL（購物 / 預約）端點冒煙測試
$h = 'http://127.0.0.1:8788'
$ownerHeaders = @{ 'x-wx-openid' = 'smoke-new-skills' }

function Send-Json($Uri, $Headers, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Headers $Headers -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Headers, $Json) {
  try { Send-Json $Uri $Headers $Json | ConvertTo-Json -Depth 6 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'--- 1. search_products 關鍵詞「耳機」---'
(Try-Send "$h/api/skill/skill.shopping.mall/search_products" $null '{"keyword":"耳機"}')

'--- 2. search_products 全部 ---'
(Try-Send "$h/api/skill/skill.shopping.mall/search_products" $null '{}')

'--- 3. add_to_cart 無身份（應 401）---'
(Try-Send "$h/api/skill/skill.shopping.mall/add_to_cart" $null '{"productId":"p_001","quantity":1}')

'--- 4. add_to_cart p_001 x1 ---'
(Try-Send "$h/api/skill/skill.shopping.mall/add_to_cart" $ownerHeaders '{"productId":"p_001","quantity":1}')

'--- 5. add_to_cart 售罄商品 p_006（應 409）---'
(Try-Send "$h/api/skill/skill.shopping.mall/add_to_cart" $ownerHeaders '{"productId":"p_006","quantity":1}')

'--- 6. checkout（1 件）---'
$checkout = Send-Json "$h/api/skill/skill.shopping.mall/checkout" $ownerHeaders '{}'
$checkout | ConvertTo-Json -Depth 6 -Compress

'--- 7. checkout 再結算（購物車已清空，應 409）---'
(Try-Send "$h/api/skill/skill.shopping.mall/checkout" $ownerHeaders '{}')

'--- 8. checkout/cancel 回滾訂單 ---'
(Try-Send "$h/api/skill/skill.shopping.mall/checkout/cancel" $ownerHeaders ('{{"orderId":"{0}"}}' -f $checkout.data.orderId))

'--- 9. search_services（今天，無關鍵詞）---'
$today = (Get-Date).ToString('yyyy-MM-dd')
$search = Send-Json "$h/api/skill/skill.booking.center/search_services" $null ('{{"date":"{0}"}}' -f $today)
$search | ConvertTo-Json -Depth 6 -Compress

'--- 10. create_reservation（svc_001 首個可約時段）---'
$firstSlot = $search.data.firstAvailableStartTimeByService.svc_001
"firstAvailableSlot(svc_001) = $firstSlot"
(Try-Send "$h/api/skill/skill.booking.center/create_reservation" $ownerHeaders ('{{"serviceId":"svc_001","date":"{0}","startTime":"{1}"}}' -f $today, $firstSlot))

'--- 11. 同時段重複預約（應 409；時段已被上一步佔用）---'
(Try-Send "$h/api/skill/skill.booking.center/create_reservation" $ownerHeaders ('{{"serviceId":"svc_001","date":"{0}","startTime":"{1}"}}' -f $today, $firstSlot))

'--- 12. list_reservations ---'
(Try-Send "$h/api/skill/skill.booking.center/list_reservations" $ownerHeaders '{}')

'--- 13. cancel_reservation（取 list 首單）---'
$list = Send-Json "$h/api/skill/skill.booking.center/list_reservations" $ownerHeaders '{}'
(Try-Send "$h/api/skill/skill.booking.center/cancel_reservation" $ownerHeaders ('{{"reservationId":"{0}"}}' -f $list.data.reservations[0].reservationId))
