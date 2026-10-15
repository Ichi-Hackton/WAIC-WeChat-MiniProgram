# send_mail 端點黑盒驗證（本地 cloudrun，埠由參數或預設 8791）
# 用例：401 無鑑權 / 400 郵箱格式 / 503 雙通道皆無 / 502 假 SMTP 上游失敗 /
#       429 頻控第 11 封 / 用戶自帶憑據（SSRF 阻斷 / DNS 失敗 / 缺 pass 視為未攜帶）
param(
  [int]$Port = 8791
)
$ErrorActionPreference = 'Continue'
$base = "http://127.0.0.1:$Port/api/skill/skill.device.comm/send_mail"

function Post($headers, $body) {
  # pwsh 7：-SkipHttpErrorCheck 讓 4xx 不抛異常，直接讀回應體
  $r = Invoke-WebRequest -Uri $base -Method Post -ContentType 'application/json' -Headers $headers -Body ($body | ConvertTo-Json) -UseBasicParsing -SkipHttpErrorCheck
  return "HTTP $($r.StatusCode) => $($r.Content)"
}

Write-Host "== T1 無 openid（期望 401）=="
Post @{} @{ to = 'tom@example.com' }

Write-Host "`n== T2 郵箱格式非法（期望 400）=="
Post @{ 'x-wx-openid' = 'test-openid-1' } @{ to = 'not-an-email' }

Write-Host "== T3 雙通道皆無（期望 503 業務碼，新文案引導綁定）=="
Post @{ 'x-wx-openid' = 'test-openid-1' } @{ to = 'tom@example.com'; subject = '測試'; body = '您好' }

Write-Host "== U2 用戶自帶 host=127.0.0.1（期望 400 SSRF 阻斷）=="
Post @{ 'x-wx-openid' = 'mail-user' } @{ to = 'tom@example.com'; userSmtp = @{ host = '127.0.0.1'; port = 465; user = 'a@qq.com'; pass = 'x' } }

Write-Host "== U4 用戶自帶缺 pass（期望視為未攜帶 → 503）=="
Post @{ 'x-wx-openid' = 'mail-user' } @{ to = 'tom@example.com'; userSmtp = @{ host = 'smtp.qq.com'; port = 465; user = 'a@qq.com' } }

Write-Host "== U5 用戶自帶不存在域名（期望 400 域名無法解析）=="
Post @{ 'x-wx-openid' = 'mail-user' } @{ to = 'tom@example.com'; userSmtp = @{ host = 'nonexistent.invalid'; port = 465; user = 'a@qq.com'; pass = 'x' } }

Write-Host "== T4-T13 假 SMTP（127.0.0.1:1 立即拒連）：前 10 封期望 502 =="

Write-Host "== T14 第 11 封（期望 429 頻控）=="
Write-Host "(T4-T14 需以 MAIL_SMTP_HOST=127.0.0.1 MAIL_SMTP_PORT=1 MAIL_SMTP_USER=x MAIL_SMTP_PASS=x 環境變數啟動服務後另行壓測)"
