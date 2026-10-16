/**
 * 健康顧問 SKILL 端點（skill.health.advisor）
 *
 * 端點（與小程序端 health-advisor SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.health.advisor/symptom_triage
 *     body: { symptoms: string, duration?, age?, sex?, history? }
 *   POST /api/skill/skill.health.advisor/report_explain
 *     body: { reportText: string }
 *   POST /api/skill/skill.health.advisor/med_info
 *     body: { drugName: string }
 *
 * 設計要點（參考 awesome-medical-ai-skills-cn / OpenClaw-Medical-Skills
 * 的家庭醫生分診、報告通俗化、藥品通識三方向，按 MicroMate 檔位模型
 * 收斂為 T1 告知 / T2 建議的純生成能力）：
 *   1. System Prompt 由雲端統一維護（醫療邊界：不診斷 / 不薦藥 / 不替代
 *      就醫；「該吃什麼藥」一律遵醫囑），迭代調優不需小程序發版
 *   2. 急症安全網：入口急症詞檢測命中時不走 LLM，直接返回確定性急診
 *      引導文案——LLM 對急症場景的分診回覆不可控，固定文案最安全；
 *      詞表與小程序端 utils/health.ts 同步維護（跨包無法共享代碼），
 *      小程序端另有規劃期短路（安全網不依賴雲端可達性）
 *   3. LLM 輸出強約束 JSON：以 /\{[\s\S]*\}/ 抽取 + 手動窄化（與
 *      planner 同模式）；關鍵字段缺失時降級 mode:'text' 純文本回覆，
 *      前端以文本氣泡兜底——結構化是體驗增益而非可用性前提
 *   4. 免責聲明 disclaimer 由雲端每端點統一攜帶（單一事實源，改文案
 *      不需發版）；前端卡片固定渲染腳註
 *   5. LLM 呼叫復用 llm-chat.ts 的 handleChat（temperature 0.3 求穩——
 *      分診 / 解讀非陪伴對話的 0.7）；503（未配置 / 上游失敗）轉為
 *      業務 fail(503)（HTTP 200，不觸發小程序端網路層重試），小程序端
 *      以離線引導文案降級（與 counseling / weather SKILL 同語義）
 */

import type { HandlerResult, RequestContext, RouteHandler } from './api';
import { ok, fail, badRequest } from './api';
import { handleChat } from './llm-chat';

/**
 * 急症詞正則：危及生命或需立即處置的表達（簡繁並列）
 *
 * 與小程序端 utils/health.ts 的 isEmergencyMessage 同款——雲端做最終
 * 把關（客戶端檢測可被繞過），修改詞表時兩端必須同步。
 * 覆蓋：胸痛胸悶 / 呼吸困難 / 大出血 / 意識障礙 / 抽搐驚厥 /
 * 中風 FAST 徵兆 / 誤服誤食 / 藥物・食物・煤氣中毒 / 過敏性休克。
 * 「中毒」不單獨收錄——「電腦中毒」類比喻會誤傷，僅收具體中毒語義；
 * 「中風」以負向環視排除「命中風險 / 家中風扇」類非醫療子串（急症
 * 守衛會整體回 120 引導，子串誤傷成本高；與小程序端同步維護）。
 */
const EMERGENCY_RE =
  /胸[痛悶闷]|呼吸困[難难]|喘不上[氣气]|喘不過[氣气]|大出血|出血不止|血流不止|意[識识]不清|昏迷|叫不醒|失去意[識识]|[暈晕][過过]去|抽搐|[驚惊]厥|突發中[風风]|中[風风](?![險险扇機机])|口角歪斜|嘴歪|半[邊边][無无]力|肢[體体][無无]力|言[語语]不清|[說说]不出[話话]|[誤误]服|[誤误]食|[藥药]物中毒|食物中毒|煤[氣气]中毒|[過过]敏性休克|喉[頭头]水[腫肿]/;

