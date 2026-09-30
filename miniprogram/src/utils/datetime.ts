/**
 * 簡單日期工具（避免引入 dayjs 等依賴）
 *
 * 規範：utils/ 不得 import 'wx.*'，本模組只依賴原生 Date。
 */

/** 取得當前時間 epoch 毫秒 */
export function now(): number {
  return Date.now();
}

/** 格式化日期為 YYYY-MM-DD */
export function formatDate(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 格式化為 YYYY-MM-DD HH:mm */
export function formatDateTime(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  return `${formatDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 從 YYYY-MM-DD 字串解析為 Date（時區為本地） */
export function parseDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 判斷兩個日期是否同一天（本地時區） */
export function isSameDay(a: Date | number, b: Date | number): boolean {
  const da = typeof a === 'number' ? new Date(a) : a;
  const db = typeof b === 'number' ? new Date(b) : b;
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** 加天數 */
export function addDays(d: Date | number, days: number): Date {
  const date = new Date(typeof d === 'number' ? d : d.getTime());
  date.setDate(date.getDate() + days);
  return date;
}

/** 取得「明天的日期字串」常用於意圖識別 */
export function tomorrowDate(): string {
  return formatDate(addDays(new Date(), 1));
}