/**
 * 動態技能全鏈路隔離測試（node --test；導入 dist 編譯產物）
 *
 * 覆蓋面（對應計劃驗收）：
 *   - 三執行器（llm / http / mcp 位址治理）與 ai_generated 標識
 *   - 生命週期：draft → approved ⇄ disabled、blocked / rejected、CAS 版本衝突
 *   - 鑒權：401（匿名寫）/ 403（非管理員審批）/ 跨用戶隔離
 *   - 安全：SSRF 私網阻斷、PII 去敏、即時數據硬攔截、受限 schema、冪等、配額
 *   - fail-closed：存儲不可用時清單收斂為空、寫路徑拒絕
 *
 * 隔離手段：存儲模式覆蓋為 memory、三外部依賴（llmChat / httpGet / mcpCall）
 * 經 configureExecutorDeps 注入替身，全程不觸真實上游。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/** CJS 產物導入（default 恆為 module.exports，避免 named export 偵測差異） */
const cjs = (p) => import(p).then((m) => m.default ?? m);

const typesMod = await cjs('../dist/skill-dynamic-types.js');
const storeMod = await cjs('../dist/skill-dynamic-store.js');
const connectorsMod = await cjs('../dist/skill-dynamic-connectors.js');
const executorMod = await cjs('../dist/skill-dynamic-executor.js');
const routesMod = await cjs('../dist/skill-dynamic-routes.js');

/** 從路由表取指定 handler */
const handler = (key) => {
  const entry = routesMod.dynamicSkillRoutes.find(([k]) => k === key);
  assert.ok(entry, `路由 ${key} 應已註冊`);
  return entry[1];
};
const manifestHandler = handler('GET /api/skills/manifest');
const centerHandler = handler('GET /api/skills/center');
const forgeHandler = handler('POST /api/skills/forge');
const reviewHandler = handler('POST /api/skills/review');
const runHandler = handler('POST /api/skills/run');

const USER_A = 'openid-user-a';
const USER_B = 'openid-user-b';
const USER_C = 'openid-user-c';
const ADMIN = 'openid-admin-1';

/** 假 LLM 下一回應（每測試按需改寫 llmNext） */
let llmNext = { text: '{}' };

test.before(async () => {
  process.env.DYNAMIC_SKILL_ADMIN_OPENIDS = ADMIN;
  process.env.DYNAMIC_SKILL_FORGE_QUOTA = '50'; // 測試內多次鍛造，抬高限額
  process.env.DYNAMIC_SKILL_CONNECTORS = JSON.stringify([
    {
      kind: 'http', id: 'http.lunar', name: '萬年曆', description: '按日期查農曆',
      urlTemplate: 'https://api.example.com/lunar?date={date}',
      outFields: [{ key: 'data.lunar', label: '農曆' }],
    },
    {
      kind: 'mcp', id: 'mcp.12306', name: '12306餘票', description: '官方餘票查詢',
      url: 'http://127.0.0.1:3001/mcp', tool: 'get-tickets',
      outFields: [{ key: 'tickets.0.train_no', label: '車次' }], allowPrivate: true,
    },
  ]);
  connectorsMod.resetConnectorCache();
  storeMod.setStoreModeOverrideForTests('memory');
  storeMod.__resetMemoryStore();
  executorMod.configureExecutorDeps({
    llmChat: async () => ({ text: llmNext.text }),
    httpGet: async (_conn, params) => ({
      status: 200,
      json: { data: { lunar: '乙巳年蛇' }, echo: params },
    }),
    mcpCall: async () => JSON.stringify({ tickets: [{ train_no: 'G101' }] }),
  });
});

test.after(async () => {
  executorMod.resetExecutorDeps();
  storeMod.setStoreModeOverrideForTests(null);
  storeMod.__resetMemoryStore();
  delete process.env.DYNAMIC_SKILL_RUN_QUOTA;
});

