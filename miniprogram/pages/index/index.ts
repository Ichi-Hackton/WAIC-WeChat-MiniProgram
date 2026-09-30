/**
 * MicroMate 首頁 - Agent 對話介面
 *
 * 規範來源：.qoder/rules/Agent.md
 *
 * 此頁為 mini program 啟動後的首頁，提供：
 *   1. 對話歷史氣泡列表（新訊息自動捲動到底部）
 *   2. 文字輸入框 + 發送按鈕（loading 僅鎖發送，不鎖輸入）
 *   3. 麥克風按鈕（語音入口，MVP 提示使用文字輸入）
 *   4. 階段性狀態指示（understanding → planning → ... → completed）
 *   5. 任務進度卡片（訂閱 runtime 事件即時更新徽章狀態）
 *
 * 與 src/core 的關係：
 *   - 透過 getApp().globalData.agent（AgentRuntime）呼叫 Orchestrator
 *   - onLoad 訂閱 runtime 事件、onUnload 退訂，不直接 import core 內部
 */

import { BRAND_NAME, BRAND_TAGLINE, BRAND_AI_GENERATED_BY } from '../../src/types/brand';
import { info as logInfo, error as logError } from '../../src/utils/logger';
import type { AgentRuntime } from '../../src/app';
import type { AgentState } from '../../src/types/agent-state';
import type { Plan } from '../../src/types/plan';
import type { Task } from '../../src/types/task';

/** 對話訊息 */
interface ChatMessage {
  /** 訊息唯一 ID（wx:key 用，避免 timestamp 同毫秒碰撞） */
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** 附帶的渲染卡片（可選） */
  cards?: ChatCard[];
}

/** Agent 回應附帶的卡片 */
interface ChatCard {
  type: string;
  title: string;
  payload: Record<string, unknown>;
}

/** 頁面資料結構 */
interface HomePageData {
  brandName: string;
  brandTagline: string;
  messages: ChatMessage[];
  inputText: string;
  loading: boolean;
  state: string;
  /** 狀態中文文案（狀態列與 loading 氣泡共用） */
  stateLabel: string;
  /** scroll-into-view 錨點（自動捲動到最新訊息） */
  scrollIntoView: string;
  [key: string]: unknown;
}

/** Page 內部 this 實例 */
interface HomePageThis {
  data: HomePageData;
  setData: (patch: Partial<HomePageData>) => void;
  /** 訊息序號（生成遞增 ID 用） */
  msgSeq: number;
  /** runtime 事件退訂函數 */
  unsubscribe?: () => void;
  nextMsgId: () => string;
  appendMessage: (msg: ChatMessage) => void;
  onAgentStateChange: (state: AgentState) => void;
  onAgentPlanUpdate: (plan: Plan) => void;
  onAgentTaskUpdate: (task: Task) => void;
  dispatch: (intent: string) => Promise<void>;
  onSend: () => Promise<void>;
  onInput: (e: { detail: { value: string } }) => void;
  onTapExample: (e: { currentTarget?: { dataset?: { text?: string } } }) => Promise<void>;
  onTapReset: () => void;
}

/** Agent 回應形狀 */
interface AgentRespShape {
  message: string;
  state: string;
  cards?: ChatCard[];
  errorCode?: string;
}

/** AgentState → 中文階段文案（狀態列與 loading 氣泡共用） */
const STATE_LABELS: Record<string, string> = {
  idle: '待命中',
  understanding: '理解意圖中',
  planning: '拆解任務中',
  confirming_plan: '等待您確認計劃',
  executing: '執行任務中',
  awaiting_human: '等待您確認操作',
  aggregating: '彙總結果中',
  completed: '已完成',
  failed: '執行失敗',
  rolling_back: '回滾中',
};

/** TaskStatus → 進度卡片徽章文案 */
const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '排隊中',
  running: '執行中',
  waiting_human: '待確認',
  succeeded: '成功',
  failed: '失敗',
  rolled_back: '已回滾',
  skipped: '已跳過',
};

/** 取得 Agent Runtime（onLaunch 先於頁面 onLoad，防禦性判空） */
function getAgent(): AgentRuntime | null {
  const app = getApp() as unknown as { globalData?: { agent?: AgentRuntime } };
  return app?.globalData?.agent ?? null;
}

