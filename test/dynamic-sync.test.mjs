/**
 * 動態技能前端隔離測試（node --test，導入 tsc 編譯後的 dist-test CJS 產物）
 *
 * 覆蓋（對應動態技能計劃驗收「前端測試覆蓋」項）：
 *   1. 清單新增 / 移除 / 碰撞（非 skill.dynamic. 前綴條目忽略，內置技能不可覆蓋）
 *   2. 刷新故障 fail-closed（網路失敗 / 業務失敗 → 全量撤下動態技能，內置不受影響）
 *   3. 相同修訂跳過註冊表操作（冪等：不撤換既有 proxy 實例）
 *   4. 規劃註冊白名單：同步後 listSlim 含動態技能（規劃器可見性）
 *   5. thin proxy invoke 轉發（/api/skills/run 契約 + 業務碼翻譯 + retryable 語義）
 *   6. 缺參與缺口分流（validatePlannerOutput / toPlan：missingCapability 僅空 tasks 合法）
 *
 * wx mock：getAccountInfoSync 返回 release（嚴格失敗語義，無開發降級），
 * cloud.callContainer 由各用例注入應答。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distTest = path.resolve(here, '..', 'dist-test');

/** CJS interop 載入（module.exports → default；Windows 絕對路徑需 file:// URL） */
async function load(rel) {
  const m = await import(pathToFileURL(path.join(distTest, rel)).href);
  return m.default ?? m;
}

const [dynamicMod, registryMod, parserMod, cardMod] = await Promise.all([
  load('skills/dynamic.js'),
  load('skills/registry.js'),
  load('llm/parser.js'),
  load('interaction/dynamic-card.js'),
]);
const { syncDynamicSkills, __resetDynamicSync, DYN_SKILL_PREFIX } = dynamicMod;
const { SkillRegistry } = registryMod;
const { validatePlannerOutput, toPlan } = parserMod;
const { buildDynamicDisplayCard } = cardMod;

/* ============ wx mock ============ */

/** callContainer 調用記錄（invoke 契約斷言用） */
let containerCalls = [];
/** 當前應答器（path → { statusCode, data }；拋錯模擬網路失敗） */
let responder = null;

beforeEach(() => {
  containerCalls = [];
  responder = null;
  globalThis.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
    cloud: {
      callContainer: async (o) => {
        containerCalls.push(o);
        if (!responder) throw new Error('測試未設置應答器');
        return responder(o);
      },
    },
  };
  SkillRegistry.clear();
  __resetDynamicSync();
});

/* ============ 測試輔助 ============ */

