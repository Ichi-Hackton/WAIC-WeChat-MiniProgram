$h = 'http://127.0.0.1:8787'
# 模擬微信雲托管注入的調用方身份（寫操作鑒權必需，見 server.ts x-wx-openid）
$ownerHeaders = @{ 'x-wx-openid' = 'smoke-test-owner' }

# PS 5.1 陷阱：中文 JSON 必須以 UTF8 位元組發送並聲明 charset，
# 否則中文會變 "??"（歷史上曾因此把編碼假象誤判為「Station not found」上游故障）
function Send-Json($Uri, $Headers, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Headers $Headers -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}

'--- 1. 健康檢查 ---'
(Invoke-RestMethod "$h/healthz") | ConvertTo-Json -Compress

'--- 2. search_train（經 12306-mcp 查真實餘票，日期取明天）---'
$tomorrow = (Get-Date).AddDays(1).ToString('yyyy-MM-dd')
$search = Send-Json "$h/api/skill/skill.train.12306/search_train" $null ('{{"from":"北京","to":"上海","date":"{0}"}}' -f $tomorrow)
$search | ConvertTo-Json -Depth 5 -Compress

'--- 3. book_ticket（取查詢結果首班真實車次，下單金額為該席別真實票價）---'
$first = $search.data.trains[0]
$book = Send-Json "$h/api/skill/skill.train.12306/book_ticket" $ownerHeaders ('{{"trainNo":"{0}","date":"{1}","seatType":"second_class","passengerName":"測試","passengerIdNo":"110101199001011234","from":"北京","to":"上海"}}' -f $first.trainNo, $tomorrow)
$book | ConvertTo-Json -Compress

'--- 4. cancel 同一訂單 ---'
(Send-Json "$h/api/skill/skill.train.12306/book_ticket/cancel" $ownerHeaders ('{{"orderId":"{0}"}}' -f $book.data.orderId)) | ConvertTo-Json -Compress

'--- 5. LLM 未配置時降級規劃（配置後為真實規劃，均應 code=0）---'
(Send-Json "$h/api/llm/chat" $null '{"messages":[{"role":"user","content":"hi"}]}') | ConvertTo-Json -Depth 3 -Compress

'--- 6. 咖啡下單 ---'
(Send-Json "$h/api/skill/skill.coffee.starbucks/place_order" $ownerHeaders '{"storeId":"sb_001","pickupType":"in_store","items":[{"sku":"latte","name":"拿鐵","quantity":2}]}') | ConvertTo-Json -Depth 5 -Compress
