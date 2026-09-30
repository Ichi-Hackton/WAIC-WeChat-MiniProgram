---
kind: error_handling
name: MicroMate 錯誤處理體系：自訂 Error 類別、重試與統一 HTTP 異常映射
category: error_handling
scope:
    - '**'
source_files:
    - miniprogram/src/utils/logger.ts
    - miniprogram/src/utils/retry.ts
    - miniprogram/src/llm/client.ts
    - miniprogram/src/core/scheduler.ts
    - miniprogram/src/llm/parser.ts
    - cloudrun/src/server.ts
---

## 1. 總體方法

本倉庫同時包含微信小程序前端（`miniprogram/`）與微信雲托管 Node.js 後端（`cloudrun/`），兩側採用不同的錯誤處理策略，但共享「自訂 Error 子類 + 結構化日誌」的約定。

- **小程序端**：使用 TypeScript `class XxxError extends Error` 定義領域錯誤類型，透過 `utils/logger.ts` 的 `error()` / `warn()` / `info()` 輸出帶品牌前綴 `[BRAND_NAME][LEVEL]` 的結構化日誌；業務層用 `try/catch` 捕獲並轉換為可讀訊息。沒有全局 middleware 或 panic/recover。
- **雲托管端**：基於 Node 內建 `http` 模組，無框架 middleware；在單一 `handle()` 函數中用一層 `try/catch` 統一捕獲所有 handler 異常，再根據 `e.message` 字串匹配映射到 HTTP 狀態碼（400/413/500）。

## 2. 關鍵檔案與套件

| 檔案 | 角色 |
|---|---|
| `miniprogram/src/utils/logger.ts` | 全域日誌工具，提供 `debug/info/warn/error` 四級別，`error()` 永遠輸出 |
| `miniprogram/src/utils/retry.ts` | 指數退避重試包裝器 `retry(fn, options)`，支援 `shouldRetry` / `onRetry` hook 與 `markRetryable` |
| `miniprogram/src/llm/client.ts` | 定義 `PlannerLLMError`，封裝 LLM 呼叫與解析失敗 |
| `miniprogram/src/core/scheduler.ts` | 定義 `SchedulerDeadlockError`，負責任務死鎖檢測與回滾 |
| `miniprogram/src/llm/parser.ts` | 定義 `LLMParserError`（用於 LLM 輸出解析失敗） |
| `cloudrun/src/server.ts` | 單一 `handle()` try/catch 作為 HTTP 異常入口，映射 `PAYLOAD_TOO_LARGE` / `INVALID_JSON` 等字串錯誤 |

## 3. 架構與慣例

### 3.1 自訂 Error 子類

小程序端以「領域導向」的方式定義錯誤類別，每個類別都覆寫 `this.name` 以便識別：

```ts
// miniprogram/src/llm/client.ts
export class PlannerLLMError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'PlannerLLMError';
  }
}

// miniprogram/src/core/scheduler.ts
export class SchedulerDeadlockError extends Error {
  constructor(public pending: Task[]) {
    super(`Deadlock detected: ${pending.length} tasks pending but none can proceed`);
    this.name = 'SchedulerDeadlockError';
  }
}
```

這些錯誤由上層 `orchestrator.ts` 捕獲並記錄：

```ts
catch (e) {
  logError('Orchestrator 異常', e);
}
```

### 3.2 開發環境降級（DEV fallback）

`llm/client.ts` 中的 `devFallbackReason(e)` 判斷是否觸發降級：當雲端 LLM 不可用（`LLMError` 且 message 含「不可用」，或 `CloudNetworkError` 且在開發環境）時，改用本地規則式規劃器 `rulePlan()` 返回兜底 Plan，僅記 `logWarn`，不向上拋出錯誤。這是一條明確的「預期路徑」，避免真實 LLM 故障被靜默掩蓋。

### 3.3 重試機制

`utils/retry.ts` 提供指數退避重試：

