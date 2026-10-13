/**
 * 心理諮詢 / 情感陪伴 SKILL（skill.mind.counseling）
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1；六環節擴展鏈路第 ③ 環
 *
 * 提供能力：
 *   - chat_companion ：陪伴對話（非任務型，NOT idempotent——每輪回覆皆新，無副作用故無需 rollback）
 *
 * 2026-10 六域回補上架。非任務型對話 SKILL 的差異維度：
 *   1. 純對話無寫操作：無需 x-wx-openid 鑒權與 rollback
 *   2. System Prompt 由雲端 skill-counseling.ts 統一維護（品牌調性：
 *      共情傾聽 + 積極反饋 + 明確邊界），此處只傳 message + history
 *   3. 危機詞短路在 rule-planner 業務域判定之前（安全優先），雲端
 *      另持同款詞表做最終把關（utils/counseling.ts 註釋）
 *   4. 多輪歷史經 orchestrator pushMessage → ctx.messages，此處抽取
 *      最近 12 輪 user / assistant 對回傳（與雲端 MAX_HISTORY_TURNS 對齊）
 *   5. 雲端 503（LLM 未配置 / 上游失敗）以離線陪伴文案降級——陪伴
 *      不因基礎設施故障中斷（與 weather SKILL 同語義）
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';

/** 歷史輪數上限（與雲端 MAX_HISTORY_TURNS 對齊，防客戶端超量注入） */
const MAX_HISTORY_TURNS = 12;

/** 單條訊息長度上限（字元，與雲端 MAX_MESSAGE_CHARS 截斷對齊） */
const MAX_MESSAGE_CHARS = 2000;

export interface ChatCompanionInput {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface ChatCompanionOutput {
  reply: string;
  crisis: boolean;
  source: 'guard' | 'llm' | 'offline';
}

/**
 * 離線陪伴文案（雲端不可用時的降級——不假裝在傾聽，如實告知並給出
 * 真實的求助出口；文案固定，確定性可控）
 */
const OFFLINE_REPLY =
  '抱歉，我此刻的陪伴服務暫時連不上（網路或服務波動），這不是你的問題。\n\n' +
  '如果此刻很難受，可以隨時撥打全國心理援助熱線 12356（24 小時免費）；緊急情況請直接撥打 120 或 110。\n\n' +
  '稍後再回來找我聊聊，我一直在。';

export const meta = {
  id: 'skill.mind.counseling',
  name: '心理諮詢 / 情感陪伴',
  description:
    '【能做】情感陪伴與日常傾訴（chat_companion：共情傾聽、輕量心理疏導、陪聊）。\n' +
    '【不能做】不能診斷疾病、不能推薦藥物、不能替代專業心理治療（危機時引導 12356 熱線）。\n' +
    '【觸發時機】用戶表達情緒（心情不好/難過/焦慮/壓力大/孤單）、想找人陪聊（陪我聊聊/說說話）時。',
  version: '1.0.0',
  owner: 'wx-micromate',
  tags: ['陪伴', '心理'],
  capabilities: [
    {
      action: 'chat_companion',
      description: '陪伴對話（多輪，回覆由雲端 LLM 生成並附 ai_generated 標識）',
      inputSchema: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', description: '用戶本輪心聲' },
          history: {
            type: 'array',
            description: '最近對話輪（由 SKILL 從 ctx.messages 自動抽取，規劃器無需提供）',
            items: { type: 'object' },
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['reply'],
        properties: {
          reply: { type: 'string' },
          crisis: { type: 'boolean' },
          source: { type: 'string' },
        },
      },
      // 對話類：每輪回覆皆新，不適用結果快取
      idempotent: false,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 2500,
    },
  ],
} as unknown as SkillMeta;

/**
 * 從會話歷史抽取最近 N 輪 user / assistant 對（供雲端多輪上下文）
 *
 * 過濾 system / tool 輪（雲端 System Prompt 自帶，注入會干擾人設）；
 * 卡片承載的 assistant 消息 content 為空串，一併略過。
 */
function extractHistory(ctx: AgentContext): Array<{ role: 'user' | 'assistant'; content: string }> {
  return ctx.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    if (action !== 'chat_companion') {
      return {
        success: false,
        error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
      };
    }
    const req = input as ChatCompanionInput;
    const message = req.message.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!message) {
      return {
        success: false,
        error: { code: 'EMPTY_MESSAGE', message: 'message 必填且不可為空', retryable: false },
      };
    }

    // 多輪歷史：規劃器未顯式攜帶時從 ctx.messages 抽取（單輪指令路徑
    // 的 rule-planner 只放 message 進 input）
    const history = req.history?.length ? req.history.slice(-MAX_HISTORY_TURNS) : extractHistory(ctx);

    const env = ctx.globals.cloudEnv as string;
    const res: CloudResponse<ChatCompanionOutput> = await postContainer<ChatCompanionOutput>(
      env,
      '/api/skill/skill.mind.counseling/chat_companion',
      { message, history },
      { sessionId: ctx.sessionId, retry: false },
    );
    if (res.code === 0 && res.data) return { success: true, data: res.data };
    // 雲端 503（業務碼，HTTP 200）：LLM 未配置 / 上游失敗 → 離線陪伴
    // 文案降級（不觸發網路層重試）；負數碼（雲基礎設施錯誤）同理降級
    if (res.code < 0 || res.code === 503) {
      return { success: true, data: { reply: OFFLINE_REPLY, crisis: false, source: 'offline' } };
    }
    return {
      success: false,
      error: { code: 'COMPANION_FAILED', message: res.message ?? '陪伴對話失敗', retryable: false },
    };
  },
};
