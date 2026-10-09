/**
 * LLM 客戶端統一介面
 *
 * 規範來源：.qoder/rules/Agent.md § 8.3
 *
 * Planner → client.plan(intent, ctx, availableSkills) → Plan
 */

import { callLLM, LLMError } from '../services/llm';
import type { LLMMessage } from '../services/llm';
import { CloudNetworkError, isDevEnv } from '../services/cloud';
import { error as logError, info as logInfo, warn as logWarn } from '../utils/logger';
import { genTraceId } from '../utils/idgen';
import { applyPassengerSlot, findFirstMissingBookingPassenger } from '../utils/passenger';
import { getDefaultPassenger } from '../storage/passenger';
import { buildPlannerPrompt } from './prompts/planner';
import { parsePlannerOutput, toPlan, LLMParserError } from './parser';
import { rulePlan } from './rule-planner';
import type { Plan } from '../types/plan';
import type { AgentContext } from '../types/context';
import type { SkillMetaSlim } from '../types/skill';

export class PlannerLLMError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = 'PlannerLLMError';
  }
}

/**
 * 判定是否觸發開發環境降級，返回觸發原因（不降級則返回 null）
 *
 * LLM 規劃一律先經雲端 /api/llm/chat 取得；雲端不可用時僅在
 * 開發 / 體驗環境降級，兩種觸發路徑：
 *   1. LLMError（不可重試且含「不可用」）— services/cloud 在開發環境
 *      把雲呼叫失敗歸一為 code:-1 佔位碼後由此抛出（雲開發未開通）
 *   2. CloudNetworkError（開發環境）— 雲端返回 5xx（如雲托管已部署
 *      但未配置 LLM_BASE_URL / LLM_API_KEY）或網路失敗，重試耗盡後抛出
 */
function devFallbackReason(e: unknown): string | null {
  if (e instanceof LLMError && !e.retryable && e.message.includes('不可用')) {
    return '雲開發未開通，佔位 code:-1';
  }
  if (e instanceof CloudNetworkError && isDevEnv()) {
    return '雲端 5xx / 網路失敗（重試耗盡）';
  }
  // 開發 / 體驗環境下的防禦性兜底：開發者工具對無效雲環境（INVALID_ENV）
  // 的呼叫可能以 resolve 錯誤體形態穿透（HTTP 非 5xx、業務碼形態各異，
  // 詳見 services/cloud.ts 的歸一說明），無法窮舉識別。dev 環境定位為
  // 「全鏈路可演示」，任何 LLM 錯誤一律降級並記 warn；release 不受影響，
  // 保留嚴格失敗語義（真實 LLM 故障不被規則規劃器靜默掩蓋）。
  if (e instanceof LLMError && isDevEnv()) {
    return `LLM 代理錯誤（${e.message.slice(0, 60)}）`;
  }
  return null;
}

/**
 * 規劃後處理：以本機個人資料（乘車人簿）補齊任務入參
 *
 * LLM 路徑與規則式降級路徑共用，保證兩條路徑行為一致：
 *   火車 / 機票下單任務缺乘車人或為演示佔位時，以「對話明說 >
 *   乘車人簿默認人」回填（applyPassengerSlot，純函數）
 *
 * 日誌不攜帶姓名 / 證號明文（隱私，§ 10 紅線）
 */
function applyLocalProfile(p: Plan, messages: AgentContext['messages']): void {
  const defaultPassenger = getDefaultPassenger();
  if (
    applyPassengerSlot(
      p,
      messages,
      defaultPassenger ? { name: defaultPassenger.name, idNo: defaultPassenger.idNo } : null,
    )
  ) {
    logInfo('乘車人槽位回填：下單任務缺乘車人 / 為演示佔位，已以「對話明說或乘車人簿默認人」補齊');
  }
}