/** llm 類草稿的假 LLM 回應 */
const LLM_DRAFT = {
  action: 'draft', name: '農曆小助手',
  description: '能做：把公曆日期換算為農曆與生肖；不能做：查即時數據；何時觸發：用戶問某日農曆時',
  kind: 'llm',
  instructions: '你是一個農曆換算助手。根據輸入參數 date（公曆 YYYY-MM-DD）計算對應農曆日期與生肖，用兩三句話回答。無法確定時明確說明限制，不得編造即時數據。',
  params: [{ name: 'date', type: 'string', required: true, description: '公曆日期 YYYY-MM-DD' }],
};

test('manifest 初始為空且 center 匿名可讀', async () => {
  const m = await manifestHandler(undefined, {});
  assert.equal(m.httpStatus, 200);
  assert.equal(m.body.code, 0);
  assert.equal(m.body.data.revision, 'v0');
  assert.equal(m.body.data.skills.length, 0);

  const c = await centerHandler(undefined, {});
  assert.equal(c.body.code, 0);
  assert.equal(c.body.data.enabled, true);
  assert.equal(c.body.data.isAdmin, false);
  assert.equal(c.body.data.storage, 'memory');
  assert.equal(c.body.data.connectors.length, 2);
});

test('forge 未登入回 401', async () => {
  const r = await forgeHandler({ requestId: 'anon0001', requirement: '查農曆' }, { sessionId: 's' });
  assert.equal(r.httpStatus, 401);
});

