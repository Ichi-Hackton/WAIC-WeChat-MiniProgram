---
kind: external_dependency
name: 微信支付 AI 專屬卡 — MicroMate 付費能力
slug: wechat-pay-ai-card
category: external_dependency
category_hints:
    - vendor_identity
    - framework_behavior
scope:
    - '**'
source_files:
    - miniprogram/src/services/payment.ts
    - miniprogram/app.json
---

### 身份與角色
- 付費通道採用**微信支付 AI 專屬卡**（provider: `ai_card`），用於 Agent 觸發的跨 SKILL 交易（如訂高鐵 + 咖啡）。
- 小程序需在 `app.json` 宣告 `permission.scope.userLocation` 與 `requiredPrivateInfos: ["getLocation"]`，因為推薦門市/車站需要位置權限。

### 穩定行為
- 開發模式或 wx.requestPayment 不可用時直接回傳 success:false，不拋錯（安全預設）。