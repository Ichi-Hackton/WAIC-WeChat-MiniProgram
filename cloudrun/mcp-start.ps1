# MicroMate 12306-mcp 啟動腳本（真實 12306 數據源，穩定化版）
#
# 用法：在 cloudrun/ 目錄下執行 .\mcp-start.ps1
#   啟動 Joooook/12306-MCP（Streamable HTTP，埠 3001，端點 /mcp），
#   供 skill-train.ts 經 MCP_12306_URL 查詢 12306 官方實時餘票。
#   依賴安裝於倉庫根 .mcp/12306/（首次缺失時自動以國內鏡像安裝）。
#
# 穩定化三層機制（治「Station not found」間歇故障）：
#   1. 啟動前冪等應用站名表快取補丁（patch.mjs）—— 官網風控拉到空頁時回退本地快取；
#   2. 啟動後以 MCP 協議真實探活（probe.mjs 調 get-stations-code-in-city），
#      「埠在監聽」≠「站名表已載入」，必須驗證到 BJP 才算就緒；
#   3. 探活失敗自動殺進程重啟（最多 3 輪），跨過官網間歇風控窗口。
#   進程以後台方式運行，日誌寫入 .mcp\12306\mcp.log；停止：Stop-Mcp（見文末注釋）。
$ErrorActionPreference = 'Stop'

$mcpDir = Join-Path $PSScriptRoot '..\.mcp\12306'
$mcpEntry = Join-Path $mcpDir 'node_modules\12306-mcp\build\index.js'
$mcpLog = Join-Path $mcpDir 'mcp.log'

# 停止既有實例（若有）：埠 3001 的監聽進程
function Stop-McpInstance {
  $listener = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    $pids = $listener | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $pids) {
      Write-Host "[mcp-start] 停止既有進程 pid=$procId" -ForegroundColor DarkGray
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
  }
}

# 首次運行：自動安裝依賴（國內鏡像加速）
if (-not (Test-Path $mcpEntry)) {
  Write-Host '[mcp-start] 首次運行，安裝 12306-mcp 依賴（國內鏡像）...' -ForegroundColor Cyan
  New-Item -ItemType Directory -Path $mcpDir -Force | Out-Null
  Push-Location $mcpDir
  try {
    if (-not (Test-Path (Join-Path $mcpDir 'package.json'))) { npm init -y | Out-Null }
    npm i 12306-mcp --registry=https://registry.npmmirror.com --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw '12306-mcp 依賴安裝失敗' }
  } finally {
    Pop-Location
  }
}

# 穩定化第 1 層：冪等應用站名表快取補丁（版本變更定位失敗僅警告，不阻塞；
# 補丁/探針腳本隨倉庫於 scripts/ 分發，.mcp/ 目錄不入庫）
& node (Join-Path $PSScriptRoot 'scripts\mcp-patch.mjs')
if ($LASTEXITCODE -eq 2) {
  Write-Host '[mcp-start] 補丁未應用（版本變更），以原始行為運行' -ForegroundColor Yellow
}

# 穩定化第 2+3 層：後台啟動 → 協議級探活 → 失敗重啟（最多 3 輪）
$maxRounds = 3
for ($round = 1; $round -le $maxRounds; $round++) {
  Stop-McpInstance
  Write-Host "[mcp-start] 第 $round/$maxRounds 輪啟動：http://127.0.0.1:3001/mcp（日誌 $mcpLog）" -ForegroundColor Green
  $proc = Start-Process -FilePath 'node' -ArgumentList @($mcpEntry, '--port', '3001') `
    -WindowStyle Hidden -RedirectStandardOutput $mcpLog -RedirectStandardError "$mcpLog.err" -PassThru

  # 最多探活 5 次（每次間隔 6s）：啟動需拉官網站名表/查詢路徑，容忍慢啟動
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    Start-Sleep -Seconds 6
    & node (Join-Path $PSScriptRoot 'scripts\mcp-probe.mjs')
    if ($LASTEXITCODE -eq 0) {
      Write-Host "[mcp-start] 就緒（pid=$($proc.Id)，第 $round 輪第 $attempt 次探活通過）" -ForegroundColor Green
      Write-Host '  停止方式：Get-NetTCPConnection -LocalPort 3001 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }' -ForegroundColor DarkGray
      exit 0
    }
    # 進程中途退出（如官網不可達導致頂層 await 拋錯）則不再等待
    if ($proc.HasExited) {
      Write-Host "[mcp-start] 進程提前退出（code=$($proc.ExitCode)），提前進入下一輪" -ForegroundColor Yellow
      break
    }
  }
}

# 徹底清理：最後一輪進程也不留 —— 「表空但活著」的進程會讓 cloudrun 收到
# 503 業務錯誤透傳（不降級 mock），比連接失敗（自動降級 mock）體驗更差
Stop-McpInstance
Write-Host '[mcp-start] 3 輪啟動均未就緒——官網風控窗口內站名表不可得且無本地快取可用，已清理全部進程。' -ForegroundColor Red
Write-Host '  cloudrun 將自動降級模擬數據；可稍後重跑 .\mcp-start.ps1 重試。' -ForegroundColor Red
exit 1
