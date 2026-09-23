---
trigger: always_on
description: MicroMate 專案級 AI 代理指引——規範三層架構、SKILL 協議、狀態機、安全紅線、開發里程碑。
---

# Agent.md — MicroMate 專案級指引

> 本文件為 `MicroMate` 專案的最高層級指引，所有 AI 代理在參與此專案開發前，必須先閱讀並遵循本文規則。

## 1. 專案概述

`MicroMate` 是一個運行於微信小程序內的「**個人 AI 助理**」（Personal Agent Mate），負責：

- 理解用戶自然語言意圖
- 將意圖拆解為子任務的有向無環圖（DAG）
- 調度多個第三方小程序 **SKILL** 協作完成任務
- 透過 **AI 專屬卡** 完成支付閉環

| 項目 | 內容 |
|------|------|
| **品牌命名** | MicroMate ——「Micro」對應微信小程序的輕量化，「Mate」對應隨身個人助理定位 |
| **技術棧** | 原生微信小程序 + TypeScript 5.x（嚴格模式）+ 微信 AI 開發模式 + 微信雲開發 |
| **運行平台** | 微信小程序（用戶端）+ 微信雲開發容器（雲端） |
| **定位** | 跨小程序調度的**個人 AI 助理中樞**，不直接執行業務，僅調度標準化 SKILL |

### 1.1 核心能力鏈路

```
用戶自然語言輸入
    ↓
[ 意圖識別 & 任務拆解 ]
    ↓
[ SKILL 路由 & 編排 ]
    ↓
[ 並行/串行執行 ]
    ↓
[ 結果聚合 & 人類確認 ]
    ↓
[ AI 專屬卡支付閉環 ]
```

---

## 2. 核心設計原則

| 原則 | 說明 |
|------|------|
| **SKILL 優先** | Agent 不直接操作業務，只呼叫標準化 SKILL |
| **宣告式編排** | 任務以 DAG 描述依賴，引擎自動調度 |
| **Human-in-the-Loop** | 涉及支付、隱私、不可逆操作必須由用戶確認 |
| **冪等與可回滾** | 每個 SKILL 必須支援 `rollback`，失敗可部分撤銷 |
| **型別安全** | SKILL 入參/出參透過泛型強約束，禁止寬鬆型別 |

---

## 3. 三層架構

```
┌─────────────────────────────────────────┐
│  Layer 3: Interaction Layer (互動層)     │  語音 / 文本 / 卡片 UI
├─────────────────────────────────────────┤
│  Layer 2: Orchestration Layer (編排層)   │  意圖解析 → Plan → 調度 → 聚合
├─────────────────────────────────────────┤
│  Layer 1: SKILL Layer (能力層)           │  12306 SKILL / 星巴克 SKILL / ...
└─────────────────────────────────────────┘
```

依賴方向：`互動層 → 編排層 → 能力層`，**單向不可逆**，下層不得反向呼叫上層。

---

## 4. 目錄結構

```
src/
├── core/                    # Agent 核心引擎
│   ├── orchestrator.ts      # 編排器（狀態機）
│   ├── planner.ts           # 任務拆解器（呼叫 LLM）
│   ├── scheduler.ts         # DAG 調度器
│   └── context.ts           # 上下文管理
│
├── skills/                  # SKILL 註冊與適配
│   ├── registry.ts          # SKILL 註冊中心
│   ├── adapter.ts           # 統一呼叫適配器
│   └── builtin/             # 內建 SKILL
│       ├── train-12306/
│       ├── coffee-starbucks/
│       └── payment-aicard/
│
├── llm/                     # 大模型接入
│   ├── client.ts            # 統一 LLM 客戶端
│   ├── prompts/             # Prompt 模板
│   └── parser.ts            # 結構化輸出解析
│
├── interaction/             # 互動層
│   ├── voice.ts             # 語音輸入（微信同聲傳譯插件）
│   ├── card-render.ts       # 動態卡片渲染
│   └── checkpoint.ts        # 人類確認彈窗
│
├── storage/                 # 持久化
│   ├── session.ts           # 會話儲存
│   └── cache.ts             # SKILL 結果快取
│
├── types/                   # 全域型別定義
│   ├── skill.d.ts
│   ├── task.d.ts
│   ├── plan.d.ts
│   └── context.d.ts
│
└── utils/                   # 工具
    ├── logger.ts
    ├── retry.ts
    └── validator.ts
```

> **`utils/` 不得 `import 'wx.*'`**，保持純函式可單元測試；`services/`（對應 `interaction/`、`storage/`）為 wx API 唯一封裝層。