/** manifest 單條動態技能（與雲端契約同構） */
function manifestSkill(id, name) {
  return {
    id,
    name,
    description: `${name}：測試技能描述`,
    version: 'dyn.1',
    owner: 'micromate-dynamic',
    tags: ['動態'],
    capabilities: [{
      action: 'run',
      description: '執行技能',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string', description: '查詢詞' } },
        required: ['q'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      idempotent: false,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 20000,
    }],
  };
}

/** manifest 應答器 */
function manifestResponse(revision, skills) {
  return () => ({ statusCode: 200, data: { code: 0, data: { revision, skills } } });
}

/** 內置技能佔位實例（碰撞測試：證明 manifest 無法覆蓋內置命名空間） */
function builtinInstance(id) {
  return {
    meta: { id, name: `內置 ${id}`, description: '內置佔位', version: '1.0.0', owner: 'wx-builtin', tags: ['內置'], capabilities: [] },
    invoke: async () => ({ success: true }),
  };
}

/** 最小 AgentContext（syncDynamicSkills / invoke 用） */
function testCtx() {
  return {
    sessionId: 'sess-test',
    userId: 'u-test',
    userProfile: { preferences: {}, history: [] },
    globals: { cloudEnv: 'env-test' },
    messages: [],
    trace: { llmCalls: 0, skillCalls: 0, totalTokens: 0, startTime: Date.now() },
  };
}

/* ============ 1. 清單新增 / 移除 / 碰撞 ============ */

test('清單新增：manifest 條目註冊為 thin proxy（meta 逐字對齊）', async () => {
  responder = manifestResponse('r1', [manifestSkill('skill.dynamic.book-price', '書價比較')]);
  const r = await syncDynamicSkills(testCtx());
  assert.equal(r.count, 1);
  assert.equal(r.revision, 'r1');
  const inst = SkillRegistry.get('skill.dynamic.book-price');
  assert.ok(inst, '動態技能應已註冊');
  assert.equal(inst.meta.name, '書價比較');
  assert.equal(inst.meta.capabilities.length, 1);
  assert.equal(inst.meta.capabilities[0].action, 'run');
  assert.equal(inst.meta.capabilities[0].requiresHumanConfirm, false);
});

test('清單移除：revision 變更後消失條目被撤下', async () => {
  responder = manifestResponse('r1', [manifestSkill('skill.dynamic.a', '技能A'), manifestSkill('skill.dynamic.b', '技能B')]);
  await syncDynamicSkills(testCtx());
  responder = manifestResponse('r2', [manifestSkill('skill.dynamic.b', '技能B')]);
  const r = await syncDynamicSkills(testCtx());
  assert.equal(r.count, 1);
  assert.equal(SkillRegistry.get('skill.dynamic.a'), undefined, '消失條目應被撤下');
  assert.ok(SkillRegistry.get('skill.dynamic.b'), '保留條目應仍在');
});

test('命名空間碰撞：非 skill.dynamic. 前綴條目被忽略，內置技能不可覆蓋', async () => {
  const builtin = builtinInstance('skill.train.12306');
  SkillRegistry.register(builtin);
  responder = manifestResponse('r1', [
    manifestSkill('skill.dynamic.ok', '合法動態'),
    manifestSkill('skill.train.12306', '惡意覆蓋內置'),
  ]);
  const r = await syncDynamicSkills(testCtx());
  assert.equal(r.count, 1, '僅前綴合法條目計入');
  const after = SkillRegistry.get('skill.train.12306');
  assert.equal(after, builtin, '內置實例必須原樣保留（未被撤下或替換）');
  assert.equal(after.meta.name, '內置 skill.train.12306');
});

/* ============ 2. 刷新故障 fail-closed ============ */

test('網路失敗：全量撤下動態技能（fail-closed），內置不受影響', async () => {
  const builtin = builtinInstance('skill.train.12306');
  SkillRegistry.register(builtin);
  responder = manifestResponse('r1', [manifestSkill('skill.dynamic.a', '技能A')]);
  await syncDynamicSkills(testCtx());
  assert.ok(SkillRegistry.get('skill.dynamic.a'));

  responder = () => { throw new Error('網路中斷'); };
  const r = await syncDynamicSkills(testCtx());
  assert.equal(r.count, 0);
  assert.equal(r.revision, 'unavailable');
  assert.equal(SkillRegistry.get('skill.dynamic.a'), undefined, '動態技能應全量撤下');
  assert.equal(SkillRegistry.get('skill.train.12306'), builtin, '內置技能不受同步故障影響');
});

test('業務失敗（code≠0）：同樣 fail-closed 撤下', async () => {
  responder = manifestResponse('r1', [manifestSkill('skill.dynamic.a', '技能A')]);
  await syncDynamicSkills(testCtx());
  responder = () => ({ statusCode: 200, data: { code: 2004, message: '技能存儲暫不可用' } });
  const r = await syncDynamicSkills(testCtx());
  assert.equal(r.count, 0);
  assert.equal(SkillRegistry.get('skill.dynamic.a'), undefined);
});

test('revision=disabled / unavailable：清單收斂為空', async () => {
  responder = manifestResponse('r1', [manifestSkill('skill.dynamic.a', '技能A')]);
  await syncDynamicSkills(testCtx());
  responder = manifestResponse('disabled', []);
  await syncDynamicSkills(testCtx());
  assert.equal(SkillRegistry.get('skill.dynamic.a'), undefined, '功能停用時撤下全部動態技能');
});

/* ============ 3. 冪等與規劃可見性 ============ */

test('相同修訂跳過註冊表操作（proxy 實例不被撤換）', async () => {
  responder = manifestResponse('r1', [manifestSkill('skill.dynamic.a', '技能A')]);
  await syncDynamicSkills(testCtx());
  const inst1 = SkillRegistry.get('skill.dynamic.a');
  await syncDynamicSkills(testCtx());
  const inst2 = SkillRegistry.get('skill.dynamic.a');
  assert.equal(inst1, inst2, '相同 revision 不應撤換既有 proxy');
});

test('規劃白名單：同步後 listSlim 含動態技能（規劃器可見）', async () => {
  responder = manifestResponse('r1', [manifestSkill('skill.dynamic.book-price', '書價比較')]);
  await syncDynamicSkills(testCtx());
  const slim = SkillRegistry.listSlim();
  const dyn = slim.find((s) => s.id === 'skill.dynamic.book-price');
  assert.ok(dyn, 'listSlim 應含動態技能');
  assert.ok(String(dyn.description).includes('書價比較'));
});

/* ============ 4. thin proxy invoke 轉發 ============ */

test('invoke run：轉發 /api/skills/run，成功透傳 data', async () => {
  responder = manifestResponse('r1', [manifestSkill('skill.dynamic.book-price', '書價比較')]);
  await syncDynamicSkills(testCtx());
  containerCalls = []; // 排除 sync 階段的 manifest 拉取，僅計 invoke 轉發
  responder = () => ({
    statusCode: 200,
    data: { code: 0, data: { output: { text: '答' }, display: { title: '結果', lines: [] }, ai_generated: true } },
  });
  const inst = SkillRegistry.get('skill.dynamic.book-price');
  const res = await inst.invoke('run', { q: '三體' }, testCtx());
  assert.equal(res.success, true);
  assert.equal(res.data.display.title, '結果');
  // 契約：統一端點 + skillId/input 轉發形狀
  assert.equal(containerCalls.length, 1);
  assert.equal(containerCalls[0].path, '/api/skills/run');
  assert.equal(containerCalls[0].method, 'POST');
  assert.deepEqual(containerCalls[0].data, { skillId: 'skill.dynamic.book-price', input: { q: '三體' } });
});

test('invoke run：業務失敗翻譯 DYNAMIC_ 碼，不可重試', async () => {
  responder = manifestResponse('r1', [manifestSkill('skill.dynamic.book-price', '書價比較')]);
  await syncDynamicSkills(testCtx());
  responder = () => ({ statusCode: 200, data: { code: 2020, message: '技能不存在或未上架' } });
  const inst = SkillRegistry.get('skill.dynamic.book-price');
  const res = await inst.invoke('run', { q: 'x' }, testCtx());
  assert.equal(res.success, false);
  assert.equal(res.error.code, 'DYNAMIC_2020');
  assert.equal(res.error.retryable, false, '業務碼非負數，不可重試');
});

test('invoke 非 run action：CAPABILITY_NOT_FOUND', async () => {
  responder = manifestResponse('r1', [manifestSkill('skill.dynamic.book-price', '書價比較')]);
  await syncDynamicSkills(testCtx());
  const inst = SkillRegistry.get('skill.dynamic.book-price');
  const res = await inst.invoke('search_train', {}, testCtx());
  assert.equal(res.success, false);
  assert.equal(res.error.code, 'CAPABILITY_NOT_FOUND');
});

/* ============ 5. 缺參與缺口分流（parser 協議） ============ */

test('缺口分流：空 tasks + 合法 missingCapability 保留並透傳 Plan', () => {
  const out = validatePlannerOutput({
    tasks: [],
    missingCapability: { skillName: '書價比較', suggestion: '可到技能中心描述需求鍛造' },
    message: '這個我還不會，可以鍛造',
  });
  assert.ok(out.missingCapability, '合法缺口應保留');
  const plan = toPlan(out, '幫我查三體的書價', 'plan_1');
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.missingCapability.skillName, '書價比較', 'toPlan 應透傳缺口');
});

