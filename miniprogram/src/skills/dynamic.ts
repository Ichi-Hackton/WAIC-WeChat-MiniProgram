/**
 * 動態技能註冊模組（L1）— manifest 同步 + thin proxy 註冊
 *
 * 設計（對應動態技能計劃）：
 *   - 動態技能 = 雲端宣告式 manifest（JSON 數據，絕不下載 / 執行代碼）；
 *     小程序側以 thin proxy 註冊進 SkillRegistry（與 builtin 技能同款
 *     postContainer 轉發模式），規劃器經 listSlim 無差別消費
 *   - 每輪規劃前同步（orchestrator 呼叫）：manifest 失敗 / 停用 / 存儲
 *     不可用 → fail-closed 撤下全部動態技能，內置技能與本輪規劃不受影響
 *   - 命名空間防護：僅接受 skill.dynamic. 前綴條目，manifest 異常數據
 *     無法覆蓋內置技能（register 同 id 拋錯，前綴隔離從源頭杜絕衝突）
 */

import { SkillRegistry } from './registry';
import { postContainer } from '../services/cloud';
import { fetchSkillManifest } from '../services/skills';
import type { DynamicManifestSkill, DynamicRunResult, DynamicSkillManifest } from '../types/dynamic-skill';
import type { AgentContext } from '../types/context';
import type { SkillInstance, SkillMeta, SkillResult } from '../types/skill';
import { info as logInfo, warn as logWarn } from '../utils/logger';

/** 動態技能 id 前綴（與雲端 skill-dynamic-types.ts 契約逐字對齊） */
export const DYN_SKILL_PREFIX = 'skill.dynamic.';

/** 最近一次同步成功的清單修訂標識（相同修訂跳過註冊表操作，省去撤/注開銷） */
let lastRevision: string | null = null;

/** manifest 條目 → SkillMeta（capabilities 單一 run 能力，欄位逐字對齊雲端契約） */
function toMeta(skill: DynamicManifestSkill): SkillMeta {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    owner: skill.owner,
    tags: skill.tags,
    capabilities: skill.capabilities.map((c) => ({
      action: c.action,
      description: c.description,
      inputSchema: c.inputSchema,
      outputSchema: c.outputSchema,
      idempotent: false,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: c.estimatedLatencyMs,
    })),
  };
}

/** manifest 條目 → thin proxy 實例（invoke 統一轉發 /api/skills/run） */
function toProxy(skill: DynamicManifestSkill): SkillInstance {
  const meta = toMeta(skill);
  return {
    meta,
    async invoke(action: string, input: unknown, ctx: AgentContext): Promise<SkillResult> {
      if (action !== 'run') {
        return {
          success: false,
          error: { code: 'CAPABILITY_NOT_FOUND', message: `動態技能僅支援 run（收到 ${action}）`, retryable: false },
        };
      }
      const env = ctx.globals.cloudEnv;
      if (typeof env !== 'string' || env === '') {
        return {
          success: false,
          error: { code: 'CLOUD_ENV_MISSING', message: '雲端環境未配置，無法執行動態技能', retryable: false },
        };
      }
      const res = await postContainer<DynamicRunResult>(
        env,
        '/api/skills/run',
        { skillId: skill.id, input },
        { sessionId: ctx.sessionId },
      );
      if (res.code === 0 && res.data) {
        return { success: true, data: res.data };
      }
      return {
        success: false,
        error: {
          code: `DYNAMIC_${res.code}`,
          message: res.message ?? '動態技能執行失敗',
          retryable: res.code < 0, // 負數碼 = 雲基礎設施不可用（可重試語義）
        },
      };
    },
  };
}

/** 當前註冊表內的動態技能 id 清單 */
function registeredDynamicIds(): string[] {
  return SkillRegistry.listIds().filter((id) => id.startsWith(DYN_SKILL_PREFIX));
}

/** 同步結果 */
export interface DynamicSyncResult {
  /** 同步後已註冊動態技能數 */
  count: number;
  /** 清單修訂標識（'unavailable' = 本次同步失敗已撤下） */
  revision: string;
}

/**
 * 同步動態技能清單（orchestrator 每輪規劃前呼叫）
 *
 * 失敗語義（fail-closed，與雲端 manifest 端點對齊）：
 *   不可達 / 業務失敗 / revision='disabled'/'unavailable'（skills=[]）
 *   → 撤下全部動態技能，規劃器僅見內置技能；絕不靜默保留舊清單。
 */
export async function syncDynamicSkills(ctx: AgentContext): Promise<DynamicSyncResult> {
  const env = ctx.globals.cloudEnv;
  if (typeof env !== 'string' || env === '') {
    return { count: registeredDynamicIds().length, revision: lastRevision ?? 'v0' };
  }

  let manifest: DynamicSkillManifest | null = null;
  try {
    const res = await fetchSkillManifest(env, ctx.sessionId);
    manifest = res.code === 0 && res.data ? res.data : null;
  } catch {
    manifest = null; // 網路層失敗（重試已耗盡）：視同清單不可信
  }

  if (!manifest) {
    const ids = registeredDynamicIds();
    for (const id of ids) SkillRegistry.unregister(id);
    if (ids.length > 0) logWarn(`動態技能清單同步失敗，已撤下 ${ids.length} 個動態技能（fail-closed）`);
    lastRevision = null;
    return { count: 0, revision: 'unavailable' };
  }

  // 相同修訂且無殘留動態技能異常：跳過註冊表操作（高頻路徑快速返回）
  if (manifest.revision === lastRevision) {
    return { count: manifest.skills.length, revision: manifest.revision };
  }

  // 差量同步：撤下已消失條目；更新條目先撤再注（meta 可能變更）
  const targetIds = new Set(manifest.skills.map((s) => s.id));
  for (const id of registeredDynamicIds()) {
    if (!targetIds.has(id)) SkillRegistry.unregister(id);
  }
  let registered = 0;
  for (const s of manifest.skills) {
    if (!s.id.startsWith(DYN_SKILL_PREFIX)) {
      logWarn(`manifest 含非動態前綴條目，已忽略：${s.id}`);
      continue;
    }
    if (SkillRegistry.get(s.id)) SkillRegistry.unregister(s.id);
    try {
      SkillRegistry.register(toProxy(s));
      registered += 1;
    } catch (e) {
      logWarn(`動態技能註冊失敗：${s.id}`, e);
    }
  }
  lastRevision = manifest.revision;
  logInfo(`動態技能清單已同步：${registered} 個（revision=${manifest.revision}）`);
  return { count: registered, revision: manifest.revision };
}

/** 測試輔助：重置同步狀態（與 SkillRegistry.clear 配合使用） */
export function __resetDynamicSync(): void {
  lastRevision = null;
}
