/**
 * 動態技能持久化層 — MySQL 優先 / 開發記憶體降級 / 正式環境 fail-closed
 *
 * 與 db.ts（訂單）的降級語義刻意不同：
 *   - 訂單丟失可接受 → 降級記憶體繼續服務
 *   - 動態技能是「未經發版審查的用戶生成能力」，DB 不可用時若降級記憶體，
 *     審批過的技能會靜默消失、審批日誌斷檔——故正式環境 fail-closed
 *     （拒絕讀寫並回 storage_unavailable），絕不靜默降級
 *
 * 存儲模式判定（resolveStoreMode）：
 *   1. MySQL 表建立成功 → 'mysql'
 *   2. NODE_ENV ≠ production 且 DYNAMIC_SKILL_DEV_MEMORY=1 → 'memory'
 *      （僅開發聯調：重啟丟失、無審批日誌持久化）
 *   3. 其餘 → 'unavailable'（fail-closed）
 *
 * 生命週期轉移一律經 casTransition（樂觀鎖 version），審批動作另記
 * dynamic_skill_reviews 審批日誌（管理員操作可回溯）。
 */

import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { initDb, getDbPool } from './db';
import type { DynamicDefinition, DynamicKind, DynamicSkillRecord, DynamicStatus } from './skill-dynamic-types';

/** 存儲模式（SkillCenterData.storage 同款枚舉） */
export type DynamicStoreMode = 'mysql' | 'memory' | 'unavailable';

/** 審批日誌條目 */
export interface DynamicSkillReviewEntry {
  skillId: string;
  reviewerOpenid: string;
  action: 'approve' | 'reject' | 'disable' | 'enable';
  fromStatus: DynamicStatus;
  toStatus: DynamicStatus;
  note?: string;
  createdAt: number;
}

/** CAS 轉移結果分流 */
export type CasOutcome =
  | { result: 'ok'; record: DynamicSkillRecord }
  | { result: 'not_found' }
  | { result: 'conflict' };

/** 存儲不可用（fail-closed）異常；路由層翻譯為 storage_unavailable */
export class StoreUnavailableError extends Error {
  constructor() {
    super('動態技能存儲不可用（fail-closed）');
    this.name = 'StoreUnavailableError';
  }
}

