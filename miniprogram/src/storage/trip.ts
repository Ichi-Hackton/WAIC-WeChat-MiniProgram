/**
 * 行程簿（本地持久化）
 *
 * 規範來源：.qoder/rules/Agent.md § 4（storage/ 業務持久化）、§ 12.3（分層依賴）
 *
 * 職責：
 *   - 行程條目的本地 CRUD（wx.setStorageSync，經 services/storage 統一封裝）
 *   - Plan → TripEntry 的兩階段同步：確認後建檔（planned）、調度結束後
 *     更新時間線任務狀態與行程終態（done / partial）
 *   - 到點提醒支持：行程日查詢（dueTodayTrips）與提醒去重（markReminded）
 *
 * 依賴說明：core/orchestrator 於 Plan 確認 / 結束時調用本模組
 * （core → storage 分層引用）；本模組不反向依賴 core / llm，任務中文標題直接取 Planner 生成的 summary。
 */

import { getItem, setItem } from '../services/storage';
import { formatDate, isSameDay } from '../utils/datetime';
import type { TripEntry } from '../types/trip';
import type { JumpPackage } from '../types/skill';
import type { Plan } from '../types/plan';

/** 存儲鍵（實際落盤為 micromate:trip:book） */
const BOOK_KEY = 'trip:book';

/** 行程簿容量上限（防無限膨脹；超出時舊行程被淘汰） */
export const TRIP_LIMIT = 20;

/** 讀取整本行程簿（新的在前） */
export function listTrips(): TripEntry[] {
  return getItem<TripEntry[]>(BOOK_KEY, []) ?? [];
}

/** 按 ID 取單條行程 */
export function getTrip(id: string): TripEntry | null {
  return listTrips().find((t) => t.id === id) ?? null;
}

/** 刪除行程（行程頁左滑 / 按鈕刪除用） */
export function removeTrip(id: string): boolean {
  const book = listTrips();
  const idx = book.findIndex((t) => t.id === id);
  if (idx < 0) return false;
  book.splice(idx, 1);
  setItem(BOOK_KEY, book);
  return true;
}

/**
 * 任務標題（展示用）：優先 Planner 生成的中文 summary；
 * 缺省或技術形態（含「skill.」前綴）時回退通用文案
 */
function taskTitle(t: Plan['tasks'][number]): string {
  const s = t.summary ?? '';
  return s && !s.includes('skill.') ? s : '執行任務';
}

/** result.data.jump → JumpPackage 型別窄化（非預期形態返回 undefined，不拋錯） */
function extractJump(data: Record<string, unknown> | undefined): JumpPackage | undefined {
  if (!data || typeof data.jump !== 'object' || data.jump === null) return undefined;
  const j = data.jump as Record<string, unknown>;
  if (typeof j.appId !== 'string' || typeof j.copyText !== 'string') return undefined;
  return {
    target: typeof j.target === 'string' ? j.target : '',
    appId: j.appId,
    ...(typeof j.path === 'string' && j.path ? { path: j.path } : {}),
    ...(typeof j.jCommand === 'string' && j.jCommand ? { jCommand: j.jCommand } : {}),
    copyText: j.copyText,
    note: typeof j.note === 'string' ? j.note : '',
  };
}

/**
 * Plan 確認後建檔（第一階段同步）
 *
 * 僅行程 Plan（plan.trip 存在）會落庫；同一 planId 冪等——重複呼叫
 * （如重試）返回既有條目，不重複建檔。時間線此時記錄任務初始狀態
 * （pending），執行結束後由 updateTripFromPlan 二次同步。
 *
 * @returns 新建（或既有的）行程條目；非行程 Plan 返回 null
 */
