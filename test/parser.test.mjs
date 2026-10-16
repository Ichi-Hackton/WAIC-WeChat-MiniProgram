/**
 * LLM 輸出抽取解析測試（node --test，導入 tsc 編譯後的 dist-test CJS 產物）
 *
 * 覆蓋（2026-10-16 事故修復：貪婪正則 /\{[\s\S]*\}/ 把 JSON 後尾巴文字
 * 併入解析跨度，缺口回應「tasks:[] + missingCapability + 引號文案」解析
 * 失敗，能力缺口引導退化為通用錯誤）：
 *   1. 配對掃描 extractFirstJsonObject：字串值內大括號 / 轉義引號跳過、
 *      無配對（截斷）/ 無 '{' 返回 null
 *   2. extractJson：尾巴文字容忍（貪婪正則必炸場景）、fenced 包裹、
 *      重複輸出取首個、回退語義保持
 *   3. 事故重建端到端：extractJson → validatePlannerOutput → 缺口保留
 *   4. dependsOn 寬容回填：單任務 Plan 省略/null 視為無依賴（實測：
 *      「查明天上海天氣」省略 dependsOn 被否決）；存在但非陣列仍攔截
 */

import { test } from 'node:test';
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

const { extractJson, extractFirstJsonObject, validatePlannerOutput, toPlan, LLMParserError } = await load('llm/parser.js');

/* ============ 1. extractFirstJsonObject 純函數 ============ */

test('配對掃描：字串值內的大括號與轉義引號不影響深度計數', () => {
  const text = '{"a":"含 } 與 { 與 \\" 的文案","b":{"c":1}}';
  assert.equal(extractFirstJsonObject(text), text);
});

test('配對掃描：尾巴文字不併入（止於首個配對閉合）', () => {
  const obj = '{"a":1}';
  assert.equal(extractFirstJsonObject(`${obj} 後記：結果如上}請查收`), obj);
});

test('配對掃描：截斷輸出（深度不歸零）與無 "{" 均返回 null', () => {
  assert.equal(extractFirstJsonObject('{"a":"未閉合'), null);
  assert.equal(extractFirstJsonObject('完全沒有大括號'), null);
});

/* ============ 2. extractJson 抽取策略 ============ */

test('事故重建：缺口回應 JSON + 引號文案 + 尾巴文字（舊貪婪正則必炸）', () => {
  const raw =
    '好的，規劃如下：{"intent":"查澳門未來七天天氣","tasks":[],' +
    '"missingCapability":{"skillName":"未來天氣預報","suggestion":"暫無未來天氣預報能力，可到技能中心鍛造「未來天氣預報」技能"},' +
    '"message":"\\"同 suggestion 文案\\""} 以上為本輪規劃，缺口請到技能中心鍛造}謝謝';
  // 修復前形態自證：貪婪正則併入尾巴後 JSON.parse 失敗
  const greedy = raw.match(/\{[\s\S]*\}/)[0];
  assert.throws(() => JSON.parse(greedy), SyntaxError);
  // 修復後：配對掃描取第一個完整物件，缺口引導不再退化為通用錯誤
  const out = validatePlannerOutput(extractJson(raw));
  assert.equal(out.tasks.length, 0);
  assert.equal(out.missingCapability.skillName, '未來天氣預報');
});

test('純 JSON 與前後夾散文：直接解析', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('以下是規劃：{"a":1} 希望有幫助'), { a: 1 });
});

test('fenced ```json 包裹：fence 內外尾巴均可容忍', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n以上為規劃結果}```'), { a: 1 });
});

test('重複輸出兩個 JSON 物件：取第一個', () => {
  const raw = '{"a":1}{"a":2}';
  assert.deepEqual(extractJson(raw), { a: 1 });
});

test('無 JSON 結構：拋 LLMParserError', () => {
  assert.throws(() => extractJson('今天天氣不錯'), LLMParserError);
});

test('徹底損壞（字串未閉合且無配對）：回退貪婪正則後仍拋 LLMParserError', () => {
  assert.throws(() => extractJson('{"a":"未閉合}但貪婪有配對}'), LLMParserError);
});

/* ============ 3. dependsOn 寬容回填 ============ */

test('事故重建：單任務 Plan 省略 dependsOn（修復前被「缺少 dependsOn[]」否決）', () => {
  // 2026-10-16 實測 LLM 輸出原文形態：task 帶 id/inputBindings 但無 dependsOn
  const raw =
    '{"intent":"查一下明天上海的天气","tasks":[' +
    '{"id":"task_001","skillId":"skill.weather.qweather","action":"get_forecast",' +
    '"input":{"city":"上海","date":"2026-10-17"},"inputBindings":{},' +
    '"summary":"查詢上海明天天氣預報"}],"message":""}';
  const out = validatePlannerOutput(extractJson(raw));
  assert.deepEqual(out.tasks[0].dependsOn, []);
  // 端到端：toPlan 產出無依賴任務，可直接並行調度
  const plan = toPlan(out, '查一下明天上海的天气', 'plan_1');
  assert.equal(plan.tasks.length, 1);
  assert.deepEqual(plan.tasks[0].dependsOn, []);
  assert.equal(plan.tasks[0].id, 'task_001');
});

test('dependsOn 為 null 同樣回填 []；多任務混合場景兼容', () => {
  const raw = {
    tasks: [
      { skillId: 'skill.a', action: 'x', input: {}, dependsOn: null },
      { skillId: 'skill.b', action: 'y', input: {}, dependsOn: ['task_001'] },
    ],
  };
  const out = validatePlannerOutput(raw);
  assert.deepEqual(out.tasks[0].dependsOn, []);
  assert.deepEqual(out.tasks[1].dependsOn, ['task_001']);
});

test('dependsOn 存在但非陣列：仍屬畸形攔截（靜默清空會丟依賴令任務提前並行）', () => {
  const raw = {
    tasks: [{ skillId: 'skill.train.12306', action: 'search_train', input: { from: '北京' }, dependsOn: 'task_000' }],
  };
  assert.throws(() => validatePlannerOutput(raw), LLMParserError);
});
