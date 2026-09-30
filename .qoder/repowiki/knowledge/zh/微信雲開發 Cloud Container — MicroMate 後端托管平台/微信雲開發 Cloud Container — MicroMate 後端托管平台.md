---
kind: external_dependency
name: 微信雲開發 Cloud Container — MicroMate 後端托管平台
slug: wechat-cloud-container
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### 身份與角色
- 本專案的後端托管平台是**微信雲開發 Cloud Container**（Node.js 容器），由 `cloudrun/` 子目錄提供，透過 miniprogram 端的 `wx.cloud.callContainer` 調用。
- 容器鏡像基於 `node:20-alpine`，監聽 `PORT` 環境變數（預設 80），Dockerfile 使用 npm mirror `https://registry.npmmirror.com` 拉取依賴。

### 整合方式
- 開發/體驗環境（envVersion ≠ 'release'）下雲端不可用時回傳 `code:-1` 佔位碼，讓 SKILL mock 與本地規則規劃器兜底；正式環境則保留嚴格失敗語義。

### 穩定約束
- 請求頭自動注入 `x-micromate-session` 關聯會話。
- 驗證具體 API 參數與 CloudResponse 結構時，請對照微信官方文件。