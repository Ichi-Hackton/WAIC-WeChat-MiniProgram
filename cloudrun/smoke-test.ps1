$h = 'http://127.0.0.1:8787'
# 模擬微信雲托管注入的調用方身份（寫操作鑒權必需，見 server.ts x-wx-openid）
$ownerHeaders = @{ 'x-wx-openid' = 'smoke-test-owner' }
'--- 1. 健康檢查 ---'
(Invoke-RestMethod "$h/healthz") | ConvertTo-Json -Compress
'--- 2. search_train ---'
(Invoke-RestMethod -Method Post -Uri "$h/api/skill/skill.train.12306/search_train" -ContentType 'application/json' -Body '{"from":"北京","to":"上海","date":"2026-09-30"}') | ConvertTo-Json -Depth 5 -Compress
'--- 3. book_ticket ---'
$book = Invoke-RestMethod -Method Post -Uri "$h/api/skill/skill.train.12306/book_ticket" -ContentType 'application/json' -Headers $ownerHeaders -Body '{"trainNo":"G101","date":"2026-09-30","seatType":"second_class","passengerName":"測試","passengerIdNo":"110101199001011234","from":"北京","to":"上海"}'
$book | ConvertTo-Json -Compress
'--- 4. cancel 同一訂單 ---'
(Invoke-RestMethod -Method Post -Uri "$h/api/skill/skill.train.12306/book_ticket/cancel" -ContentType 'application/json' -Headers $ownerHeaders -Body ('{"orderId":"' + $book.data.orderId + '"}')) | ConvertTo-Json -Compress
'--- 5. LLM 未配置（預期 503）---'
try { Invoke-RestMethod -Method Post -Uri "$h/api/llm/chat" -ContentType 'application/json' -Body '{"messages":[{"role":"user","content":"hi"}]}' } catch { "HTTP $($_.Exception.Response.StatusCode.value__)（預期 503）OK" }
'--- 6. 咖啡下單 ---'
(Invoke-RestMethod -Method Post -Uri "$h/api/skill/skill.coffee.starbucks/place_order" -ContentType 'application/json' -Headers $ownerHeaders -Body '{"storeId":"sb_001","pickupType":"in_store","items":[{"sku":"latte","name":"拿鐵","quantity":2}]}') | ConvertTo-Json -Depth 5 -Compress
