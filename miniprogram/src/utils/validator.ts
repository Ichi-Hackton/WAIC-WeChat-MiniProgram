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

/** 原型污染防護：禁止作為路徑段的危險鍵（2026-10 審計 P2-1）
 *
 * 攻擊面：inputBindings 的 paramName 來自 LLM 規劃輸出（可被 prompt
 * injection 誘導），攜帶 "__proto__.x" 形態的鍵時，setByPath 中間段
 * 讀取 cur['__proto__'] 會拿到 Object.prototype 並往下寫入，造成進程內
 * 全局原型污染（已隔離驗證復現）。此處單點攔截，覆蓋全部現有與未來
 * 調用方（binding.applyBindings 等）。
 */
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** 設定深層值（用於 inputBindings 反向注入）
 *
 * @throws 路徑任一段命中危險鍵時拋錯（呼叫方將其轉譯為任務級失敗，
 *         與 applyBindings 取值失敗的 BINDING_FAILED 語義一致）
 */
export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  for (const part of parts) {
    if (FORBIDDEN_PATH_SEGMENTS.has(part)) {
      throw new Error(`不安全的路徑段「${part}」：拒絕寫入（原型污染防護）`);
    }
  }
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
  // 可選屬性缺省（undefined）：跳過全部約束。JSON Schema 語義中「屬性缺席」
  // 不觸發 enum/const/type 約束，必填性由父層 object 的 required 檢查承擔。
  // （實測踩坑：LLM 對未提及的坐席正確地不編造 seatType，若此處不豁免，
  // 缺省值會被誤判為「undefined 不在 enum」導致任務誤失敗）
  if (value === undefined) return;

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
      // null 視同缺失（2026-10-16）：LLM 對無法確定的必填參數也會輸出 null
      // 而非省略，報「缺少必填欄位」比型別錯誤語義更準，且可直接觸發追問
      if (!(req in obj) || obj[req] === undefined || obj[req] === null) {
        errors.push({
          path: path === '' ? req : `${path}.${req}`,
          message: `缺少必填欄位 ${req}`,
        });
      } else if (typeof obj[req] === 'string' && (obj[req] as string).trim() === '') {
        // 收緊語義（2026-10）：必填欄位空字串視同缺失。LLM 規劃對無法
        // 確定的參數（如城市未知時的 city）偶爾輸出 "" 而非追問用戶，
        // 僅檢查缺席攔不住，髒請求會打到雲端才被 badRequest 拒絕
        //（實測復現：查詢任務攜 city:"" → 400 city 必填）
        errors.push({
          path: path === '' ? req : `${path}.${req}`,
          message: `必填欄位 ${req} 不得為空字串`,
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
    const requiredKeys = schema.required ?? [];
    for (const [key, subSchema] of Object.entries(schema.properties)) {
      const v = obj[key];
      // 可選屬性顯式 null 視為缺省（2026-10-16 實測：LLM 對未提及的
      // 可選參數普遍輸出 null 而非省略——健康分診 age/sex 填 null 曾致
      // 整任務誤失敗「任務參數不完整」）。SKILL 端本就按「條件滿足才
      // 透傳」組裝請求，null 不會進入雲端 body；顯式宣告 nullable 或
      // type 含 'null' 的欄位行為不變（本處 skip 與其豁免等價）
      if (v === null && !requiredKeys.includes(key)) continue;
      validateAgainst(v, subSchema, path === '' ? key : `${path}.${key}`, errors);
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