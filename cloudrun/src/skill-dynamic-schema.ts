/**
 * 動態技能受限 schema 校驗與去敏（純函數，無副作用）
 *
 * 安全模型：
 *   - inputSchema 僅開放「扁平 object + string/number/boolean 純量」子集，
 *     杜絕 $ref / patternProperties / 遞迴結構 / 原型污染鍵
 *   - 公開 definition 欄位（name/description/instructions）經 PII 掃描去敏，
 *     手機 / 證件號 / email / 長數字串一律遮罩後再落庫
 *   - 校驗同時用於：forge 草稿生成、審批前複檢、run 入參檢查
 */

import type { RestrictedInputSchema, RestrictedPropertySchema } from './skill-dynamic-types';

/** 屬性名合法性：字母開頭，僅字母 / 數字 / 下劃線，長度 1-24 */
const PROP_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;

/** 原型污染鍵（含變形） */
function isUnsafeKey(key: string): boolean {
  const k = key.toLowerCase();
  return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

export interface SchemaCheck {
  ok: boolean;
  error?: string;
  schema?: RestrictedInputSchema;
}

/**
 * 校驗並正規化受限 inputSchema
 *
 * 通過條件：type='object'、properties 1-6 個純量屬性、required 為其子集、
 * 無未知保留字（$ref / allOf / additionalProperties 等）
 */
export function validateInputSchema(raw: unknown): SchemaCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'inputSchema 必須為物件' };
  }
  const o = raw as Record<string, unknown>;
  if (o.type !== 'object') return { ok: false, error: 'inputSchema.type 必須為 object' };
  // additionalProperties 必須顯式為 false（受限子集的圍欄，禁止開放式物件）
  if (o.additionalProperties !== undefined && o.additionalProperties !== false) {
    return { ok: false, error: 'inputSchema.additionalProperties 僅允許 false' };
  }
  // 僅允許出現本子集定義的鍵（出現其他鍵一律拒絕，防語義漂移）
  const allowedKeys = new Set(['type', 'properties', 'required', 'description', 'additionalProperties']);
  for (const key of Object.keys(o)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `inputSchema 不支援欄位「${key}」` };
    }
  }
  const propsRaw = o.properties;
  if (!propsRaw || typeof propsRaw !== 'object' || Array.isArray(propsRaw)) {
    return { ok: false, error: 'inputSchema.properties 必須為物件' };
  }
  const propKeys = Object.keys(propsRaw);
  if (propKeys.length === 0 || propKeys.length > 6) {
    return { ok: false, error: 'inputSchema.properties 屬性數須為 1-6' };
  }
  const properties: Record<string, RestrictedPropertySchema> = {};
  for (const key of propKeys) {
    if (!PROP_NAME_RE.test(key) || isUnsafeKey(key)) {
      return { ok: false, error: `屬性名「${key}」不合法（字母開頭，僅字母數字下劃線）` };
    }
    const p = (propsRaw as Record<string, unknown>)[key];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return { ok: false, error: `屬性「${key}」宣告必須為物件` };
    }
    const po = p as Record<string, unknown>;
    if (po.type !== 'string' && po.type !== 'number' && po.type !== 'boolean') {
      return { ok: false, error: `屬性「${key}」.type 僅支援 string/number/boolean` };
    }
    const pAllowed = new Set(['type', 'description']);
    for (const pk of Object.keys(po)) {
      if (!pAllowed.has(pk)) return { ok: false, error: `屬性「${key}」不支援欄位「${pk}」` };
    }
    const desc = po.description;
    if (desc !== undefined && (typeof desc !== 'string' || desc.length > 60)) {
      return { ok: false, error: `屬性「${key}」description 須為 ≤60 字字串` };
    }
    properties[key] = {
      type: po.type,
      ...(typeof desc === 'string' ? { description: desc } : {}),
    };
  }
  let required: string[] = [];
  if (o.required !== undefined) {
    if (!Array.isArray(o.required) || o.required.some((r) => typeof r !== 'string')) {
      return { ok: false, error: 'inputSchema.required 必須為字串陣列' };
    }
    required = o.required as string[];
  }
  for (const r of required) {
    if (!(r in properties)) return { ok: false, error: `required 欄位「${r}」未在 properties 宣告` };
  }
  return { ok: true, schema: { type: 'object', properties, required, additionalProperties: false } };
}

export interface InputCheck {
  ok: boolean;
  error?: string;
}

/** run 入參校驗（必填在場 + 型別相符 + 長度上限） */
export function validateInputAgainstSchema(
  input: unknown,
  schema: RestrictedInputSchema,
): InputCheck {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'input 必須為物件' };
  }
  const o = input as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!(key in schema.properties)) {
      return { ok: false, error: `不支援的參數「${key}」` };
    }
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = o[key];
    if (v === undefined || v === null) {
      if (schema.required.includes(key)) return { ok: false, error: `缺少必填參數「${key}」` };
      continue;
    }
    switch (prop.type) {
      case 'string':
        if (typeof v !== 'string' || v.length > 200) {
          return { ok: false, error: `參數「${key}」須為 ≤200 字字串` };
        }
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return { ok: false, error: `參數「${key}」須為有限數字` };
        }
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return { ok: false, error: `參數「${key}」須為布林值` };
        break;
    }
  }
  return { ok: true };
}

/** PII 樣式（去敏用；寧可誤傷長數字串，不可漏放證件 / 手機） */
const PII_PATTERNS: Array<{ re: RegExp; mask: string }> = [
  { re: /1[3-9]\d{9}/g, mask: '[已隱去]' }, // 手機
  { re: /\d{17}[\dXx]/g, mask: '[已隱去]' }, // 18 位證件
  { re: /\b\d{15}\b/g, mask: '[已隱去]' }, // 15 位證件
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, mask: '[已隱去]' }, // email
  { re: /\d{12,}/g, mask: '[已隱去]' }, // 其餘長數字（卡號 / 票號等）
  { re: /(sk|api|token|key)[-_.][A-Za-z0-9]{16,}/gi, mask: '[已隱去]' }, // 憑證樣式
];

/** 去敏一段文字（遮罩 PII 樣式；截斷至 maxLen） */
export function scrubPii(text: string, maxLen: number): string {
  let out = text;
  for (const { re, mask } of PII_PATTERNS) {
    out = out.replace(re, mask);
  }
  return out.slice(0, maxLen);
}

/** 公開欄位是否仍含明顯 PII（去敏後複檢，命中即拒絕公開） */
export function containsResidualPii(text: string): boolean {
  return (
    /1[3-9]\d{9}/.test(text) ||
    /\d{17}[\dXx]/.test(text) ||
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text) ||
    /\d{12,}/.test(text)
  );
}
