/**
 * Orchestrator 編排器（狀態機）
 *
 * 規範來源：.qoder/rules/Agent.md § 5, § 8.1
 *
 * 對外入口：handle(intent, ctx) → AgentResponse
 *
 * 流程：
 *   idle → understanding → planning → confirming_plan → executing → aggregating → completed
 *                                                                              ↘ failed
 */

import { buildContext, pushMessage } from './context';
import {
  plan as llmPlan,
  understand,
  aggregate as llmAggregate,
  replan as llmReplan,
  PlannerLLMError,
} from '../llm/client';
import { run as runScheduler, SchedulerDeadlockError } from './scheduler';
import { saveTripFromPlan, updateTripFromPlan } from '../storage/trip';
import { takePendingProposal, takeRememberedProposal } from '../storage/preferences';
import {
  detectProfileCapture,
  takePendingProfile,
  takeRememberedProfile,
} from '../storage/profile-proposal';
import * as skillAdapter from '../skills/adapter';
import { getCapability } from '../skills/adapter';
import { SkillRegistry } from '../skills/registry';
import { syncDynamicSkills } from '../skills/dynamic';
import { BRAND_AI_GENERATED_BY } from '../types/brand';
import { info as logInfo, error as logError, warn as logWarn } from '../utils/logger';
import { genPlanId } from '../utils/idgen';
import type { AgentContext } from '../types/context';
import type { AgentResponse, AgentState, AgentCard } from '../types/agent-state';
import type { Plan } from '../types/plan';
import type { Task } from '../types/task';
import type { CheckpointFn, ConfirmPlanFn } from '../types/checkpoint';

/** Orchestrator 建構選項 */
export interface OrchestratorOptions {
  /**
   * Plan 確認回調（必填）。
   * 由上層組裝時注入 interaction 實作——core 不得反向依賴互動層
   * （規範 § 12.3 依賴方向單向不可逆），型別見 types/checkpoint.d.ts。
   */
  confirmPlan: ConfirmPlanFn;
  /** 單步寫操作確認回調（必填，同上） */
  checkpoint: CheckpointFn;
  /** 是否自動 confirm Plan（測試用，預設 false） */
  autoConfirm?: boolean;
  /** 是否自動同意所有 checkpoint（測試用，預設 false） */
  autoApproveCheckpoint?: boolean;
  /** Plan 任務更新回調（UI 推播用） */
  onTaskUpdate?: (task: Task) => void;
  /** Plan 完整回調 */
  onPlanUpdate?: (plan: Plan) => void;
  /** 狀態機轉移回調（UI 階段提示用） */
  onStateChange?: (next: AgentState, prev: AgentState) => void;
}

/**
 * 允許的狀態轉移對映表（規範 § 5.1 狀態機的程式化表述）
 *
 * 實值必須放在 .ts（.d.ts 中的值宣告 runtime 取不到值），
 * 與 src/types/agent-state.d.ts 的型別宣告配套。
 *
 * understanding / planning 可回 idle：clarify（需補充資訊）與
 * EMPTY_PLAN（無法識別意圖）兩條提前返回路徑必須歸位狀態機，
 * 否則內部狀態殘留導致後續所有請求被 BUSY 守衛攔截（永久死鎖）。
 *
 * 重規劃路徑（2026-10，規範 § 9「業務錯誤 → 回傳 LLM 調整 Plan」的接線）：
 * executing / rolling_back 可回 planning（失敗回滾後嘗試替代方案——
 * rollbackIfNeeded 無回滾目標時狀態停在 executing，故兩態均需放行）；
 * planning 可直入 executing（重規劃方案跳過 confirming_plan：UI plan 卡
 * 已提供能見度，同 § 8.1 最小打擾修訂）。
 */
const ALLOWED_TRANSITIONS: Readonly<Record<AgentState, ReadonlyArray<AgentState>>> = {
  idle: ['understanding'],
  understanding: ['planning', 'failed', 'idle'],
  planning: ['confirming_plan', 'failed', 'idle', 'executing'],
  confirming_plan: ['executing', 'idle', 'failed'],
  executing: ['awaiting_human', 'aggregating', 'rolling_back', 'failed', 'planning'],
  awaiting_human: ['executing', 'rolling_back', 'failed'],
  aggregating: ['completed', 'failed'],
  rolling_back: ['failed', 'completed', 'planning'],
  completed: ['idle'],
  failed: ['idle'],
};

