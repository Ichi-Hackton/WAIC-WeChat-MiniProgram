# MicroMate 本地雲托管服務守護腳本（計劃任務 MicroMate-dev-cloudrun-guard 用）
#
# 職責：檢查 127.0.0.1:8787 是否有服務監聽；沒有則以分離進程靜默拉起
# dev-start.ps1。設計要點：
#   1. 冪等：埠已監聽即退出——無論服務由誰啟動（IDE 會話手動實例同樣
#      計入），不重複編譯、不搶佔埠；與開發會話內手動 dev-start 完美共存
#   2. 分離拉起：Start-Process 不等待（dev-start 含 tsc 編譯 + node 常駐，
#      會阻塞到服務退出）——守護腳本秒退，node 服務獨立於任務進程樹存活，
#      任務 ExecutionTimeLimit 到期終止的是守護腳本而非服務
#   3. 拉起後 20 秒覆核：dev-start 需先 tsc 編譯（10~30s），當輪未就緒
#      不算失敗，由下一輪 15 分鐘守護複查兜底
#
# 註冊方式（管理員不要求，當前用戶即可）：
#   觸發 = 用戶登錄時 + 每 15 分鐘重複；MultipleInstances=IgnoreNew 防重疊
#
# 日誌：logs/dev-guard.log（超過 500KB 截尾保留最後 200 行，防無界增長）
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$logFile = Join-Path $root 'logs\dev-guard.log'

function Write-GuardLog([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try {
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 500KB) {
      $tail = Get-Content $logFile -Tail 200
      Set-Content -Path $logFile -Value $tail -Encoding utf8
    }
    Add-Content -Path $logFile -Value $line -Encoding utf8
  } catch {
    # 取證日誌失敗不影響守護動作本身
  }
}

try {
  # ---- 埠守衛：已監聽即退（冪等） ----
  $listen = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
  if ($listen) {
    Write-GuardLog "埠 8787 已有監聽（PID $($listen[0].OwningProcess)），無需動作"
    exit 0
  }

  # ---- 分離拉起 dev-start.ps1（隱藏窗口） ----
  Write-GuardLog '埠 8787 無監聽，分離拉起 dev-start.ps1 ...'
  $devStart = Join-Path $root 'dev-start.ps1'
  if (-not (Test-Path $devStart)) {
    Write-GuardLog "找不到 $devStart，放棄"
    exit 1
  }
  # 拉起前覆核一次：縮小與手動觸發/另一守護實例的競態窗口
  # （雙拉起時第二個 node 以 EADDRINUSE 自行退出，此處覆核把概率再壓一檔）
  $recheck = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
  if ($recheck) {
    Write-GuardLog "覆核發現已有監聽（PID $($recheck[0].OwningProcess)），無需動作"
    exit 0
  }
  Start-Process -FilePath 'pwsh.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"{0}"' -f $devStart)) `
    -WindowStyle Hidden

  # ---- 20 秒覆核（容忍 tsc 編譯耗時） ----
  Start-Sleep -Seconds 20
  $after = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
  if ($after) {
    Write-GuardLog "拉起成功（PID $($after[0].OwningProcess)）"
  } else {
    Write-GuardLog '20 秒內尚未監聽（編譯中或啟動失敗），待下輪守護複查'
  }
  exit 0
} catch {
  Write-GuardLog ('異常: ' + $_.Exception.Message)
  exit 1
}