/**
 * 下單任務缺實名信息 → 整輪降級為追問（LLM 與規則式兩條路徑共用）
 *
 * 語義與 prompt 規則 9 對齊（LLM 缺乘車人本應自行回空 tasks + message
 * 追問）：返回「空 tasks + note」形態的 Plan，Orchestrator 現有分支自動
 * 以 NEEDS_INPUT + idle 收斂——用戶補充後下一輪 extractPassenger 提取到
 * 成對「姓名 + 證件號」（或乘車人簿已有默認人），即可完整規劃「查詢 +
 * 下單」。查詢任務一併暫緩（不帶病執行半個 Plan）：與規則 9「先追問
 * 再整鏈規劃」的產品語義一致，避免「查詢成功、下單失敗」的破碎體驗
 * （帶病執行實測復現：task_002 缺 passengerName / passengerIdNo 被執行
 * 期校驗拒絕）。日誌僅攜帶任務號與缺失項標籤，不含明文（隱私 § 10）
 */
function clarifyIfPassengerMissing(p: Plan): Plan {
  const miss = findFirstMissingBookingPassenger(p);
  if (!miss) return p;
  logWarn(
    `下單任務 ${miss.taskId} 缺實名信息（${miss.missingFields.join('、')}），降級為追問${miss.roleLabel}信息`,
  );
  return {
    id: p.id,
    intent: p.intent,
    tasks: [],
    createdAt: p.createdAt,
    status: 'draft',
    traceId: p.traceId,
    note: `請補充${miss.roleLabel}姓名與 18 位證件號（可說「${miss.roleLabel}王小明，身份證 110101⋯」，也可在「我的」頁乘車人簿預先保存），我會立即為您完成預訂`,
  };
}

/**
 * 呼叫 LLM 產生 Plan
 *
 * @param intent 用戶自然語言意圖
 * @param ctx Agent 上下文
 * @param availableSkills 可用 SKILL 簡表（由呼叫方 core 傳入——
 *   llm 層不得反向依賴 skills 註冊表，規範 § 12.3 依賴方向單向不可逆）
 * @returns 結構化 Plan（draft 狀態，待用戶確認）
 */
export async function plan(
  intent: string,
  ctx: AgentContext,
  availableSkills: SkillMetaSlim[],
): Promise<Plan> {
  const env = ctx.globals.cloudEnv as string;
  const traceId = genTraceId();
  const t0 = Date.now();

  // 1. 構造 Prompt（含 availableSkills 簡表）
  const messages = buildPlannerPrompt({
    userIntent: intent,
    availableSkills,
    ctx,
  });

  // 2. 呼叫 LLM
  ctx.trace.llmCalls += 1;
  let res;
  try {
    res = await callLLM(env, {
      messages: messages as LLMMessage[],
      temperature: 0.3,
      maxTokens: 1500,
      jsonMode: true,
      sessionId: ctx.sessionId,
    });
  } catch (e) {
    // 開發環境降級：雲端 LLM 不可用（開發者工具未開通雲開發 / 雲托管
    // 未部署 / LLM 未配置 Key 等）時，以本地規則式規劃器兜底，保證
    // 全鏈路可本地演示（見 rule-planner.ts）；release 保持失敗語義，
    // 避免真實 LLM 故障被靜默掩蓋。此為預期路徑，僅記 warn
    // （ERROR 級留給真實 LLM 故障）
    const fallbackReason = devFallbackReason(e);
    if (fallbackReason) {
      logWarn(`雲端 LLM 不可用（${fallbackReason}），降級為本地規則式規劃器（DEV fallback）`);
      ctx.trace.llmCalls -= 1; // 未實際消耗 LLM 呼叫，修正計數
      const fallback = toPlan(rulePlan(intent, ctx), intent, `plan_${Date.now()}`);
      fallback.traceId = traceId;
      applyLocalProfile(fallback, ctx.messages);
      // 規則式路徑的實名檢查：占位值非空不會命中，但與 LLM 路徑統一走同一
      // 後處理管線，保證兩條路徑行為一致（本檔頂部注釋的既有原則）
      return clarifyIfPassengerMissing(fallback);
    }
    logError('LLM 呼叫失敗', e);
    throw new PlannerLLMError('LLM 呼叫失敗，請稍後再試', e);
  }

  ctx.trace.totalTokens += res.usage.totalTokens;
  logInfo(`LLM 規劃耗時 ${Date.now() - t0}ms, tokens=${res.usage.totalTokens}`);

  // 3. 解析 + 驗證
  let planObj: Plan;
  try {
    planObj = parsePlannerOutput(res.text, intent, `plan_${Date.now()}`);
    planObj.traceId = traceId;
  } catch (e) {
    if (e instanceof LLMParserError) {
      logError('LLM 輸出解析失敗', { raw: res.text.slice(0, 200) });
      // 「缺少必要參數」類（assertNoPlaceholder 攔截的空值/佔位符）直接
      // 透傳——指導用戶補充參數；結構性解析失敗保持通用文案
      const msg = e.message.startsWith('缺少必要參數')
        ? e.message
        : 'LLM 輸出無法解析，請重新描述意圖';
      throw new PlannerLLMError(msg, e);
    }
    throw e;
  }

  // 4. 兜底：若 LLM 沒填 intent，沿用用戶輸入
  if (!planObj.intent) planObj.intent = intent;

  // 5. 後處理：本機個人資料補齊——乘車人槽位回填（LLM 已從上下文槽位
  //    「知道」乘車人但實測可能未寫入任務參數，彈窗缺 passengerName →
  //    校驗失敗），與 prompt 規則 8 的寫入義務構成雙保險。
  //    日誌不攜帶姓名 / 證號明文（隱私）
  applyLocalProfile(planObj, ctx.messages);
  // 6. 回填後仍缺實名信息 → 整輪降級為追問（LLM 違規「整鍵省略」實名欄位
  //    的最終防線，見 clarifyIfPassengerMissing 注釋）
  return clarifyIfPassengerMissing(planObj);
}