export function saveTripFromPlan(plan: Plan): TripEntry | null {
  if (!plan.trip) return null;
  const book = listTrips();
  const existed = book.find((t) => t.planId === plan.id);
  if (existed) return existed;

  const trip = plan.trip;
  const entry: TripEntry = {
    id: `trip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    planId: plan.id,
    date: trip.date,
    dateLabel: trip.dateLabel,
    city: trip.city,
    activity: trip.activity,
    intent: plan.intent,
    timeline: plan.tasks.map((t) => ({
      taskId: t.id,
      // 時間標籤缺省回退活動日（MM-DD），保證時間線節點恆有時間語義
      timeLabel: t.timeLabel ?? trip.date.slice(5),
      title: taskTitle(t),
      status: t.status,
    })),
    status: 'planned',
    createdAt: Date.now(),
  };
  book.unshift(entry); // 新行程在前
  if (book.length > TRIP_LIMIT) book.length = TRIP_LIMIT;
  setItem(BOOK_KEY, book);
  return entry;
}

/**
 * 調度結束後同步（第二階段同步）：按 planId 更新時間線任務狀態與行程終態
 *
 * 終態口徑：plan.status === 'done' → done；其餘（failed / 提前中止）
 * 只要存在已成功任務 → partial，全部未成功保持 planned（下次執行仍可同步）。
 */
export function updateTripFromPlan(plan: Plan): void {
  const book = listTrips();
  const idx = book.findIndex((t) => t.planId === plan.id);
  if (idx < 0) return;

  const entry = book[idx];
  for (const task of plan.tasks) {
    const node = entry.timeline.find((n) => n.taskId === task.id);
    if (!node) continue;
    node.status = task.status;
    // 跳轉模式：成功寫任務攜帶 jump 包時隨節點落盤，
    // 供行程頁「去下單」重跳轉入口消費（跳轉卡丟失後的二次入口）
    if (task.status === 'succeeded') {
      const data = task.result?.data as Record<string, unknown> | undefined;
      const jump = extractJump(data);
      if (jump) node.jump = jump;
      // 跳轉訂單要素（orderId + 路由拼徑用 skillId / action）：行程頁
      // 「標記已支付」成交確認入口消費（雲端 complete 端點歸檔 completed）
      if (data && typeof data.orderId === 'string' && data.orderId) {
        node.orderId = data.orderId;
        node.skillId = task.skillId;
        node.action = task.action;
      }
    }
  }
  const succeeded = plan.tasks.filter((t) => t.status === 'succeeded').length;
  entry.status =
    plan.status === 'done' ? 'done' : succeeded > 0 ? 'partial' : entry.status;
  book[idx] = entry;
  setItem(BOOK_KEY, book);
}

/**
 * 行程日到期查詢（到點提醒用）：活動日為今日且今日未提醒過的行程
 *
 * 提醒與行程任務成敗無關——「今天有行程」本身就是提醒語義；
 * 同日同行程僅提醒一次（remindedAt 記錄最近提醒時間）。
 */
export function dueTodayTrips(now: Date = new Date()): TripEntry[] {
  const today = formatDate(now);
  return listTrips().filter((t) => {
    if (t.date !== today) return false;
    if (t.remindedAt && isSameDay(t.remindedAt, now.getTime())) return false;
    return true;
  });
}

/** 標記已提醒（今日內不再重複提醒） */
export function markReminded(id: string): void {
  const book = listTrips();
  const entry = book.find((t) => t.id === id);
  if (!entry) return;
  entry.remindedAt = Date.now();
  setItem(BOOK_KEY, book);
}

/** 標記已訂閱出發提醒（訂閱消息授權 accept 後記錄；出發前推送側消費） */
export function markSubscribed(id: string): void {
  const book = listTrips();
  const entry = book.find((t) => t.id === id);
  if (!entry) return;
  entry.subscribedAt = Date.now();
  setItem(BOOK_KEY, book);
}

/**
 * 標記時間線節點已成交（渠道側支付完成後的用戶自證；本地 UI 態，
 * 雲端訂單狀態由 complete 端點先行歸檔，兩處同步由頁面層保證）
 *
 * @returns 是否標記成功（行程 / 節點不存在，或節點未攜帶訂單號時 false）
 */
export function markNodePaid(tripId: string, taskId: string): boolean {
  const book = listTrips();
  const entry = book.find((t) => t.id === tripId);
  const node = entry?.timeline.find((n) => n.taskId === taskId);
  if (!entry || !node || !node.orderId) return false;
  node.paidAt = Date.now();
  setItem(BOOK_KEY, book);
  return true;
}

/** 清空行程簿（測試 / 重置用） */
export function clearTrips(): void {
  setItem(BOOK_KEY, []);
}
