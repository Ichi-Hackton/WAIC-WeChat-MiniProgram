/**
 * MicroMate 型別統一匯出入口
 *
 * 規範：所有跨層級引用型別時，優先從本檔案 import，避免深層路徑依賴。
 */

export * from './jsonschema';
export * from './skill';
export * from './task';
export * from './plan';
export * from './context';
export * from './checkpoint';
export * from './agent-state';
export * from './trip';
export { BRAND_NAME, BRAND_TAGLINE, BRAND_TAGLINE_EN, BRAND_SHORT, BRAND_VERSION, BRAND_AI_GENERATED_BY } from './brand';