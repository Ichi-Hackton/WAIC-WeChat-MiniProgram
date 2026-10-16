/**
 * 健康顧問 SKILL（skill.health.advisor）
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1；檔位模型 § 2.1（T1 告知 / T2 建議）
 *
 * 提供能力（全為純生成查詢，無寫操作、無資金流，故無需 rollback）：
 *   - symptom_triage：症狀分診與就醫指引（T2 建議——給出就醫傾向與理由，
 *     決策留用戶；NOT idempotent——每輪生成皆新，防結果快取命中舊值）
 *   - report_explain：化驗 / 體檢報告通俗解讀（T1 告知 + T2 復診建議）
 *   - med_info：藥品通識查詢（T1 告知；不提供劑量與個性化用藥指導）
 *
 * 設計要點（與 counseling SKILL 同構，參考 awesome-medical-ai-skills-cn /
 * OpenClaw-Medical-Skills 的家庭醫生 / 報告解讀 / 藥品通識三方向）：
 *   1. 醫療紅線：不診斷疾病、不推薦藥物、不替代就醫；System Prompt 由
 *      雲端 skill-health.ts 統一維護，輸出統一附雲端下發的 disclaimer
 *   2. 急症安全網：規劃層短路（utils/health.ts，不依賴雲端）+ 雲端三端點
 *      入口守衛（mode:'guard' 確定性急診文案，不經 LLM）雙保險
 *   3. 雲端 503（LLM 未配置 / 上游失敗）以離線引導文案降級——不編造
 *      分診結論，引導線下就醫 / 諮詢藥師（真實或誠實缺失，不演）
 *   4. 就近就醫（附近醫院 / 藥店）不在此 SKILL：由 skill.map.tianditu 的
 *      search_poi 承接；triage 輸出的 departments 可供規劃器綁定地圖搜索
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';

/** 症狀描述長度上限（字元，與雲端截斷對齊） */
const MAX_SYMPTOM_CHARS = 2000;

/** 報告文本長度上限（字元，與雲端對齊） */
const MAX_REPORT_CHARS = 3000;

/** 藥品名長度上限（字元，與雲端對齊） */
const MAX_DRUG_CHARS = 100;

/** 歷史輪數上限（與雲端 MAX_HISTORY_TURNS 對齊，防客戶端超量注入） */
const MAX_HISTORY_TURNS = 12;

/** 單條訊息長度上限（字元，與雲端 MAX_TURN_CHARS 對齊） */
const MAX_TURN_CHARS = 1000;

/** 分診離線文案（服務不可用時引導線下就醫，不編造分診結論） */
const TRIAGE_OFFLINE_REPLY =
  '抱歉，症狀分診服務暫時連不上（網路或服務波動）。\n\n' +
  '若症狀持續加重，或出現胸痛、呼吸困難、意識不清等情況，請直接前往急診或撥打 120，不要等待線上服務。';

/** 報告解讀離線文案（引導以報告單與醫生解讀為準） */
const REPORT_OFFLINE_REPLY =
  '抱歉，報告解讀服務暫時連不上（網路或服務波動）。\n\n' +
  '請先以報告單上標注的參考範圍為準；指標明顯異常或有「複查 / 就診」提示時，及早就診請醫生解讀。';

/** 藥品通識離線文案（引導以說明書 / 藥師為準） */
const MED_OFFLINE_REPLY =
  '抱歉，藥品通識服務暫時連不上（網路或服務波動）。\n\n' +
  '請以藥品說明書為準，或諮詢醫師 / 藥師；急性情況請直接就醫。';

