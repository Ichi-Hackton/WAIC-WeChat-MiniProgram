---
kind: logging_system
name: MicroMate 小程序與雲托管雙端日誌系統
category: logging_system
scope:
    - '**'
source_files:
    - miniprogram/src/utils/logger.ts
    - cloudrun/src/server.ts
    - miniprogram/src/app.ts
---

## 1. 使用的系統/方法

項目採用**自實現的輕量級日誌模組**，無第三方依賴：
- 微信小程序端（`miniprogram/src/utils/logger.ts`）：基於原生 `console.log/warn/error`，封裝為 `debug/info/warn/error` 四級 API，並提供全局門檻控制。
- 雲托管服務端（`cloudrun/src/server.ts`）：在入口處定義一個本地 `log()` 輔助函數，直接 `console.log` 輸出到 stdout，由微信雲托管日誌系統收集。

兩端均不使用 Winston、Pino、bunyan 等第三方日誌框架。

## 2. 關鍵文件

- `miniprogram/src/utils/logger.ts` — 小程序端唯一日誌抽象，定義 `LogLevel` 類型、`setLogLevel` 門檻設置、四級輸出函數。
- `miniprogram/src/app.ts` — 通過 `import { info as logInfo, error as logError } from './utils/logger'` 使用日誌，並在 Agent 引擎就緒時輸出啟動日誌。
- `cloudrun/src/server.ts` — 雲托管入口，定義本地 `log()` 函數用於請求/異常日誌。

被調用 logger 的業務文件（僅列舉部分）：`core/context.ts`、`core/orchestrator.ts`、`core/scheduler.ts`、`interaction/checkpoint.ts`、`llm/client.ts`、`services/cloud.ts`、`services/llm.ts`、`services/payment.ts`、`skills/adapter.ts`、`skills/registry.ts`。

## 3. 架構與約定

### 3.1 小程序端日誌格式

每條日誌統一以 `[BRAND_NAME][LEVEL]` 前綴開頭，緊接 ISO 時間戳，再拼接業務訊息。例如：

```
[MicroMate][INFO] 2025-01-01T00:00:00.000Z handleIntent: "..."
```

- 前綴中的 `BRAND_NAME` 來自 `src/types/brand.ts`，確保所有日誌可溯源到品牌。
- 時間戳由 `stamp()` 生成，使用 `new Date().toISOString()`。
- 輸出通道：`debug`/`info` 走 `console.log`；`warn` 走 `console.warn`；`error` 走 `console.error`。

### 3.2 日誌級別與閾值

`logger.ts` 定義了四級別及權重：

| 級別 | 權重 | 說明 |
|------|------|------|
| debug | 0 | 開發調試用 |
| info | 1 | 預設閾值 |
| warn | 2 | 警告 |
| error | 3 | **永遠輸出，不受閾值限制**（見第 58-60 行註釋） |

全局閾值由 `setLogLevel(lv)` 設定，預設為 `'info'`。註釋指出「一般由 App onLaunch 依環境動態注入」——但當前代碼中未找到實際調用點，意味著預設行為是 info 及以上可見。

### 3.3 雲托管服務端日誌

`server.ts` 內的 `log()` 函數格式為：

```
[cloudrun] <ISO timestamp> <message>
```

僅用於記錄 HTTP 請求入站、異常以及服務啟動信息，全部寫入 stdout，由微信雲托管平台日誌系統自動採集。

### 3.4 設計約束

`logger.ts` 頂部註釋明確引用規範來源（Agent.md § 12.3）：

> utils/ 層不得 import 'wx.*'，本模組僅依賴 console，確保純函式可單元測試。

這意味著 logger 不依賴任何微信運行時 API，從而可以被單元測試替換或模擬。

## 4. 約定與規則

- **格式約定**：小程序端日誌必須使用 `logger.ts` 導出的 `debug/info/warn/error`，禁止在各業務文件中直接調用 `console.*`。該約定由 logger 作為唯一匯出點強制（業務文件只從 `../utils/logger` 導入）。
- **前綴約定**：所有日誌以 `[BRAND_NAME][LEVEL]` 開頭，便於日誌聚合與品牌溯源（見 logger.ts 第 7 行註釋）。
- **錯誤級別例外**：`error()` 永遠輸出，不受 `currentLevel` 閾值過濾（見第 58-60 行），保證異常必達。
- **雲托管端**：所有服務端日誌統一經過 `server.ts` 的 `log()` 函數，避免散落的 `console.log`。
- **結構化字段**：目前未引入 JSON 結構化日誌；所有字段均以字串拼接方式輸出。若需聚合分析，應依賴外部日誌平台的解析能力。
- **閾值配置**：`setLogLevel` 暴露給上層（如 `App.onLaunch`）按環境切換，但當前工程未實際調用，因此生產環境預設為 `info` 級別。

## 5. 現狀評估

這是一個**最小可行**的日誌系統：功能完整（四級別 + 閾值 + 品牌前綴 + 時間戳），但沒有以下特性：
- 無第三方日誌框架（Winston/Pino 等）。
- 無 JSON 結構化輸出。
- 無遠程日誌推送（僅 stdout/console）。
- 雲托管端與小程序端的日誌格式不一致（前者 `[cloudrun]`，後者 `[BRAND_NAME][LEVEL]`）。
- 閾值設置尚未在啟動流程中被實際調用。