- 預設 `maxAttempts=3`、`baseDelayMs=500`、`maxDelayMs=5000`。
- 退避公式：`min(baseDelayMs * 2^(attempt-1), maxDelayMs) + ±25% 隨機抖動`，避免雪崩。
- 透過 `shouldRetry(err)` 決定是否重試，預設全部重試。
- `markRetryable(err, boolean)` 為第三方錯誤加上 `err.retryable` 標記，讓 `retry` 統一判斷。
- 每次重試前調用 `onRetry` hook（用於埋點）。
- 最終失敗時以 `logError` 輸出。

規範註明來源：`.qoder/rules/Agent.md § 9`。

### 3.4 任務級錯誤模型

`scheduler.ts` 的 `failTask()` 將任務錯誤標準化為結構：

```ts
t.result = {
  success: false,
  error: { code, message, retryable: false },
};
```

其中 `code` 是領域代碼（如 `BINDING_FAILED`、`USER_CANCELLED`、`RUN_CANCELLED`），`message` 是人讀訊息，`retryable` 指示是否可重試。下游依賴此 Task 的任務會透過 `cascadeSkip()` 遞迴標記為 `skipped`。

### 3.5 雲托管 HTTP 異常映射

`cloudrun/src/server.ts` 的 `handle()` 是唯一 try/catch 入口：

```ts
try {
  const body = await readBody(req);
  const result = await handler(body, ctx);
  sendJson(res, result.httpStatus, result.body);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  log(`${method} ${url} 異常：${msg}`);
  if (msg === 'PAYLOAD_TOO_LARGE') {
    sendJson(res, 413, { code: 413, message: '請求體過大（上限 1MB）' });
    return;
  }
  if (msg === 'INVALID_JSON') {
    sendJson(res, 400, { code: 400, message: '請求體必須為合法 JSON' });
    return;
  }
  sendJson(res, 500, { code: 500, message: '內部錯誤' });
}
```

`readBody()` 中以 `reject(new Error('PAYLOAD_TOO_LARGE'))` 和 `reject(new Error('INVALID_JSON'))` 拋出特定字串錯誤，再由 `handle()` 匹配映射為對應 HTTP 狀態碼。未匹配的錯誤一律回傳 500。

## 4. 觀察到的慣例與約束

- **日誌前綴固定**：`logger.ts` 強制所有日誌以 `[BRAND_NAME][LEVEL]` 開頭，便於聚合與品牌溯源（見文件頭註釋）。
- **utils 層不得 import wx\***：`logger.ts` 文件頭註明「規範（Agent.md § 12.3）：utils/ 層不得 import 'wx.*'」，確保純函式可單元測試。
- **錯誤分級**：`logger.error()` 永遠輸出（不受門檻限制），`warn`/`info`/`debug` 受 `setLogLevel()` 控制。
- **領域錯誤以 class 繼承 Error**：`PlannerLLMError`、`SchedulerDeadlockError`、`LLMParserError` 皆覆寫 `this.name`，方便調試。
- **HTTP 異常集中映射**：雲托管端所有 handler 異常由單一 `handle()` try/catch 捕獲，再以 `e.message` 字串匹配映射為 HTTP 狀態碼，而非使用自訂錯誤類別。
- **任務失敗統一結構**：所有任務失敗都經過 `failTask()` 產生 `{ success:false, error:{code,message,retryable} }`，供 Orchestrator 與 UI 層統一消費。
- **重試可插拔**：`retry()` 的 `shouldRetry` 與 `markRetryable()` 讓呼叫方決定哪些錯誤值得重試，避免盲目重試所有異常。
- **開發環境降級**：LLM 呼叫在開發/體驗環境遇到雲端不可用時自動降級至本地規則規劃器，僅記 `warn`，不中斷流程。
- **死鎖保護**：`scheduler.ts` 設定迭代次數上限（>1000 輪拋出普通 `Error`）並主動偵測死鎖拋出 `SchedulerDeadlockError`。