/**
 * 急症守衛固定文案（guard 路徑，不經 LLM）
 *
 * 要點：立即撥打 120 / 不獨自走動不自行開車 / 中風 FAST 提醒 /
 * 陪同者記錄發作時間。文案確定性可控，與小程序端 EMERGENCY_PROMPT
 * 同主題不同載體（端上為規劃期短路文案，此處為 SKILL 端點回應）。
 */
const EMERGENCY_GUARD_REPLY =
  '你描述的情況可能需要緊急處理，請立即行動：\n\n' +
  '· 撥打 120 急救電話（或讓身邊的人立刻撥打）\n' +
  '· 保持鎮靜，就地休息，不要獨自走動或自行開車前往醫院\n' +
  '· 若患者意識不清，協助側臥防嗆咳，保持呼吸道通暢；切勿餵水餵藥\n' +
  '· 若出現口角歪斜 / 肢體無力 / 言語不清，牢記中風識別要點，越快送醫恢復越好\n' +
  '· 有陪同者時，請 TA 記下症狀開始時間與變化，告知醫生\n\n' +
  '此時請以 120 與急診醫生的指引為準。';

/**
 * 免責聲明（所有生成回應統一攜帶；單一事實源在雲端，前端直接渲染）
 *
 * 措辭對齊參考倉庫（awesome-medical-ai-skills-cn 等）的通行免責要求：
 * AI 生成內容非臨床工具，不用於實際診斷與治療決策。
 */
const DISCLAIMER =
  'AI 生成，僅供健康參考，不能替代專業醫療診斷與治療建議；如有不適請及時就醫，具體用藥請遵醫囑或諮詢藥師。';

/** 共享醫療角色邊界段（三端點 System Prompt 前綴） */
const HEALTH_ROLE_PROMPT = `你是 MicroMate——用戶隨身的個人 AI 助理，此刻的角色是嚴謹克制的健康顧問（不是醫生）。

## 邊界（必須遵守）
1. 你不是醫生：不診斷疾病、不用「你得了 XX 病」的結論性措辭、不推薦或評價具體用藥方案、不替代專業診療。
2. 「該吃什麼藥 / 吃 XX 藥行嗎」類問題：一律回覆需遵醫囑或諮詢藥師，不推薦藥品。
3. 涉及兒童 / 孕產婦 / 高齡 / 慢病人群：格外保守，傾向建議就醫。
4. 信息不確定時如實說明，不編造檢驗參考值或醫學結論。
5. 語言跟隨用戶：用戶用簡體你就回簡體，用繁體就回繁體（JSON 欄位值同樣跟隨）。
6. 身份保密：任何欄位中不得出現底層模型型號或供應商名稱；被問及「你是什麼模型」類問題時以「MicroMate 的 AI 能力」籠統帶過，僅聚焦本任務的健康解讀。`;

/** 症狀分診 System Prompt（任務段） */
const TRIAGE_SYSTEM_PROMPT = `${HEALTH_ROLE_PROMPT}

## 任務：症狀分診與就醫指引
根據用戶描述的症狀評估就醫緊迫度並給出指引。僅輸出一個 JSON 物件（不要 markdown 代碼塊包裹、不要 JSON 以外的任何文字），結構如下：
{
  "urgency": "emergency / urgent_care / routine / self_care 四者之一",
  "urgencyLabel": "緊迫度一句話概括（如「建議 24 小時內就診」）",
  "departments": ["推薦就診科室（中文，1~3 個，如「呼吸內科」）"],
  "possibility": "基於常見情況的謹慎說明（用「常見原因可能包括…」類措辭並明確非診斷，60~120 字）",
  "advice": "就醫前 / 居家期間的實用建議（120~200 字，口語化、一次不超過三條）",
  "redFlags": ["症狀惡化需立刻升級就醫的警示信號（1~4 條）"]
}

## urgency 定檔原則（拿不準時向更高檔位靠攏）
- emergency：可能危及生命或需立即處置（如懷疑心梗 / 中風 / 嚴重過敏 / 高熱驚厥）→ 立即急診或撥打 120
- urgent_care：症狀較重或持續加重，不宜拖延 → 24 小時內就診
- routine：明確不適但無急症徵象 → 近期擇期門診
- self_care：輕症且無警示信號 → 居家觀察，必要時再就醫

用戶消息中的【基礎信息】（年齡 / 性別 / 持續時間）可能缺失，缺什麼就不假設什麼。`;

