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

import { buildContext } from './context';
import { plan as llmPlan, understand, aggregate as llmAggregate, PlannerLLMError } from '../llm/client';
import { run as runScheduler, SchedulerDeadlockError } from './scheduler';
import * as skillAdapter from '../skills/adapter';
import { getCapability } from '../skills/adapter';
import { SkillRegistry } from '../skills/registry';
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
 */
const ALLOWED_TRANSITIONS: Readonly<Record<AgentState, ReadonlyArray<AgentState>>> = {
  idle: ['understanding'],
  understanding: ['planning', 'failed', 'idle'],
  planning: ['confirming_plan', 'failed', 'idle'],
  confirming_plan: ['executing', 'idle', 'failed'],
  executing: ['awaiting_human', 'aggregating', 'rolling_back', 'failed'],
  awaiting_human: ['executing', 'rolling_back', 'failed'],
  aggregating: ['completed', 'failed'],
  rolling_back: ['failed', 'completed'],
  completed: ['idle'],
  failed: ['idle'],
};

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
   * @param intent 用戶自然語言意圖
   */
  async handle(intent: string): Promise<AgentResponse> {
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
      const u = await understand(intent, this.ctx);
      if (u.kind === 'clarify') {
        // 狀態機歸位：提前返回必須轉回 idle，否則後續請求永久 BUSY
        this.transition('idle');
        return {
          message: `${BRAND_AI_GENERATED_BY}：${u.clarification ?? '請補充資訊'}`,
          state: 'idle',
        };
      }

      this.transition('planning');
      // availableSkills 由 core 層取註冊表後傳入（llm 層不得反向依賴 skills，§ 12.3）
      const planObj = await llmPlan(intent, this.ctx, SkillRegistry.listSlim());
      if (planObj.tasks.length === 0) {
        // 狀態機歸位：同上（空 tasks 為高頻路徑，LLM 對不支援意圖或缺參數回空 tasks）
        this.transition('idle');
        // note = LLM 追問文案（如「請補充出行日期」）：引導用戶補充後重試，
        // 區別於「無法識別」（EMPTY_PLAN）
        if (planObj.note) {
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
        this.transition('failed');
        const rolledCount = finalPlan.tasks.filter((t) => t.status === 'rolled_back').length;
        const rollNote = rolledCount > 0 ? `已回滾 ${rolledCount} 個已成功任務。` : '';
        return {
          message: `${BRAND_AI_GENERATED_BY}：執行失敗，部分任務未完成。${rollNote}`,
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