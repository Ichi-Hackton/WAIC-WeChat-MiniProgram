/**
 * 對話式引導頁（Agent.md「流程一：初次引導」）。
 *
 * - 一次只問一個問題；已答信息不再重複詢問（斷點恢復）；
 * - 自由輸入先經 sensitive-detector 識別：危機 → 停止流程、給心理支持；
 *   悲傷 → 溫柔回應後繼續；
 * - 全部回答完成 → 彙總面板 → 生成個性化清單並跳轉。
 */
import { CRISIS_RESPONSE, GRIEF_RESPONSES } from '../../knowledge';
import {
  GUIDE_STEPS,
  OPENING_FIRST,
  OPENING_RESUMED,
  applyAnswer,
  buildStepAck,
  buildSummary,
  getActiveStepIndex,
} from '../../utils/guidance-flow';
import type { ChatMessage, GuideProfile, GuideStep } from '../../utils/guidance-flow';
import { detectSensitive } from '../../utils/sensitive-detector';
import { emptyChecklistState, generateChecklist } from '../../utils/checklist-generator';
import { hideLoading, showLoading, toast } from '../../services/feedback';
import { goChecklistTab } from '../../services/navigation';
import {
  clearGuideSession,
  getGuideSession,
  saveChecklist,
  saveChecklistState,
  saveGuideSession,
} from '../../services/storage';

interface SelectDetail {
  value: string;
  label: string;
}

interface InputLikeEvent {
  detail: { value: string };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let msgSeq = 0;
function nextMsgId(): string {
  msgSeq += 1;
  return `m${Date.now()}_${msgSeq}`;
}

Page({
  data: {
    messages: [] as ChatMessage[],
    profile: {} as GuideProfile,
    inputVal: '',
    activeStep: null as GuideStep | null,
    isTyping: false,
    summaryReady: false,
    summaryText: '',
    scrollInto: '',
  },

  onLoad() {
    const session = getGuideSession();
    if (session && session.messages.length > 0) {
      this.setData({ messages: session.messages, profile: session.profile });
      if (session.finished) {
        void this.enterSummary();
      } else {
        void this.resume();
      }
    } else {
      void this.startFresh();
    }
  },

  /** 全新開始（或「重新填寫信息」） */
  async startFresh() {
    this.setData({
      messages: [],
      profile: {},
      summaryReady: false,
      summaryText: '',
      activeStep: null,
    });
    for (const line of OPENING_FIRST) {
      await this.agentSay(line);
    }
    this.askCurrent();
  },

  /** 斷點恢復：不重複已問過的問題 */
  async resume() {
    for (const line of OPENING_RESUMED) {
      await this.agentSay(line);
    }
    this.askCurrent();
  },

  /** Agent 發言：先展示「正在輸入」，再落氣泡（模擬陪伴感） */
  async agentSay(text: string, kind: 'normal' | 'crisis' = 'normal') {
    this.setData({ isTyping: true });
    await wait(320 + Math.min(text.length * 5, 500));
    const msg: ChatMessage = { id: nextMsgId(), role: 'agent', text, kind, ts: Date.now() };
    this.setData({
      messages: [...this.data.messages, msg],
      isTyping: false,
      scrollInto: msg.id,
    });
    this.persist();
  },

  pushUser(text: string) {
    const msg: ChatMessage = { id: nextMsgId(), role: 'user', text, ts: Date.now() };
    this.setData({
      messages: [...this.data.messages, msg],
      inputVal: '',
      scrollInto: msg.id,
    });
    this.persist();
  },

  persist() {
    saveGuideSession({
      messages: this.data.messages,
      profile: this.data.profile,
      finished: this.data.summaryReady,
    });
  },

  /** 推進到下一個未回答的問題；全部完成則進入彙總 */
  askCurrent() {
    const idx = getActiveStepIndex(this.data.profile);
    if (idx === -1) {
      void this.enterSummary();
      return;
    }
    const step = GUIDE_STEPS[idx];
    this.setData({ activeStep: step, summaryReady: false, summaryText: '' });
    void this.agentSay(step.question);
  },

  async enterSummary() {
    this.setData({
      summaryReady: true,
      summaryText: buildSummary(this.data.profile),
      activeStep: null,
    });
    this.persist();
    await this.agentSay('信息已齊。點擊下方按鈕，我會為您生成按時間段整理好的辦理清單。');
  },

  // ---------- 用戶輸入 ----------

  onChipSelect(e: WechatMiniprogram.CustomEvent<SelectDetail>) {
    if (this.data.isTyping || this.data.summaryReady) {
      return;
    }
    const { value, label } = e.detail;
    this.pushUser(label);
    const step = this.data.activeStep;
    if (step) {
      void this.applyStepAnswer(step, value, label);
    }
  },

  onInputVal(e: InputLikeEvent) {
    this.setData({ inputVal: e.detail.value });
  },

  onSendInput() {
    const text = this.data.inputVal.trim();
    if (!text || this.data.isTyping || this.data.summaryReady) {
      return;
    }
    this.pushUser(text);
    void this.handleFreeText(text);
  },

  /** 自由文本：先做敏感識別，再決定是否作為本步答案 */
  async handleFreeText(text: string) {
    const result = detectSensitive(text);
    if (result.level === 'crisis') {
      await this.handleCrisis();
      return;
    }
    const step = this.data.activeStep;
    if (!step) {
      return;
    }
    if (step.allowCustom) {
      if (result.level === 'grief') {
        await this.agentSay(GRIEF_RESPONSES[0]);
      }
      await this.applyStepAnswer(step, text, text);
      return;
    }
    if (result.level === 'grief') {
      await this.agentSay(GRIEF_RESPONSES[1]);
    } else {
      await this.agentSay('收到。這一步點選上方最接近的選項就好，不用打字。');
    }
    await this.agentSay(step.question);
  },

  /** 危機場景：立即停止流程指引，心理支持置於一切之上（Agent.md 緊急情況處理） */
  async handleCrisis() {
    await this.agentSay(CRISIS_RESPONSE[0]);
    await this.agentSay(CRISIS_RESPONSE[1], 'crisis');
    // 不推進步驟；用戶平復後可繼續點選選項或輸入
  },

  async applyStepAnswer(step: GuideStep, value: string, label: string) {
    const profile = applyAnswer(this.data.profile, step.key, value, label);
    this.setData({ profile });
    const ack = buildStepAck(step.key, value, label);
    await this.agentSay(ack);
    this.askCurrent();
  },

  // ---------- 生成清單 ----------

  async onGenerate() {
    if (this.data.isTyping) {
      return;
    }
    showLoading('正在為您整理清單…');
    await wait(700);
    const checklist = generateChecklist(this.data.profile);
    saveChecklist(checklist);
    saveChecklistState(emptyChecklistState());
    hideLoading();
    toast('清單已生成');
    await wait(500);
    goChecklistTab();
  },

  onRestart() {
    clearGuideSession();
    void this.startFresh();
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return {
      title: '身後事導航助手｜一步一步，把該辦的事辦好',
      path: '/pages/index/index',
    };
  },
});
