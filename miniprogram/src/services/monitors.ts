/**
 * 條件監控雲端調用薄封裝（2026-10 第二梯隊·項A）
 *
 * 三個操作對應雲端 monitors.ts 路由：創建（首頁車次卡售罄行「監控」
 * 入口）、列表同步（行程頁 onShow 拉取覆蓋本地副本）、刪除（歸屬鑒權
 * 雲端內建，防 IDOR）。
 */

import { postContainer, getContainer, type CloudResponse } from './cloud';

/** 創建監控入參（與雲端 handleCreate 契約對齊，兩份副本維護） */
export interface MonitorCreateInput {
  kind: 'train_tickets';
  params: { from: string; to: string; date: string; trainNo?: string };
  label: string;
}

/** 監控條目（雲端 MonitorItem 同構契約，兩份副本維護） */
export interface MonitorCloudItem {
  monitorId: string;
  kind: 'train_tickets';
  params: { from: string; to: string; date: string; trainNo?: string };
  label: string;
  createdAt: number;
  lastCheckedAt: number;
  hit: boolean;
  hitAt?: number;
  lastMessage: string;
}

/** 創建監控（首頁售罄車次行入口；上限與日期校驗雲端把關） */
export function createMonitor(
  env: string,
  input: MonitorCreateInput,
): Promise<CloudResponse<MonitorCloudItem>> {
  return postContainer<MonitorCloudItem>(env, '/api/monitors', input);
}

/** 拉取我的監控列表（行程頁 onShow 同步；活躍 + 已命中） */
export function fetchMyMonitors(env: string): Promise<CloudResponse<MonitorCloudItem[]>> {
  return getContainer<MonitorCloudItem[]>(env, '/api/monitors');
}

/** 刪除監控（歸屬鑒權雲端內建） */
export function removeMonitorCloud(
  env: string,
  monitorId: string,
): Promise<CloudResponse<{ removed: boolean }>> {
  return postContainer<{ removed: boolean }>(env, '/api/monitors/remove', { monitorId });
}
