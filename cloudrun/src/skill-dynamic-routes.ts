/**
 * 動態技能路由（L1→L3 對外五端點）
 *
 *   GET  /api/skills/manifest  動態技能清單（小程序動態註冊唯一數據源）
 *   GET  /api/skills/center    技能中心（本人提案 + 公開技能 + 管理員審批視圖）
 *   POST /api/skills/forge     LLM 起草技能（冪等 requestId）
 *   POST /api/skills/review    管理員審批（approve / reject / disable / enable；CAS）
 *   POST /api/skills/run       執行已上架動態技能（統一入口）
 *
 * 環境變數：
 *   ENABLE_DYNAMIC_SKILLS        總開關（'0' 關閉；默認開啟）
 *   DYNAMIC_SKILL_ADMIN_OPENIDS  管理員 openid 名單（逗號 / 空白分隔）
 *   DYNAMIC_SKILL_FORGE_QUOTA    每 openid 每小時鍛造次數（默認 5）
 *
 * 鑒權矩陣：
 *   manifest / center  匿名可讀（center 匿名僅見公開 approved 條目）
 *   forge / run        需 openid（401；配額以 openid 計）
 *   review             需 openid 且為管理員（401 / 403；人工審批不可繞過）
 */

import { createHash } from 'node:crypto';
import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';
import { listConnectorsPublic } from './skill-dynamic-connectors';
import { containsResidualPii, validateInputSchema } from './skill-dynamic-schema';
import {
  listApproved,
  listSkillsForCenter,
  resolveStoreMode,
  getSkill,
  casTransition,
  appendReview,
  StoreUnavailableError,
} from './skill-dynamic-store';
import { checkRunQuota, runDynamic, DynamicRunError } from './skill-dynamic-executor';
import { forgeDraft } from './skill-dynamic-forge';
import {
  KIND_LATENCY_MS,
  RUN_OUTPUT_SCHEMA,
  toCenterRecord,
  type DynamicSkillRecord,
  type SkillCenterData,
  type SkillManifestData,
} from './skill-dynamic-types';

/** 動態技能總開關 */
function dynamicEnabled(): boolean {
  return process.env.ENABLE_DYNAMIC_SKILLS !== '0';
}

