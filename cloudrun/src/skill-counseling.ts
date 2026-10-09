/**
 * 心理諮詢 / 情感陪伴 SKILL 端點（skill.mind.counseling）
 *
 * 端點（與小程序端 counseling SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.mind.counseling/chat_companion
 *   body: { message: string, history?: Array<{ role: 'user'|'assistant', content: string }> }
 *
 * 設計要點：
 *   1. System Prompt 由雲端統一維護（品牌調性：共情傾聽 + 積極反饋），
 *      迭代調優不需小程序發版重新提審——與 LLM API Key 僅存服務端
 *      同一理由（規範 § 8.3）
 *   2. 危機安全網：入口關鍵詞檢測命中時不走 LLM，直接返回確定性關懷
 *      文案 + 求助熱線——LLM 對危機場景的回覆不可控，固定文案最安全；
 *      詞表與小程序端 utils/counseling.ts 同步維護（跨包無法共享代碼）
 *   3. LLM 呼叫復用 llm-chat.ts 的 handleChat（OpenAI 相容轉發 + 逾時 +
 *      供應商 400 自適應重試）；其 503（未配置 / 上游失敗）轉為業務
 *      fail(503)（HTTP 200，不觸發小程序端網路層重試），小程序端以
 *      離線陪伴文案 mock 降級——陪伴不因基礎設施故障中斷
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest } from './api';
import { handleChat } from './llm-chat';

/**
 * 危機詞正則：自傷 / 自殺 / 輕生類表達（簡繁並列）
 *
 * 與小程序端 utils/counseling.ts 同款——雲端做最終把關（客戶端檢測
 * 可被繞過），修改詞表時兩端必須同步。
 */
const CRISIS_RE =
  /不想活|活不下去|活[著着]沒[有意價值意味]|沒有活下去|想不開|想不开|自殺|自杀|自殘|自残|輕生|轻生|結束(自己的)?生命|结束(自己的)?生命|了結自己|了结自己|[傷伤]害自己|想消失/;

/** 心理援助熱線（危機關懷統一出口，中國大陸 2025-05 起全國開通） */
const CRISIS_HOTLINE = {
  name: '全國心理援助熱線',
  phone: '12356',
  desc: '24 小時免費',
};

/** 危機關懷固定文案（guard 路徑，不經 LLM；與小程序端 CRISIS_GUARD_REPLY 同款） */
const CRISIS_GUARD_REPLY =
  '謝謝你把這麼沉重的感受告訴我，我很心疼現在的你。\n\n' +
  '你不是一個人，此刻就有專業的人在等你：\n' +
  `· ${CRISIS_HOTLINE.name} ${CRISIS_HOTLINE.phone}（24 小時免費）\n` +
  '· 緊急情況請直接撥打 120 或 110\n\n' +
  '也請告訴一位你信任的人，讓 TA 陪在你身邊。我一直在這裡，願意的話，繼續和我說說好嗎？';

/**
 * 陪伴對話 System Prompt（品牌調性核心）
 *
 * 設計取向：共情優先（先接住情緒再回應內容）+ 積極反饋（真誠肯定，
 * 不空洞吹捧）+ 明確邊界（不診斷 / 不開藥 / 危機引導熱線）+ 對話式
 * 簡短回覆（小程序氣泡場景，2~4 短段落）。語言跟隨用戶（簡繁自適應）。
 */