---

## 5. 狀態機

Agent 必須嚴格遵守以下狀態轉移，**禁止跳過 `confirming_plan`**：

```
idle
 ↓ (用戶輸入)
understanding ──(失敗)──▶ failed
 ↓ (成功)
planning ──(失敗)──▶ failed
 ↓ (生成 Plan)
confirming_plan ──(拒絕)──▶ idle
 ↓ (確認)
executing ──(需要人類)──▶ awaiting_human ──(確認)──▶ executing
 ↓                                              └──(拒絕)──▶ rolling_back
 ↓ (全部成功)
aggregating
 ↓
completed
```

### 5.1 AgentState 完整枚舉

```typescript
export type AgentState =
  | 'idle'              // 閒置，等待輸入
  | 'understanding'     // 意圖識別中
  | 'planning'          // 任務拆解中
  | 'confirming_plan'   // 等待用戶確認 Plan
  | 'executing'         // SKILL 執行中
  | 'awaiting_human'    // 等待人類確認（支付等）
  | 'aggregating'       // 結果聚合中
  | 'completed'         // 完成
  | 'failed'            // 失敗
  | 'rolling_back';     // 回滾中
```

---

## 6. 核心資料模型

### 6.1 SKILL 協議

```typescript
// src/types/skill.d.ts

/** SKILL 元資訊（給 LLM 閱讀理解用） */
export interface SkillMeta {
  id: string;                    // 全域唯一，如 "skill.train.12306"
  name: string;                  // 人類可讀名
  description: string;           // LLM 可讀描述（規劃的關鍵依據！）
  version: string;
  owner: string;                 // 所屬小程序 appid
  tags: string[];                // 如 ["出行", "交通"]
  capabilities: SkillCapability[];
}

export interface SkillCapability {
  action: string;                // 如 "search_train", "book_ticket"
  description: string;
  inputSchema: JSONSchema;       // 入參 JSON Schema
  outputSchema: JSONSchema;      // 出參 JSON Schema
  idempotent: boolean;           // 是否冪等
  reversible: boolean;           // 是否可回滾
  requiresHumanConfirm: boolean; // 是否需要人類確認
  estimatedLatencyMs: number;    // 預估延遲
}

export interface SkillInstance {
  meta: SkillMeta;
  invoke(capability: string, input: unknown, ctx: AgentContext): Promise<SkillResult>;
  rollback?(capability: string, input: unknown, result: SkillResult, ctx: AgentContext): Promise<void>;
}

export interface SkillResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; retryable: boolean };
  bindings?: Record<string, unknown>;  // 供後續 SKILL 引用的輸出綁定
}
```

### 6.2 Task 與 Plan

```typescript
// src/types/task.d.ts
export type TaskStatus =
  | 'pending' | 'running' | 'waiting_human'
  | 'succeeded' | 'failed' | 'rolled_back' | 'skipped';

export interface Task {
  id: string;                    // 如 "task_001"
  skillId: string;               // 關聯的 SKILL
  action: string;                // 呼叫的 capability
  input: Record<string, unknown>;
  /** 跨 Task 資料流引用：支援點號路徑（如 "data.trainNo"） */
  inputBindings?: {
    [paramName: string]: { fromTaskId: string; fromField: string };
  };
  /** 依賴的前置 Task */
  dependsOn: string[];
  status: TaskStatus;
  result?: SkillResult;
  startedAt?: number;
  finishedAt?: number;
  retryCount: number;
}

// src/types/plan.d.ts
export interface Plan {
  id: string;
  intent: string;                // 用戶原始意圖
  tasks: Task[];
  createdAt: number;
  status: 'draft' | 'confirmed' | 'executing' | 'done' | 'failed';
}
```

### 6.3 AgentContext

```typescript
// src/types/context.d.ts
export interface AgentContext {
  sessionId: string;
  userId: string;
  /** 用戶畫像（用於 LLM 推理） */
  userProfile: {
    location?: { lat: number; lng: number; city: string };
    preferences: Record<string, unknown>;
    history: Array<{ intent: string; timestamp: number }>;
  };
  /** 當前 Plan */
  plan?: Plan;
  /** 全域變數（如當前時間、天氣） */
  globals: Record<string, unknown>;
  /** 會話歷史（用於多輪對話） */
  messages: ChatMessage[];
  /** 追蹤資訊 */
  trace: {
    llmCalls: number;
    skillCalls: number;
    totalTokens: number;
    startTime: number;
  };
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}
```

---

## 7. SKILL 開發規範

### 7.1 必要實作

每個 SKILL **必須**：