export interface SymptomTriageInput {
  symptoms: string;
  duration?: string;
  age?: number;
  sex?: 'male' | 'female';
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** 分診輸出（structured / text / guard 三形態，與雲端契約對齊） */
export interface TriageOutput {
  mode: 'structured' | 'text' | 'guard';
  urgency?: 'emergency' | 'urgent_care' | 'routine' | 'self_care';
  urgencyLabel?: string;
  departments?: string[];
  possibility?: string;
  advice?: string;
  redFlags?: string[];
  reply?: string;
  disclaimer?: string;
}

export interface ReportExplainInput {
  reportText: string;
}

export interface ReportItem {
  name: string;
  value: string;
  unit: string;
  status: 'normal' | 'high' | 'low' | 'abnormal';
  meaning: string;
}

export interface ReportOutput {
  mode: 'structured' | 'text' | 'guard';
  items?: ReportItem[];
  summary?: string;
  followUp?: string;
  reply?: string;
  disclaimer?: string;
}

export interface MedInfoInput {
  drugName: string;
}

export interface MedOutput {
  mode: 'structured' | 'text' | 'guard';
  drugName?: string;
  category?: string;
  commonUses?: string[];
  keyNotes?: string[];
  uncertainty?: string;
  reply?: string;
  disclaimer?: string;
}

export const meta = {
  id: 'skill.health.advisor',
  name: '健康顧問（分診 / 報告解讀 / 藥品通識）',
  description:
    '【能做】症狀分診與就醫指引（symptom_triage：按症狀評估就醫緊迫度——立即急診/24小時內/擇期門診/居家觀察，並推薦就診科室 departments，輸出可直接作為地圖搜索 search_poi 的關鍵詞綁定，如「兒科醫院」）；化驗/體檢報告通俗解讀（report_explain：逐項解釋指標含義、標注偏高偏低、給出復查建議）；藥品通識查詢（med_info：藥品類別/常見用途/一般注意事項，不做劑量與個性化指導）。\n' +
    '【不能做】不能診斷疾病、不能推薦或評價用藥方案、不能替代醫生診療（「該吃什麼藥」一律引導遵醫囑/諮詢藥師；急症表達由安全網短路到 120 引導）。\n' +
    '【觸發時機】用戶描述身體症狀並疑問是否就醫/掛什麼科（如「發燒頭痛要去醫院嗎」）、提供化驗/體檢指標求解讀（如「白細胞11.5是什麼意思」）、詢問藥品通識（如「阿莫西林是什麼藥」）時。',
  version: '1.0.0',
  owner: 'wx-micromate',
  tags: ['健康', '醫療'],
  capabilities: [
    {
      action: 'symptom_triage',
      description: '症狀分診與就醫指引（回覆由雲端 LLM 生成並附 ai_generated 標識與免責聲明；急症詞命中時走 guard 固定文案）',
      inputSchema: {
        type: 'object',
        required: ['symptoms'],
        properties: {
          symptoms: { type: 'string', description: '用戶症狀描述原文' },
          duration: { type: 'string', description: '症狀持續時間（口語原文，如「三天」）' },
          age: { type: 'number', description: '患者年齡（上下文可得時透傳）' },
          sex: { type: 'string', description: 'male / female（上下文可得時透傳）' },
          history: {
            type: 'array',
            description: '最近對話輪（由 SKILL 從 ctx.messages 自動抽取，規劃器無需提供）',
            items: { type: 'object' },
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { type: 'string', description: 'structured / text / guard' },
          urgency: { type: 'string', description: 'emergency / urgent_care / routine / self_care' },
          urgencyLabel: { type: 'string' },
          departments: { type: 'array', items: { type: 'string' }, description: '推薦科室（可供地圖搜索綁定）' },
          possibility: { type: 'string' },
          advice: { type: 'string' },
          redFlags: { type: 'array', items: { type: 'string' } },
          reply: { type: 'string', description: 'text 降級形態的回覆全文' },
          disclaimer: { type: 'string' },
        },
      },
      // 生成式：每輪分診結論皆新，不適用結果快取
      idempotent: false,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 3000,
    },
    {
      action: 'report_explain',
      description: '化驗 / 體檢報告通俗解讀（輸出逐項含義與復查建議，附 ai_generated 標識與免責聲明）',
      inputSchema: {
        type: 'object',
        required: ['reportText'],
        properties: {
          reportText: { type: 'string', description: '化驗 / 體檢指標文本（用戶原文照抄）' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { type: 'string', description: 'structured / text / guard' },
          items: {
            type: 'array',
            description: '逐項解讀（status: normal / high / low / abnormal）',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
                unit: { type: 'string' },
                status: { type: 'string' },
                meaning: { type: 'string' },
              },
            },
          },
          summary: { type: 'string' },
          followUp: { type: 'string' },
          reply: { type: 'string' },
          disclaimer: { type: 'string' },
        },
      },
      idempotent: false,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 3000,
    },
    {
      action: 'med_info',
      description: '藥品通識查詢（類別 / 常見用途 / 一般注意事項；不提供劑量建議，附 ai_generated 標識與免責聲明）',
      inputSchema: {
        type: 'object',
        required: ['drugName'],
        properties: {
          drugName: { type: 'string', description: '藥品名（用戶原文）' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: { type: 'string', description: 'structured / text / guard' },
          drugName: { type: 'string' },
          category: { type: 'string' },
          commonUses: { type: 'array', items: { type: 'string' } },
          keyNotes: { type: 'array', items: { type: 'string' } },
          uncertainty: { type: 'string' },
          reply: { type: 'string' },
          disclaimer: { type: 'string' },
        },
      },
      idempotent: false,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 3000,
    },
  ],
} as unknown as SkillMeta;

/**
 * 從會話歷史抽取最近 N 輪 user / assistant 對（供分診多輪上下文）
 *
 * 與 counseling SKILL 的抽取同款：過濾 system / tool 輪（雲端 System
 * Prompt 自帶，注入會干擾邊界約束）；卡片承載的 assistant 消息 content
 * 為空串，一併略過
 */
function extractHistory(ctx: AgentContext): Array<{ role: 'user' | 'assistant'; content: string }> {
  return ctx.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0)
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, MAX_TURN_CHARS) }));
}

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    if (action !== 'symptom_triage' && action !== 'report_explain' && action !== 'med_info') {
      return {
        success: false,
        error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
      };
    }
    const env = ctx.globals.cloudEnv as string;

    // ---- symptom_triage：症狀分診 ----
    if (action === 'symptom_triage') {
      const req = input as SymptomTriageInput;
      const symptoms = (req.symptoms ?? '').trim().slice(0, MAX_SYMPTOM_CHARS);
      if (!symptoms) {
        return {
          success: false,
          error: { code: 'EMPTY_SYMPTOMS', message: 'symptoms 必填且不可為空', retryable: false },
        };
      }
      // 多輪歷史：規劃器未顯式攜帶時從 ctx.messages 抽取（急症檢測由雲端
      // 對本輪症狀與歷史一併把關，此處不重複檢測——規劃層已有第一道短路）
      const history = req.history?.length ? req.history.slice(-MAX_HISTORY_TURNS) : extractHistory(ctx);
      const res: CloudResponse<TriageOutput> = await postContainer<TriageOutput>(
        env,
        '/api/skill/skill.health.advisor/symptom_triage',
        {
          symptoms,
          ...(typeof req.duration === 'string' && req.duration.trim() ? { duration: req.duration.trim().slice(0, 50) } : {}),
          ...(typeof req.age === 'number' && req.age > 0 && req.age < 150 ? { age: req.age } : {}),
          ...(req.sex === 'male' || req.sex === 'female' ? { sex: req.sex } : {}),
          history,
        },
        { sessionId: ctx.sessionId, retry: false },
      );
      if (res.code === 0 && res.data) return { success: true, data: res.data };
      // 雲端 503（業務碼，HTTP 200）：LLM 未配置 / 上游失敗 → 離線引導
      // 文案降級（不觸發網路層重試）；負數碼（雲基礎設施錯誤）同理降級
      if (res.code < 0 || res.code === 503) {
        return { success: true, data: { mode: 'text', reply: TRIAGE_OFFLINE_REPLY } };
      }
      return {
        success: false,
        error: { code: 'TRIAGE_FAILED', message: res.message ?? '症狀分診失敗', retryable: false },
      };
    }

    // ---- report_explain：報告解讀 ----
    if (action === 'report_explain') {
      const req = input as ReportExplainInput;
      const reportText = (req.reportText ?? '').trim().slice(0, MAX_REPORT_CHARS);
      if (!reportText) {
        return {
          success: false,
          error: { code: 'EMPTY_REPORT', message: 'reportText 必填且不可為空', retryable: false },
        };
      }
      const res: CloudResponse<ReportOutput> = await postContainer<ReportOutput>(
        env,
        '/api/skill/skill.health.advisor/report_explain',
        { reportText },
        { sessionId: ctx.sessionId, retry: false },
      );
      if (res.code === 0 && res.data) return { success: true, data: res.data };
      if (res.code < 0 || res.code === 503) {
        return { success: true, data: { mode: 'text', reply: REPORT_OFFLINE_REPLY } };
      }
      return {
        success: false,
        error: { code: 'REPORT_EXPLAIN_FAILED', message: res.message ?? '報告解讀失敗', retryable: false },
      };
    }

    // ---- med_info：藥品通識 ----
    const req = input as MedInfoInput;
    const drugName = (req.drugName ?? '').trim().slice(0, MAX_DRUG_CHARS);
    if (!drugName) {
      return {
        success: false,
        error: { code: 'EMPTY_DRUG_NAME', message: 'drugName 必填且不可為空', retryable: false },
      };
    }
    const res: CloudResponse<MedOutput> = await postContainer<MedOutput>(
      env,
      '/api/skill/skill.health.advisor/med_info',
      { drugName },
      { sessionId: ctx.sessionId, retry: false },
    );
    if (res.code === 0 && res.data) return { success: true, data: res.data };
    if (res.code < 0 || res.code === 503) {
      return { success: true, data: { mode: 'text', reply: MED_OFFLINE_REPLY } };
    }
    return {
      success: false,
      error: { code: 'MED_INFO_FAILED', message: res.message ?? '藥品通識查詢失敗', retryable: false },
    };
  },
};
