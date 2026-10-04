/**
 * 日誌工具
 *
 * 規範（Agent.md § 12.3）：utils/ 層不得 import 'wx.*'，
 * 本模組僅依賴 console，確保純函式可單元測試。
 *
 * 所有日誌前綴固定為 `[BRAND_NAME][LEVEL]`，便於日誌聚合與品牌溯源。
 */

import { BRAND_NAME } from '../types/brand';

/** 日誌等級 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 遠端日誌接收器：由 App 組裝層注入 wx.request 實作（utils 不得
 * import wx，規範 § 12.3）；開發環境用於將日誌旁路上報本地雲托管
 * /api/dev-log 落盤，徹底繞開開發者工具 Console 面板取證不穩定的問題。
 */
export type RemoteSink = (level: LogLevel, message: string) => void;

let remoteSink: RemoteSink | null = null;

/** 注入 / 移除遠端日誌接收器（冪等；App onLaunch 時呼叫一次） */
export function setRemoteSink(sink: RemoteSink | null): void {
  remoteSink = sink;
}

/** 非字串參數安全序列化（循環引用等異常退回 String()） */
function serialize(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** 旁路上報（fire-and-forget）：任何異常靜默吞掉，日誌路徑永不影響業務 */
function emitRemote(lv: LogLevel, args: unknown[]): void {
  if (!remoteSink) return;
  try {
    remoteSink(lv, args.map(serialize).join(' '));
  } catch {
    // 上報失敗靜默（接收器自身缺陷不應波及主流程）
  }
}

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
  emitRemote('debug', args);
}

/** Info 等級日誌，受門檻控制 */
export function info(...args: unknown[]): void {
  if (!shouldLog('info')) return;
  console.log(prefix('info'), stamp(), ...args);
  emitRemote('info', args);
}

/** Warn 等級日誌，受門檻控制 */
export function warn(...args: unknown[]): void {
  if (!shouldLog('warn')) return;
  console.warn(prefix('warn'), stamp(), ...args);
  emitRemote('warn', args);
}

/** Error 等級日誌，永遠輸出（不受門檻限制） */
export function error(...args: unknown[]): void {
  console.error(prefix('error'), stamp(), ...args);
  emitRemote('error', args);
}