1. 提供 `meta`，其中 `description` 必須清楚描述「能做什麼 / 不能做什麼 / 何時觸發」（這是 LLM 規劃的唯一依據）
2. 實作 `invoke(capability, input, ctx)`
3. 若 `reversible=true`，**必須**實作 `rollback(capability, input, result, ctx)`
4. 所有寫操作 capability 的 `requiresHumanConfirm` 必須為 `true`
5. 透過 `wx.cloud.callContainer` 呼叫雲端能力，禁止在小程序端直接對接第三方 API

### 7.2 標準骨架

```typescript
// src/skills/builtin/xxx/index.ts
import type { SkillInstance, SkillMeta } from '../../../types/skill';

export const meta: SkillMeta = {
  id: 'skill.xxx',
  name: '...',
  description: '...',   // 給 LLM 看，務必清晰
  version: '1.0.0',
  owner: 'wx-appid',
  tags: [...],
  capabilities: [{
    action: '...',
    description: '...',
    inputSchema:  { /* JSON Schema */ },
    outputSchema: { /* JSON Schema */ },
    idempotent: true | false,
    reversible: true | false,
    requiresHumanConfirm: true | false,  // 寫操作必須為 true
    estimatedLatencyMs: 1000,
  }],
};

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx) {
    return wx.cloud.callContainer({
      config: { env: ctx.globals.cloudEnv as string },
      path: `/api/skill/${meta.id}/${action}`,
      method: 'POST',
      data: input,
    });
  },
  async rollback(action, input, result, ctx) {
    // 必須實作可逆邏輯
  },
};
```

### 7.3 命名與註冊

- SKILL ID 格式：`skill.{domain}.{app}`（例：`skill.train.12306`、`skill.coffee.starbucks`）
- 註冊位置：`src/skills/builtin/<name>/index.ts`，並在 `app.ts` 透過 `SkillRegistry.register()` 注入

---

## 8. 編排器實作要點

### 8.1 Orchestrator

- **必須以狀態機驅動**，禁止跳過 `confirming_plan`
- Plan 必須透過 `wx.showModal` 取得用戶確認才可進入 `executing`
- 失敗時**必須**呼叫 `rollbackIfNeeded()`，按反序撤銷已成功的 Task
- Plan 摘要渲染：列出每個 Task 的 `skillId` + `action`，供用戶檢視

### 8.2 Scheduler（DAG 調度）

- 每輪找出所有 `dependsOn` 已完成且狀態為 `pending` 的 Task
- **並行執行**所有就緒的 Task（`Promise.all`）
- **死鎖偵測**：`ready.length === 0 && running.size === 0` 時拋出 `Deadlock detected: no task can proceed`
- `inputBindings` 解析：支援點號路徑（如 `data.userLocation.lat`）
- 寫操作前先檢查 `requiresHumanConfirm`，若為 `true` 則進入 `waiting_human` 等待用戶確認

### 8.3 Planner（LLM 任務拆解）

- 必須傳入 `availableSkills` 列表（簡化版 meta）給 LLM
- Prompt 必須包含：用戶上下文（位置、時間、偏好）、可用 SKILL、用戶意圖
- LLM 輸出**必須**以正則 `/\{[\s\S]*\}/` 抽取 JSON，否則拋錯
- 期望回傳結構：
  ```json
  {
    "tasks": [
      {
        "skillId": "skill.xxx",
        "action": "xxx",
        "input": { ... },
        "inputBindings": { "param": { "fromTaskId": "task_001", "fromField": "data.xxx" } },
        "dependsOn": []
      }
    ]
  }
  ```
- 無依賴的任務可並行（`dependsOn: []`）

---

## 9. 錯誤處理策略

| 錯誤類型 | 處理方式 |
|---------|---------|
| **可重試錯誤**（網路、限流） | 指數退避，最多 3 次 |
| **業務錯誤**（無票、售罄） | 回傳給 LLM 讓其調整 Plan |
| **不可恢復錯誤** | 觸發 `rollback`，按反序撤銷已成功的任務 |
| **LLM 輸出解析失敗** | 進入 `failed`，提示用戶重新描述意圖 |

---

## 10. 安全與合規紅線

> ⚠️ **以下為不可妥協的底線，AI 代理在變更時必須顯式說明依據。**

| 風險點 | 紅線要求 |
|--------|---------|
| LLM 幻覺導致錯誤下單 | 所有寫操作必須 `requiresHumanConfirm: true` |
| SKILL 越權呼叫 | 每個 SKILL 獨立鑒權，Agent 只持有呼叫令牌 |
| 用戶隱私洩露 | Context **不跨會話持久化**，敏感欄位加密儲存 |
| 支付金額異常 | 支付前強制展示明細，金額 > 閾值需二次確認 |
| 生成式 AI 合規 | 所有 LLM 輸出添加 `ai_generated` 標識，符合《生成式人工智能服務管理暫行辦法》 |

