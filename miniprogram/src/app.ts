/**
 * MicroMate Agent Runtime（編排層組裝）
 *
 * 規範來源：.qoder/rules/Agent.md § 15
 *
 * 此檔案位於 src/ 層，為**純模組**（頂層不得呼叫 App/Page）：
 *   1. 註冊所有 SKILL（9 域：出行 3 域 + 2026-10 回補的 6 域）
 *
 * 2026-10 六域回補（跳轉模式）：星巴克 / 網購商城 / 生活預約 / 演出票務 /
 * 心理諮詢 / 支付引導重新上架。個人主體拿不到真實交易 API（星巴克與
 * 美團開放平台僅面向企業資質 ISV、大麥 / 秀動無公開 API、微信支付個人
 * 主體不可開通），故寫操作一律降級為「需求卡 + 半屏跳轉官方小程序」
 * （wx.openEmbeddedMiniProgram，白名單未命中時自動普通跳轉 / 複製
 * 資訊），用戶在官方渠道內完成真實交易；諮詢域走雲端 LLM 真實對話；
 * 支付域重定義為「聚合收銀台引導」（拉取全域 pending_external 訂單
 * 逐單重建渠道跳轉包，無站內資金流）。
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
import { instance as mapTianditu } from './skills/builtin/map-tianditu/index';
import { instance as coffeeStarbucks } from './skills/builtin/coffee-starbucks/index';
import { instance as mcdonalds } from './skills/builtin/mcdonalds/index';
import { instance as coffeeLuckin } from './skills/builtin/coffee-luckin/index';
import { instance as rideDidi } from './skills/builtin/ride-didi/index';
import { instance as travelFliggy } from './skills/builtin/travel-fliggy/index';
import { instance as shoppingMall } from './skills/builtin/shopping-mall/index';
import { instance as bookingCenter } from './skills/builtin/booking-center/index';
import { instance as ticketShow } from './skills/builtin/ticket-show/index';
import { instance as counseling } from './skills/builtin/counseling/index';
import { instance as paymentAicard } from './skills/builtin/payment-aicard/index';
import { instance as deviceComm } from './skills/builtin/device-comm/index';
import { Orchestrator } from './core/orchestrator';
import { buildContext } from './core/context';
import { confirmPlan, awaitCheckpoint, setCheckpointSink } from './interaction/checkpoint';
import { ensureCloudInit, isDevEnv, LOCAL_RUN_BASE } from './services/cloud';
import { BRAND_NAME } from './types/brand';
import { info as logInfo, error as logError, setRemoteSink } from './utils/logger';
import { appendHistory } from './storage/session';
import { confirmProposal, dismissPendingMemory } from './storage/preferences';
import { confirmProfileSave, dismissProfileProposal } from './storage/profile-proposal';
import type { AgentResponse, AgentState, ProfileProposalEntry } from './types/agent-state';
import type { CheckpointCardPayload, CheckpointRespond } from './types/checkpoint';
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
 * 推模式閉環（2026-10 第二梯隊·項B）：授權成功 → 雲端白化登記
 * （/api/trip/remind/register，同步展開 wxa_ 天氣監控）→ 雲托管定時
 * 觸發器前一天推送（文案附天氣預報；雲端環變數 TRIP_REMIND_TMPL_ID
 * 須與此處同模板）。為空串時按鈕不渲染（配置驅動，不出現無效按鈕——
 * 「真實或誠實缺失，不演」）；一次性訂閱額度可經重複 tap 補充。
 */
export const SUBSCRIBE_TMPL_TRIP_REMIND = '';

/**
 * 餘票監控命中通知模板 ID（2026-10 第二梯隊·項A）
 *
 * 配置驅動與 SUBSCRIBE_TMPL_TRIP_REMIND 同款：為空串時首頁售罄車次行
 * 「監控」按鈕跳過授權彈窗直接創建（拉模式——命中狀態經行程頁刷新可見）；
 * 配置後 tap 時彈訂閱授權，雲端 tick 命中時經 subscribeMessage.send 推送
 * （推模式，需部署側配齊 WX_APPID / WX_APPSECRET / MONITOR_TMPL_ID）。
 */
export const SUBSCRIBE_TMPL_TICKET_MONITOR = '';

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
  /** 寫操作確認請求（第二梯隊·項C確認卡）：渲染確認卡，用戶點按後經
   * respond 回傳；僅 requiresHumanConfirm / 域級 confirm 檔位的任務觸發 */
  onCheckpointRequest?: (payload: CheckpointCardPayload, respond: CheckpointRespond) => void;
}