/** 報告解讀 System Prompt（任務段） */
const REPORT_SYSTEM_PROMPT = `${HEALTH_ROLE_PROMPT}

## 任務：化驗 / 體檢報告通俗解讀
把用戶提供的檢驗指標解讀成通俗語言。僅輸出一個 JSON 物件（不要 markdown 代碼塊包裹、不要 JSON 以外的任何文字），結構如下：
{
  "items": [
    { "name": "指標名", "value": "檢測值（含單位，照抄用戶原文）", "unit": "單位（不明確時空串）", "status": "normal / high / low / abnormal 四者之一", "meaning": "這項指標是什麼、當前狀態的通俗解釋（40~80 字）" }
  ],
  "summary": "整體解讀（哪些正常、哪些偏高偏低；謹慎措辭並明確非診斷，80~150 字）",
  "followUp": "後續建議（是否建議復查、掛哪科；發現危急值級別異常時明確建議立即就醫，60~120 字）"
}

## 解讀原則
1. 參考範圍僅按一般成人常識口徑說明，並提醒「以報告單上標注的參考範圍為準」；不同醫院 / 儀器參考範圍有差異。
2. status 判定：明顯超出常識範圍 → high / low；方向不明確但用戶已標注異常 → abnormal；明確在範圍內 → normal。
3. 用戶未提供檢測值的指標不逐項猜測；最多解讀 12 項，按用戶原文順序排列。`;

/** 藥品通識 System Prompt（任務段） */
const MED_SYSTEM_PROMPT = `${HEALTH_ROLE_PROMPT}

## 任務：藥品通識查詢
介紹藥品的公開通識（是什麼 / 常見用途 / 一般注意事項）。僅輸出一個 JSON 物件（不要 markdown 代碼塊包裹、不要 JSON 以外的任何文字），結構如下：
{
  "drugName": "藥品名（照抄用戶輸入）",
  "category": "藥品類別（如「青黴素類抗生素（處方藥）」「解熱鎮痛藥（非處方藥）」，處方屬性一併說明）",
  "commonUses": ["常見用途（2~4 條，基於公開說明書常識）"],
  "keyNotes": ["一般注意事項（2~4 條，如過敏史警示、常見相互作用提醒；不做個性化用藥指導）"],
  "uncertainty": "知識邊界聲明（非知名常用藥品或信息不確定時必須如實說明，引導以說明書 / 醫師 / 藥師為準；十分確定時可為空串）"
}

## 邊界補充
1. 只講公開通識：不提供劑量建議、不判斷「你能不能吃 / 該不該吃」。
2. 輸入不是藥品名（如「感冒了吃什麼好」）：category 填「非藥品諮詢」、commonUses 空陣列、keyNotes 引導就醫或諮詢藥師、uncertainty 說明無法識別藥品，並在 keyNotes 中明確不做食療或藥物推薦。`;

/** 症狀描述長度上限（字元，與小程序端截斷對齊） */
const MAX_SYMPTOM_CHARS = 2000;

/** 報告文本長度上限（字元） */
const MAX_REPORT_CHARS = 3000;

/** 藥品名長度上限（字元） */
const MAX_DRUG_CHARS = 100;

/** 單條歷史長度上限（字元） */
const MAX_TURN_CHARS = 1000;

/** 歷史輪數上限（與 counseling MAX_HISTORY_TURNS / 小程序端對齊，防客戶端超量注入） */
const MAX_HISTORY_TURNS = 12;

/** urgency 合法枚舉 */
const URGENCY_VALUES = ['emergency', 'urgent_care', 'routine', 'self_care'] as const;
type Urgency = (typeof URGENCY_VALUES)[number];

