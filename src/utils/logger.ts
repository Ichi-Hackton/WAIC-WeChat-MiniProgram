/**
 * 日誌工具
 *
 * 規範（Agent.md § 12.3）：utils/ 層不得 import 'wx.*'，
 * 本模組僅依賴 console，確保純函式可單元測試。
 *
 * 所有日誌前綴固定為 `[BRAND_NAME][LEVEL]`，便於日誌聚合與品牌溯源。
 */

import { BRAND_NAME, BRAND_VERSION } from '../types/brand';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

/** 設置全局日誌門檻（一般由 App onLaunch 依環境動態注入） */
export function setLogLevel(lv: LogLevel): void {
  currentLevel = lv;
}

function shouldLog(lv: LogLevel): boolean {
  return LEVEL_ORDER[lv] >= LEVEL_ORDER[currentLevel];
}

function prefix(lv: LogLevel): string {
  return `[${BRAND_NAME}][${lv.toUpperCase()}]`;
}

function stamp(): string {
  return new Date().toISOString();
}

/** Debug 等級日誌，受門檻控制 */
export function debug(...args: unknown[]): void {
  if (!shouldLog('debug')) return;
  console.log(prefix('debug'), stamp(), ...args);
}

/** Info 等級日誌，受門檻控制 */
export function info(...args: unknown[]): void {
  if (!shouldLog('info')) return;
  console.log(prefix('info'), stamp(), ...args);
}

/** Warn 等級日誌，受門檻控制 */
export function warn(...args: unknown[]): void {
  if (!shouldLog('warn')) return;
  console.warn(prefix('warn'), stamp(), ...args);
}

/** Error 等級日誌，永遠輸出（不受門檻限制） */
export function error(...args: unknown[]): void {
  console.error(prefix('error'), stamp(), ...args);
}

/** 啟動 banner，集中輸出品牌資訊 */
export function banner(): void {
  info(`${BRAND_NAME} v${BRAND_VERSION} 已就緒`);
}
