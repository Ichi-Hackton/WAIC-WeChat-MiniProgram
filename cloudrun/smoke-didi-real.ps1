# 滴滴（skill.ride.didi）真實端點唯讀冒煙（2026-10-14，DIDI_MCP_KEY 已配置）
# 範圍嚴格限縮唯讀環節：maps_textsearch（地名→坐標）+ taxi_estimate（估價）。
# ⚠️ 不觸發 taxi_create_order（真實派車 / 真實費用），下單閉環需人工決策後手動驗證。
# 判別要點：連線層失敗（含 Key 無效）會「靜默降級 mock_deterministic」——
#   斷言必須鎖定 source='didi_mcp_realtime'，否則結果為假綠。
# 服務位址：跟隨 $env:PORT（與 dev-start.ps1 預設 8787 一致）
$h = "http://127.0.0.1:$(if ($env:PORT) { $env:PORT } else { 8787 })"

function Send-Json($Uri, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Json) {
  try { Send-Json $Uri $Json | ConvertTo-Json -Depth 8 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'--- R1. estimate_ride 三里屯→北京南站（真實檢索+估價；斷言 didi_mcp_realtime + 真實坐標 + traceId）---'
# 注：地名選学均為工具鏈零篡改字（曾實測「貿」會被寫入層誤轉為「貸」，改用安全地名）
$est = Send-Json "$h/api/skill/skill.ride.didi/estimate_ride" '{"fromName":"三里屯","toName":"北京南站","fromCity":"北京市"}'
$est | ConvertTo-Json -Depth 6 -Compress
$isOk = ($est.data.source -eq 'didi_mcp_realtime') -and $est.data.traceId -and ($est.data.options.Count -ge 1) -and ($est.data.from.lng -ne 0)
if ($isOk) {
  $first = $est.data.options[0]
  "ASSERT OK: source = didi_mcp_realtime，from（$($est.data.from.name) lng=$($est.data.from.lng)）→ to（$($est.data.to.name)），$($est.data.options.Count) 檔車型（首檔 $($first.productName) $($first.priceText)），traceId $($est.data.traceId)"
} else {
  "ASSERT FAIL: source=$($est.data.source)（若為 mock_deterministic 代表上游連線/鑑權失敗，查服務日誌 [skill-didi]）"
}

'--- R2. estimate_ride 缺 fromCity（應 400——滴滴 city 為 required 參數，上游對缺 city 直接 400）---'
(Try-Send "$h/api/skill/skill.ride.didi/estimate_ride" '{"fromName":"三里屯","toName":"北京南站"}')

'--- R3. 地點不存在（上游對異常關鍵詞回 400，應以 503 業務錯誤透傳，不降級假數據）---'
(Try-Send "$h/api/skill/skill.ride.didi/estimate_ride" '{"fromName":"不存在的虚构地点xyzqwk","toName":"北京南站","fromCity":"北京市"}')

''
'--- 冒煙結束：唯讀環節驗證完畢；place_ride 真實下單未觸發（需人工決策）---'
