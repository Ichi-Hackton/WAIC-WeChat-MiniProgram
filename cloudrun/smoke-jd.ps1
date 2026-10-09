# 京東聯盟轉鏈端到端冒煙（2026-10 真實渠道上線）
# 前置：JD_UNION_APP_KEY / JD_UNION_APP_SECRET / JD_UNION_POSITION_ID 已配置（推廣位過審後轉鏈可用）
# 未配置憑證時 search 降級 demo 目錄（source=demo），腳本以 SKIP 標記跳過轉鏈斷言不判失敗
$h = 'http://127.0.0.1:8788'
$ownerHeaders = @{ 'x-wx-openid' = 'smoke-jd-owner' }

function Send-Json($Uri, $Headers, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Headers $Headers -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Headers, $Json) {
  try { Send-Json $Uri $Headers $Json | ConvertTo-Json -Depth 8 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'--- 1. search_products 關鍵詞「無線耳機」（觀察 source 是否含 jd）---'
$search = Send-Json "$h/api/skill/skill.shopping.mall/search_products" $null '{"keyword":"無線耳機","limit":6}'
$search | ConvertTo-Json -Depth 6 -Compress
"source = $($search.data.source)"

$jdItem = $search.data.products | Where-Object { $_.channel -eq 'jd' } | Select-Object -First 1
if (-not $jdItem) {
  'SKIP: 京東渠道未配置 / 未命中（source 無 jd），轉鏈斷言跳過——配置 JD_UNION_APP_KEY / JD_UNION_APP_SECRET / JD_UNION_POSITION_ID 後重跑'
} else {
  '--- 2. add_to_cart 京東真實商品（透傳 name / priceCent / jumpUrl 供結算轉鏈）---'
  $add = Send-Json "$h/api/skill/skill.shopping.mall/add_to_cart" $ownerHeaders ('{{"productId":"{0}","quantity":1,"name":"{1}","priceCent":{2},"jumpUrl":"{3}"}}' -f $jdItem.productId, $jdItem.name, $jdItem.priceCent, $jdItem.jumpUrl)
  $add | ConvertTo-Json -Depth 6 -Compress

  '--- 3. checkout（京東商品走聯盟轉鏈：斷言 jumps[0] 為 miniapp + jCommand 小程序跳轉指令）---'
  $checkout = Send-Json "$h/api/skill/skill.shopping.mall/checkout" $ownerHeaders '{}'
  $checkout | ConvertTo-Json -Depth 8 -Compress
  $j0 = $checkout.data.jumps[0]
  if ($checkout.data.status -eq 'pending_external' -and $j0.channel -eq 'jd') {
    if ($j0.action -eq 'miniapp' -and $j0.jCommand) {
      'ASSERT OK: 京東轉鏈 miniapp 跳轉（jCommand 已取得，可跳京東小程序下單）'
    } else {
      "ASSERT WARN: 轉鏈降級為複製（action=$($j0.action)，jCommand 未取得——推廣位未過審 / 轉鏈失敗，checkout 降級複製連結）"
    }
  } else { "ASSERT FAIL: $($checkout | ConvertTo-Json -Compress)" }

  '--- 4. checkout/cancel 回滾跳轉訂單（放棄購買）---'
  (Try-Send "$h/api/skill/skill.shopping.mall/checkout/cancel" $ownerHeaders ('{{"orderId":"{0}"}}' -f $checkout.data.orderId))
}
