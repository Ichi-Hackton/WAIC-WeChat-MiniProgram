/**
 * LLM 客戶端統一介面
 *
 * 規範來源：.qoder/rules/Agent.md § 8.3
 *
 * Planner → client.plan(intent, ctx, availableSkills) → Plan
 */

import { callLLM, LLMError, type LLMMessage } from '../services/llm';
import { CloudNetworkError, isDevEnv } from '../services/cloud';
import { error as logError, info as logInfo, warn as logWarn } from '../utils/logger';
import { genTraceId } from '../utils/idgen';
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
  return null;
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
      return fallback;
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
      throw new PlannerLLMError('LLM 輸出無法解析，請重新描述意圖', e);
    }
    throw e;
  }

  // 4. 兜底：若 LLM 沒填 intent，沿用用戶輸入
  if (!planObj.intent) planObj.intent = intent;
  return planObj;
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

/**
 * 結果聚合（aggregating 階段）
 *
 * 將 Task 結果翻譯為人類可讀訊息。
 * MVP 簡化版：直接列出每個 Task 的成功狀態。
 */
export function aggregate(plan: Plan, aiTag: string): string {
  const okTasks = plan.tasks.filter((t) => t.status === 'succeeded');
  if (okTasks.length === 0) {
    return `${aiTag} 已處理您的請求，但沒有產生結果。`;
  }
  const lines = okTasks.map((t) => {
    const r = t.result;
    const dataStr = r?.data ? JSON.stringify(r.data).slice(0, 80) : '';
    return `✓ ${t.summary ?? `${t.skillId}.${t.action}`}：${dataStr}`;
  });
  return [`${aiTag} 已完成 ${okTasks.length} 個任務：`, ...lines].join('\n');
}