/**
 * 可重規劃的業務錯誤碼（白名單制，寧缺勿濫）
 *
 * 僅「業務性可替代」錯誤（SOLD_OUT / NO_* 系列：售罄、無票、無班次、
 * 無庫存等）觸發重規劃；以下類型明確排除——
 *   - 取消類（USER_CANCELLED / RUN_CANCELLED）：用戶意志，不得違背；
 *   - 參數類（INVALID_INPUT / BINDING_FAILED）：缺參該走追問，換路徑無益；
 *   - 攔截類（REVIEW_BLOCKED）：安全複核已否定的寫操作，重規劃繞道
 *     屬於規避攔截（且新方案若仍與用戶點名不符會被再次攔截）；
 *   - 網絡類（retryable=true）：網路問題重試更合適。
 */
const REPLANNABLE_CODE_RE = /^(?:SOLD_OUT|NO_[A-Z_]+)$/;

/** 判定任務錯誤碼是否屬業務性可替代失敗（重規劃白名單） */
function isReplannableFailure(code: string | undefined): boolean {
  return !!code && REPLANNABLE_CODE_RE.test(code);
}

/** Orchestrator 實例序號（模組級）：正常全生命週期僅 1 個實例，> 1 表示 runtime 被重建 */
let ORCHESTRATOR_SEQ = 0;

/**
 * 模組級運行註冊表：當前仍有效的執行令牌集合（RUN_SEQ 遞增分配）。
 *
 * 設計考量：令牌探測閉包（isRunActive）跨 awaits 長時間存活（如 checkpoint
 * 彈窗掛起數十秒），以模組級變數存取、閉包捕獲原始值 token，不經 this、
 * 不受實例重建 / 環境重建影響，探測語義全程穩定。
 *
 * 生命週期：handle 接管 / reset 時 clear（= 舊輪失效的唯一語義）。
 * 熱重載重建模組時，舊閉包引用舊 Set（令牌仍在其中 → 放行），且重建後
 * 無人再對舊輪呼叫 reset，語義仍安全。
 */
const ACTIVE_RUNS = new Set<number>();
let RUN_SEQ = 0;

/** Orchestrator 單例（支援持續多輪對話） */
export class Orchestrator {
  private state: AgentState = 'idle';
  private ctx: AgentContext;
  private currentPlan?: Plan;
  private options: OrchestratorOptions;
  /** 實例序號（模組級遞增）：診斷「多 Orchestrator 實例」類問題用 */
  private readonly instanceSeq = ++ORCHESTRATOR_SEQ;