/** 症狀分診請求體 */
interface TriageInput {
  symptoms?: unknown;
  duration?: unknown;
  age?: unknown;
  sex?: unknown;
  history?: unknown;
}

/** 報告解讀請求體 */
interface ReportInput {
  reportText?: unknown;
}

/** 藥品通識請求體 */
interface MedInput {
  drugName?: unknown;
}

/** 歷史輪（窄化後） */
interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 窄化歷史輪（與 skill-counseling.ts 的 sanitizeHistory 同款模式；handler
 * 間不互相引用，兩處獨立維護）：僅收 user / assistant 且內容非空，截斷
 * 至單條上限，取最後 N 輪
 */
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

/**
 * 從首個 { 起做括號平衡掃描，取第一個頂層平衡的物件字串
 *
 * LLM 偶發在 JSON 後附言或多寫閉括號（實測 2026-10 冒煙復現），貪婪正則
 * 會把尾隨雜質一併捕進去導致 parse 失敗；平衡掃描在首個平衡點截斷，
 * 天然容忍「引導語在前 / 附言與多餘括號在後」兩類畸形（字符串内的括號
 * 由 inStr / 轉義跟蹤跳過）
 */
function balancedJsonSlice(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** 從 LLM 回覆文本抽取首個 JSON 物件（容錯 markdown 圍欄；解析失敗返回 null） */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  // 快速路徑：貪婪正則（無尾隨雜質時最快）；失敗以括號平衡掃描兜底
  for (const candidate of [raw.match(/\{[\s\S]*\}/)?.[0], balancedJsonSlice(raw)]) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      return parsed as Record<string, unknown>;
    } catch {
      // 試下一個候選
    }
  }
  return null;
}

/** 剝除 markdown 圍欄後的純文本（mode:'text' 降級回覆用） */
function stripFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

