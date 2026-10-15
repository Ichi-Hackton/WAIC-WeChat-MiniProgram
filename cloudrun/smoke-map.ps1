# 地圖 POI 搜尋 SKILL 端點冒煙測試（skill.map.tianditu / search_poi）
# 斷言口徑（雲端雙上游：高德優先、天地圖兜底；2026-10-14 騰訊上游移除）：
# 入參校驗 400 家族；兩把金鑰（AMAP_KEY / TIANDITU_KEY）均未配置 → 業務 503（HTTP
# 200，小程序端以確定性模擬數據降級）；任一可用 → code=0 + pois 結構（name/
# lat/lng/distanceM 齊備，distanceM 由雲端 haversine 後置計算；source 標識
# 實際回源：amap / tianditu）。
# 服務位址：跟隨 $env:PORT（與 dev-start.ps1 預設 8787 一致），可覆寫
$h = "http://127.0.0.1:$(if ($env:PORT) { $env:PORT } else { 8787 })"

function Send-Json($Uri, $Json) {
  Invoke-RestMethod -Method Post -Uri $Uri -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($Json))
}
function Try-Send($Uri, $Json) {
  try { Send-Json $Uri $Json | ConvertTo-Json -Depth 6 -Compress }
  catch { "HTTP_ERROR: $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)" }
}

'--- 1. search_poi 缺 keyword（應 400）---'
(Try-Send "$h/api/skill/skill.map.tianditu/search_poi" '{"lat":39.9,"lng":116.4}')

'--- 2. search_poi 座標超界（應 400；gcj02 粗邊界攔截）---'
(Try-Send "$h/api/skill/skill.map.tianditu/search_poi" '{"keyword":"便利店","lat":51.5,"lng":-0.12}')

'--- 3. radiusM 越界（應 400）---'
(Try-Send "$h/api/skill/skill.map.tianditu/search_poi" '{"keyword":"便利店","lat":39.9,"lng":116.4,"radiusM":999999}')

'--- 4. limit 越界（應 400）---'
(Try-Send "$h/api/skill/skill.map.tianditu/search_poi" '{"keyword":"便利店","lat":39.9,"lng":116.4,"limit":99}')

'--- 5. search_poi 正常入參（北京座標；斷言見輸出）---'
$res = Send-Json "$h/api/skill/skill.map.tianditu/search_poi" '{"keyword":"便利店","lat":39.9042,"lng":116.4074}'
$res | ConvertTo-Json -Depth 6 -Compress
if ($res.code -eq 0) {
  $first = $res.data.pois | Select-Object -First 1
  if (@('amap', 'tianditu') -contains $res.data.source -and $first -and $first.name -and $first.lat -and $first.distanceM) {
    "ASSERT OK: code=0 source=$($res.data.source) pois=$($res.data.pois.Count) 首條距離 $($first.distanceM)m"
  } else { 'ASSERT FAIL: pois 結構異常' }
} elseif ($res.code -eq 503) {
  "ASSERT OK: 兩把金鑰均未配置業務 503（小程序端降級模擬數據）：$($res.message)"
} else { "ASSERT FAIL: 意外狀態碼 $($res.code)" }
