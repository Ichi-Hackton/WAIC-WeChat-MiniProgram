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

/** 將 SkillMeta 縮減為 slim（去除 LLM 不需要的元欄位；schema 壓縮見 summarizeSchema） */
function toSlim(m: SkillMeta): SkillMetaSlim {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    tags: m.tags,
    capabilities: m.capabilities.map((c) => ({
      action: c.action,
      description: c.description,
      params: summarizeSchema(c.inputSchema),
      requiresHumanConfirm: c.requiresHumanConfirm,
    })),
  };
}

/**
 * 將 inputSchema 壓縮為緊湊參數摘要，如：
 *   "from: string(必填，出發城市); date: string(可選，YYYY-MM-DD)"
 *
 * 規劃期 LLM 只需參數名 / 型別 / 必填 / 含義；完整 JSON Schema 經縮進
 * 序列化隨 SKILL 數量膨脹（15 個 SKILL 實測 63520 字元），撞爆雲端
 * llm-chat 單條消息 16000 字元上限，令 LLM 規劃永久 400 而降級規則
 * 規劃器。enum / description 對規劃決策有價值，保留進摘要。
 */
function summarizeSchema(schema: SkillCapability['inputSchema']): string {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const parts: string[] = [];
  for (const [name, p] of Object.entries(props)) {
    const bits: string[] = [required.has(name) ? '必填' : '可選'];
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      bits.push(`可選值 ${p.enum.map((v) => String(v)).join('|')}`);
    }
    if (p.description) bits.push(p.description);
    let type = Array.isArray(p.type) ? p.type.join('|') : (p.type ?? 'unknown');
    // 嵌套 array<object> 參數（如點單 items[]）展開一層元素鍵名——
    // 否則必填欄位（sku/quantity 等）對 LLM 完全不可見，規劃只能盲猜元素形狀
    const innerKeys = p.type === 'array' && p.items?.properties
      ? Object.keys(p.items.properties).join(',')
      : '';
    if (innerKeys) type = `array<object{${innerKeys}}>`;
    parts.push(`${name}: ${type}(${bits.join('，')})`);
  }
  return parts.join('; ');
}

/** 單例導出 */
export const SkillRegistry = new SkillRegistryImpl();