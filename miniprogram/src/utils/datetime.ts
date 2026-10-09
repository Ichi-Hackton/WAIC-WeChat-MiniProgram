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

/** 星期詞 → getDay() 值（週日 = 0） */
const WEEKDAY_MAP: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
};

/**
 * 口語星期詞 → 具體日期（行程槽位的 date 來源之一）
 *
 * 支持形態：「周六 / 週六 / 星期六 / 本周六 / 下周六 / 禮拜三」等。
 * 口徑：
 *   - 「下周 X」固定取下一個自然週的 X（先算下週一，再偏移到目標日）
 *   - 「X / 本週 X」取末來 7 天内最近的 X（含今天——今天恰為 X 時口語
 *     「周六去」通常即指今天）
 *
 * @returns 日期（YYYY-MM-DD）與口語標籤（如「下周六」）；無命中返回 null
 */
export function resolveWeekday(
  text: string,
  now: Date = new Date(),
): { date: string; label: string } | null {
  const m = /(下|next)?(本|這|这)?(週|周|星期|禮拜|礼拜)([一二三四五六日天])/.exec(text);
  if (!m) return null;
  const target = WEEKDAY_MAP[m[4]];
  if (target === undefined) return null;

  if (m[1]) {
    // 「下周 X」：下週一 = 本週一 + 7；本週一偏移 = (getDay + 6) % 7（週一為 0）
    const mondayOffset = (now.getDay() + 6) % 7;
    const nextMonday = addDays(now, 7 - mondayOffset);
    const dayOffset = target === 0 ? 6 : target - 1;
    return { date: formatDate(addDays(nextMonday, dayOffset)), label: m[0] };
  }

  // 「X / 本週 X」：未來 7 天内最近的 X（含今天）
  const diff = (target - now.getDay() + 7) % 7;
  return { date: formatDate(addDays(now, diff)), label: m[0] };
}