Page({
  data: {
    brandName: BRAND_NAME,
    brandTagline: BRAND_TAGLINE,
    messages: [] as ChatMessage[],
    inputText: '',
    loading: false,
    state: 'idle',
    stateLabel: STATE_LABELS.idle,
    scrollIntoView: '',
  } as HomePageData,

  onLoad(): void {
    const self = this as unknown as HomePageThis;
    self.msgSeq = 0;
    logInfo(`${BRAND_NAME} 首頁載入`);

    self.appendMessage({
      id: self.nextMsgId(),
      role: 'assistant',
      content: `你好，我是${BRAND_NAME}。${BRAND_TAGLINE}。\n\n你可以試試說：\n• 「明天北京到上海的高鐵」\n• 「附近有星巴克嗎」\n• 「幫我點一杯拿鐵」`,
      timestamp: Date.now(),
    });

    // 訂閱 Agent runtime 事件（狀態 / 計劃 / 任務進度 → UI 即時更新）
    const agent = getAgent();
    if (agent) {
      self.unsubscribe = agent.subscribe({
        onStateChange: (s) => self.onAgentStateChange(s),
        onPlanUpdate: (p) => self.onAgentPlanUpdate(p),
        onTaskUpdate: (t) => self.onAgentTaskUpdate(t),
      });
    } else {
      logError('Agent runtime 未就緒（globalData.agent 缺失），對話功能不可用');
    }
  },

  onUnload(): void {
    const self = this as unknown as HomePageThis;
    self.unsubscribe?.();
    self.unsubscribe = undefined;
  },

  /** 即時更新輸入框（受控元件；loading 期間允許繼續輸入下一條） */
  onInput(this: HomePageThis, e: { detail: { value: string } }): void {
    this.setData({ inputText: e.detail.value });
  },

  /** 發送按鈕 */
  async onSend(this: HomePageThis): Promise<void> {
    const text = (this.data.inputText ?? '').trim();
    if (!text || this.data.loading) return;
    this.setData({ inputText: '' });
    await this.dispatch(text);
  },

  /** 範例點選（開發體驗用） */
  async onTapExample(this: HomePageThis, e: { currentTarget?: { dataset?: { text?: string } } }): Promise<void> {
    const text = e.currentTarget?.dataset?.text;
    if (!text) return;
    await this.dispatch(text);
  },

  /** 麥克風按鈕（MVP 簡化：直接提示用戶使用文字輸入） */
  onTapMic(): void {
    wx.showModal({
      title: '語音輸入',
      content: 'MVP 階段請使用文字輸入；語音 STT 接入微信同聲傳譯插件後即可使用。',
      showCancel: false,
    });
  },

  /** 清空對話並重置 Agent */
  onTapReset(this: HomePageThis): void {
    getAgent()?.resetAgent();
    this.msgSeq = 0;
    this.setData({
      messages: [{
        id: 'msg_0',
        role: 'assistant',
        content: '對話已重置。',
        timestamp: Date.now(),
      }],
      state: 'idle',
      stateLabel: STATE_LABELS.idle,
      scrollIntoView: 'msg_0',
      loading: false,
    });
  },

  /** 內部：生成遞增訊息 ID */
  nextMsgId(this: HomePageThis): string {
    this.msgSeq += 1;
    return `msg_${this.msgSeq}`;
  },

  /** 內部：發送訊息給 Agent */
  async dispatch(this: HomePageThis, intent: string): Promise<void> {
    if (this.data.loading) return;

    // 1. 追加用戶訊息
    this.appendMessage({
      id: this.nextMsgId(),
      role: 'user',
      content: intent,
      timestamp: Date.now(),
    });

    this.setData({
      loading: true,
      state: 'understanding',
      stateLabel: STATE_LABELS.understanding,
    });

    try {
      const agent = getAgent();
      if (!agent) {
        throw new Error('Agent runtime 未就緒');
      }
      const res = (await agent.handleIntent(intent)) as AgentRespShape;

      // 2. 追加 Agent 回覆（任務進度已由計劃卡片即時展示，此處僅放聚合結論）
      this.appendMessage({
        id: this.nextMsgId(),
        role: 'assistant',
        content: res.message ?? `${BRAND_AI_GENERATED_BY} 已完成`,
        timestamp: Date.now(),
      });

      if (res.errorCode === 'BUSY') {
        wx.showToast({ title: '請等待當前任務完成', icon: 'none' });
      }

      const finalState = res.state ?? 'idle';
      this.setData({
        loading: false,
        state: finalState,
        stateLabel: STATE_LABELS[finalState] ?? finalState,
      });
    } catch (e) {
      logError('dispatch 失敗', e);
      this.appendMessage({
        id: this.nextMsgId(),
        role: 'assistant',
        content: `${BRAND_AI_GENERATED_BY}：系統異常，請稍後再試。`,
        timestamp: Date.now(),
      });
      this.setData({
        loading: false,
        state: 'failed',
        stateLabel: STATE_LABELS.failed,
      });
    }
  },

  /** runtime 事件：狀態機轉移 → 更新狀態列與 loading 氣泡文案 */
  onAgentStateChange(this: HomePageThis, state: AgentState): void {
    this.setData({ state, stateLabel: STATE_LABELS[state] ?? state });
  },

  /** runtime 事件：Plan 生成 → 追加計劃卡片訊息（徽章隨任務進度更新） */
  onAgentPlanUpdate(this: HomePageThis, plan: Plan): void {
    if (plan.tasks.length === 0) return;
    const cards: ChatCard[] = plan.tasks.map((t) => ({
      type: 'plan',
      title: t.summary ?? `${t.skillId}.${t.action}`,
      payload: {
        taskId: t.id,
        skill: `${t.skillId}.${t.action}`,
        status: t.status,
        statusLabel: TASK_STATUS_LABELS[t.status] ?? t.status,
        dependsOn: t.dependsOn,
      },
    }));
    this.appendMessage({
      id: this.nextMsgId(),
      role: 'assistant',
      content: `已生成執行計劃（${plan.tasks.length} 個任務），請在彈窗中確認：`,
      timestamp: Date.now(),
      cards,
    });
  },

  /** runtime 事件：任務狀態更新 → 就地更新對應進度卡片徽章 */
  onAgentTaskUpdate(this: HomePageThis, task: Task): void {
    const messages = this.data.messages.map((msg) => {
      if (!msg.cards?.length) return msg;
      const idx = msg.cards.findIndex(
        (c) => (c.payload as { taskId?: string }).taskId === task.id,
      );
      if (idx < 0) return msg;
      const cards = msg.cards.slice();
      cards[idx] = {
        ...cards[idx],
        payload: {
          ...cards[idx].payload,
          status: task.status,
          statusLabel: TASK_STATUS_LABELS[task.status] ?? task.status,
          ...(task.result?.error?.message ? { error: task.result.error.message } : {}),
        },
      };
      return { ...msg, cards };
    });
    this.setData({ messages });
  },

  /** 追加訊息到列表並自動捲動到底部 */
  appendMessage(this: HomePageThis, msg: ChatMessage): void {
    const messages = [...this.data.messages, msg];
    this.setData({ messages, scrollIntoView: msg.id });
  },
} as unknown as Parameters<typeof Page>[0]);
