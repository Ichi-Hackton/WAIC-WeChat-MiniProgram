# MicroMate 本地雲托管服務啟動腳本（開發直連模式）
#
# 用法：在 cloudrun/ 目錄下執行 .\dev-start.ps1
#   1. 讀取 .env.local 注入環境變數（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，
#      該檔已被 .gitignore 忽略）
#   2. 編譯 TypeScript（tsc -p .）
#   3. 以 PORT=8787 啟動服務 —— 小程序端 services/cloud.ts 開發環境
#      直連此埠（LOCAL_RUN_BASE），無需開通微信雲開發即可跑通
#      「真實 LLM 規劃 → SKILL 端點執行」全鏈路
$ErrorActionPreference = 'Stop'

# 固定工作目錄為腳本所在目錄（cloudrun/），不依賴調用方的當前位置
Push-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '.env.local'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#')) {
      $kv = $line -split '=', 2
      if ($kv.Length -eq 2) {
        Set-Item -Path ('Env:' + $kv[0].Trim()) -Value $kv[1].Trim()
      }
    }
  }
  Write-Host '[dev-start] .env.local 已載入' -ForegroundColor Green
} else {
  Write-Warning '[dev-start] 未找到 .env.local（LLM 代理將返回 503，僅 SKILL 端點可用）'
}

$env:PORT = '8787'

# 啟用 /api/dev-log 日誌旁路落盤端點（server.ts 以 ENABLE_DEV_LOG 門控，
# 生產容器未設此變數時端點按 404 處理；僅本地開發需要取證能力）
$env:ENABLE_DEV_LOG = '1'

Write-Host '[dev-start] 編譯 TypeScript ...' -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw '編譯失敗' }

Write-Host '[dev-start] 服務啟動：http://127.0.0.1:8787 （Ctrl+C 停止）' -ForegroundColor Green
node dist/server.js