/**
 * 意圖識別（understanding 階段）
 *
 * MVP 簡化版：直接返回 'intent_ok'，
 * 進階版可呼叫 LLM 做意圖分類。
 */
export async function understand(
  _intent: string,
  _ctx: AgentContext,
): Promise<{ kind: 'ok' | 'clarify'; clarification?: string }> {
  // MVP 階段不做複雜 NLU，直接通過
  return { kind: 'ok' };
}

/** action → 中文短語（summary 缺失或技術形態時的兜底，避免暴露 skillId.action 代碼）。
 * 2026-10 跳轉模式：train / flight 域寫操作為「生成資訊卡跳轉官方渠道」，
 * 支付在渠道側完成（站內代付任務已随演示域摘除）。 */
const ACTION_LABELS: Record<string, string> = {
  search_train: '查詢車次',
  book_ticket: '生成購票卡跳轉 12306 下單',
  search_flights: '查詢航班',
  book_flight: '生成購票卡跳轉 OTA 下單',
  get_weather: '查詢實時天氣',
};

/**
 * 任務展示名：優先中文 summary；若 summary 為技術形態（parser 兜底會產生
 * 「skillId.action」字串，含「skill.」前綴）則改用 action 中文名，
 * 確保 EndUser 永遠看到人類可讀文案。導出供互動層（首頁計劃卡）復用。
 */
export function taskLabel(t: { summary?: string; action: string }): string {
  const s = t.summary ?? '';
  if (s && !s.includes('skill.')) return s;
  return ACTION_LABELS[t.action] ?? '執行任務';
}

/**
 * 結果聚合（aggregating 階段）
 *
 * 將 Task 結果翻譯為人類可讀訊息：僅列出任務的中文摘要行。
 * 詳細數據不在此傾倒——首頁已以結構化交付卡（車次 / 航班 / 天氣卡）
 * 呈現完整結果，對話氣泡中輸出原始 JSON 屬代碼級細節，EndUser 不應看到。
 */
export function aggregate(plan: Plan, aiTag: string): string {
  const okTasks = plan.tasks.filter((t) => t.status === 'succeeded');
  if (okTasks.length === 0) {
    return `${aiTag} 已處理您的請求，但沒有產生結果。`;
  }
  const lines = okTasks.map((t) => `✓ ${taskLabel(t)}`);
  return [`${aiTag} 已完成 ${okTasks.length} 項任務：`, ...lines].join('\n');
}