/** 窄化字串欄位（非字串或空白返回空串；截斷至上限） */
function asTrimmedString(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 窄化字串陣列（過濾非字串 / 空項；限項數與單項長度） */
function asStringArray(v: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .slice(0, maxItems)
    .map((s) => s.trim().slice(0, maxChars));
}

/**
 * 急症守衛回應（三端點共用形態；前端對 mode:'guard' 統一渲染緊急就醫卡）
 *
 * urgency 固定 emergency；不走 LLM——急症場景的分診回覆必須確定性可控
 */
function emergencyGuardResult() {
  return ok({
    mode: 'guard',
    urgency: 'emergency',
    urgencyLabel: '疑似急症：請立即就醫',
    departments: ['急診科（撥打 120）'],
    advice: EMERGENCY_GUARD_REPLY,
    redFlags: [] as string[],
    disclaimer: DISCLAIMER,
  });
}

/** LLM 呼叫結局：成功帶回覆文本；失敗帶可直接返回的業務 503 回應 */
type LlmOutcome = { ok: true; text: string } | { ok: false; result: HandlerResult };

/**
 * 共享 LLM 呼叫：System Prompt + 消息 → 回覆文本
 *
 * 業務 503 語義與 counseling 對齊：LLM 未配置 / 上游失敗 / 429 限流 /
 * 回覆為空均以業務 fail(503) 返回（HTTP 200，小程序端離線降級，不觸發
 * 網路層重試）
 */
async function callHealthLlm(
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  ctx: RequestContext,
  serviceLabel: string,
  maxTokens = 900,
): Promise<LlmOutcome> {
  const chatRes = await handleChat(
    { messages: [{ role: 'system', content: systemPrompt }, ...messages], temperature: 0.3, maxTokens },
    ctx,
  );
  if (chatRes.httpStatus !== 200 || chatRes.body.code !== 0) {
    return { ok: false, result: fail(503, chatRes.body.message ?? `${serviceLabel}服務暫不可用`) };
  }
  const text = ((chatRes.body.data as { text?: string } | undefined)?.text ?? '').trim();
  if (!text) {
    return { ok: false, result: fail(503, `${serviceLabel}回覆為空（上游異常）`) };
  }
  return { ok: true, text };
}

/**
 * POST symptom_triage：症狀分診與就醫指引
 *
 * 入口先過急症守衛（本輪症狀 + 歷史 user 輪一併檢測——上一輪提及急症
 * 的追問同樣短路）；LLM 輸出 JSON 窄化，urgency 非法時保守升檔
 * urgent_care（24 小時內就診），關鍵字段缺失整體降級 text
 */
const handleSymptomTriage: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as TriageInput;
  const symptoms = typeof input.symptoms === 'string' ? input.symptoms.trim().slice(0, MAX_SYMPTOM_CHARS) : '';
  if (!symptoms) {
    return badRequest('symptoms 必填且不可為空');
  }
  const history = sanitizeHistory(input.history);

  // 1. 急症守衛：固定文案即刻回應（不走 LLM）
  if (
    EMERGENCY_RE.test(symptoms) ||
    history.some((t) => t.role === 'user' && EMERGENCY_RE.test(t.content))
  ) {
    return emergencyGuardResult();
  }

  // 2. 基礎信息前綴（僅拼用戶 / 規劃器提供的欄位，缺什麼不猜什麼）
  const infoParts: string[] = [];
  if (typeof input.age === 'number' && Number.isFinite(input.age) && input.age > 0 && input.age < 150) {
    infoParts.push(`年齡 ${Math.floor(input.age)} 歲`);
  }
  if (input.sex === 'male' || input.sex === 'female') {
    infoParts.push(input.sex === 'male' ? '男' : '女');
  }
  if (typeof input.duration === 'string' && input.duration.trim()) {
    infoParts.push(`持續 ${input.duration.trim().slice(0, 50)}`);
  }
  const userContent =
    (infoParts.length > 0 ? `【基礎信息】${infoParts.join(' / ')}\n` : '') + `【症狀描述】\n${symptoms}`;

  // 3. LLM 分診（生成溫度 0.3 求穩）
  const llm = await callHealthLlm(
    TRIAGE_SYSTEM_PROMPT,
    [...history.map((t) => ({ role: t.role, content: t.content })), { role: 'user', content: userContent }],
    ctx,
    '症狀分診',
  );
  if (!llm.ok) return llm.result;

  const parsed = extractJsonObject(llm.text);
  if (parsed) {
    const urgencyRaw = parsed.urgency;
    // urgency 非法 → 保守升檔 urgent_care（寧可多跑一趟醫院，不可漏掉該去的）
    const urgency: Urgency =
      typeof urgencyRaw === 'string' && (URGENCY_VALUES as readonly string[]).includes(urgencyRaw)
        ? (urgencyRaw as Urgency)
        : 'urgent_care';
    const urgencyLabel = asTrimmedString(parsed.urgencyLabel, 60);
    const departments = asStringArray(parsed.departments, 3, 30);
    const possibility = asTrimmedString(parsed.possibility, 300);
    const advice = asTrimmedString(parsed.advice, 600);
    const redFlags = asStringArray(parsed.redFlags, 4, 80);
    // advice 為核心交付字段：缺失即視為結構化失敗，整體降級 text 氣泡
    if (advice) {
      return ok({
        mode: 'structured',
        urgency,
        urgencyLabel: urgencyLabel || '建議盡快就診',
        departments,
        possibility,
        advice,
        redFlags,
        disclaimer: DISCLAIMER,
      });
    }
  }
  return ok({ mode: 'text', reply: stripFence(llm.text), disclaimer: DISCLAIMER });
};

/**
 * POST report_explain：化驗 / 體檢報告通俗解讀
 *
 * items 為核心交付欄位：窄化後為空（用戶文本無可識別指標或 LLM 未按
 * 結構輸出）即降級 text 純文本回覆
 */