---

## 11. 微信 AI 開發模式接入

### 11.1 `app.json` 宣告

```json
{
  "ai": {
    "mode": "development",
    "skills": ["skill.train.12306", "skill.coffee.starbucks"]
  }
}
```

### 11.2 呼叫第三方 SKILL

```typescript
wx.cloud.callContainer({
  config: { env: 'prod-xxx' },
  path: '/ai/skill/invoke',
  method: 'POST',
  data: {
    skillId: 'skill.train.12306',
    action: 'search_train',
    input: { from: '北京', to: '上海', date: '2026-09-24' },
  },
});
```

### 11.3 AI 專屬卡支付

```typescript
wx.requestPayment({
  provider: 'ai_card',          // 微信 AI 專屬卡
  timeStamp: String(Date.now()),
  orderIds,                     // 多個子訂單合併支付
  agentSessionId: ctx.sessionId,
  success: resolve,
  fail: reject,
});
```

---

## 12. 程式碼規範

### 12.1 註解與文件

- **全部註解、文件、識別符外的字串均使用繁體中文**
- 公開 API 必須有 JSDoc 註解
- 複雜演算法必須在 `.ts` 內以區塊註解說明設計理由

### 12.2 型別約束

- **禁止 `any`**；必要時使用 `unknown` 並做窄化
- SKILL 介面優先使用泛型約束
- JSON Schema 用於跨 SKILL 資料交換與 LLM 輸出驗證

### 12.3 模組依賴

- `utils/` 不得 `import 'wx.*'`，保持純函式可單元測試
- `services/` 為 wx API 唯一封裝層
- 依賴方向：`interaction → core → skills → llm`，單向不可逆

### 12.4 命名

| 對象 | 格式 | 範例 |
|------|------|------|
| SKILL ID | `skill.{domain}.{app}` | `skill.train.12306` |
| Task ID | `task_NNN`（三位數補零） | `task_001` |
| Plan ID | `plan_{timestamp}` | `plan_1737620792400` |
| AgentState | 全小寫蛇形 | `awaiting_human` |

---

## 13. 開發里程碑

| 階段 | 週期 | 目標 |
|------|------|------|
| **M1 - 單 SKILL 跑通** | 1 週 | 接入 12306 SKILL，完成「查高鐵 → 確認 → 下單」單鏈路 |
| **M2 - 雙 SKILL 並行** | 1 週 | 加入星巴克 SKILL，實現 DAG 並行調度 |
| **M3 - 自然語言入口** | 1 週 | 接入語音識別 + Planner，支援一句話觸發 |
| **M4 - 支付閉環** | 3 天 | 接入 AI 專屬卡，完成合併支付 |
| **M5 - 灰度上線** | 持續 | 邀請 100 名內測用戶，收集 Case 優化 Prompt |

---

## 14. 提交前驗證清單

每次變更提交前，AI 代理必須逐項確認：

- [ ] TypeScript 編譯無錯誤（`tsc --noEmit`）
- [ ] 所有 SKILL 的 `requiresHumanConfirm` 設定正確（寫操作必為 `true`）
- [ ] 寫操作的 SKILL 已實作 `rollback`
- [ ] Prompt 模板更新時同步更新測試案例
- [ ] 新增的 LLM 輸出結構已加入 `parser.ts` 的 schema 驗證
- [ ] LLM 生成內容已加入 `ai_generated` 標記
- [ ] 依賴方向未發生反向引用

---

## 15. 最小可運行範例（`app.ts`）

```typescript
import { Orchestrator } from './core/orchestrator';
import { SkillRegistry } from './skills/registry';
import { instance as train12306 } from './skills/builtin/train-12306';
import { instance as starbucks } from './skills/builtin/coffee-starbucks';

// 註冊 SKILL
SkillRegistry.register(train12306);
SkillRegistry.register(starbucks);

App({
  onLaunch() {
    console.log('[App] Agent ready');
  },
  globalData: {
    async handleVoice(text: string) {
      const ctx = buildContext();
      const agent = new Orchestrator(ctx);
      const res = await agent.handle(text);
      wx.showToast({ title: res.message });
    },
  },
});
```

---

> **文件維護**：本文件隨專案演進持續更新；任何重大架構變更必須同步修訂本文件並在 PR 中說明依據。