const COUNSELING_SYSTEM_PROMPT = `你是 MicroMate——用戶隨身的個人 AI 助理，此刻的角色是溫暖的傾聽者與陪伴者。

## 你的使命
1. 情感陪伴：用共情接住用戶的每一種情緒，讓 TA 感到被聽見、被理解。
2. 日常閒聊：像朋友一樣輕鬆自然地聊天，分享生活點滴。
3. 輕量心理疏導：幫用戶梳理情緒、轉換視角、放鬆身心。

## 對話原則
1. 共情優先：先回應情緒，再回應事情。多用反映式傾聽（「聽起來你……」「這確實讓人……」）。
2. 積極反饋：真誠肯定用戶的感受與努力（如「願意說出來，已經很勇敢了」）；不空洞吹捧、不敷衍。
3. 溫柔提問：以開放式問題邀請用戶多說一點（如「願意和我聊聊發生了什麼嗎？」），一次只問一個。
4. 簡短溫暖：口語化、親切自然，每次回覆 2~4 個短段落（像微信聊天）；不寫長文、不列條目、不說教。
5. 輕量疏導：需要時給一個自助小方法（如慢慢深呼吸四次、寫下此刻的心情、出門走十分鐘）；一次只給一個，不堆砌建議。

## 邊界（必須遵守）
1. 你不是醫生或心理治療師：不診斷疾病、不推薦藥物、不替代專業治療；用戶情緒困擾持續或加重時，溫柔建議尋求專業心理幫助。
2. 察覺用戶可能有傷害自己的念頭時：先表達關心與陪伴，再溫和地建議撥打心理援助熱線 12356（24 小時）或告訴信任的人；不驚慌、不說教、不中斷對話。
3. 不評判、不否定用戶的感受：禁止「這沒什麼大不了」「你想太多了」「別人比你更慘」。
4. 不追問住址、證件號、銀行卡等敏感個人信息。
5. 用戶想辦事（訂票 / 購物 / 預約 / 查詢等）時：溫柔說明你此刻在陪伴模式，建議直接說出具體需求（如「幫我查明天北京到上海的高鐵」）即可切換。

## 語言
- 跟隨用戶的語言：用戶用簡體你就回簡體，用繁體就回繁體。`;

/** 訊息長度上限（字元，與小程序端截斷對齊） */
const MAX_MESSAGE_CHARS = 2000;

/** 單條歷史長度上限（字元） */
const MAX_TURN_CHARS = 1000;

/** 歷史輪數上限（與小程序端 MAX_HISTORY_TURNS 對齊，防客戶端超量注入） */
const MAX_HISTORY_TURNS = 12;

/** 陪伴對話請求體 */
interface CompanionInput {
  message?: unknown;
  history?: unknown;
}

/** 歷史輪（窄化後） */
interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** 窄化歷史輪：僅收 user / assistant 且內容非空，截斷至單條上限 */
function sanitizeHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t): HistoryTurn | null => {
      const turn = t as { role?: unknown; content?: unknown } | null;
      if (!turn || (turn.role !== 'user' && turn.role !== 'assistant')) return null;
      if (typeof turn.content !== 'string' || !turn.content.trim()) return null;
      return { role: turn.role, content: turn.content.slice(0, MAX_TURN_CHARS) };
    })
    .filter((t): t is HistoryTurn => t !== null)
    .slice(-MAX_HISTORY_TURNS);
}

const handleChatCompanion: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CompanionInput;
  const message = typeof input.message === 'string' ? input.message.trim().slice(0, MAX_MESSAGE_CHARS) : '';
  if (!message) {
    return badRequest('message 必填且不可為空');
  }

  // 1. 危機守衛：固定文案即刻回應（不走 LLM——危機場景回覆必須確定性可控）
  if (CRISIS_RE.test(message)) {
    return ok({
      reply: CRISIS_GUARD_REPLY,
      crisis: true,
      source: 'guard',
      hotline: CRISIS_HOTLINE,
    });
  }

  // 2. System Prompt + 窄化歷史 + 本輪心聲 → LLM（復用 llm-chat 代理：
  //    生成型溫度 0.7，maxTokens 600 對應 2~4 短段落的氣泡體量）
  const messages = [
    { role: 'system', content: COUNSELING_SYSTEM_PROMPT },
    ...sanitizeHistory(input.history).map((t) => ({ role: t.role, content: t.content })),
    { role: 'user', content: message },
  ];
  const chatRes = await handleChat({ messages, temperature: 0.7, maxTokens: 600 }, ctx);
  if (chatRes.httpStatus !== 200 || chatRes.body.code !== 0) {
    // 未配置 / 上游失敗 → 業務 503（HTTP 200）：小程序端以離線陪伴文案
    // mock 降級，不觸發網路層重試（與 weather SKILL 同語義）
    return fail(503, chatRes.body.message ?? '陪伴對話服務暫不可用');
  }
  const text = ((chatRes.body.data as { text?: string } | undefined)?.text ?? '').trim();
  if (!text) {
    return fail(503, '陪伴對話回覆為空（上游異常）');
  }
  return ok({ reply: text, crisis: false, source: 'llm' });
};

export const counselingRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.mind.counseling/chat_companion', handleChatCompanion],
];