/** Agent Runtime：由 miniprogram/app.ts 於 onLaunch 建構並注入 globalData */
export interface AgentRuntime {
  /** 處理用戶意圖（語音已 STT 為文字） */
  handleIntent(intent: string): Promise<AgentResponse>;
  /** 確認記憶提議（確認卡「記住」按鈕）：UI 回傳卡面條目 → 長期偏好
   * 落盤（所見即所寫，不依賴 storage 中間態），下一輪規劃自動採用。
   * @returns 實際落盤的偏好鍵（空 = 無有效條目） */
  confirmMemory(entries: Array<{ key: string; value: string }>): string[];
  /** 拒絕記憶提議（確認卡「不用了」按鈕）：丟棄並記錄拒絕（同鍵同值不再重複提議） */
  dismissMemory(): void;
  /** 確認個人資料保存提議（確認卡「保存」按鈕，對話捕獲）：UI 回傳卡面
   * 條目 → 乘車人 / 地址落盤（所見即所寫；落盤前雙重校驗 + 查重，
   * 證號加密存於本機）。@returns 實際保存的條目標籤（空 = 無有效條目） */
  confirmProfileSave(entries: ProfileProposalEntry[]): string[];
  /** 拒絕個人資料保存提議（確認卡「不用了」按鈕）：丟棄（同鍵同值不再重複提議） */
  dismissProfileProposal(): void;
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
  // 2026-10 六域回補（跳轉模式）：咖啡 / 購物 / 預約 / 票務的寫操作為
  // 「需求卡 + 渠道跳轉」（星巴克 / 京東 / 美團 / 大麥收銀台完成真實交易）；
  // 諮詢域為雲端 LLM 真實對話；支付域為聚合收銀台引導（無站內資金流）。
  // 出行三域維持「真實數據源 + 官方渠道跳轉下單」鏈路不變。
  // 2026-10 設備通訊域：撥打電話 / 發郵件為本地設備能力（wx 原生 API
  // 經 services/device 封裝），零雲端呼叫，離線可用。
  SkillRegistry.register(train12306);
  SkillRegistry.register(flightVariflight);
  SkillRegistry.register(weatherQuery);
  SkillRegistry.register(mapTianditu);
  SkillRegistry.register(coffeeStarbucks);
  // 2026-10-14 麥當勞真實下單域：官方 MCP（open.mcd.cn）提供真實
  // create-order / cancel-order，訂單在麥當勞側真實創建、用戶掃碼支付，
  // 是首個突破「跳轉模式」的真實交易 SKILL
  SkillRegistry.register(mcdonalds);
  // 2026-10-14 瑞幸真實點單域：官方 AI 開放平台 MCP（gwmcp.lkcoffee.com），
  // 訂單在本人瑞幸賬號真實創建、掃碼支付；Token 未配置時降級跳轉模式
  SkillRegistry.register(coffeeLuckin);
  // 2026-10-14 滴滴打車域：官方 MCP（mcp.didichuxing.com）taxi_* 工具鏈，
  // 真實派單；叫車需確認彈窗（上游明令禁止自動下單）
  SkillRegistry.register(rideDidi);
  // 2026-10-14 飛豬旅行域：官方 FlyAI MCP（flyai.open.fliggy.com/mcp，
  // HMAC-SHA256 請求簽名），內置公共 Key 開箱即真實數據（體驗模式價格
  // 脫敏）；只讀搜索域（結構化酒店搜索 + AI 行程推薦），預訂在飛豬側完成
  SkillRegistry.register(travelFliggy);
  SkillRegistry.register(shoppingMall);
  SkillRegistry.register(bookingCenter);
  SkillRegistry.register(ticketShow);
  SkillRegistry.register(counseling);
  SkillRegistry.register(paymentAicard);
  SkillRegistry.register(deviceComm);
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

  // 確認卡轉發通道（項C觀察者反轉）：interaction 層的 checkpoint 請求經
  // sink 送到訂閱者（首頁）；多訂閱者時逐個轉發（respond 冪等，實際僅
  // 持確認卡渲染的頁面會消費），依賴方向保持 app → interaction 單向
  setCheckpointSink((payload, respond) => {
    for (const l of listeners) {
      l.onCheckpointRequest?.(payload, respond);
    }
  });

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

    /** 記憶確認卡回調：用戶點「記住」→ 以卡面條目落盤（分層記憶；
     * 確認數據由 UI 回傳——所見即所寫，不依賴 storage 中間態） */
    confirmMemory(entries: Array<{ key: string; value: string }>): string[] {
      const written = confirmProposal(entries);
      logInfo(written.length > 0 ? `記憶確認：已記住 ${written.join('、')}` : '記憶確認：無有效條目');
      return written;
    },

    /** 記憶確認卡回調：用戶點「不用了」→ 丟棄提議並記錄拒絕 */
    dismissMemory(): void {
      dismissPendingMemory();
      logInfo('記憶確認：用戶拒絕，已丟棄提議（同鍵同值不再重複詢問）');
    },

    /** 個人資料保存卡回調：用戶點「保存」→ 以卡面條目落盤（對話捕獲；
     * 確認數據由 UI 回傳——所見即所寫，storage 側防禦式校驗 + 查重） */
    confirmProfileSave(entries: ProfileProposalEntry[]): string[] {
      const saved = confirmProfileSave(entries);
      logInfo(saved.length > 0 ? `個人資料確認：已保存 ${saved.join('、')}` : '個人資料確認：無有效條目');
      return saved;
    },

    /** 個人資料保存卡回調：用戶點「不用了」→ 丟棄提議（同鍵同值不再重複詢問） */
    dismissProfileProposal(): void {
      dismissProfileProposal();
      logInfo('個人資料確認：用戶拒絕，已丟棄提議（同鍵同值不再重複詢問）');
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
