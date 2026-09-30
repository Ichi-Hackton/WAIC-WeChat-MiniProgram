/**
 * SKILL 註冊中心
 *
 * 規範來源：.qoder/rules/Agent.md § 7.3
 *
 * 提供：
 *   - 註冊 / 反註冊
 *   - 列出完整 SkillMeta（給管理員 / 測試）
 *   - 列出 SkillMetaSlim（給 Planner，降低 token 消耗）
 *   - 透過 skillId 取得 SkillInstance（給 Scheduler 呼叫）
 */

import type { SkillInstance, SkillMeta, SkillMetaSlim, SkillCapability } from '../types/skill';
import { error as logError, info as logInfo } from '../utils/logger';

class SkillRegistryImpl {
  private readonly map = new Map<string, SkillInstance>();

  /** 註冊 SKILL，若 id 重複則拋錯 */
  register(instance: SkillInstance): void {
    const id = instance.meta.id;
    if (this.map.has(id)) {
      logError(`SKILL id 重複：${id}`);
      throw new Error(`SKILL id 重複：${id}`);
    }
    this.map.set(id, instance);
    logInfo(`SKILL 註冊：${id} v${instance.meta.version}`);
  }

  /** 反註冊 */
  unregister(id: string): void {
    this.map.delete(id);
  }

  /** 透過 id 取得實例（呼叫方負責 null 處理） */
  get(id: string): SkillInstance | undefined {
    return this.map.get(id);
  }

  /** 列出所有 SKILL id */
  listIds(): string[] {
    return Array.from(this.map.keys());
  }

  /** 列出所有完整 SkillMeta（管理 / 測試用） */
  list(): SkillMeta[] {
    return Array.from(this.map.values()).map((i) => i.meta);
  }

  /** 列出 Planner 用的簡化版（slim） */
  listSlim(): SkillMetaSlim[] {
    return Array.from(this.map.values()).map((i) => toSlim(i.meta));
  }

  /** 透過 (skillId, action) 查詢 capability（給 Scheduler 確認 idempotent 等屬性） */
  findCapability(skillId: string, action: string): SkillCapability | undefined {
    const inst = this.map.get(skillId);
    if (!inst) return undefined;
    return inst.meta.capabilities.find((c) => c.action === action);
  }

  /** 清空（測試用） */
  clear(): void {
    this.map.clear();
  }

  /** 數量 */
  size(): number {
    return this.map.size;
  }
}

/** 將 SkillMeta 縮減為 slim（去除 LLM 不需要的元欄位） */
function toSlim(m: SkillMeta): SkillMetaSlim {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    tags: m.tags,
    capabilities: m.capabilities.map((c) => ({
      action: c.action,
      description: c.description,
      inputSchema: c.inputSchema,
      outputSchema: c.outputSchema,
      requiresHumanConfirm: c.requiresHumanConfirm,
    })),
  };
}

/** 單例導出 */
export const SkillRegistry = new SkillRegistryImpl();