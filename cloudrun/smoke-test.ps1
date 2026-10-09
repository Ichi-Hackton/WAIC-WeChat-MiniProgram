$h = 'http://127.0.0.1:8787'
# 模擬微信雲托管注入的調用方身份（寫操作鑒權必需，見 server.ts x-wx-openid）
$ownerHeaders = @{ 'x-wx-openid' = 'smoke-test-owner' }

# PS 5.1 陷阱：中文 JSON 必須以 UTF8 位元組發送並聲明 charset，
# 否則中文會變 "??"（歷史上曾因此把編碼假象誤判為「Station not found」上游故障）
function Send-Json($Uri, $Headers, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Headers $Headers -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Headers, $Json) {
  try { Send-Json $Uri $Headers $Json | ConvertTo-Json -Depth 6 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'--- 1. 健康檢查 ---'
(Invoke-RestMethod "$h/healthz") | ConvertTo-Json -Compress

'--- 2. search_train（經 12306-mcp 查真實餘票，日期取明天）---'
$tomorrow = (Get-Date).AddDays(1).ToString('yyyy-MM-dd')
$search = Send-Json "$h/api/skill/skill.train.12306/search_train" $null ('{{"from":"北京","to":"上海","date":"{0}"}}' -f $tomorrow)
$search | ConvertTo-Json -Depth 5 -Compress

'--- 3. book_ticket（2026-10 跳轉模式：取首班車次，斷言 pending_external + train_12306 跳轉包）---'
$first = $search.data.trains[0]
$book = Send-Json "$h/api/skill/skill.train.12306/book_ticket" $ownerHeaders ('{{"trainNo":"{0}","date":"{1}","seatType":"second_class","passengerName":"測試","passengerIdNo":"110101199001011234","from":"北京","to":"上海"}}' -f $first.trainNo, $tomorrow)
$book | ConvertTo-Json -Depth 6 -Compress
# 斷言：跳轉模式寫操作恆為 pending_external + jump（target=train_12306、copyText 四行購票資訊）
if ($book.data.status -eq 'pending_external' -and $book.data.jump.target -eq 'train_12306' -and $book.data.jump.copyText) {
  'ASSERT OK: book_ticket = pending_external + jump(train_12306)'
} else { "ASSERT FAIL: $($book | ConvertTo-Json -Compress)" }

'--- 4. book_ticket/cancel（跳轉訂單取消 = 放棄購買，DB 刪單）---'
(Send-Json "$h/api/skill/skill.train.12306/book_ticket/cancel" $ownerHeaders ('{{"orderId":"{0}"}}' -f $book.data.orderId)) | ConvertTo-Json -Compress

'--- 5. cancel 再取消同單（應 404：訂單已從 DB 刪除，印證落庫生命週期；「重啟容器訂單仍在」為部署驗證項）---'
(Try-Send "$h/api/skill/skill.train.12306/book_ticket/cancel" $ownerHeaders ('{{"orderId":"{0}"}}' -f $book.data.orderId))

'--- 6. book_flight（跳轉模式：斷言 pending_external + ota_flight 跳轉包；VARIFLIGHT 未配置時金額為靜態基準價）---'
$flight = Send-Json "$h/api/skill/skill.flight.variflight/book_flight" $ownerHeaders ('{{"flightNo":"CA1501","date":"{0}","cabin":"economy","passengerName":"測試","passengerIdNo":"110101199001011234","from":"北京","to":"上海"}}' -f $tomorrow)
$flight | ConvertTo-Json -Depth 6 -Compress
if ($flight.data.status -eq 'pending_external' -and $flight.data.jump.target -eq 'ota_flight' -and $flight.data.jump.copyText) {
  'ASSERT OK: book_flight = pending_external + jump(ota_flight)'
} else { "ASSERT FAIL: $($flight | ConvertTo-Json -Compress)" }

'--- 7. book_flight/cancel（放棄購買）---'
(Send-Json "$h/api/skill/skill.flight.variflight/book_flight/cancel" $ownerHeaders ('{{"orderId":"{0}"}}' -f $flight.data.orderId)) | ConvertTo-Json -Compress

'--- 8. LLM 未配置時降級規劃（配置後為真實規劃，均應 code=0）---'
(Send-Json "$h/api/llm/chat" $null '{"messages":[{"role":"user","content":"hi"}]}') | ConvertTo-Json -Depth 3 -Compress

'--- 9. 咖啡下單 ---'
(Send-Json "$h/api/skill/skill.coffee.starbucks/place_order" $ownerHeaders '{"storeId":"sb_001","pickupType":"in_store","items":[{"sku":"latte","name":"拿鐵","quantity":2}]}') | ConvertTo-Json -Depth 5 -Compress

'--- 10. 天氣查詢（上海座標；WEATHERCN_KEY 未配置時業務 503，配置後為中國天氣網實況）---'
(Send-Json "$h/api/skill/skill.weather.query/get_weather" $null '{"lat":31.2304,"lng":121.4737}') | ConvertTo-Json -Depth 3 -Compress