test('forge 產生 llm 草稿：本人可見、他人不可見、manifest 不含', async () => {
  llmNext = { text: JSON.stringify(LLM_DRAFT) };
  const r = await forgeHandler(
    { requestId: 'req01llm', requirement: '幫我查農曆日期換算' },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(r.body.code, 0);
  assert.equal(r.body.data.status, 'draft');
  assert.equal(r.body.data.record.status, 'draft');
  assert.equal(r.body.data.record.name, '農曆小助手');
  assert.equal(r.body.data.record.definition.kind, 'llm');

  const mine = await centerHandler(undefined, { openid: USER_A, sessionId: 's' });
  assert.equal(mine.body.data.records.length, 1);
  const other = await centerHandler(undefined, { openid: USER_B, sessionId: 's' });
  assert.equal(other.body.data.records.length, 0); // 跨用戶隔離：draft 不公開

  const m = await manifestHandler(undefined, {});
  assert.equal(m.body.data.skills.length, 0); // 未審批不上 manifest
});

test('forge 同 requestId 冪等：返回既有記錄不重複鍛造', async () => {
  llmNext = { text: JSON.stringify(LLM_DRAFT) };
  const r = await forgeHandler(
    { requestId: 'req01llm', requirement: '幫我查農曆日期換算' },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(r.body.code, 0);
  assert.equal(r.body.data.duplicate, true);
  assert.equal(r.body.data.record.id, 'skill.dynamic.req01llm');
});

test('forge 跨用戶冪等衝突：他人 requestId 佔用回 2003 不洩露記錄', async () => {
  // 冪等鍵全局命名空間：USER_B 冒用 USER_A 已鍛造的 requestId，
  // 必須拒絕且不返回他人記錄（requirement / sourceText 隱私紅線）
  llmNext = { text: JSON.stringify(LLM_DRAFT) };
  const r = await forgeHandler(
    { requestId: 'req01llm', requirement: '冒用他人冪等鍵測試' },
    { openid: USER_B, sessionId: 's' },
  );
  assert.equal(r.body.code, 2003);
  assert.match(r.body.message, /佔用/);
  assert.equal(r.body.data, undefined); // 不得攜帶他人記錄
  // 本人重新提交仍正常冪等（不受衝突影響）
  const mine = await forgeHandler(
    { requestId: 'req01llm', requirement: '幫我查農曆日期換算' },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(mine.body.code, 0);
  assert.equal(mine.body.data.duplicate, true);
});

test('非管理員審批回 403', async () => {
  const r = await reviewHandler(
    { skillId: 'skill.dynamic.req01llm', decision: 'approve', expectedVersion: 1 },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(r.httpStatus, 403);
});

test('管理員 approve 後進入 manifest（含 outputSchema 契約與修訂標識）', async () => {
  const r = await reviewHandler(
    { skillId: 'skill.dynamic.req01llm', decision: 'approve', expectedVersion: 1, note: '首個審批' },
    { openid: ADMIN, sessionId: 's' },
  );
  assert.equal(r.body.code, 0);
  assert.equal(r.body.data.record.status, 'approved');
  assert.equal(r.body.data.record.version, 2);

  const m = await manifestHandler(undefined, {});
  assert.equal(m.body.data.skills.length, 1);
  const skill = m.body.data.skills[0];
  assert.equal(skill.id, 'skill.dynamic.req01llm');
  assert.equal(skill.version, 'dyn.2');
  assert.equal(skill.owner, 'micromate-dynamic'); // 不洩露 openid
  assert.deepEqual(skill.capabilities[0].outputSchema, typesMod.RUN_OUTPUT_SCHEMA);
  assert.equal(skill.capabilities[0].action, 'run');
  assert.equal(skill.capabilities[0].idempotent, false);
  assert.equal(skill.capabilities[0].estimatedLatencyMs, typesMod.KIND_LATENCY_MS.llm);
  assert.notEqual(m.body.data.revision, 'v0');
});

test('run llm 技能成功且標記 ai_generated', async () => {
  llmNext = { text: '2026 年 10 月 14 日對應農曆乙巳年九月初四，生肖蛇。' };
  const r = await runHandler(
    { skillId: 'skill.dynamic.req01llm', input: { date: '2026-10-14' } },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(r.body.code, 0);
  assert.equal(r.body.data.ai_generated, true);
  assert.equal(r.body.data.output.text, '2026 年 10 月 14 日對應農曆乙巳年九月初四，生肖蛇。');
  assert.equal(r.body.data.display.lines[0].label, 'date');
  assert.equal(r.body.data.display.lines[0].value, '2026-10-14');
});

test('run 入參不合法回業務失敗（型別不符）', async () => {
  const r = await runHandler(
    { skillId: 'skill.dynamic.req01llm', input: { date: 123 } },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(r.body.code, 2021);
  assert.match(r.body.message, /date/);
});

test('非法轉移與過期版本分別回 2011 / 2014', async () => {
  const again = await reviewHandler(
    { skillId: 'skill.dynamic.req01llm', decision: 'approve', expectedVersion: 2 },
    { openid: ADMIN, sessionId: 's' },
  );
  assert.equal(again.body.code, 2011); // approved 不可再 approve

  const stale = await reviewHandler(
    { skillId: 'skill.dynamic.req01llm', decision: 'disable', expectedVersion: 1 },
    { openid: ADMIN, sessionId: 's' },
  );
  assert.equal(stale.body.code, 2014); // CAS 版本衝突
});

test('disable 退出 manifest，enable 後恢復', async () => {
  const off = await reviewHandler(
    { skillId: 'skill.dynamic.req01llm', decision: 'disable', expectedVersion: 2 },
    { openid: ADMIN, sessionId: 's' },
  );
  assert.equal(off.body.code, 0);
  let m = await manifestHandler(undefined, {});
  assert.equal(m.body.data.skills.length, 0);

  const on = await reviewHandler(
    { skillId: 'skill.dynamic.req01llm', decision: 'enable', expectedVersion: 3 },
    { openid: ADMIN, sessionId: 's' },
  );
  assert.equal(on.body.code, 0);
  m = await manifestHandler(undefined, {});
  assert.equal(m.body.data.skills.length, 1);
});

test('SSRF：私網 / 回環 / metadata 字面量一律阻斷，公網放行', async () => {
  assert.equal(connectorsMod.isPublicIpLiteral('8.8.8.8'), true);
  assert.equal(connectorsMod.isPublicIpLiteral('1.2.3.4'), true);
  assert.equal(connectorsMod.isPublicIpLiteral('127.0.0.1'), false);
  assert.equal(connectorsMod.isPublicIpLiteral('10.1.2.3'), false);
  assert.equal(connectorsMod.isPublicIpLiteral('192.168.1.5'), false);
  assert.equal(connectorsMod.isPublicIpLiteral('169.254.169.254'), false);
  assert.equal(connectorsMod.isPublicIpLiteral('::1'), false);
  assert.equal(connectorsMod.isPublicIpLiteral('2001:db8::1'), false);

  const mkConn = (urlTemplate) => ({
    kind: 'http', id: 'http.test', name: '測試', description: '測試',
    urlTemplate, outFields: [{ key: 'x', label: 'x' }],
  });
  await assert.rejects(
    connectorsMod.httpGetSafe(mkConn('http://127.0.0.1:9999/x?date={date}'), { date: '2026-01-01' }),
    (e) => e instanceof connectorsMod.HttpFetchError && e.kind === 'private_address',
  );
  await assert.rejects(
    connectorsMod.httpGetSafe(mkConn('http://169.254.169.254/latest/meta-data/?d={date}'), { date: 'x' }),
    (e) => e instanceof connectorsMod.HttpFetchError && e.kind === 'private_address',
  );
  // http 連接器永不允許私網（縱使模板指向域名，解析階段亦攔——此處驗證協議外鍵）
  await assert.rejects(
    connectorsMod.httpGetSafe(mkConn('ftp://example.com/x'), {}),
    (e) => e instanceof connectorsMod.HttpFetchError && e.kind === 'invalid_url',
  );
});

test('mcp 端點治理：私網 mcp 未標記 allowPrivate 阻斷，標記後放行', async () => {
  const mkMcp = (allowPrivate) => ({
    kind: 'mcp', id: 'mcp.test', name: '測試', description: '測試',
    url: 'http://192.168.1.5:3001/mcp', tool: 't',
    outFields: [{ key: 'x', label: 'x' }], ...(allowPrivate ? { allowPrivate: true } : {}),
  });
  await assert.rejects(
    connectorsMod.assertMcpEndpointAllowed(mkMcp(false)),
    (e) => e instanceof connectorsMod.HttpFetchError && e.kind === 'private_address',
  );
  await connectorsMod.assertMcpEndpointAllowed(mkMcp(true)); // 字面量路徑不觸網
});

test('http 技能全鏈路：forge → approve → run（非 ai 生成）', async () => {
  llmNext = {
    text: JSON.stringify({
      action: 'draft', name: '農曆查詢',
      description: '能做：按日期查農曆；不能做：其他曆法換算；何時觸發：問某日農曆時',
      kind: 'http', connectorId: 'http.lunar',
      params: [{ name: 'date', type: 'string', required: true, description: '公曆日期' }],
    }),
  };
  const f = await forgeHandler(
    { requestId: 'req02http', requirement: '查指定日期的農曆' },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(f.body.data.status, 'draft');

  const rv = await reviewHandler(
    { skillId: 'skill.dynamic.req02http', decision: 'approve', expectedVersion: 1 },
    { openid: ADMIN, sessionId: 's' },
  );
  assert.equal(rv.body.code, 0);

  const run = await runHandler(
    { skillId: 'skill.dynamic.req02http', input: { date: '2026-10-14' } },
    { openid: USER_B, sessionId: 's' }, // 他人可執行已上架技能
  );
  assert.equal(run.body.code, 0);
  assert.equal(run.body.data.ai_generated, false);
  assert.equal(run.body.data.display.lines[0].label, '農曆');
  assert.equal(run.body.data.display.lines[0].value, '乙巳年蛇');
});

test('blocked：即時數據需求在無連接器時被硬攔截（服務端兜底）', async () => {
  // (a) LLM 自判 blocked
  llmNext = { text: JSON.stringify({ action: 'blocked', reason: '需要即時匯率接口，暫無適配連接器' }) };
  const a = await forgeHandler(
    { requestId: 'req03fx1', requirement: '查即時美元匯率' },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(a.body.data.status, 'blocked');
  assert.equal(a.body.data.record.status, 'blocked');

  // (b) LLM 誤判為 llm 草稿，服務端 REALTIME_RE 兜底強制 blocked
  llmNext = { text: JSON.stringify({ ...LLM_DRAFT, name: '匯率助手' }) };
  const b = await forgeHandler(
    { requestId: 'req03fx2', requirement: '我要查即時匯率走勢' },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(b.body.data.status, 'blocked');
  assert.match(b.body.data.record.reason, /即時/);

  // blocked 終態：不可審批
  const rv = await reviewHandler(
    { skillId: 'skill.dynamic.req03fx2', decision: 'approve', expectedVersion: 1 },
    { openid: ADMIN, sessionId: 's' },
  );
  assert.equal(rv.body.code, 2011);
});

test('非法 params（7 個屬性）鍛造失敗回 2003', async () => {
  const params = Array.from({ length: 7 }, (_, i) => ({ name: `p${i}`, type: 'string', required: false }));
  llmNext = { text: JSON.stringify({ ...LLM_DRAFT, params }) };
  const r = await forgeHandler(
    { requestId: 'req04bad', requirement: '測試非法參數數量' },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(r.body.code, 2003);
});

test('PII 去敏：草稿名稱中的手機號被遮罩', async () => {
  llmNext = { text: JSON.stringify({ ...LLM_DRAFT, name: '13812345678助手' }) };
  const r = await forgeHandler(
    { requestId: 'req05pii', requirement: '帶手機號的名稱測試' },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(r.body.code, 0);
  assert.equal(r.body.data.status, 'draft');
  assert.ok(r.body.data.record.name.includes('[已隱去]'));
  assert.ok(!r.body.data.record.name.includes('13812345678'));
});

test('run 配額超限回業務失敗', async () => {
  process.env.DYNAMIC_SKILL_RUN_QUOTA = '1';
  const skillId = 'skill.dynamic.req02http';
  const first = await runHandler(
    { skillId, input: { date: '2026-01-01' } },
    { openid: USER_C, sessionId: 's' },
  );
  assert.equal(first.body.code, 0);
  const second = await runHandler(
    { skillId, input: { date: '2026-01-02' } },
    { openid: USER_C, sessionId: 's' },
  );
  assert.equal(second.body.code, 2021);
  assert.match(second.body.message, /上限/);
  delete process.env.DYNAMIC_SKILL_RUN_QUOTA;
});

test('存儲 fail-closed：清單收斂為空、寫路徑拒絕', async () => {
  storeMod.setStoreModeOverrideForTests('unavailable');
  const m = await manifestHandler(undefined, {});
  assert.equal(m.body.code, 0);
  assert.equal(m.body.data.skills.length, 0);
  assert.equal(m.body.data.revision, 'unavailable');

  const f = await forgeHandler(
    { requestId: 'req06fc', requirement: 'fail closed 測試' },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(f.body.code, 2004);

  const run = await runHandler(
    { skillId: 'skill.dynamic.req02http', input: { date: '2026-01-01' } },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(run.body.code, 2020); // 不可用視同未上架

  storeMod.setStoreModeOverrideForTests('memory');
});

test('上游超時：http 連接器超時映射 2021 業務失敗', async () => {
  // 註：真實 httpGetSafe 超時（8s 計時器，node http timeout 傳參保證）無法
  // 在隔離測試觸發——公網黑洞位址不可靠，本地位址先被 SSRF 私網防護攔截
  // （正確行為）；故以 DI 注入 HttpFetchError('timeout') 驗證 executor →
  // 路由層的超時語義端到端映射（upstream_timeout → 2021）
  executorMod.configureExecutorDeps({
    llmChat: async () => ({ text: '{}' }),
    httpGet: async () => {
      throw new connectorsMod.HttpFetchError('timeout', '連線超時（8000ms）');
    },
    mcpCall: async () => JSON.stringify({}),
  });
  const r = await runHandler(
    { skillId: 'skill.dynamic.req02http', input: { date: '2026-01-01' } },
    { openid: USER_A, sessionId: 's' },
  );
  assert.equal(r.body.code, 2021);
  assert.match(r.body.message, /超時/);
});