const handleReportExplain: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as ReportInput;
  const reportText = typeof input.reportText === 'string' ? input.reportText.trim().slice(0, MAX_REPORT_CHARS) : '';
  if (!reportText) {
    return badRequest('reportText 必填且不可為空');
  }

  // 急症守衛（報告文本含急症語義時同樣短路，誤報成本僅多一次就醫引導）
  if (EMERGENCY_RE.test(reportText)) {
    return emergencyGuardResult();
  }

  // 報告解讀 maxTokens 放寬至 1400：12 項 × meaning 40-80 字 + summary +
  // followUp 的 JSON 全文易超 900，截斷會整體降級 text 氣泡（triage / med
  // 900 已足）。若上游仍截斷，extractJsonObject 失敗自然降級，安全無虞
  const llm = await callHealthLlm(REPORT_SYSTEM_PROMPT, [{ role: 'user', content: reportText }], ctx, '報告解讀', 1400);
  if (!llm.ok) return llm.result;

  const parsed = extractJsonObject(llm.text);
  if (parsed) {
    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items = rawItems
      .slice(0, 12)
      .filter((it): it is Record<string, unknown> => typeof it === 'object' && it !== null)
      .map((it) => {
        const o = it as Record<string, unknown>;
        const name = asTrimmedString(o.name, 40);
        const meaning = asTrimmedString(o.meaning, 200);
        if (!name || !meaning) return null;
        const statusRaw = asTrimmedString(o.status, 20);
        // status 非法 → abnormal（寧可多高亮提示復查，不掩蓋潛在異常）
        const status: 'normal' | 'high' | 'low' | 'abnormal' =
          statusRaw === 'normal' || statusRaw === 'high' || statusRaw === 'low' ? statusRaw : 'abnormal';
        return {
          name,
          value: asTrimmedString(o.value, 60),
          unit: asTrimmedString(o.unit, 20),
          status,
          meaning,
        };
      })
      .filter((it): it is NonNullable<typeof it> => it !== null);
    const summary = asTrimmedString(parsed.summary, 400);
    const followUp = asTrimmedString(parsed.followUp, 300);
    if (items.length > 0 && summary) {
      return ok({ mode: 'structured', items, summary, followUp, disclaimer: DISCLAIMER });
    }
  }
  return ok({ mode: 'text', reply: stripFence(llm.text), disclaimer: DISCLAIMER });
};

/**
 * POST med_info：藥品通識查詢
 *
 * category 為核心欄位：缺失即降級 text；System Prompt 已約束非藥品輸入
 * 走「非藥品諮詢」引導形態（不薦藥紅線）
 */
const handleMedInfo: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as MedInput;
  const drugName = typeof input.drugName === 'string' ? input.drugName.trim().slice(0, MAX_DRUG_CHARS) : '';
  if (!drugName) {
    return badRequest('drugName 必填且不可為空');
  }

  // 急症守衛（「誤服了 XX 藥」類輸入同樣短路到急診引導）
  if (EMERGENCY_RE.test(drugName)) {
    return emergencyGuardResult();
  }

  const llm = await callHealthLlm(MED_SYSTEM_PROMPT, [{ role: 'user', content: drugName }], ctx, '藥品通識');
  if (!llm.ok) return llm.result;

  const parsed = extractJsonObject(llm.text);
  if (parsed) {
    const category = asTrimmedString(parsed.category, 100);
    const commonUses = asStringArray(parsed.commonUses, 4, 100);
    const keyNotes = asStringArray(parsed.keyNotes, 4, 150);
    if (category) {
      return ok({
        mode: 'structured',
        drugName,
        category,
        commonUses,
        keyNotes,
        uncertainty: asTrimmedString(parsed.uncertainty, 200),
        disclaimer: DISCLAIMER,
      });
    }
  }
  return ok({ mode: 'text', reply: stripFence(llm.text), disclaimer: DISCLAIMER });
};

export const healthRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.health.advisor/symptom_triage', handleSymptomTriage],
  ['POST /api/skill/skill.health.advisor/report_explain', handleReportExplain],
  ['POST /api/skill/skill.health.advisor/med_info', handleMedInfo],
];
