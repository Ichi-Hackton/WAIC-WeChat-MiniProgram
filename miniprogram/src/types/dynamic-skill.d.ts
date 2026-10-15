/**
 * 動態技能雙端契約 — 小程序側類型副本
 *
 * 與雲端 cloudrun/src/skill-dynamic-types.ts 的公開形態逐字對齊
 * （微信小程序包不能跨包根引用，契約以兩份副本維護，變更須同步）。
 * 常量 DYN_SKILL_PREFIX 為 runtime 值，置於 skills/dynamic.ts（.d.ts 不能承載值）。
 */

/** 生命週期狀態（雲端 skill-dynamic-types.ts 同款枚舉） */
export type DynamicStatus = 'draft' | 'blocked' | 'approved' | 'rejected' | 'disabled';

/** 執行器類型 */
export type DynamicKind = 'http' | 'mcp' | 'llm';

/** 受限 inputSchema（扁平 object + 純量屬性；服務端 forge/審批雙重校驗） */
export interface DynamicInputSchema {
  type: 'object';
  properties: Record<string, { type: 'string' | 'number' | 'boolean'; description?: string }>;
  required: string[];
  additionalProperties: false;
}

/** GET /api/skills/manifest 回應 data（動態註冊唯一數據源） */
export interface DynamicSkillManifest {
  /** 清單修訂標識（'v0'=空清單；'disabled'=功能停用；'unavailable'=存儲不可用） */
  revision: string;
  skills: DynamicManifestSkill[];
}

/** manifest 單條技能（SkillMeta 同構；單一 capability action='run'） */
export interface DynamicManifestSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  owner: string;
  tags: string[];
  capabilities: Array<{
    action: 'run';
    description: string;
    inputSchema: DynamicInputSchema;
    outputSchema: Record<string, unknown>;
    idempotent: false;
    reversible: false;
    requiresHumanConfirm: false;
    estimatedLatencyMs: number;
  }>;
}

/** POST /api/skills/run 回應 data（受控展示協議；ai_generated 為合規標識） */
export interface DynamicRunResult {
  output: { text: string };
  display: { title: string; lines: Array<{ label: string; value: string }> };
  ai_generated: boolean;
}

/** center 條目（他人 approved 公開形態；本人 / 管理員另含私有欄位） */
export interface DynamicCenterRecord {
  id: string;
  version: number;
  status: DynamicStatus;
  name: string;
  description: string;
  kind: DynamicKind;
  reason?: string;
  /** 是否為調用方本人提案（「我的提案 / 公開技能」分組用） */
  mine: boolean;
  createdAt: number;
  updatedAt: number;
  /** 僅本人與管理員可見 */
  requirement?: string;
  sourceText?: string;
  definition?: {
    kind: DynamicKind;
    connectorId?: string;
    instructions?: string;
    inputSchema: DynamicInputSchema;
  };
}

/** GET /api/skills/center 回應 data */
export interface DynamicSkillCenter {
  enabled: boolean;
  isAdmin: boolean;
  storage: 'mysql' | 'memory' | 'unavailable';
  connectors: Array<{ id: string; name: string; kind: 'http' | 'mcp'; description: string }>;
  records: DynamicCenterRecord[];
}

/** POST /api/skills/forge 回應 data */
export interface DynamicForgeResult {
  status: 'draft' | 'blocked';
  duplicate: boolean;
  record: DynamicCenterRecord;
}

/** 審批決策（管理員專用；CAS 版本鎖） */
export type DynamicReviewDecision = 'approve' | 'reject' | 'disable' | 'enable';

/** POST /api/skills/review 回應 data */
export interface DynamicReviewResult {
  record: DynamicCenterRecord;
}