/** 管理員名單（逗號 / 空白分隔的 openid 集合） */
function adminSet(): Set<string> {
  const raw = process.env.DYNAMIC_SKILL_ADMIN_OPENIDS ?? '';
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** openid 是否管理員 */
export function isAdminOpenid(openid: string | undefined): boolean {
  if (!openid) return false;
  return adminSet().has(openid);
}

/** 鍛造頻控窗口：openid → 時間戳 */
const forgeWindow = new Map<string, number[]>();

/** 檢查鍛造配額（超限拋 Error；進程內滑動窗口，與 run 配額同策略） */
function checkForgeQuota(openid: string): void {
  const quota = Math.max(1, Number(process.env.DYNAMIC_SKILL_FORGE_QUOTA ?? 5) || 5);
  const now = Date.now();
  const window = (forgeWindow.get(openid) ?? []).filter((t) => now - t < 3_600_000);
  if (window.length >= quota) {
    forgeWindow.set(openid, window);
    throw new Error(`鍛造請求已達每小時上限（${quota} 次），請稍後再試`);
  }
  window.push(now);
  forgeWindow.set(openid, window);
}

/** 清單修訂標識：approved 集合（id+version）排序雜湊；空集合恆 'v0' */
function computeRevision(records: DynamicSkillRecord[]): string {
  if (records.length === 0) return 'v0';
  const keys = records.map((r) => `${r.id}@${r.version}`).sort();
  return createHash('sha1').update(keys.join('|')).digest('hex').slice(0, 12);
}

/** 記錄 → manifest 條目（SkillMeta 同構；owner 以固定標識替代，不洩露 openid） */
function toManifestSkill(rec: DynamicSkillRecord): SkillManifestData['skills'][number] {
  return {
    id: rec.id,
    name: rec.name,
    description: rec.description,
    version: `dyn.${rec.version}`,
    owner: 'micromate-dynamic',
    tags: ['動態'],
    capabilities: [
      {
        action: 'run' as const,
        description: rec.description,
        inputSchema: rec.definition.inputSchema,
        outputSchema: RUN_OUTPUT_SCHEMA,
        idempotent: false,
        reversible: false,
        requiresHumanConfirm: false,
        estimatedLatencyMs: KIND_LATENCY_MS[rec.definition.kind],
      },
    ],
  };
}

// ---- GET /api/skills/manifest ----

const handleManifest: RouteHandler = async () => {
  if (!dynamicEnabled()) {
    return ok<SkillManifestData>({ revision: 'disabled', skills: [] });
  }
  // 存儲不可用：fail-closed 且以 revision 標識（小程序端據此區分「無技能」與「存儲異常」）
  if ((await resolveStoreMode()) === 'unavailable') {
    return ok<SkillManifestData>({ revision: 'unavailable', skills: [] });
  }
  try {
    const approved = await listApproved();
    return ok<SkillManifestData>({
      revision: computeRevision(approved),
      skills: approved.map(toManifestSkill),
    });
  } catch (e) {
    // 存儲異常：fail-closed（清單收斂為空，小程序端撤下全部動態技能）
    console.error(`[skill-dynamic] manifest 讀取失敗（fail-closed 為空清單）：${e instanceof Error ? e.message : String(e)}`);
    return ok<SkillManifestData>({ revision: 'unavailable', skills: [] });
  }
};

// ---- GET /api/skills/center ----

const handleCenter: RouteHandler = async (_body, ctx) => {
  const openid = ctx.openid ?? '';
  const isAdmin = isAdminOpenid(ctx.openid);
  const storage = await resolveStoreMode();
  let records: DynamicSkillRecord[] = [];
  try {
    records = await listSkillsForCenter(openid, isAdmin);
  } catch (e) {
    console.error(`[skill-dynamic] center 讀取失敗（以空清單返回）：${e instanceof Error ? e.message : String(e)}`);
  }
  const data: SkillCenterData = {
    enabled: dynamicEnabled(),
    isAdmin,
    storage,
    connectors: dynamicEnabled() ? listConnectorsPublic() : [],
    records: records.map((r) => toCenterRecord(r, r.ownerOpenid === openid || isAdmin, r.ownerOpenid === openid)),
  };
  return ok(data);
};

// ---- POST /api/skills/forge ----

const handleForge: RouteHandler = async (body, ctx) => {
  if (!ctx.openid) return unauthorized('鍛造需要登入身份');
  if (!dynamicEnabled()) return fail(2001, '動態技能功能未開放');
  const o = (body ?? {}) as Record<string, unknown>;
  const requestId = o.requestId;
  const requirement = o.requirement;
  const sourceText = o.sourceText;
  if (typeof requestId !== 'string' || typeof requirement !== 'string') {
    return badRequest('requestId 與 requirement 必須為字串');
  }
  if (requirement.trim().length < 4 || requirement.length > 1200) {
    return badRequest('需求描述須為 4-1200 字');
  }
  if (sourceText !== undefined && (typeof sourceText !== 'string' || sourceText.length > 8000)) {
    return badRequest('教材內容須為 ≤8000 字字串');
  }
  try {
    checkForgeQuota(ctx.openid);
  } catch (e) {
    return fail(2002, e instanceof Error ? e.message : '鍛造請求過於頻繁');
  }
  try {
    const outcome = await forgeDraft(ctx.openid, requestId, requirement, typeof sourceText === 'string' && sourceText.trim().length > 0 ? sourceText : undefined);
    if (outcome.action === 'error') {
      return fail(2003, outcome.message);
    }
    return ok({
      status: outcome.action,
      duplicate: outcome.duplicate,
      record: toCenterRecord(outcome.record, true, true),
    });
  } catch (e) {
    if (e instanceof StoreUnavailableError) {
      return fail(2004, '技能存儲暫不可用，請稍後再試');
    }
    console.error(`[skill-dynamic] forge 異常：${e instanceof Error ? e.message : String(e)}`);
    return fail(2005, '鍛造服務異常，請稍後再試');
  }
};

// ---- POST /api/skills/review ----

/** decision → 允許的來源狀態與目標狀態 */
const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  approve: { from: ['draft'], to: 'approved' },
  reject: { from: ['draft'], to: 'rejected' },
  disable: { from: ['approved'], to: 'disabled' },
  enable: { from: ['disabled'], to: 'approved' },
};

