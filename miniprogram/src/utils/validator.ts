/**
 * 通用驗證器（極簡實作，覆蓋 LLM 輸出 + SKILL 入參）
 *
 * 規範來源：.qoder/rules/Agent.md § 8.3
 *
 * 不引入 ajv 等重型依賴，僅覆蓋 MVP 階段必要校驗：
 *   - 必填欄位檢查
 *   - 型別檢查
 *   - 列舉值檢查
 *   - 點號路徑取值（與 inputBindings 共用）
 */

import type { JSONSchema, JSONSchemaType } from '../types/jsonschema';

export interface ValidationError {
  path: string;
  message: string;
}

/** 驗證結果 */
export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

/** 透過點號路徑取得物件深層值（如 "data.train.no"） */
export function getByPath(obj: unknown, path: string): unknown {
  if (obj === undefined || obj === null) return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** 設定深層值（用於 inputBindings 反向注入） */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      cur[key] = created;
      cur = created;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  cur[parts[parts.length - 1]] = value;
}

/** 型別校驗 */
function matchesType(value: unknown, type: JSONSchemaType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      if (typeof value !== 'number') return false;
      if (type === 'integer' && !Number.isInteger(value)) return false;
      return true;
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/** 校驗單一 schema（遞迴） */
function validateAgainst(
  value: unknown,
  schema: JSONSchema,
  path: string,
  errors: ValidationError[],
): void {
  // nullable
  if (value === null && schema.nullable) return;

  // type 檢查
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) => matchesType(value, t));
    if (!ok && value !== undefined) {
      errors.push({
        path,
        message: `期望型別 ${types.join('|')}, 實際為 ${value === null ? 'null' : typeof value}`,
      });
      return;
    }
  }

  // enum 檢查
  if (schema.enum && !schema.enum.includes(value as never)) {
    errors.push({
      path,
      message: `值 ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schema.enum)}`,
    });
  }

  // const 檢查
  if (schema.const !== undefined && value !== schema.const) {
    errors.push({
      path,
      message: `值必須等於 ${JSON.stringify(schema.const)}`,
    });
  }

  // 必填欄位
  if (schema.type === 'object' && schema.required && typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required) {
      if (!(req in obj) || obj[req] === undefined) {
        errors.push({
          path: path === '' ? req : `${path}.${req}`,
          message: `缺少必填欄位 ${req}`,
        });
      }
    }
  }

  // 陣列元素
  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    value.forEach((item, idx) => {
      validateAgainst(item, schema.items!, `${path}[${idx}]`, errors);
    });
  }

  // 物件屬性
  if (schema.type === 'object' && schema.properties && typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const [key, subSchema] of Object.entries(schema.properties)) {
      validateAgainst(obj[key], subSchema, path === '' ? key : `${path}.${key}`, errors);
    }
  }
}

/** 對外主入口 */
export function validate(value: unknown, schema: JSONSchema): ValidationResult {
  const errors: ValidationError[] = [];
  validateAgainst(value, schema, '', errors);
  return { ok: errors.length === 0, errors };
}

/** 拋出型版本，便於鏈式使用 */
export function assertValid(value: unknown, schema: JSONSchema, label = 'value'): void {
  const r = validate(value, schema);
  if (!r.ok) {
    const detail = r.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`[${label}] 驗證失敗：${detail}`);
  }
}