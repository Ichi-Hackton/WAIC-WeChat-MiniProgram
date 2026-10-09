# 新 SKILL（購物 / 預約）端點冒煙測試（2026-10 跳轉模式斷言版）
# checkout 斷言 pending_external + jumps 逐商品轉鏈 / 淘口令；
# create_reservation 斷言 pending_external + meituan 跳轉包（時段目錄為演示參考，真實時段以美團為準）
$h = 'http://127.0.0.1:8788'
$ownerHeaders = @{ 'x-wx-openid' = 'smoke-new-skills' }

function Send-Json($Uri, $Headers, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Headers $Headers -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Headers, $Json) {
  try { Send-Json $Uri $Headers $Json | ConvertTo-Json -Depth 6 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'--- 1. search_products 關鍵詞「耳機」（觀察 source：聯盟憑證已配置時為 jd/taobao，未配置降級 demo）---'
$search = Send-Json "$h/api/skill/skill.shopping.mall/search_products" $null '{"keyword":"耳機"}'
$search | ConvertTo-Json -Depth 6 -Compress
"source = $($search.data.source)"

'--- 2. search_products 全部 ---'
(Try-Send "$h/api/skill/skill.shopping.mall/search_products" $null '{}')

'--- 3. add_to_cart 無身份（應 401）---'
(Try-Send "$h/api/skill/skill.shopping.mall/add_to_cart" $null '{"productId":"p_001","quantity":1}')

'--- 4. add_to_cart p_001 x1（演示商品；真實商品需透傳 name/priceCent/jumpUrl 供結算轉鏈）---'
(Try-Send "$h/api/skill/skill.shopping.mall/add_to_cart" $ownerHeaders '{"productId":"p_001","quantity":1}')

'--- 5. add_to_cart 售罄演示商品 p_006（應 409；聯盟真實商品無實時庫存、不校驗）---'
(Try-Send "$h/api/skill/skill.shopping.mall/add_to_cart" $ownerHeaders '{"productId":"p_006","quantity":1}')

'--- 6. checkout（跳轉模式：斷言 pending_external + jumps 逐商品跳轉項 + 主 jump 包）---'
$checkout = Send-Json "$h/api/skill/skill.shopping.mall/checkout" $ownerHeaders '{}'
$checkout | ConvertTo-Json -Depth 8 -Compress
if ($checkout.data.status -eq 'pending_external' -and $checkout.data.jumps.Count -ge 1 -and $checkout.data.jump.copyText) {
  "ASSERT OK: checkout = pending_external + jumps($($checkout.data.jumps.Count) 項) + jump 主包"
} else { "ASSERT FAIL: $($checkout | ConvertTo-Json -Compress)" }

'--- 7. checkout 再結算（心願單已清空，應 409）---'
(Try-Send "$h/api/skill/skill.shopping.mall/checkout" $ownerHeaders '{}')

'--- 8. checkout/cancel 回滾跳轉訂單（放棄購買）---'
(Try-Send "$h/api/skill/skill.shopping.mall/checkout/cancel" $ownerHeaders ('{{"orderId":"{0}"}}' -f $checkout.data.orderId))

'--- 9. search_services（今天，無關鍵詞；source=demo 演示目錄，真實商家以美團為準）---'
$today = (Get-Date).ToString('yyyy-MM-dd')
$search2 = Send-Json "$h/api/skill/skill.booking.center/search_services" $null ('{{"date":"{0}"}}' -f $today)
$search2 | ConvertTo-Json -Depth 6 -Compress

'--- 10. create_reservation（svc_001 首個可約時段；斷言 pending_external + meituan 跳轉包）---'
$firstSlot = $search2.data.firstAvailableStartTimeByService.svc_001
"firstAvailableSlot(svc_001) = $firstSlot"
$res = Send-Json "$h/api/skill/skill.booking.center/create_reservation" $ownerHeaders ('{{"serviceId":"svc_001","date":"{0}","startTime":"{1}"}}' -f $today, $firstSlot)
$res | ConvertTo-Json -Depth 6 -Compress
if ($res.data.status -eq 'pending_external' -and $res.data.jump.target -eq 'meituan' -and $res.data.jump.copyText) {
  'ASSERT OK: create_reservation = pending_external + jump(meituan)'
} else { "ASSERT FAIL: $($res | ConvertTo-Json -Compress)" }

'--- 11. 同時段重複預約（跳轉模式：時段真實性以美團為準，本地不再攔截，應正常生成第二張預約卡）---'
(Try-Send "$h/api/skill/skill.booking.center/create_reservation" $ownerHeaders ('{{"serviceId":"svc_001","date":"{0}","startTime":"{1}"}}' -f $today, $firstSlot))

'--- 12. list_reservations ---'
$list = Send-Json "$h/api/skill/skill.booking.center/list_reservations" $ownerHeaders '{}'
$list | ConvertTo-Json -Depth 6 -Compress

'--- 13. cancel_reservation（取 list 首單；跳轉訂單取消 = 放棄預約）---'
(Try-Send "$h/api/skill/skill.booking.center/cancel_reservation" $ownerHeaders ('{{"reservationId":"{0}"}}' -f $list.data.reservations[0].reservationId))
