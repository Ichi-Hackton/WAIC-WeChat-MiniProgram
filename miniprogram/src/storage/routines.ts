/**
 * 快捷例程儲存（Plan 模板化·時刻版，2026-10 第一梯隊·項2，借鑑 Grok
 * Bot / Cue 的 routines 模式）
 *
 * 設計定位：快捷短語記「一句話」（點擊原樣重發），快捷例程記「一句話
 * + 當時成功的任務序列」——重複意圖固化後，下次一鍵觸發同一條任務鏈
 * （規劃仍走 LLM 全流程，例程僅承擔「入口個人化」，不快取 Plan——
 * 意圖重述時日期 / 車次等參數由規劃器按當輪上下文重新解析，避免模板
 * 過期下單）。
 *
 * 固化入口：重複意圖完成後由首頁出「存為例程」提議卡（重複 ≥2 次
 * 才提議，低打擾）；用戶確認才落盤（推斷須徵求同意，與偏好分層記憶
 * 同口徑）。例程 chips 長按可刪。
 *
 * 記錄口徑：label 為任務序列的中文摘要（「查詢車次 → 購票」），text
 * 為用戶原話；以 text 精確匹配判重（與 quick-phrases 同口徑）。
 */

import { setItem, getItem } from '../services/storage';

const ROUTINES_KEY = 'quick:routines';

/** 已拒絕固化的话语記錄（拒絕或忽略皆同）——同話語不再重複提議，避免反覆打擾 */
const ROUTINE_DISMISSED_KEY = 'quick:routines:dismissed';

/** 例程容量上限（超出淘汰最久未用，防無界增長） */
const MAX_ROUTINES = 12;

/** 單條例程文本長度上限（與快捷短語同口徑） */
const MAX_ROUTINE_TEXT = 60;

/** 快捷例程條目 */
export interface RoutineEntry {
  /** 例程 ID（rt_ 時間戳_序號） */
  id: string;
  /** 用戶原話（點擊 chip 原樣發送） */
  text: string;
  /** 任務序列摘要（成功任務的中文標籤以 → 連接，展示「這會做什麼」） */
  label: string;
  /** 創建時間 */
  createdAt: number;
  /** 最近一次使用時間 */
  lastUsedAt: number;
}

/** 例程序號（ID 唯一性兜底：同毫秒多次創建） */
let ROUTINE_SEQ = 0;

/** 新增例程（已存在同 text 時靜默忽略——確認卡與 chips 雙入口防重） */
export function addRoutine(raw: string, label: string): RoutineEntry | null {
  const text = raw.trim();
  if (!text || text.length > MAX_ROUTINE_TEXT) return null;
  const cleanLabel = label.trim().slice(0, 60) || text.slice(0, 20);
  const list = getRoutines();
  if (list.some((r) => r.text === text)) return null;
  const now = Date.now();
  const entry: RoutineEntry = {
    id: `rt_${now}_${++ROUTINE_SEQ}`,
    text,
    label: cleanLabel,
    createdAt: now,
    lastUsedAt: now,
  };
  list.push(entry);
  if (list.length > MAX_ROUTINES) {
    // 淘汰最久未用（例程價值以使用新鮮度為準，與短語的頻次口徑不同）
    list.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    list.length = MAX_ROUTINES;
  }
  setItem(ROUTINES_KEY, list);
  return entry;
}

/** 全量例程（最近使用在前） */
export function listRoutines(): RoutineEntry[] {
  return getRoutines()
    .slice()
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** 例程使用計數（點擊 chip 觸發時刷新新鮮度） */
export function touchRoutine(id: string): void {
  const list = getRoutines();
  const hit = list.find((r) => r.id === id);
  if (!hit) return;
  hit.lastUsedAt = Date.now();
  setItem(ROUTINES_KEY, list);
}

/** 刪除例程（長按 chips 觸發） */
export function removeRoutine(id: string): void {
  setItem(
    ROUTINES_KEY,
    getRoutines().filter((r) => r.id !== id),
  );
}

/** 清空全部例程（隱私控制中心「清除偏好與快捷數據」聯動） */
export function clearRoutines(): void {
  setItem(ROUTINES_KEY, []);
}

/** 判斷話語是否已存為例程（提議卡去重：已固化不再重複提議） */
export function hasRoutineText(raw: string): boolean {
  const text = raw.trim();
  return getRoutines().some((r) => r.text === text);
}

/** 記錄話語已拒絕固化（提議卡「不用了」：同話語不再重複提議） */
export function dismissRoutineText(raw: string): void {
  const text = raw.trim();
  if (!text) return;
  const list = getItem<string[]>(ROUTINE_DISMISSED_KEY, []) ?? [];
  if (!list.includes(text)) {
    list.push(text);
    // 拒絕記錄有界（保留最近 60 條，防無界增長）
    setItem(ROUTINE_DISMISSED_KEY, list.slice(-60));
  }
}

/** 判斷話語是否已拒絕過固化（提議卡出卡條件之一） */
export function isRoutineDismissed(raw: string): boolean {
  const text = raw.trim();
  const list = getItem<string[]>(ROUTINE_DISMISSED_KEY, []) ?? [];
  return list.includes(text);
}

/** 讀取並窄化（防髒數據：形狀不符的條目靜默丟棄） */
function getRoutines(): RoutineEntry[] {
  const raw = getItem<unknown>(ROUTINES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is RoutineEntry =>
    typeof r === 'object' && r !== null
      && typeof (r as RoutineEntry).id === 'string'
      && typeof (r as RoutineEntry).text === 'string'
      && typeof (r as RoutineEntry).label === 'string'
      && typeof (r as RoutineEntry).createdAt === 'number'
      && typeof (r as RoutineEntry).lastUsedAt === 'number');
}
