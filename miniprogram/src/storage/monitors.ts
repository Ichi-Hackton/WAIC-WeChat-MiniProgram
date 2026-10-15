/**
 * 餘票監控本地登記（2026-10 第二梯隊·項A）
 *
 * 雲端 /api/monitors 為權威數據源（MySQL 落庫 / 記憶體降級，定時觸發器
 * tick 掃描回寫命中狀態）；本機僅存展示副本（離線可見 + 秒開），行程頁
 * onShow 時經 syncMonitors 拉雲端覆蓋——與 storage/trip 同款「雲權威 +
 * 本地快取」分層。
 */

import { setItem, getItem } from '../services/storage';

/** 本地監控條目（雲端 MonitorItem 的展示子集，雙端契約對齊維護） */
export interface MonitorEntry {
  monitorId: string;
  /** 展示摘要（「北京→上海 2026-10-20 G5」） */
  label: string;
  kind: 'train_tickets';
  params: { from: string; to: string; date: string; trainNo?: string };
  /** 命中標記（雲端 tick 掃描回寫；命中即目標達成） */
  hit: boolean;
  /** 最近掃描結論 / 命中詳情 */
  lastMessage: string;
  lastCheckedAt: number;
  createdAt: number;
}

const MONITORS_KEY = 'agent:monitors';

/** 讀取並窄化（防髒數據：形態不符的條目靜默丟棄） */
function readAll(): MonitorEntry[] {
  const raw = getItem<unknown>(MONITORS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is MonitorEntry =>
    typeof e === 'object' && e !== null
      && typeof (e as MonitorEntry).monitorId === 'string'
      && typeof (e as MonitorEntry).label === 'string'
      && typeof (e as MonitorEntry).hit === 'boolean'
      && typeof (e as MonitorEntry).lastMessage === 'string');
}

/** 創建 / 更新一條（以 monitorId 冪等合併，新條目置頂） */
export function upsertMonitor(entry: MonitorEntry): void {
  const list = readAll().filter((e) => e.monitorId !== entry.monitorId);
  list.unshift(entry);
  setItem(MONITORS_KEY, list);
}

/** 全量本地條目 */
export function listMonitors(): MonitorEntry[] {
  return readAll();
}

/** 雲端同步覆蓋（權威數據源整表替換本地副本） */
export function replaceMonitors(list: MonitorEntry[]): void {
  setItem(MONITORS_KEY, list);
}

/** 本地移除（雲端刪除成功後聯動） */
export function removeMonitorLocal(monitorId: string): void {
  setItem(MONITORS_KEY, readAll().filter((e) => e.monitorId !== monitorId));
}
