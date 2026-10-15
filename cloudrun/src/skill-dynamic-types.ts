/**
 * 動態技能協議型別與常數（L1→L3）
 *
 * 設計邊界（對應 2026-10 動態技能計劃）：
 *   - 動態技能 = 雲端宣告式定義（JSON），絕不下載 / 執行任意程式碼
 *   - 單一 capability，action 恆為 'run'；idempotent:false（禁用查詢快取，
 *     與「是否唯讀」無關——唯讀保證由服務端執行器與連接器治理承擔）
 *   - 生命週期：draft →（人工審批）approved ⇄ disabled；blocked / rejected 為終態
 *   - 公開面（manifest / center 他人條目）僅含展示所需欄位，
 *     來源需求（requirement / sourceText）僅本人與管理員可見
 */

/** 動態技能 id 前綴（小程序端註冊與撤銷的命名空間邊界） */
export const DYN_SKILL_PREFIX = 'skill.dynamic.';

/** 生命週期狀態 */
export type DynamicStatus = 'draft' | 'blocked' | 'approved' | 'rejected' | 'disabled';

/** 執行器類型 */
export type DynamicKind = 'http' | 'mcp' | 'llm';

/** 受限 inputSchema 的單屬性宣告（僅開放純量型別，禁 ref / 任意鍵） */
export interface RestrictedPropertySchema {
  type: 'string' | 'number' | 'boolean';
  description?: string;
}

/** 受限 inputSchema（JSON Schema 子集：扁平 object + 純量屬性） */
export interface RestrictedInputSchema {
  type: 'object';
  properties: Record<string, RestrictedPropertySchema>;
  required: string[];
  additionalProperties: false;
}

/** 動態技能執行定義（審批後不可原地改寫；變更須重新送審） */
export interface DynamicDefinition {
  kind: DynamicKind;
  /** http / mcp 必填：服務端預註冊連接器 id（禁止模型自帶 URL / 工具名） */
  connectorId?: string;
  /** llm 必填：受限 System Prompt（不得要求即時外部數據） */
  instructions?: string;
  inputSchema: RestrictedInputSchema;
}

/** 持久化記錄（含私有欄位；對外序列化須過濾） */
export interface DynamicSkillRecord {
  id: string;
  ownerOpenid: string;
  status: DynamicStatus;
  /** 樂觀鎖版本（審批 / 停用以 CAS 更新） */
  version: number;
  name: string;
  description: string;
  kind: DynamicKind;
  definition: DynamicDefinition;
  /** 私有：用戶提案原文（已去敏存儲） */
  requirement?: string;
  /** 私有：教材文字（截斷存儲，僅作不可信數據） */
  sourceText?: string;
  /** blocked / rejected 的原因（對本人可見） */
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

/** center 他人 approved 條目 / 本人全部條目的對外形態 */
export interface SkillCenterRecord {
  id: string;
  version: number;
  status: DynamicStatus;
  name: string;
  description: string;
  kind: DynamicKind;
  reason?: string;
  /** 是否為調用方本人提案（前端「我的提案 / 公開技能」分組用） */
  mine: boolean;
  createdAt: number;
  updatedAt: number;
  /** 僅本人與管理員可見 */
  requirement?: string;
  sourceText?: string;
  definition?: DynamicDefinition;
}

/** GET /api/skills/center 回應 data */
export interface SkillCenterData {
  enabled: boolean;
  isAdmin: boolean;
  storage: 'mysql' | 'memory' | 'unavailable';
  connectors: Array<{
    id: string;
    name: string;
    kind: 'http' | 'mcp';
    description: string;
  }>;
  records: SkillCenterRecord[];
}

/** GET /api/skills/manifest 回應 data（小程序動態註冊的單一來源） */
export interface SkillManifestData {
  /** 清單修訂標識（approved 集合任一變更即改變） */
  revision: string;
  /** 與 miniprogram/src/types/skill.d.ts 的 SkillMeta 同構 */
  skills: Array<{
    id: string;
    name: string;
    description: string;
    version: string;
    owner: string;
    tags: string[];
    capabilities: Array<{
      action: 'run';
      description: string;
      inputSchema: RestrictedInputSchema;
      outputSchema: Record<string, unknown>;
      idempotent: false;
      reversible: false;
      requiresHumanConfirm: false;
      estimatedLatencyMs: number;
    }>;
  }>;
}

/** POST /api/skills/run 回應 data（manifest outputSchema 逐字對齊） */
export interface DynamicRunData {
  output: { text: string };
  display: { title: string; lines: Array<{ label: string; value: string }> };
  ai_generated: boolean;
}

/** run 統一 outputSchema（雙端契約，禁止漂移） */
export const RUN_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['output', 'display', 'ai_generated'],
  properties: {
    output: {
      type: 'object',
      required: ['text'],
      properties: { text: { type: 'string', description: '執行結果正文（純文字）' } },
    },
    display: {
      type: 'object',
      required: ['title', 'lines'],
      properties: {
        title: { type: 'string', description: '結果卡標題' },
        lines: {
          type: 'array',
          description: '受控展示行（label/value 純文字）',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
      },
    },
    ai_generated: { type: 'boolean', description: '內容是否由 LLM 生成' },
  },
};

/** 依 kind 的預估延遲（manifest estimatedLatencyMs 用） */
export const KIND_LATENCY_MS: Record<DynamicKind, number> = {
  http: 3000,
  mcp: 15000,
  llm: 20000,
};

/** 記錄轉 center 條目（默認剝除私有欄位） */
export function toCenterRecord(
  rec: DynamicSkillRecord,
  includePrivate: boolean,
  mine: boolean,
): SkillCenterRecord {
  const base: SkillCenterRecord = {
    id: rec.id,
    version: rec.version,
    status: rec.status,
    name: rec.name,
    description: rec.description,
    kind: rec.kind,
    mine,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    ...(rec.reason ? { reason: rec.reason } : {}),
  };
  if (!includePrivate) return base;
  return {
    ...base,
    ...(rec.requirement ? { requirement: rec.requirement } : {}),
    ...(rec.sourceText ? { sourceText: rec.sourceText } : {}),
    definition: rec.definition,
  };
}
