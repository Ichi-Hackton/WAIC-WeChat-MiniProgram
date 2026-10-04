/**
 * MicroMate Agent Runtime（編排層組裝）
 *
 * 規範來源：.qoder/rules/Agent.md § 15
 *
 * 此檔案位於 src/ 層，為**純模組**（頂層不得呼叫 App/Page）：
 *   1. 註冊所有 SKILL（12306 / 星巴克 / 網購商城 / 生活預約 / AI 卡支付）
 *   2. 冪等初始化雲開發環境
 *   3. 建構 Orchestrator 並轉發狀態 / 任務 / 計劃事件供 UI 訂閱
 *   4. 暴露 handleIntent / resetAgent / getState 對外入口
 *
 * 與 miniprogram/app.ts 的關係（修正歷史缺陷）：
 *   - miniprogramRoot = miniprogram/，微信運行時只執行 miniprogram/app.ts
 *     的 App({...})；本檔案若呼叫 App() 永遠不會被執行，且會造成
 *     「重複註冊 App」風險。故本檔案僅匯出 createAgentRuntime，
 *     由 miniprogram/app.ts 於 onLaunch 注入 globalData.agent。
 *
 * 依賴方向：interaction → core → skills → llm（單向不可逆）
 */

import { SkillRegistry } from './skills/registry';
// 注意：微信運行時 require 不支援 Node 式目錄解析（不會自動補 /index.js），
// import 目錄模組必須顯式寫至 /index，否則編譯後報 module is not defined
import { instance as train12306 } from './skills/builtin/train-12306/index';
import { instance as starbucks } from './skills/builtin/coffee-starbucks/index';
import { instance as aiCard } from './skills/builtin/payment-aicard/index';
import { instance as shoppingMall } from './skills/builtin/shopping-mall/index';
import { instance as bookingCenter } from './skills/builtin/booking-center/index';
import { Orchestrator } from './core/orchestrator';
import { buildContext } from './core/context';
import { confirmPlan, awaitCheckpoint } from './interaction/checkpoint';
import { ensureCloudInit, getContainer, isDevEnv, LOCAL_RUN_BASE } from './services/cloud';
import { BRAND_NAME } from './types/brand';
import { info as logInfo, error as logError, setRemoteSink } from './utils/logger';
import { appendHistory } from './storage/session';
import type { AgentResponse, AgentState } from './types/agent-state';
import type { Plan } from './types/plan';
import type { Task } from './types/task';

/** 雲端環境 ID（MVP 寫死，實際應從 mini config 注入） */
const CLOUD_ENV = 'micromate-prod-001';

/** Runtime 對外事件監聽器（UI 訂閱用，全部可選） */
export interface AgentRuntimeEvents {
  /** 狀態機轉移（階段提示用） */
  onStateChange?: (state: AgentState) => void;
  /** 單一任務狀態更新（進度可視化用） */
  onTaskUpdate?: (task: Task) => void;
  /** Plan 生成 / 更新（計劃卡片渲染用） */
  onPlanUpdate?: (plan: Plan) => void;
}

/** LLM 接入狀態（GET /api/config 脫敏回應，供 UI 展示） */
export interface LlmStatus {
  configured: boolean;
  provider: string;
  model: string;
  baseUrl: string;
}

/** Agent Runtime：由 miniprogram/app.ts 於 onLaunch 建構並注入 globalData */
export interface AgentRuntime {
  /** 處理用戶意圖（語音已 STT 為文字） */
  handleIntent(intent: string): Promise<AgentResponse>;
  /** 重置 Agent（清空當前 Plan，保留會話上下文） */
  resetAgent(): void;
  /** 當前狀態機狀態（Orchestrator 未建立時為 idle） */
  getState(): AgentState;
  /** 當前 Plan（尚未開始或已重置時為 undefined） */
  getCurrentPlan(): Plan | undefined;
  /** 訂閱 runtime 事件；返回取消訂閱函數（頁面 onUnload 時呼叫） */
  subscribe(events: AgentRuntimeEvents): () => void;
  /** 查詢 LLM 接入狀態（雲端 /api/config 脫敏回應；離線時拋錯由呼叫方兜底） */
  getLlmStatus(): Promise<LlmStatus>;
}

/**
 * 確保 SKILL 已註冊（冪等）
 *
 * 註冊結果併入 createAgentRuntime 末尾的單條就緒日誌 —— 開發者工具中
 * 單條 console 輸出約 10-20ms，多條會直接推高建構耗時。
 */
function ensureSkillsRegistered(): void {
  if (SkillRegistry.size() > 0) return;
  SkillRegistry.register(train12306);
  SkillRegistry.register(starbucks);
  SkillRegistry.register(aiCard);
  SkillRegistry.register(shoppingMall);
  SkillRegistry.register(bookingCenter);
}

/** Runtime 單例（重複呼叫 createAgentRuntime 返回同一實例） */
let runtimeSingleton: AgentRuntime | null = null;