const handleReview: RouteHandler = async (body, ctx) => {
  if (!ctx.openid) return unauthorized('審批需要登入身份');
  if (!isAdminOpenid(ctx.openid)) {
    return forbidden('審批為管理員專用操作');
  }
  const o = (body ?? {}) as Record<string, unknown>;
  const skillId = o.skillId;
  const decision = o.decision;
  const expectedVersion = o.expectedVersion;
  const note = o.note;
  if (typeof skillId !== 'string' || typeof decision !== 'string' || typeof expectedVersion !== 'number') {
    return badRequest('skillId / decision / expectedVersion(name:number) 必填');
  }
  const trans = TRANSITIONS[decision];
  if (!trans) return badRequest('decision 必須為 approve / reject / disable / enable');
  if (note !== undefined && (typeof note !== 'string' || note.length > 200)) {
    return badRequest('note 須為 ≤200 字字串');
  }
  try {
    const rec = await getSkill(skillId);
    if (!rec) return fail(2010, '技能記錄不存在');
    if (!trans.from.includes(rec.status)) {
      return fail(2011, `目前狀態 ${rec.status} 不允許 ${decision}（允許來源：${trans.from.join(' / ')}）`);
    }
    // approve 前縱深複檢：受限 schema + 公開欄位 PII 殘留（防繞過 forge 校驌的髒數據上架）
    if (decision === 'approve') {
      const schemaCheck = validateInputSchema(rec.definition.inputSchema);
      if (!schemaCheck.ok) return fail(2012, `技能定義未通過複檢：${schemaCheck.error}`);
      const publicText = [rec.name, rec.description, rec.definition.instructions ?? ''].join('\n');
      if (containsResidualPii(publicText)) return fail(2013, '技能公開欄位含殘留敏感信息，禁止上架');
    }
    const outcome = await casTransition(skillId, expectedVersion, { status: trans.to as typeof rec.status });
    if (outcome.result === 'not_found') return fail(2010, '技能記錄不存在');
    if (outcome.result === 'conflict') return fail(2014, '技能版本已變更，請刷新後重試');
    await appendReview({
      skillId,
      reviewerOpenid: ctx.openid,
      action: decision as 'approve' | 'reject' | 'disable' | 'enable',
      fromStatus: rec.status,
      toStatus: trans.to as typeof rec.status,
      ...(typeof note === 'string' && note.length > 0 ? { note } : {}),
      createdAt: Date.now(),
    });
    return ok({ record: toCenterRecord(outcome.record, true, outcome.record.ownerOpenid === ctx.openid) });
  } catch (e) {
    if (e instanceof StoreUnavailableError) {
      return fail(2004, '技能存儲暫不可用，請稍後再試');
    }
    console.error(`[skill-dynamic] review 異常：${e instanceof Error ? e.message : String(e)}`);
    return fail(2015, '審批服務異常，請稍後再試');
  }
};

// ---- POST /api/skills/run ----

const handleRun: RouteHandler = async (body, ctx) => {
  if (!ctx.openid) return unauthorized('執行動態技能需要登入身份');
  if (!dynamicEnabled()) return fail(2001, '動態技能功能未開放');
  const o = (body ?? {}) as Record<string, unknown>;
  const skillId = o.skillId;
  const input = o.input;
  if (typeof skillId !== 'string' || typeof input !== 'object' || input === null || Array.isArray(input)) {
    return badRequest('skillId 必填且 input 必須為物件');
  }
  try {
    const rec = await getSkill(skillId);
    if (!rec || rec.status !== 'approved') {
      return fail(2020, '技能不存在或未上架');
    }
    checkRunQuota(ctx.openid);
    const data = await runDynamic(rec, input, ctx);
    return ok(data);
  } catch (e) {
    if (e instanceof DynamicRunError) {
      return fail(2021, e.message);
    }
    if (e instanceof StoreUnavailableError) {
      return fail(2020, '技能不存在或未上架'); // fail-closed：不可用視同未上架
    }
    console.error(`[skill-dynamic] run 異常：${e instanceof Error ? e.message : String(e)}`);
    return fail(2022, '技能執行異常，請稍後再試');
  }
};

/** 路由表 entries（server.ts 展開註冊） */
export const dynamicSkillRoutes: Array<[string, RouteHandler]> = [
  ['GET /api/skills/manifest', handleManifest],
  ['GET /api/skills/center', handleCenter],
  ['POST /api/skills/forge', handleForge],
  ['POST /api/skills/review', handleReview],
  ['POST /api/skills/run', handleRun],
];
