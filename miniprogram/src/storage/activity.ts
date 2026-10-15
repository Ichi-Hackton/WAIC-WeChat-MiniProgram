/**
 * 執行記錄儲存（本地用户侧 Activity 日誌，2026-10 第二梯隊·項E，借鑑
 * Dots 的 Activity 審計頁）
 *
 * 設計定位：用户可見的「Agent 替我做了什麼」留痕——每輪任務流收尾時
 * 落一條記錄（意圖脱敏摘要 + 結果 + 任務標籤序列），個人資料頁「執行
 * 記錄」分區時間倒序展示。
 *
 * 與雲端 metrics 的邊界（隱私紅線 § 10 數據最小化）：
 *   - 雲端 metrics 僅收事件名 + 時間戳（刻意不含內容），供漏斗統計——
 *     「旁路轉正」會違背其設計承諾，故執行記錄走本機存儲；
 *   - 本記錄不出本機：意圖經 sanitizeIntent 打碼，不存任何入參 /
 *     出參 / 證件信息，僅存任務中文標籤（「查詢車次」級粒度）；
 *   - 生命週期隨「清除會話歷史」聯動歸零（會話類數據，用戶可控）。
 */

import { setItem, getItem } from '../services/storage';
import { sanitizeIntent } from './session';

const ACTIVITY_KEY = 'agent:activity-log';

/** 記錄容量上限（超出淘汰最舊；50 條約覆蓋數週使用軌跡，足夠複核） */
const MAX_ENTRIES = 50;

/** 意圖摘要截斷上限 */
const MAX_INTENT_LEN = 40;

/** 任務標籤序列截斷上限（展示防溢出） */
const MAX_LABELS = 6;

/** 單輪執行結果 */
export type ActivityOutcome = 'completed' | 'failed' | 'mixed';

/** 執行記錄條目 */
export interface ActivityEntry {
  /** 落記錄時間（收尾時刻） */
  ts: number;
  /** 意圖脱敏摘要（sanitizeIntent 打碼 + 截斷） */
  intent: string;
  /** 結果：completed 全部成功 / failed 全部未成 / mixed 部分成功 */
  outcome: ActivityOutcome;
  /** 任務中文標籤序列（本輪成功任務，按執行敘述順序；失敗輪以 outcome 表達） */
  labels: string[];
}

/** 追加一條執行記錄（超限淘汰最舊） */
export function appendActivity(rawIntent: string, outcome: ActivityOutcome, labels: string[]): void {
  const intent = sanitizeIntent(rawIntent).slice(0, MAX_INTENT_LEN);
  if (!intent && labels.length === 0) return;
  const entry: ActivityEntry = {
    ts: Date.now(),
    intent: intent || '（未留痕意圖）',
    outcome,
    labels: labels.slice(0, MAX_LABELS),
  };
  const list = getEntries();
  list.push(entry);
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  setItem(ACTIVITY_KEY, list);
}

/** 全量記錄（時間倒序，最新在前） */
export function listActivities(): ActivityEntry[] {
  return getEntries().slice().reverse();
}

/** 清空全部執行記錄（隱私控制中心「清除會話歷史」聯動） */
export function clearActivities(): void {
  setItem(ACTIVITY_KEY, []);
}

/** 讀取並窄化（防髒數據：形狀不符的條目靜默丟棄） */
function getEntries(): ActivityEntry[] {
  const raw = getItem<unknown>(ACTIVITY_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is ActivityEntry =>
    typeof e === 'object' && e !== null
      && typeof (e as ActivityEntry).ts === 'number'
      && typeof (e as ActivityEntry).intent === 'string'
      && typeof (e as ActivityEntry).outcome === 'string'
      && Array.isArray((e as ActivityEntry).labels));
}
