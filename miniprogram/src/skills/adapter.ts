/**
 * SKILL 統一呼叫適配器
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1
 *
 * Scheduler 透過此適配器呼叫 SKILL，負責：
 *   - 入參 schema 驗證
 *   - 呼叫前 / 後埋點
 *   - 統一錯誤轉換（任何丟擲的 Error 都包成 SkillError）
 *   - 不直接 import 'wx.*'（規範 § 7.1）
 */

import type { AgentContext } from '../types/context';
import type { SkillCapability, SkillError, SkillInstance, SkillResult } from '../types/skill';
import { validate } from '../utils/validator';
import { error as logError, info as logInfo } from '../utils/logger';
import { SkillRegistry } from './registry';

export interface InvokeOptions {
  /** 是否跳過 schema 驗證（內部呼叫用） */
  skipValidation?: boolean;
}

/** 將任意錯誤包裝為 SkillError */
function toSkillError(err: unknown): SkillError {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return err as SkillError;
  }
  return {
    code: 'UNKNOWN',
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}

/** 統一呼叫入口 */
export async function invoke(
  skillId: string,
  action: string,
  input: unknown,
  ctx: AgentContext,
  options: InvokeOptions = {},
): Promise<SkillResult> {
  const inst = SkillRegistry.get(skillId);
  if (!inst) {
    return {
      success: false,
      error: { code: 'SKILL_NOT_FOUND', message: `SKILL ${skillId} 未註冊`, retryable: false },
    };
  }
  const cap = inst.meta.capabilities.find((c) => c.action === action);
  if (!cap) {
    return {
      success: false,
      error: { code: 'CAPABILITY_NOT_FOUND', message: `${skillId} 不支援 ${action}`, retryable: false },
    };
  }

  // 入參 schema 驗證
  if (!options.skipValidation) {
    const v = validate(input, cap.inputSchema);
    if (!v.ok) {
      const detail = v.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return {
        success: false,
        error: { code: 'INVALID_INPUT', message: `入參校驗失敗：${detail}`, retryable: false },
      };
    }
  }

  ctx.trace.skillCalls += 1;
  logInfo(`SKILL 呼叫 ${skillId}.${action}`);
  const t0 = Date.now();
  try {
    const result = await inst.invoke(action, input, ctx);
    logInfo(`SKILL 完成 ${skillId}.${action} 耗時 ${Date.now() - t0}ms`);
    return result;
  } catch (err) {
    logError(`SKILL 拋錯 ${skillId}.${action}`, err);
    return {
      success: false,
      error: toSkillError(err),
    };
  }
}

/** 呼叫 rollback（若 SKILL 未實作則記錄警告） */
export async function rollback(
  skillId: string,
  action: string,
  input: unknown,
  result: SkillResult,
  ctx: AgentContext,
): Promise<{ rolled: boolean; reason?: string }> {
  const inst = SkillRegistry.get(skillId);
  if (!inst || typeof inst.rollback !== 'function') {
    return { rolled: false, reason: 'SKILL 未實作 rollback' };
  }
  try {
    await inst.rollback(action, input, result, ctx);
    logInfo(`SKILL 回滾成功 ${skillId}.${action}`);
    return { rolled: true };
  } catch (err) {
    logError(`SKILL 回滾失敗 ${skillId}.${action}`, err);
    return { rolled: false, reason: String(err) };
  }
}

/** 取得 capability 元資料（給 Scheduler） */
export function getCapability(skillId: string, action: string): SkillCapability | undefined {
  return SkillRegistry.findCapability(skillId, action);
}

/** 確保 SKILL 已實例化（給 ts 型別推導輔助） */
export type { SkillInstance };