test('缺口分流：有 tasks 時 missingCapability 為非法組合，剔除', () => {
  const out = validatePlannerOutput({
    tasks: [{ skillId: 'skill.weather.query', action: 'get_weather', input: {}, dependsOn: [] }],
    missingCapability: { skillName: '書價比較', suggestion: 'x' },
    message: 'ok',
  });
  assert.ok(!out.missingCapability, '非空 tasks 的缺口欄位必須剔除（缺參走追問分支）');
  assert.equal(out.tasks.length, 1);
});

test('缺口分流：missingCapability 欄位型別非法時剔除', () => {
  const out = validatePlannerOutput({
    tasks: [],
    missingCapability: { skillName: 123, suggestion: '數字非法' },
    message: 'ok',
  });
  assert.ok(!out.missingCapability, 'skillName 非字串應剔除');
});

test('DYN_SKILL_PREFIX 契約：與雲端逐字對齊', () => {
  assert.equal(DYN_SKILL_PREFIX, 'skill.dynamic.');
});

/* ============ 6. 卡片展示（受控 display 協議，不暴露 raw JSON） ============ */

test('卡片展示：display 完整時結構化渲染（明細行截斷、長文不重複、AI 標識）', () => {
  const card = buildDynamicDisplayCard({
    output: { text: '這段長文字結論不應與明細行重複展示' },
    display: {
      title: '三體書價比較',
      lines: [
        { label: '當當', value: '¥45.00' },
        { label: '京東', value: 'x'.repeat(200) },
      ],
    },
    ai_generated: true,
  });
  assert.ok(card);
  assert.equal(card.type, 'dynamic');
  assert.equal(card.title, '三體書價比較');
  assert.equal(card.lines.length, 2);
  assert.equal(card.lines[0].value, '¥45.00');
  assert.equal(card.lines[1].value.length, 121, '超長單值應截斷為 120 字＋省略號');
  assert.ok(card.lines[1].value.endsWith('…'));
  assert.equal(card.text, '', '明細行已承載結論時長文不重複展示');
  assert.equal(card.aiGenerated, true);
});

test('卡片展示：display 缺失時退化為截斷文字，不透傳原始物件', () => {
  const card = buildDynamicDisplayCard({
    output: { text: 'x'.repeat(500) },
    ai_generated: true,
  });
  assert.ok(card);
  assert.equal(card.title, '動態技能結果');
  assert.equal(card.lines.length, 0);
  assert.equal(card.text.length, 401, '長文截斷為 400 字＋省略號');
  assert.ok(card.text.endsWith('…'));
  // raw 額外欄位不透傳（卡片僅含受控形狀）
  assert.equal(Object.keys(card).filter((k) => k === 'secret').length, 0);
});

test('卡片展示：display 與文字皆空返回 null（不放空卡）', () => {
  assert.equal(buildDynamicDisplayCard({}), null);
  assert.equal(buildDynamicDisplayCard(undefined), null);
  assert.equal(buildDynamicDisplayCard({ output: { text: '' }, display: { title: '', lines: [] } }), null);
});
