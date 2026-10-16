/**
 * 健康顧問域規則路由測試（2026-10 健康顧問 SKILL）
 *
 * 驗證 rule-planner 對醫療域意圖的分流契約：
 *   - 急症短路（置於危機短路之後、一切業務域之前）
 *   - 報告解讀 > 藥品通識 > 症狀分診 互斥分流
 *   - 「附近醫院 / 藥店」仍歸地圖域（search_poi），且可與症狀詞並存雙任務
 *
 * 運行：npm run build 前置編譯 dist-test（見 package.json test:health）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distTest = path.resolve(here, '..', 'dist-test');

/** CJS interop 載入（module.exports → default；Windows 絕對路徑需 file:// URL） */
async function load(rel) {
  const mod = await import(pathToFileURL(path.join(distTest, rel)).href);
  return mod.default ?? mod;
}

const { rulePlan } = await load('llm/rule-planner.js');

/** 最小 AgentContext（規劃層僅讀 userProfile.location / locationAuth 等；
 *  currentCity 模擬定位逆地理成功——「我現在在哪」的城市供給） */
function buildCtx(overrides = {}) {
  return {
    sessionId: 'test-session',
    userId: 'test-user',
    userProfile: {
      location: { lat: 22.5431, lng: 114.0579, city: '深圳', currentCity: '深圳' },
      locationAuth: 'authorized',
      preferences: {},
      history: [],
      ...overrides.userProfile,
    },
    globals: {},
    messages: [],
    trace: { llmCalls: 0, skillCalls: 0, totalTokens: 0, startTime: Date.now() },
    ...overrides,
  };
}

test('症狀詞 + 就醫疑問 → symptom_triage 單任務', () => {
  const r = rulePlan('我有點發燒頭痛，要去醫院嗎', buildCtx());
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].skillId, 'skill.health.advisor');
  assert.equal(r.tasks[0].action, 'symptom_triage');
  assert.equal(r.tasks[0].input.symptoms, '我有點發燒頭痛，要去醫院嗎');
});

test('急症詞 → 本地短路（空 tasks + 120 引導文案）', () => {
  const r = rulePlan('突然胸痛喘不上氣', buildCtx());
  assert.equal(r.tasks.length, 0);
  assert.ok(r.message.includes('120'), '急症文案應含 120 引導');
});

test('危機詞與急症詞並存 → 危機短路優先（心理危機在急症之前）', () => {
  const r = rulePlan('誤服了安眠藥，我想不開了', buildCtx());
  assert.equal(r.tasks.length, 0);
  // 危機文案走「專業支持 / 生命熱線」語義，不應出現急症的 120 急救要點為主體
  assert.ok(r.message.length > 0);
});

test('藥品通識問句（無症狀詞）→ med_info，藥名抽取', () => {
  const r = rulePlan('阿莫西林是什麼藥', buildCtx());
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].skillId, 'skill.health.advisor');
  assert.equal(r.tasks[0].action, 'med_info');
  assert.equal(r.tasks[0].input.drugName, '阿莫西林');
});

test('報告指標詞 → report_explain（原文照抄）', () => {
  const intent = '白細胞11.5血紅蛋白130是什麼意思';
  const r = rulePlan(intent, buildCtx());
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].action, 'report_explain');
  assert.equal(r.tasks[0].input.reportText, intent);
});

test('伴隨症狀詞的用藥疑問 → 分診（非 med_info）', () => {
  const r = rulePlan('我發燒該吃什麼藥', buildCtx());
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].action, 'symptom_triage');
});

test('簡體表述同等分流（繁簡並列詞表）', () => {
  const r = rulePlan('我发烧该吃什么药', buildCtx());
  assert.equal(r.tasks[0].action, 'symptom_triage');
  const r2 = rulePlan('帮我看看体检报告，白细胞偏高', buildCtx());
  assert.equal(r2.tasks[0].action, 'report_explain');
});

test('「附近醫院」→ 地圖域 search_poi（不進健康顧問）', () => {
  const r = rulePlan('附近醫院', buildCtx());
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].skillId, 'skill.map.tianditu');
  assert.equal(r.tasks[0].action, 'search_poi');
});

test('症狀詞 + 附近就醫 → 分診與 POI 雙任務並存', () => {
  const r = rulePlan('我有點發燒頭痛，附近有醫院嗎', buildCtx());
  const actions = r.tasks.map((t) => `${t.skillId}:${t.action}`);
  assert.equal(r.tasks.length, 2, `實際任務：${actions.join(', ')}`);
  assert.ok(actions.includes('skill.health.advisor:symptom_triage'));
  assert.ok(actions.includes('skill.map.tianditu:search_poi'));
});

test('非醫療意圖不受影響（回歸）：查天氣仍走天氣域', () => {
  const r = rulePlan('今天天氣怎麼樣', buildCtx());
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].skillId, 'skill.weather.query');
  assert.equal(r.tasks[0].action, 'get_weather');
});

