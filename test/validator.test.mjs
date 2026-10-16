/**
 * 通用驗證器 null 語義守護測試（2026-10-16）
 *
 * 事故背景：LLM 規劃對未提及的可選參數普遍輸出 null 而非省略（實測
 * 「我最近有些咳嗽」→ symptom_triage 任務 age:null / sex:null），舊語義
 * 對可選屬性的顯式 null 報型別錯誤，導致整任務誤失敗「任務參數不完整」。
 * 修復語義：
 *   - 可選屬性顯式 null → 視為缺省（跳過校驗，SKILL 端條件透傳自然丟棄）
 *   - 必填屬性 null → 視同缺失（報「缺少必填欄位」，語義比型別錯誤準）
 *   - 真型別錯誤（如 age:'abc'）仍必須攔截，不放鬆校驗強度
 *
 * 運行：npm run build 前置編譯 dist-test（見 package.json test:validator）
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

const { validate } = await load('utils/validator.js');

/** 代表性 schema：健康分診 symptom_triage 的形態（required 單欄位 + 可選增強欄位） */
const schema = {
  type: 'object',
  required: ['symptoms'],
  properties: {
    symptoms: { type: 'string', description: '用戶症狀描述原文' },
    duration: { type: 'string' },
    age: { type: 'number' },
    sex: { type: 'string' },
  },
};

test('事故復現：可選屬性 age/sex 填 null → 校驗通過（不再誤報型別錯誤）', () => {
  const r = validate(
    { symptoms: '我最近有些咳嗽', duration: null, age: null, sex: null },
    schema,
  );
  assert.equal(r.ok, true, `不應報錯：${JSON.stringify(r.errors)}`);
});

test('可選屬性合法值正常透過；混合 null 與合法值互不干擾', () => {
  const r = validate(
    { symptoms: '咳嗽三天', age: 30, sex: 'male', duration: null },
    schema,
  );
  assert.equal(r.ok, true);
});

test('真型別錯誤仍攔截：age 填字串 → 報期望型別 number', () => {
  const r = validate({ symptoms: '咳嗽', age: '三十歲' }, schema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'age' && e.message.includes('期望型別 number')));
});

test('必填屬性填 null → 視同缺失（報「缺少必填欄位」而非型別錯誤）', () => {
  const r = validate({ symptoms: null, age: null }, schema);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'symptoms' && e.message.includes('缺少必填欄位')));
});

test('既有語義回歸：必填缺席 / 空字串仍報錯', () => {
  const r1 = validate({ age: 30 }, schema);
  assert.ok(r1.errors.some((e) => e.path === 'symptoms' && e.message.includes('缺少必填欄位')));
  const r2 = validate({ symptoms: '   ' }, schema);
  assert.ok(r2.errors.some((e) => e.path === 'symptoms' && e.message.includes('空字串')));
});

test('nullable 顯式宣告契約不變：null 豁免', () => {
  const r = validate(
    { symptoms: '咳嗽', remark: null },
    {
      type: 'object',
      required: ['symptoms'],
      properties: {
        symptoms: { type: 'string' },
        remark: { type: 'string', nullable: true },
      },
    },
  );
  assert.equal(r.ok, true);
});