/**
 * 建構 Agent Runtime
 *
 * 冪等：首次呼叫完成 SKILL 註冊與雲端初始化，後續呼叫（含不同
 * cloudEnv 參數）一律返回首個實例 —— 微信小程序全生命週期僅應
 * 存在一個 Agent，多實例會導致 SKILL 註冊表與狀態機分裂。
 *
 * @param cloudEnv 雲端環境 ID，預設 CLOUD_ENV
 */
export function createAgentRuntime(cloudEnv: string = CLOUD_ENV): AgentRuntime {
  if (runtimeSingleton) return runtimeSingleton;

  // 開發環境注入日誌旁路 sink：logger 逐條上報本地雲托管 /api/dev-log
  // 落盤（自動化驗證取證用，徹底繞開開發者工具 Console 面板
  // 「Copy all messages 不可用 / OCR 轉錄漏行」的痛點）。
  // 僅 develop / trial 安裝；release 恆不注入，wx.request 旁路不進正式鏈路。
  // fire-and-forget：失敗靜默，日誌上報永不影響業務流程。
  if (isDevEnv()) {
    setRemoteSink((lv, msg) => {
      const wxApi = (globalThis as { wx?: { request?: (o: Record<string, unknown>) => void } }).wx;
      wxApi?.request?.({
        url: `${LOCAL_RUN_BASE}/api/dev-log`,
        method: 'POST',
        data: { level: lv, msg: msg.slice(0, 2000), ts: Date.now() },
        fail: () => undefined,
      });
    });
  }

  // 啟動日誌精簡為「末尾單條就緒日誌」：品牌啟動訊息已由
  // miniprogram/app.ts 的 onLaunch 日誌承擔，此處不再重複輸出 banner
  ensureSkillsRegistered();
  ensureCloudInit(cloudEnv);

  const listeners = new Set<AgentRuntimeEvents>();
  let orchestrator: Orchestrator | null = null;

  /** 建構（或復用） Orchestrator，事件統一轉發給訂閱者 */
  async function getOrchestrator(): Promise<Orchestrator> {
    if (orchestrator) return orchestrator;
    const ctx = await buildContext({ cloudEnv });
    orchestrator = new Orchestrator(ctx, {
      // 互動層實作於此注入（組裝層位於依賴鏈最頂層，方向合法）：
      // core 僅依賴 types/checkpoint 型別，不反向 import interaction（§ 12.3）
      confirmPlan,
      checkpoint: awaitCheckpoint,
      onStateChange: (s) => {
        for (const l of listeners) l.onStateChange?.(s);
      },
      onTaskUpdate: (t) => {
        for (const l of listeners) l.onTaskUpdate?.(t);
      },
      onPlanUpdate: (p) => {
        for (const l of listeners) l.onPlanUpdate?.(p);
      },
    });
    return orchestrator;
  }

  runtimeSingleton = {
    /**
     * 對外暴露的語音 / 文本入口
     *
     * @param intent 用戶自然語言意圖（語音已 STT 為文字）
     */
    async handleIntent(intent: string): Promise<AgentResponse> {
      try {
        logInfo(`handleIntent: "${intent.slice(0, 80)}"`);
        const orch = await getOrchestrator();
        const res = await orch.handle(intent);
        appendHistory({
          intent,
          timestamp: Date.now(),
          planId: orch.getCurrentPlan()?.id,
          state: res.state === 'completed' ? 'completed' : res.state === 'failed' ? 'failed' : 'cancelled',
        });
        return res;
      } catch (e) {
        logError('handleIntent 異常', e);
        return {
          message: `${BRAND_NAME}：系統異常，請稍後再試。`,
          state: 'failed',
          errorCode: 'UNEXPECTED',
        };
      }
    },

    /** 重置 Agent（給 UI 呼叫） */
    resetAgent(): void {
      if (orchestrator) {
        orchestrator.reset();
      }
      logInfo('Agent 已重置');
    },

    getState(): AgentState {
      return orchestrator?.getState() ?? 'idle';
    },

    getCurrentPlan(): Plan | undefined {
      return orchestrator?.getCurrentPlan();
    },

    subscribe(events: AgentRuntimeEvents): () => void {
      listeners.add(events);
      return () => {
        listeners.delete(events);
      };
    },

    /** 查詢 LLM 接入狀態（供首頁狀態列展示；失敗時由呼叫方顯示離線文案） */
    async getLlmStatus(): Promise<LlmStatus> {
      const res = await getContainer<{ llm: LlmStatus }>(cloudEnv, '/api/config', {
        retry: false,
        timeoutMs: 5_000,
      });
      if (res.code === 0 && res.data?.llm) {
        return res.data.llm;
      }
      throw new Error(res.message ?? 'LLM 配置查詢失敗');
    },
  };

  logInfo(`${BRAND_NAME} Agent 引擎就緒：${SkillRegistry.size()} 個 SKILL 可調度（${SkillRegistry.listIds().join('、')}，cloud env=${cloudEnv}）`);
  return runtimeSingleton;
}