/** 動態技能主表（definition 為 JSON 欄位；kind 冗餘列以利 center 過濾展示） */
const DYNAMIC_DDL = `
  CREATE TABLE IF NOT EXISTS dynamic_skills (
    id           VARCHAR(64)  NOT NULL PRIMARY KEY,
    owner_openid VARCHAR(128) NOT NULL,
    status       VARCHAR(16)  NOT NULL,
    version      INT          NOT NULL DEFAULT 1,
    name         VARCHAR(40)  NOT NULL,
    description  VARCHAR(300) NOT NULL,
    kind         VARCHAR(8)   NOT NULL,
    definition   JSON         NOT NULL,
    requirement  TEXT         NULL,
    source_text  MEDIUMTEXT   NULL,
    reason       VARCHAR(300) NULL,
    created_at   BIGINT       NOT NULL,
    updated_at   BIGINT       NOT NULL,
    KEY idx_dyn_owner (owner_openid),
    KEY idx_dyn_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/** 審批日誌表（管理員動作可回溯；seq 自增即時間序） */
const REVIEW_DDL = `
  CREATE TABLE IF NOT EXISTS dynamic_skill_reviews (
    seq             BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    skill_id        VARCHAR(64)  NOT NULL,
    reviewer_openid VARCHAR(128) NOT NULL,
    action          VARCHAR(16)  NOT NULL,
    from_status     VARCHAR(16)  NOT NULL,
    to_status       VARCHAR(16)  NOT NULL,
    note            VARCHAR(300) NULL,
    created_at      BIGINT       NOT NULL,
    KEY idx_review_skill (skill_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/** 動態表初始化守衛（並發呼叫共享同一 Promise；失敗僅記日誌，模式判定吸收） */
let dynInitPromise: Promise<void> | null = null;

/** 記憶體模式表：id → 記錄（僅開發聯調；讀寫皆經 clone 防外部別名改寫） */
const memoryRecords = new Map<string, DynamicSkillRecord>();

/** 記憶體審批日誌（上限 1000 條，防無界增長） */
const memoryReviews: DynamicSkillReviewEntry[] = [];

/** 測試專用模式覆蓋（null = 恢復環境判定；僅測試與本地腳本可設） */
let modeOverride: DynamicStoreMode | null = null;

/** 深拷貝一筆記錄（防 Map 內物件被外部引用改寫；definition 結構固定兩層） */
function cloneRecord(rec: DynamicSkillRecord): DynamicSkillRecord {
  return {
    ...rec,
    definition: {
      ...rec.definition,
      inputSchema: {
        ...rec.definition.inputSchema,
        properties: { ...rec.definition.inputSchema.properties },
        required: [...rec.definition.inputSchema.required],
      },
    },
  };
}

/** 確保動態表已建（冪等；不拋出） */
async function ensureDynReady(): Promise<void> {
  if (!dynInitPromise) {
    dynInitPromise = (async () => {
      await initDb();
      const pool = getDbPool();
      if (!pool) return;
      try {
        await pool.query(DYNAMIC_DDL);
        await pool.query(REVIEW_DDL);
      } catch (e) {
        // 表建立失敗：模式仍回報 mysql，後續查詢將拋錯 → 路由層 fail-closed
        console.error(`[skill-dynamic] 動態技能表建立失敗（後續操作將 fail-closed）：${e instanceof Error ? e.message : String(e)}`);
      }
    })().catch(() => {
      /* 內部已處理日誌，吸收拒絕避免未處理 Promise */
    });
  }
  await dynInitPromise;
}

/**
 * 解析當前存儲模式（每次呼叫即時判定；測試覆蓋優先）
 *
 * 注意 'memory' 需同時滿足非正式環境 + 顯式開發開關，
 * 正式環境 DB 不可用一律 'unavailable'（fail-closed）。
 */
export async function resolveStoreMode(): Promise<DynamicStoreMode> {
  if (modeOverride) return modeOverride;
  await ensureDynReady();
  if (getDbPool()) return 'mysql';
  if (process.env.NODE_ENV !== 'production' && process.env.DYNAMIC_SKILL_DEV_MEMORY === '1') {
    return 'memory';
  }
  return 'unavailable';
}

/** 寫路徑前置：不可用即拋 StoreUnavailableError */
async function requireStore(): Promise<'mysql' | 'memory'> {
  const mode = await resolveStoreMode();
  if (mode === 'unavailable') throw new StoreUnavailableError();
  return mode;
}

/** DB 列 → 領域記錄（definition JSON 欄位相容字串 / 物件兩種驅動形態） */
function rowToRecord(row: RowDataPacket): DynamicSkillRecord {
  const defRaw = row.definition as unknown;
  let definition: DynamicDefinition;
  if (typeof defRaw === 'string') {
    definition = JSON.parse(defRaw) as DynamicDefinition;
  } else {
    definition = defRaw as DynamicDefinition;
  }
  const rec: DynamicSkillRecord = {
    id: String(row.id),
    ownerOpenid: String(row.owner_openid),
    status: String(row.status) as DynamicStatus,
    version: Number(row.version),
    name: String(row.name),
    description: String(row.description),
    kind: String(row.kind) as DynamicKind,
    definition,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  const requirement = row.requirement;
  if (typeof requirement === 'string' && requirement.length > 0) rec.requirement = requirement;
  const sourceText = row.source_text;
  if (typeof sourceText === 'string' && sourceText.length > 0) rec.sourceText = sourceText;
  const reason = row.reason;
  if (typeof reason === 'string' && reason.length > 0) rec.reason = reason;
  return rec;
}

/** 查詢用欄位清單（INSERT / SELECT 保持逐字對齊） */
const COLS = 'id, owner_openid, status, version, name, description, kind, definition, requirement, source_text, reason, created_at, updated_at';

/** 建立技能記錄（id 衝突由主鍵拒絕；呼叫方以 getSkill 先行實現冪等） */
export async function createSkill(record: DynamicSkillRecord): Promise<void> {
  const mode = await requireStore();
  if (mode === 'memory') {
    memoryRecords.set(record.id, cloneRecord(record));
    return;
  }
  const pool = getDbPool();
  if (!pool) throw new StoreUnavailableError();
  await pool.execute(
    `INSERT INTO dynamic_skills (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.ownerOpenid,
      record.status,
      record.version,
      record.name,
      record.description,
      record.kind,
      JSON.stringify(record.definition),
      record.requirement ?? null,
      record.sourceText ?? null,
      record.reason ?? null,
      record.createdAt,
      record.updatedAt,
    ],
  );
}

/** 按 ID 取記錄（含全部狀態；不存在回 null） */
export async function getSkill(id: string): Promise<DynamicSkillRecord | null> {
  const mode = await resolveStoreMode();
  if (mode === 'memory') {
    const rec = memoryRecords.get(id);
    return rec ? cloneRecord(rec) : null;
  }
  if (mode === 'unavailable') return null; // 讀路徑降級為空清單語義（manifest 收斂為無動態技能）
  const pool = getDbPool();
  if (!pool) return null;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${COLS} FROM dynamic_skills WHERE id = ?`,
    [id],
  );
  return rows.length > 0 ? rowToRecord(rows[0]) : null;
}

/**
 * 列出 center 條目：本人全部 + 他人 approved（管理員另見全部 draft，
 * 供審批工作台使用；他人 blocked / rejected / disabled 一律不可見）
 */
export async function listSkillsForCenter(viewerOpenid: string, isAdmin: boolean): Promise<DynamicSkillRecord[]> {
  const mode = await resolveStoreMode();
  if (mode === 'memory') {
    return Array.from(memoryRecords.values())
      .filter((r) => r.ownerOpenid === viewerOpenid || isAdmin || r.status === 'approved')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneRecord);
  }
  if (mode === 'unavailable') return [];
  const pool = getDbPool();
  if (!pool) return [];
  const visible = isAdmin ? '' : " OR status = 'approved'";
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${COLS} FROM dynamic_skills WHERE owner_openid = ?${visible} ORDER BY updated_at DESC LIMIT 200`,
    [viewerOpenid],
  );
  return rows.map(rowToRecord);
}

/** 列出全部 approved（manifest 唯一數據源；新→舊） */
export async function listApproved(): Promise<DynamicSkillRecord[]> {
  const mode = await resolveStoreMode();
  if (mode === 'memory') {
    return Array.from(memoryRecords.values())
      .filter((r) => r.status === 'approved')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(cloneRecord);
  }
  if (mode === 'unavailable') return [];
  const pool = getDbPool();
  if (!pool) return [];
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${COLS} FROM dynamic_skills WHERE status = 'approved' ORDER BY updated_at DESC LIMIT 200`,
  );
  return rows.map(rowToRecord);
}

/**
 * CAS 生命週期轉移（樂觀鎖：WHERE version = expectedVersion）
 *
 * 僅允許改變 status / reason（definition 不可原地改寫，變更須重新提案送審）。
 * affectedRows=0 時以再查詢分流 not_found / conflict。
 */
export async function casTransition(
  id: string,
  expectedVersion: number,
  patch: { status: DynamicStatus; reason?: string },
): Promise<CasOutcome> {
  const mode = await requireStore();
  const now = Date.now();
  if (mode === 'memory') {
    const rec = memoryRecords.get(id);
    if (!rec) return { result: 'not_found' };
    if (rec.version !== expectedVersion) return { result: 'conflict' };
    const next = cloneRecord(rec);
    next.status = patch.status;
    next.version = rec.version + 1;
    next.updatedAt = now;
    if (patch.reason !== undefined) next.reason = patch.reason;
    memoryRecords.set(id, next);
    return { result: 'ok', record: cloneRecord(next) };
  }
  const pool = getDbPool();
  if (!pool) throw new StoreUnavailableError();
  const [res] = await pool.execute<ResultSetHeader>(
    'UPDATE dynamic_skills SET status = ?, reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
    [patch.status, patch.reason ?? null, now, id, expectedVersion],
  );
  if (res.affectedRows > 0) {
    const got = await getSkill(id);
    if (got) return { result: 'ok', record: got };
    return { result: 'not_found' }; // 理論不可達（剛更新成功），防禦性分流
  }
  const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM dynamic_skills WHERE id = ?', [id]);
  return rows.length > 0 ? { result: 'conflict' } : { result: 'not_found' };
}

/** 追加審批日誌（記錄失敗不阻斷主流程，僅記 ERROR） */
export async function appendReview(entry: DynamicSkillReviewEntry): Promise<void> {
  const mode = await resolveStoreMode();
  if (mode === 'memory') {
    memoryReviews.push(entry);
    if (memoryReviews.length > 1000) memoryReviews.shift();
    return;
  }
  if (mode === 'unavailable') return; // 不可用時日誌無處可寫，主流程已由 casTranslation 擋下
  const pool = getDbPool();
  if (!pool) return;
  try {
    await pool.execute(
      'INSERT INTO dynamic_skill_reviews (skill_id, reviewer_openid, action, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [entry.skillId, entry.reviewerOpenid, entry.action, entry.fromStatus, entry.toStatus, entry.note ?? null, entry.createdAt],
    );
  } catch (e) {
    console.error(`[skill-dynamic] 審批日誌寫入失敗（不阻斷）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 列出某技能的審批日誌（舊→新；僅管理員審批工作台使用） */
export async function listReviews(skillId: string): Promise<DynamicSkillReviewEntry[]> {
  const mode = await resolveStoreMode();
  if (mode === 'memory') {
    return memoryReviews.filter((r) => r.skillId === skillId).map((r) => ({ ...r }));
  }
  if (mode === 'unavailable') return [];
  const pool = getDbPool();
  if (!pool) return [];
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT skill_id, reviewer_openid, action, from_status, to_status, note, created_at FROM dynamic_skill_reviews WHERE skill_id = ? ORDER BY seq ASC LIMIT 50',
    [skillId],
  );
  return rows.map((row) => {
    const entry: DynamicSkillReviewEntry = {
      skillId: String(row.skill_id),
      reviewerOpenid: String(row.reviewer_openid),
      action: String(row.action) as DynamicSkillReviewEntry['action'],
      fromStatus: String(row.from_status) as DynamicStatus,
      toStatus: String(row.to_status) as DynamicStatus,
      createdAt: Number(row.created_at),
    };
    const note = row.note;
    if (typeof note === 'string' && note.length > 0) entry.note = note;
    return entry;
  });
}

// ---- 測試輔助（僅供 node --test 與本地腳本；生產代碼禁止呼叫） ----

/** 覆蓋存儲模式判定（null 恢復環境判定） */
export function setStoreModeOverrideForTests(mode: DynamicStoreMode | null): void {
  modeOverride = mode;
}

/** 清空記憶體表（測試隔離用） */
export function __resetMemoryStore(): void {
  memoryRecords.clear();
  memoryReviews.length = 0;
}
