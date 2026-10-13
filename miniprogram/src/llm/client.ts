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
import {
  setPendingMemory,
  rememberExplicit,
  extractPreferenceMemory,
  extractPreferenceSuggestion,
  isExplicitLongTerm,
} from '../storage/preferences';
import { isCrisisMessage } from '../utils/counseling';
import { buildPlannerPrompt } from './prompts/planner';
import { buildClassifierPrompt } from './prompts/classifier';
import type { ClassifierOutput } from './prompts/classifier';
import { toPlan, validatePlannerOutput, validatePlanBindings, extractJson, LLMParserError } from './parser';
import { rulePlan, localChatReply, UNSUPPORTED_HINT } from './rule-planner';
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
 * 規劃後處理：記憶分層沉澱（storage/preferences）
 *
 * 2026-10 交互修訂（UX 回歸後重設計——顯式指令再確認是打擾）：
 *   顯式路徑——意圖文本命中長期意圖詞（「以後都…」「記住我…」，
 *   isExplicitLongTerm 為唯一權威）：直接落盤（rememberExplicit），
 *   回執條目隨最終響應透出「已記住 ✓」卡告知（告知而非詢問）。
 *   LLM memory 欄位此時作值補充（語義更豐富），但未經意圖印證的
 *   memory 不得直接落盤（防 LLM 把一次性需求誤判為長期偏好）。
 *   推斷路徑——無長期意圖詞但命中偏好域詞（如「幫我訂靠窗的票」）
 *   或 LLM 自行輸出 memory：暫存待確認提議（setPendingMemory），
 *   UI 確認卡詢問「以後都這樣做嗎？」，用戶確認才落盤（從單次
 *   行為推斷習慣須徵求同意）。問過（拒絕 / 忽略皆同）同鍵同值
 *   不再重複提議。提議為空不影響規劃主鏈路。
 */
function sinkMemory(intent: string, llmMemory: unknown): void {
  const llmMem: Record<string, unknown> =
    llmMemory && typeof llmMemory === 'object' && !Array.isArray(llmMemory)
      ? (llmMemory as Record<string, unknown>)
      : {};
  if (isExplicitLongTerm(intent)) {
    // 規則抽取值優先（本輪文本字面抽取最保守），LLM memory 補充漏抽鍵
    const written = rememberExplicit({ ...llmMem, ...extractPreferenceMemory(intent) });
    if (written.length > 0) {
      logInfo(`顯式長期偏好直接落盤：${written.join('、')}（回執卡告知，不打擾）`);
    }
    return;
  }
  // 推斷提議：域詞句式抽取 + LLM 自行輸出的 memory（未經印證，走確認卡）
  const proposed = setPendingMemory({ ...llmMem, ...extractPreferenceSuggestion(intent) });
  if (proposed.length > 0) {
    logInfo(`偏好推斷提議待確認：${proposed.join('、')}（用戶確認後落盤）`);
  }
}

/**
 * 規則式規劃結果的統一後處理管線（雲端不可用降級與參數缺陷兜底共用）：
 * toPlan 定形 → traceId 透傳 → 本機畫像回填 → 實名缺失澄清，
 * 與 LLM 正常路徑行為一致（本檔頂部注釋的既有原則）。
 */
