/**
 * MicroMate Agent Runtime（編排層組裝）
 *
 * 規範來源：.qoder/rules/Agent.md § 15
 *
 * 此檔案位於 src/ 層，為**純模組**（頂層不得呼叫 App/Page）：
 *   1. 註冊所有 SKILL（出行域：12306 火車票 / 飛常準機票 / 天氣查詢）
 *
 * 2026-10 技能收敛：星巴克 / 網購商城 / 生活預約 / 演出票務 / 心理諮詢 /
 * AI 卡支付六域下架（個人主體補不動真實交易渠道：星巴克與美團開放平台
 * 僅面向企業資質 ISV、大麥 / 秀動無公開 API、微信支付個人主體不可開通；
 * 購物域聯盟憑證未配置前演示商品亦屬假數據）。保留域全部為「查詢真實
 * 數據源 + 跳轉官方渠道下單」的個人可及鏈路；下架代碼見 git 歷史，
 * 企業主體與商務渠道就緒後按 SKILL 註冊架構回補即可。
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
import { instance as flightVariflight } from './skills/builtin/flight-variflight/index';
import { instance as weatherQuery } from './skills/builtin/weather-query/index';
import { Orchestrator } from './core/orchestrator';
import { buildContext } from './core/context';
import { confirmPlan, awaitCheckpoint } from './interaction/checkpoint';
import { ensureCloudInit, isDevEnv, LOCAL_RUN_BASE } from './services/cloud';
import { BRAND_NAME } from './types/brand';
import { info as logInfo, error as logError, setRemoteSink } from './utils/logger';
import { appendHistory } from './storage/session';
import type { AgentResponse, AgentState } from './types/agent-state';
import type { Plan } from './types/plan';
import type { Task } from './types/task';

/** 雲端環境 ID（MVP 寫死，實際應從 mini config 注入；匯出供頁面直接消費，如語音輸入） */
export const CLOUD_ENV = 'micromate-prod-001';

/**
 * 訂閱消息模板 ID（出發提醒；2026-10 產品評審 #4 複訪通道）
 *
 * 個人主體小程序可在後台「功能 → 訂閱消息」申請一次性模板（如「行程
 * 出發提醒」類）。申請通過後將模板 ID 填入此處，行程頁將出現「訂閱出發
 * 提醒」按鈕（tap 授權，微信要求必須由點擊動作觸發）。
 *
 * 為空串時按鈕不渲染（配置驅動，不出現無效按鈕——「真實或誠實缺失，
 * 不演」）。推送側（出發前一天）由雲托管定時觸發器調微信開放接口
 * subscribeMessage.send（雲托管容器內可免 access_token 直調）完成，
 * 屬部署側配置，模板 ID 就位後上線——授權鏈路本身真實可用。
 */
export const SUBSCRIBE_TMPL_TRIP_REMIND = '';

/**
 * 半屏跳轉白名單（2026-10 半屏升級：wx.openEmbeddedMiniProgram）
 *
 * 前置條件（缺一不可，均為部署側操作）：
 *   1. 小程序管理後台「設置 → 第三方設置 → 半屏小程序管理」向目標渠道
 *      （12306 / OTA）發起申請並獲通過（個人主體小程序能否獲官方大渠道
 *      審批需實測——不通過時微信自動降級普通跳轉，功能不斷裂）；
 *   2. EXTERNAL_JUMP 環境變數已配置對應渠道 appId（查詢 / 購票卡才會
 *      攜帶跳轉入口）；
 *   3. 通過後將該 appId 填入本清單（跳轉自動升級半屏，支付環節由渠道
 *      自行轉全屏——allowFullScreen，基礎庫 3.10.0 起強制 true）。
 *
 * 空清單 = 全部普通跳轉（現狀，零行為變化）；半屏 fail 時顯式降級
 * 普通跳轉再兜底提示（services/jump.ts），任何環境下單路徑不斷裂。
 */
export const EMBEDDED_JUMP_APPIDS: readonly string[] = [];

/** Runtime 對外事件監聽器（UI 訂閱用，全部可選） */
export interface AgentRuntimeEvents {
  /** 狀態機轉移（階段提示用） */
  onStateChange?: (state: AgentState) => void;
  /** 單一任務狀態更新（進度可視化用） */
  onTaskUpdate?: (task: Task) => void;
  /** Plan 生成 / 更新（計劃卡片渲染用） */
  onPlanUpdate?: (plan: Plan) => void;
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
}

/**
 * 確保 SKILL 已註冊（冪等）
 *
 * 註冊結果併入 createAgentRuntime 末尾的單條就緒日誌 —— 開發者工具中
 * 單條 console 輸出約 10-20ms，多條會直接推高建構耗時。
 */
function ensureSkillsRegistered(): void {
  if (SkillRegistry.size() > 0) return;
  // 2026-10 技能收敛：僅保留出行域三個「數據真實 + 個人主體可及」的 SKILL；
  // 支付發生在渠道側收銀台（跳轉模式），無需 AI 專屬卡。其餘六域回補
  // 條件見檔頂注釋。
  SkillRegistry.register(train12306);
  SkillRegistry.register(flightVariflight);
  SkillRegistry.register(weatherQuery);
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
  };

  logInfo(`${BRAND_NAME} Agent 引擎就緒：${SkillRegistry.size()} 個 SKILL 可調度（${SkillRegistry.listIds().join('、')}，cloud env=${cloudEnv}）`);
  return runtimeSingleton;
}