  constructor(ctx: AgentContext, options: OrchestratorOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  /** 取得當前狀態 */
  getState(): AgentState {
    return this.state;
  }

  /** 取得當前 Plan */
  getCurrentPlan(): Plan | undefined {
    return this.currentPlan;
  }

  /**
   * 處理用戶輸入
   *
   * 薄包裝：狀態機全流程（run）結束後，把規劃階段沉澱的記憶記錄附加到
   * 最終響應（storage/preferences 分層記憶）——顯式已記住的回執卡
   * （remembered，「已記住 ✓」告知）在前，推斷提議的確認卡（suggested，
   * 「以後都這樣做嗎？」詢問）在後。讀即清保證不重複透出；BUSY /
   * 遺留記錄也統一在此出清，無害。
   *
   * @param intent 用戶自然語言意圖
   */
  async handle(intent: string): Promise<AgentResponse> {
    const res = await this.run(intent);
    // 個人資料捕獲透出（讀即清，與記憶提議同款模式）：顯式已保存回執 +
    // 推斷確認卡提議，任何分支（chat / clarify / 任務流）統一於此附加
    const memoryProposal = [...(takeRememberedProposal() ?? []), ...(takePendingProposal() ?? [])];
    const profileProposal = [...(takeRememberedProfile() ?? []), ...(takePendingProfile() ?? [])];
    return {
      ...res,
      ...(memoryProposal.length > 0 ? { memoryProposal } : {}),
      ...(profileProposal.length > 0 ? { profileProposal } : {}),
    };
  }

  /** 狀態機全流程（原 handle 主體；private，僅經 handle 包裝對外） */
  private async run(intent: string): Promise<AgentResponse> {
    logInfo(`Orchestrator.handle: "${intent.slice(0, 60)}"`);
    if (this.state !== 'idle' && this.state !== 'completed' && this.state !== 'failed') {
      return {
        message: `${BRAND_AI_GENERATED_BY} 正在執行中，請等待當前任務完成`,
        state: this.state,
        errorCode: 'BUSY',
      };
    }

    // 本輪執行令牌（模組級註冊表）：接管即清除舊輪令牌（= 舊 run 失效事件）。
    // 宣告於 try 外供 catch 判定；模組級設計理由見 ACTIVE_RUNS 註釋
    const token = ++RUN_SEQ;
    ACTIVE_RUNS.clear();
    ACTIVE_RUNS.add(token);
    logInfo(`[runToken] handle 註冊 #${token}（實例 #${this.instanceSeq}）`);

    try {
      // completed / failed 先合法歸位 idle（守衛表僅允許這兩態回到 idle）
      if (this.state !== 'idle') {
        this.transition('idle');
      }
      this.transition('understanding');
      // 對話記憶接線：本輪用戶意圖寫入 ctx.messages（planner 的「最近對話」
      // 與陪伴 SKILL 的多輪歷史均消費此數據；上限 20 條由 pushMessage 維護）
      pushMessage(this.ctx, { role: 'user', content: intent, timestamp: Date.now() });
      // 個人資料對話捕獲（2026-10）：乘車人 / 地址口述 → 顯式直存或推斷
      // 提議，結果寫入 storage 由 handle 尾部統一透出。置於 understand
      // 之前——純保存指令（「記住我的地址…」）常被分類為閒聊，掛在規劃
      // 後處理會漏掉 chat 分支；檢測異常已在內部吞掉，不阻斷主流程
      detectProfileCapture(intent);
      const u = await understand(intent, this.ctx);
      if (u.kind === 'clarify') {
        // 狀態機歸位：提前返回必須轉回 idle，否則後續請求永久 BUSY。
        // 追問寫入對話記憶（規劃層的追問錨點——isTripFollowup / 實名補充
        // 輪——靠 lastAssistant 識別追問上下文，不寫入則錨點恒不命中）
        this.transition('idle');
        pushMessage(this.ctx, { role: 'assistant', content: u.clarification ?? '請補充資訊', timestamp: Date.now() });
        return {
          message: `${BRAND_AI_GENERATED_BY}：${u.clarification ?? '請補充資訊'}`,
          state: 'idle',
        };
      }
      if (u.kind === 'chat') {
        // 閒聊 / 元問題短路（2026-10 修訂）：分類為非任務輸入時直接以對話
        // 回答，不進任務規劃漏斗——避免元問題（如「能不能獲取我的位置」）
        // 落到規劃器兜底的「功能清單推銷」文案。歸位語義同 clarify；
        // 回答寫入對話歷史，支援多輪閒聊上下文延續
        this.transition('idle');
        pushMessage(this.ctx, { role: 'assistant', content: u.reply, timestamp: Date.now() });
        return {
          message: `${BRAND_AI_GENERATED_BY}：${u.reply}`,
          state: 'idle',
        };
      }

      this.transition('planning');
      // 動態技能清單同步（每輪規劃前，動態技能計劃）：manifest 失敗僅撤下
      // 動態技能（fail-closed，見 skills/dynamic.ts），不影響內置技能與本輪規劃；
      // 此處額外兜底以防註冊表操作意外拋出阻斷規劃主鏈路
      await syncDynamicSkills(this.ctx).catch(() => undefined);
      // availableSkills 由 core 層取註冊表後傳入（llm 層不得反向依賴 skills，§ 12.3）
      const planObj = await llmPlan(intent, this.ctx, SkillRegistry.listSlim());
      if (planObj.tasks.length === 0) {
        // 狀態機歸位：同上（空 tasks 為高頻路徑，LLM 對不支援意圖或缺參數回空 tasks）
        this.transition('idle');
        // 能力缺口（優先於追問：缺口 = 補參數也無法解決，追問 = 可補參數）：
        // 引導用戶到技能中心鍛造新技能（LLM 起草 → 人工審批 → 免發版生效）。
        // 建議文案寫入對話記憶，支援後續輪次識別缺口上下文
        if (planObj.missingCapability) {
          const gap = planObj.missingCapability;
          pushMessage(this.ctx, { role: 'assistant', content: gap.suggestion, timestamp: Date.now() });
          return {
            message: `${BRAND_AI_GENERATED_BY}：${gap.suggestion}`,
            state: 'idle',
            errorCode: 'CAPABILITY_GAP',
            capabilityGap: { intent, skillName: gap.skillName, suggestion: gap.suggestion },
          };
        }
        // note = LLM 追問文案（如「請補充出行日期」）：引導用戶補充後重試，
        // 區別於「無法識別」（EMPTY_PLAN）
        if (planObj.note) {
          // 追問寫入對話記憶（同 clarify 分支：實名補充輪錨點靠
          // lastAssistant 識別「請補充乘車人 / 觀演人」上下文）
          pushMessage(this.ctx, { role: 'assistant', content: planObj.note, timestamp: Date.now() });
          return {
            message: `${BRAND_AI_GENERATED_BY}：${planObj.note}`,
            state: 'idle',
            errorCode: 'NEEDS_INPUT',
          };
        }
        return {
          message: `${BRAND_AI_GENERATED_BY}：抱歉，我無法識別您的意圖。請換個說法。`,
          state: 'idle',
          errorCode: 'EMPTY_PLAN',
        };
      }

      this.currentPlan = planObj;
      planObj.status = 'draft';
      this.options.onPlanUpdate?.(planObj);

      // 1. Plan 確認
      this.transition('confirming_plan');
      const planCards: AgentCard[] = planObj.tasks.map((t) => ({
        type: 'plan',
        title: `${t.skillId}.${t.action}`,
        payload: { taskId: t.id, summary: t.summary ?? '', input: t.input, dependsOn: t.dependsOn },
      }));
      const confirmed = this.options.autoConfirm
        ? true
        : await this.options.confirmPlan({
            intent,
            tasks: planObj.tasks,
            ctx: this.ctx,
          });
      if (!confirmed) {
        this.transition('idle');
        return {
          message: `${BRAND_AI_GENERATED_BY}：好的，已取消本次計劃。`,
          state: 'idle',
        };
      }
      planObj.status = 'confirmed';
      // 行程落庫（第一階段同步）：行程 Plan 確認即建檔為日程（時間線記錄
      // 任務初始狀態），供「我的行程」頁與到點提醒消費；非行程 Plan 無副作用
      // （plan.trip 缺省返回 null）。core → storage 先例：core/context.ts
      saveTripFromPlan(planObj);

      // 2. 執行（任務 waiting_human 時聯動轉入 awaiting_human，見 handleTaskUpdate）
      this.transition('executing');
      const finalPlan = await runScheduler(planObj, this.ctx, {
        checkpoint: this.options.autoApproveCheckpoint
          ? () => Promise.resolve(true)
          : this.options.checkpoint,
        onTaskUpdate: (t) => this.handleTaskUpdate(t),
        // 模組級註冊表探測（設計理由見 ACTIVE_RUNS 註釋）：不讀 this.*，
        // 探測閉包跨 awaits 長期存活的語義全程穩定。注意消費方語義：
        // 本函數 true = 仍有效；scheduler 的 shouldAbort true = 應中止（相反）
        isRunActive: () => {
          if (ACTIVE_RUNS.has(token)) return true;
          logWarn(`[runToken] run #${token} 已失效（reset 或新輪接管）`);
          return false;
        },
      });
      this.currentPlan = finalPlan;
      // 行程狀態同步（第二階段同步）：時間線任務狀態與行程終態（done /
      // partial）落庫；按 planId 冪等，覆蓋 done / failed / 提前中止全部路徑
      updateTripFromPlan(finalPlan);

      // 執行期間被 reset / 新輪接管（模組級註冊表探測，與 isRunActive 同源）：
      // 狀態已被 reset 歸位，不再轉移
      if (!ACTIVE_RUNS.has(token)) {
        logWarn('handle：執行期間被 reset，丟棄本輪後續流程');
        if (finalPlan.tasks.some((t) => t.status === 'succeeded')) {
          logWarn(
            '注意：本輪存在已成功任務（可能含寫操作）。reset 為強制丟棄語義、不自動回滾；pending_payment 訂單將按支付截止時間自動過期',
          );
        }
        return {
          message: `${BRAND_AI_GENERATED_BY}：本輪任務已被重置中止。`,
          state: this.getState(),
          errorCode: 'RUN_RESET',
        };
      }

      // 3. 結果聚合
      if (finalPlan.status === 'failed') {
        // 失敗回滾（規範 § 8.1）：按反序撤銷已成功且可逆的任務
        await this.rollbackIfNeeded(finalPlan);
        // 規劃層失敗重規劃（規範 § 9「業務錯誤回傳 LLM 調整 Plan」的接線，
        // 借鑑千問Go 動態路徑切換）：僅業務性可替代錯誤（售罄 / 無票等）
        // 嘗試單次自動調整；任何環節不可行返回 null，回落下方原失敗語義
        // （增強路徑非關鍵路徑，不影響失敗語義的正確性）
        const replanRes = await this.tryReplan(intent, token, finalPlan);
        if (replanRes) return replanRes;
        this.transition('failed');
        const rolledCount = finalPlan.tasks.filter((t) => t.status === 'rolled_back').length;
        const rollNote = rolledCount > 0 ? `已回滾 ${rolledCount} 個已成功任務。` : '';
        // 透出首個失敗任務的業務錯誤（如「必填欄位 city 不得為空字串」）：
        // 僅「執行失敗」的通用文案無法指導用戶補充什麼（實測復現——
        // 查詢任務缺城市時用戶不知該補城市）。訊息均為業務級中文
        // 文案，無 URL / 堆疊等代碼級數據（脱敏規範）
        const firstFail = finalPlan.tasks.find((t) => t.status === 'failed');
        const failNote = firstFail?.result?.error?.message ? `原因：${firstFail.result.error.message}。` : '';
        return {
          message: `${BRAND_AI_GENERATED_BY}：執行失敗，部分任務未完成。${failNote}${rollNote}`,
          state: 'failed',
          cards: planCards,
        };
      }
      this.transition('aggregating');
      const message = llmAggregate(finalPlan, BRAND_AI_GENERATED_BY);
      this.transition('completed');
      return {
        message,
        state: 'completed',
        cards: [{ type: 'result', title: '執行結果', payload: { planId: finalPlan.id } }],
      };
    } catch (e) {
      logError('Orchestrator 異常', e);
      // 異常發生時若已被 reset / 新輪接管（模組級註冊表探測，同上）：狀態已歸位，不再轉移
      if (!ACTIVE_RUNS.has(token)) {
        logWarn('handle：異常且執行期間被 reset，丟棄本輪後續流程');
        return {
          message: `${BRAND_AI_GENERATED_BY}：本輪任務已被重置中止。`,
          state: this.getState(),
          errorCode: 'RUN_RESET',
        };
      }
      // 不可恢復異常：先反序撤銷已成功任務再進入 failed（規範 § 9）
      if (this.currentPlan && e instanceof SchedulerDeadlockError) {
        await this.rollbackIfNeeded(this.currentPlan);
      }
      if (e instanceof PlannerLLMError) {
        this.transition('failed');
        return { message: `${BRAND_AI_GENERATED_BY}：${e.message}`, state: 'failed', errorCode: 'LLM_ERROR' };
      }
      if (e instanceof SchedulerDeadlockError) {
        this.transition('failed');
        return {
          message: `${BRAND_AI_GENERATED_BY}：任務卡死，請重新描述。`,
          state: 'failed',
          errorCode: 'DEADLOCK',
        };
      }
      this.transition('failed');
      return {
        message: `${BRAND_AI_GENERATED_BY}：系統異常，請稍後再試。`,
        state: 'failed',
        errorCode: 'UNEXPECTED',
      };
    }
  }

  /** 重置（清空 Plan 但保留 ctx；强制通道，繞過轉移守衛） */
  reset(): void {
    // 清空運行註冊表：在途 Scheduler / checkpoint 流程隨即失效
    //（防併發雙跑與交錯彈窗；模組級設計理由見 ACTIVE_RUNS 註釋）
    ACTIVE_RUNS.clear();
    logWarn(`[runToken] reset：全部運行令牌已失效（實例 #${this.instanceSeq}）`);
    if (this.state !== 'idle' && this.state !== 'completed' && this.state !== 'failed') {
      logWarn(`reset() 從非終態 ${this.state} 強制歸位 idle（繞過轉移守衛）`);
    }
    const prev = this.state;
    this.state = 'idle';
    this.currentPlan = undefined;
    this.options.onStateChange?.('idle', prev);
    logWarn('Orchestrator 已重置');
  }

  /**
   * 失敗回滾（規範 § 8.1 rollbackIfNeeded）：按任務反序撤銷「已成功且可逆」的任務
   *
   * 單一任務回滾失敗僅記 ERROR 並繼續其餘（盡力而為），
   * 不得因單點失敗中斷整體回滾；全部處理完畢由呼叫方接續轉移至 failed。
   */
  private async rollbackIfNeeded(plan: Plan): Promise<void> {
    const targets = plan.tasks
      .filter((t) => t.status === 'succeeded' && getCapability(t.skillId, t.action)?.reversible === true)
      .reverse(); // 反序：後完成的先撤銷，與執行順序對稱
    if (targets.length === 0) {
      logInfo('rollbackIfNeeded：無需回滾的任務');
      return;
    }
    this.transition('rolling_back');
    for (const task of targets) {
      const r = await skillAdapter.rollback(
        task.skillId,
        task.action,
        task.input,
        task.result ?? { success: true },
        this.ctx,
      );
      if (r.rolled) {
        task.status = 'rolled_back';
        task.finishedAt = Date.now();
        this.options.onTaskUpdate?.(task);
      } else {
        logError(`回滾失敗 ${task.id}（${task.skillId}.${task.action}）：${r.reason ?? '未知原因'}`);
      }
    }
  }

  /**
   * 規劃層失敗重規劃（規範 § 9「業務錯誤 → 回傳 LLM 調整 Plan」；單次，不遞歸）
   *
   * 語義：盡力而為的增強路徑——任何環節不可行（無可重規劃失敗 / LLM 無
   * 替代方案 / 執行期間被 reset）均返回 null 或自身響應，呼叫方回落原
   * 失敗語義。成功時直接執行新方案（跳過 confirming_plan，理由見
   * ALLOWED_TRANSITIONS 註釋）；新方案的寫操作仍經 scheduler 內的安全
   * 複核攔截（utils/review），與用戶點名參數不符的替代下單會被擋下。
   *
   * @param intent 本輪用戶原始意圖（重規劃不脫離原目標）
   * @param token 本輪執行令牌（重規劃輪共用，reset 語義全程覆蓋）
   * @param failedPlan 已回滾完畢的失敗方案（僅讀取其失敗任務摘要）
   * @returns 替代方案執行完畢的響應；null = 未觸發或無替代（回落原失敗語義）
   */
  private async tryReplan(
    intent: string,
    token: number,
    failedPlan: Plan,
  ): Promise<AgentResponse | null> {
    // 僅業務性可替代錯誤值得換路徑；取消 / 參數 / 攔截 / 網絡類失敗
    // 各有正確處置，重規劃無濟於事或有規避攔截風險（見白名單註釋）
    const bizFailures = failedPlan.tasks
      .filter((t) => t.status === 'failed' && isReplannableFailure(t.result?.error?.code))
      .map((t) => ({
        action: t.action,
        summary: t.summary,
        errorCode: t.result?.error?.code ?? '',
        errorMessage: t.result?.error?.message ?? '',
      }));
    if (bizFailures.length === 0) return null;
    logInfo(`重規劃觸發：${bizFailures.length} 個業務性失敗任務，嘗試替代路徑`);

    // llmReplan 內部已吞異常返回 null（危機信號 / 解析失敗 / 空方案均放棄），
    // 此處僅防禦 listSlim 等外圍意外拋出
    this.transition('planning');
    const nextPlan = await llmReplan(
      intent,
      this.ctx,
      SkillRegistry.listSlim(),
      { failures: bizFailures },
    ).catch((e: unknown) => {
      logWarn(`重規劃外圍異常（放棄，回落原失敗語義）：${String(e)}`);
      return null;
    });
    if (!nextPlan || nextPlan.tasks.length === 0) {
      logInfo('重規劃：無可行替代方案，回落原失敗語義');
      return null;
    }

    // 新方案直入執行：plan 卡推播提供 UI 能見度（activePlanId 隔離新舊兩
    // 輪任務卡片），行程落庫與首輪同構
    this.currentPlan = nextPlan;
    nextPlan.status = 'confirmed';
    this.options.onPlanUpdate?.(nextPlan);
    saveTripFromPlan(nextPlan);
    this.transition('executing');
    const finalPlan2 = await runScheduler(nextPlan, this.ctx, {
      checkpoint: this.options.autoApproveCheckpoint
        ? () => Promise.resolve(true)
        : this.options.checkpoint,
      onTaskUpdate: (t) => this.handleTaskUpdate(t),
      // 與首輪同源的模組級令牌探測（設計理由見 ACTIVE_RUNS 註釋）
      isRunActive: () => ACTIVE_RUNS.has(token),
    });
    this.currentPlan = finalPlan2;
    updateTripFromPlan(finalPlan2);

    // 重規劃輪執行期間被 reset / 新輪接管：同首輪語義丟棄
    if (!ACTIVE_RUNS.has(token)) {
      logWarn('tryReplan：重規劃執行期間被 reset，丟棄本輪後續流程');
      return {
        message: `${BRAND_AI_GENERATED_BY}：本輪任務已被重置中止。`,
        state: this.getState(),
        errorCode: 'RUN_RESET',
      };
    }

    if (finalPlan2.status === 'failed') {
      // 單次語義：重規劃後仍失敗不再遞歸調整，按常規失敗收斂
      await this.rollbackIfNeeded(finalPlan2);
      this.transition('failed');
      const firstFail = finalPlan2.tasks.find((t) => t.status === 'failed');
      const failNote = firstFail?.result?.error?.message
        ? `原因：${firstFail.result.error.message}。`
        : '';
      const rolledCount = finalPlan2.tasks.filter((t) => t.status === 'rolled_back').length;
      const rollNote = rolledCount > 0 ? `已回滾 ${rolledCount} 個已成功任務。` : '';
      return {
        message: `${BRAND_AI_GENERATED_BY}：已自動調整方案，但替代路徑仍未能完成。${failNote}${rollNote}`,
        state: 'failed',
      };
    }
    this.transition('aggregating');
    const agg = llmAggregate(finalPlan2, BRAND_AI_GENERATED_BY);
    this.transition('completed');
    return {
      message: `${BRAND_AI_GENERATED_BY}：原方案部分路徑受阻，已自動調整為替代方案。\n${agg}`,
      state: 'completed',
    };
  }

  /**
   * 任務更新聯動處理：
   * Scheduler 不持有 Orchestrator 狀態，此處將 task.waiting_human
   * 映射為狀態機的 awaiting_human，讓 UI 即時看到「等待人類確認」。
   */
  private handleTaskUpdate(task: Task): void {
    if (task.status === 'waiting_human' && this.state === 'executing') {
      this.transition('awaiting_human');
    } else if (task.status === 'running' && this.state === 'awaiting_human') {
      this.transition('executing');
    }
    this.options.onTaskUpdate?.(task);
  }

  /** 狀態轉移（含合法性檢查；MVP 寬鬆模式：非法轉移僅告警不中斷） */
  private transition(next: AgentState): void {
    const allowed = ALLOWED_TRANSITIONS[this.state];
    if (allowed && !allowed.includes(next)) {
      logWarn(`非法狀態轉移 ${this.state} → ${next}（已放行，請檢查狀態機時序）`);
    }
    const prev = this.state;
    this.state = next;
    this.options.onStateChange?.(next, prev);
  }
}

/** 便捷工廠：建構 + 處理一輪（一次性會話；confirmPlan / checkpoint 為必填依賴，由呼叫方注入） */
export async function handleOnce(
  intent: string,
  ctxOpts: Parameters<typeof buildContext>[0],
  options: OrchestratorOptions,
): Promise<AgentResponse> {
  const ctx = await buildContext(ctxOpts);
  const orch = new Orchestrator(ctx, options);
  return orch.handle(intent);
}