function postProcessRulePlan(
  ruled: ReturnType<typeof rulePlan>,
  intent: string,
  ctx: AgentContext,
  traceId: string,
): Plan {
  const planObj = toPlan(ruled, intent, `plan_${Date.now()}`);
  planObj.traceId = traceId;
  // 規則路徑的記憶沉澱：LLM 路徑靠輸出 memory 欄位，此處以句式
  // 匹配（顯式 / 推斷兩路徑純函數，僅依賴本輪意圖文本）
  sinkMemory(intent, null);
  applyLocalProfile(planObj, ctx.messages);
  // 規則式路徑的實名檢查：占位值非空不會命中，但與 LLM 路徑統一走同一
  // 後處理管線，保證兩條路徑行為一致
  return clarifyIfPassengerMissing(planObj);
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

  // 0. 規則式規劃優先（2026-10 架構修訂：由「LLM 優先、規則兜底」翻轉
  //    為「規則優先、LLM 兜底」）：六域詞表覆蓋的明顯任務意圖直接走
  //    確定性規劃——零 LLM 延遲（實測規劃 4-6 秒歸零）、零幻覺（LLM
  //    對綁定欄位路徑 / 鍵名 / 字面值教學的遵循度不穩定，多輪修 prompt
  //    仍換姿勢幻覺：firstServiceId → data.firstAvailableServiceId →
  //    映射表編造鍵名 svc_badminton_001；規劃期白名單只攔首段，深層
  //    幻覺穿透到 Scheduler 運行時 BINDING_FAILED 回滾）。規則帶追問
  //    引導語（message）而無任務時也直接短路（天氣無定位引導等），
  //    不浪費 LLM 呼叫；規則完全不認識的意圖（複雜組合 / 詞表外表述，
  //    詞表外兜底回空 tasks + 空 message）穿透至此走 LLM 規劃，保持
  //    靈活性（修復前兜底帶非空 message 令本路徑 100% 不可達，審計 H1）
  const ruledFast = rulePlan(intent, ctx);
  if ((ruledFast.tasks ?? []).length > 0 || ruledFast.message) {
    logInfo(`規則式規劃命中（${(ruledFast.tasks ?? []).length} 任務），跳過 LLM`);
    return postProcessRulePlan(ruledFast, intent, ctx, traceId);
  }

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
      const ruled = rulePlan(intent, ctx);
      // 規則也不認識（空 tasks + 空 message，原本頭部短路已放行到 LLM）：
      // LLM 不可用的開發環境下以功能清單引導（UNSUPPORTED_HINT 隨路由
      // 翻轉從 rule-planner 兜底分支遷入，僅 DEV 降級路徑出現）
      const withHint =
        (ruled.tasks ?? []).length > 0 || ruled.message ? ruled : { ...ruled, message: UNSUPPORTED_HINT };
      return postProcessRulePlan(withHint, intent, ctx, traceId);
    }
    logError('LLM 呼叫失敗', e);
    throw new PlannerLLMError('LLM 呼叫失敗，請稍後再試', e);
  }

  ctx.trace.totalTokens += res.usage.totalTokens;
  logInfo(`LLM 規劃耗時 ${Date.now() - t0}ms, tokens=${res.usage.totalTokens}`);

  // 3. 解析 + 驗證（拆開一體化 pipeline：memory 為規劃副作用不進 Plan，
  //    需在 toPlan 前從 validated 取出交 sinkMemory 分層沉澱）
  let planObj: Plan;
  try {
    const validated = validatePlannerOutput(extractJson(res.text));
    planObj = toPlan(validated, intent, `plan_${Date.now()}`);
    planObj.traceId = traceId;
    sinkMemory(intent, validated.memory);
  } catch (e) {
    if (e instanceof LLMParserError) {
      logError('LLM 輸出解析失敗', { raw: res.text.slice(0, 200) });
      // 「缺少必要參數」類（assertNoPlaceholder 攔截的空值/佔位符）：LLM
      // 已理解意圖但參數填空（如無定位時 city 為空）——先嘗試本地規則式
      // 規劃器兜底，各域槽位自帶缺省與追問（咖啡域無城市兜底上海、票務
      // 域無城市追問場次）；規則也產不出任務（意圖超出規則詞表）才失敗，
      // 透傳原始參數錯誤指導用戶補充。結構性解析失敗（非 JSON 形態，
      // LLM 完全跑偏）不兜底——規劃依據已失真，保持通用失敗文案
      if (e.message.startsWith('缺少必要參數')) {
        const ruled = rulePlan(intent, ctx);
        if ((ruled.tasks ?? []).length > 0) {
          logWarn(`LLM 規劃參數缺陷（${e.message}），降級本地規則式規劃器兜底`);
          return postProcessRulePlan(ruled, intent, ctx, traceId);
        }
        throw new PlannerLLMError(e.message, e);
      }
      throw new PlannerLLMError('LLM 輸出無法解析，請重新描述意圖', e);
    }
    throw e;
  }

  // 3.5 綁定引用校驗：fromTaskId / dependsOn 引用幻覺（不存在的任務 /
  //     自引用）與參數占位符同屬 LLM 規劃缺陷——規則規劃器能產出同意圖
  //     任務則兜底接管（各域綁定路徑確定性生成），否則誠實失敗引導
  //     用戶重新描述
  const bindingErrs = validatePlanBindings(planObj);
  if (bindingErrs.length > 0) {
    const ruled = rulePlan(intent, ctx);
    if ((ruled.tasks ?? []).length > 0) {
      logWarn(`LLM 規劃綁定引用缺陷（${bindingErrs[0]}），降級本地規則式規劃器兜底`);
      return postProcessRulePlan(ruled, intent, ctx, traceId);
    }
    logError('LLM 規劃綁定引用無效且規則規劃器無法兜底', { errs: bindingErrs });
    throw new PlannerLLMError(`任務引用無效：${bindingErrs[0]}`);
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

/** 意圖分類結果：task 續走任務規劃；chat 帶直接回答；clarify 維持原語義 */
export type UnderstandResult =
  | { kind: 'ok' }
  | { kind: 'clarify'; clarification?: string }
  | { kind: 'chat'; reply: string };

/**
 * 意圖分類（understanding 階段）
 *
 * 2026-10 修訂：由 MVP 空殼升級為 LLM 分類——閒聊 / 元問題（如
 * 「能不能獲取我的位置」）在進入任務規劃漏斗前攔截，直接以對話回答，
 * 避免落到規劃器兜底的「功能清單推銷」文案（真實 badcase 復現）。
 * 分類與回答一體（單次 LLM 呼叫），kind=task 時零回答、零侵入。
 *
 * 容錯語義：分類器是「增強」而非「單點」——LLM 不可用 / 輸出解析
 * 失敗時降級為 '{ kind: ok }' 續走規劃鏈路（任何環境），不得阻断任務；
 * 開發環境先以本地規則回答已知元問題（localChatReply，位置授權類）。
 */
export async function understand(
  intent: string,
  ctx: AgentContext,
): Promise<UnderstandResult> {
  // 危機信號短路：維持既有行為（規劃鏈路內 rulePlan 有本地靜態關懷
  // 文案短路；LLM 路徑行為與改動前完全一致），不交给分類器自由發揮
  if (isCrisisMessage(intent)) {
    return { kind: 'ok' };
  }
  // 本地短路：已知元問題形態無需雲端往返（任何環境先命中——
  // 靜態事實回答與 LLM 口徑一致，省一次呼叫與延遲）
  const local = localChatReply(intent, ctx);
  if (local !== null) {
    logInfo('understand：本地短路回答位置類元問題');
    return { kind: 'chat', reply: local };
  }
  // 明顯任務域詞快速通道：跳過 LLM 分類——高頻任務路徑保持單次 LLM
  // 呼叫（僅 planner），分類器只處理「非明顯任務」輸入。詞表與
  // rule-planner 各域判定同源（2026-10 六域回補同步：咖啡 / 票務 /
  // 預約 / 購物 / 諮詢域詞入通道）。含買 / 訂泛詞：寧可 task 兜底——分類器
  // 誤判會把任務擋在規劃前（實測「來杯拿鐵 / 預約場地」曾被判域外
  // 閑聊直接拒絕），而快速通道誤命中時 rule-planner 產不出任務僅會
  // 追問，兩害相取其輕
  if (
    // 出行域：火車 / 機票
    /高[铁鐵]|动[车車]|火[车車]|[车車][次票]|12306|機票|机票|航班|飛機|飞机|飛往|飞往|搭機|搭机|坐飛|坐飞/.test(
      intent,
    ) ||
    // 天氣 / 行程 / 支付與買賣泛詞
    /天氣|天气|氣溫|气温|溫度|温度|幾度|几度|下雨|行程|支付|付款|[买買訂订]|下[单單]/.test(intent) ||
    // 咖啡域（「咖啡(?!豆)」負向：咖啡豆歸購物域，與 rule-planner 同構）
    /星巴克|咖啡(?!豆)|拿[铁鐵]|美式|摩卡/.test(intent) ||
    // 票務域：顯式演出詞（藝人 / 劇目詞表留在 planner 判定，避免
    // 「買周杰倫專輯」類商品語境誤入）
    /演唱[會会]|音[樂乐][節节]|話[劇剧]|音[樂乐][劇剧]|演出|看比[賽赛]|CBA|[門门]票|[購购]票|[買买]票|[搶抢]票/.test(
      intent,
    ) ||
    // 預約域：域詞 + 高頻服務詞（與 rule-planner SERVICE_MAP 同源子集）
    /預約|预约|預訂|预订|羽毛球|[潔洁]牙|[體体][檢检]|游泳|泳池|[理剪][髮发]|剪裁|[設设][計计]師/.test(
      intent,
    ) ||
    // 實名補充輪（「張三，身份證 110101…」）：純補充信息無域詞，直接放行
    // 交給規劃層錨點恢復多輪訂票（LLM 分類器對無域詞輸入可能誤判閒聊拒絕，
    // 且多一次雲端往返延遲實測 1.6s）
    /身份[證证]/.test(intent) ||
    // 購物域詞（商品詞已由買 / 訂泛詞覆蓋；含結帳 / 結算入口）
    /购物|購物|商城|商品|加[购購]|買東西|买东西|結[帳账]|结账|結算|结算/.test(intent) ||
    // 諮詢域：情緒 / 陪聊詞（與 rule-planner wantsCounseling 同源——
    // 分類器的 task 定義僅覆蓋出行類，情感陪伴表達會被誤判 chat 擋在
    // 規劃前；混合語句由上方任務域詞先行命中，純情緒表達才落到此處）
    /心情|難過|难过|傷心|伤心|焦慮|焦虑|壓[力大]|压[力大]|孤單|孤单|寂寞|[鬱郁][悶闷]|煩|烦|陪我|聊[一]?聊|說說話|说说话|傾訴|倾诉|開心不起來|开心不起来/.test(
      intent,
    )
  ) {
    return { kind: 'ok' };
  }

  const env = ctx.globals.cloudEnv as string;
  ctx.trace.llmCalls += 1;
  let res;
  try {
    res = await callLLM(env, {
      messages: buildClassifierPrompt({ userIntent: intent, ctx }) as LLMMessage[],
      temperature: 0.1,
      maxTokens: 300,
      jsonMode: true,
      sessionId: ctx.sessionId,
    });
  } catch (e) {
    // 分類器故障不阻断任務：修正計數後按任務指令續走規劃鏈路
    ctx.trace.llmCalls -= 1;
    const reason = devFallbackReason(e);
    logWarn(`意圖分類不可用（${reason ?? (e as Error)?.message ?? '未知'}），按任務指令處理`);
    return { kind: 'ok' };
  }
  ctx.trace.totalTokens += res.usage.totalTokens;

  // 解析：失敗同樣降級為任務指令（分類器輸出非關鍵路徑）
  const m = res.text.match(/\{[\s\S]*\}/);
  if (!m) {
    logWarn(`意圖分類輸出無法解析，按任務指令處理（raw: ${res.text.slice(0, 80)}）`);
    return { kind: 'ok' };
  }
  let parsed: ClassifierOutput;
  try {
    parsed = JSON.parse(m[0]) as ClassifierOutput;
  } catch {
    logWarn('意圖分類 JSON 解析失敗，按任務指令處理');
    return { kind: 'ok' };
  }
  if (parsed.kind === 'chat' && parsed.reply && parsed.reply.trim()) {
    return { kind: 'chat', reply: parsed.reply.trim() };
  }
  // kind=task / 缺 reply 的 chat（模型違規）→ 一律按任務續走
  return { kind: 'ok' };
}

/** action → 中文短語（summary 缺失或技術形態時的兕底，避免暴露 skillId.action 代碼）。
 * 2026-10 六域回補（跳轉模式）：各域寫操作統一為「生成需求卡跳轉官方
 * 渠道」，支付在渠道側完成（站內無代付任務，pay_orders 僅聚合引導）。 */
const ACTION_LABELS: Record<string, string> = {
  search_train: '查詢車次',
  book_ticket: '生成購票卡跳轉 12306 下單',
  search_flights: '查詢航班',
  book_flight: '生成購票卡跳轉 OTA 下單',
  get_weather: '查詢實時天氣',
  search_store: '查詢星巴克門市',
  place_order: '下單點單卡跳轉星巴克完成',
  search_products: '搜尋商城商品',
  add_to_cart: '加入購物車',
  checkout: '結算並跳轉京東下單',
  search_services: '查詢可預約服務',
  create_reservation: '生成預約卡跳轉美團完成',
  list_reservations: '查詢我的預約',
  cancel_reservation: '取消預約',
  search_events: '搜尋演出',
  list_sessions: '查詢場次票檔',
  create_order: '生成購票卡跳轉大麥下單',
  list_orders: '查詢我的訂單',
  cancel_order: '取消訂單',
  chat_companion: '陪伴對話',
  pay_orders: '聚合待支付訂單引導渠道收銀台',
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