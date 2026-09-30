/**
 * JSON Schema 型別（簡化版，覆蓋 SKILL 與 LLM 輸出驗證所需）
 *
 * 規範來源：.qoder/rules/Agent.md § 6.1
 *
 * 完整 Draft 7 規格請裝 `@types/json-schema`；本檔案僅聲明 MicroMate
 * bootstrap 階段會主動讀取的子集，避免外部型別依賴。
 */

export type JSONSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null'
  | (string & {});

export interface JSONSchema {
  type?: JSONSchemaType | JSONSchemaType[];
  /** 物件的欄位定義 */
  properties?: Record<string, JSONSchema>;
  /** 必填欄位 */
  required?: string[];
  /** 陣列元素 schema */
  items?: JSONSchema;
  /** 列舉值 */
  enum?: unknown[];
  /** 預設值 */
  default?: unknown;
  /** 字串說明（給 LLM 讀） */
  description?: string;
  /** 附加約束 */
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** 是否允許額外欄位 */
  additionalProperties?: boolean | JSONSchema;
  /** 與其他 schema 的聯合 */
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];
  /** const 限定 */
  const?: unknown;
  /** nullable 簡寫 */
  nullable?: boolean;
}