test('「中風」子串誤傷回歸：「家中風扇壞了」不觸發急症短路（2026-10-16 審計 M2）', () => {
  for (const intent of ['家中風扇壞了怎麼辦', '這個方案命中風險很高']) {
    const r = rulePlan(intent, buildCtx());
    assert.ok(!r.message.includes('120'), `「${intent}」不應觸發 120 急症引導`);
    assert.ok(!r.tasks.some((t) => t.action === 'symptom_triage'));
  }
});

test('「未來 N 天」無天氣詞不劫持預報域（2026-10-16 審計 M1 回歸）', () => {
  const r = rulePlan('未來三天請陪我聊聊天', buildCtx());
  const actions = r.tasks.map((t) => t.action);
  assert.ok(!actions.includes('get_forecast'), `實際任務：${actions.join(', ')}`);
  assert.ok(actions.includes('chat_companion'));
  // 對照組：「未來兩天的天氣」疊加天氣詞，應走預報而非實況
  const r2 = rulePlan('未來兩天的天氣', buildCtx());
  assert.equal(r2.tasks[0].action, 'get_forecast');
  assert.equal(r2.tasks[0].input.days, 2);
});

test('預報城市：定位所得 currentCity 優先於地址簿出發城市（2026-10-16 修訂）', () => {
  // badcase 復現：人在澳門（定位）、家在廣州（地址簿默認地址），
  // 預報應查澳門而非廣州（「我現在在哪」語義不受出發城市壓制）
  const ctx = buildCtx({
    userProfile: {
      location: {
        lat: 22.19875, lng: 113.54913,
        city: '广州', citySource: 'address_book', currentCity: '澳门',
      },
      homeAddress: { city: '广州', full: '廣東省廣州市天河區XX路1號' },
    },
  });
  const r = rulePlan('未來七天的天氣如何', ctx);
  assert.equal(r.tasks[0].action, 'get_forecast');
  assert.equal(r.tasks[0].input.city, '澳门');
});

test('預報無當前城市：追問文案給出家地址城市選項（隨機應變）', () => {
  // 定位成功但逆地理未出城市（currentCity 缺失），地址簿僅供出發城市：
  // 不靜默回退廣州，而是追問並把家地址城市作顯式選項
  const ctx = buildCtx({
    userProfile: {
      location: { lat: 22.19875, lng: 113.54913, city: '广州', citySource: 'address_book' },
      homeAddress: { city: '广州', full: '廣東省廣州市天河區XX路1號' },
    },
  });
  const r = rulePlan('未來七天的天氣如何', ctx);
  assert.equal(r.tasks.length, 0);
  assert.ok(r.message.includes('广州'), `追問文案應含家地址城市：${r.message}`);
});

test('預報無當前城市且無家地址：追問引導說城市名', () => {
  const ctx = buildCtx({ userProfile: { location: {} } });
  const r = rulePlan('查天氣預報', ctx);
  assert.equal(r.tasks.length, 0);
  assert.ok(r.message.includes('城市'), r.message);
});

test('「預約掛號」無症狀詞不再疊加空分診任務（2026-10-16 審計 L1 回歸）', () => {
  const r = rulePlan('預約掛號看醫生', buildCtx());
  const actions = r.tasks.map((t) => t.action);
  assert.ok(!actions.includes('symptom_triage'), `實際任務：${actions.join(', ')}`);
  assert.ok(actions.includes('search_services'));
  // 對照組：伴隨症狀詞的預約仍雙任務並存，交分診出具體指引
  const r2 = rulePlan('預約明天門診，我發燒了', buildCtx());
  assert.ok(r2.tasks.some((t) => t.action === 'symptom_triage'));
});

test('「最近」時間副詞不劫持地圖域（2026-10-16 實測 badcase）', () => {
  // 原句復現：「我最近心里不得劲」曾被裸「最近」劫持為
  // search_poi「搜尋深圳附近的心里不得劲」，應進諮詢域陪伴對話
  const r = rulePlan('我最近心里不得劲', buildCtx());
  assert.equal(r.tasks.length, 1, `實際任務：${JSON.stringify(r.tasks)}`);
  assert.equal(r.tasks[0].skillId, 'skill.mind.counseling');
  assert.equal(r.tasks[0].action, 'chat_companion');
  // 繁體對照（詞表簡繁並列慣例）
  const r2 = rulePlan('我最近心裡不得勁', buildCtx());
  assert.equal(r2.tasks[0].action, 'chat_companion');
  // 同款隱患：時間副詞 + 症狀詞不應疊加幽靈 POI 任務
  const r3 = rulePlan('我最近有些咳嗽', buildCtx());
  const actions3 = r3.tasks.map((t) => t.action);
  assert.ok(!actions3.includes('search_poi'), `實際任務：${actions3.join(', ')}`);
  assert.ok(actions3.includes('symptom_triage'));
});

test('「最近的」空間指代仍通地圖域（消歧收窄回歸）', () => {
  // 對照組：帶「的」的空間指代（nearest）不受「最近」消歧影響
  const r = rulePlan('最近的便利店在哪', buildCtx());
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].skillId, 'skill.map.tianditu');
  assert.equal(r.tasks[0].action, 'search_poi');
  assert.equal(r.tasks[0].input.keyword, '便利店');
});
