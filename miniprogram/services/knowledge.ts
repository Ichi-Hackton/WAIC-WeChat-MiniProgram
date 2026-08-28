/**
 * 知識庫服務（RAG 對接預留接口）。
 *
 * MVP 階段：從本地 knowledge/ 示例數據異步讀取（模擬網絡延遲，
 * 以驗證頁面的加載與反饋狀態）。
 *
 * 接入 RAG 時：僅替換以下函數的實現為 wx.request 或雲函數調用
 * （例如 wx.cloud.callFunction({ name: 'rag-query', data: { kind, id, city } })），
 * 函數簽名與返回類型保持不變，頁面無需改動。
 */

import {
  FAQS,
  findCityPolicy,
  findFeeReference,
  findProcedure,
} from '../knowledge';
import type { CityPolicy, FaqEntry, FeeReference, ProcedureDetail } from '../knowledge';

/** 模擬遠端檢索延遲，保證異步契約真實有效 */
function delay(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 流程指引詳情（單項深挖） */
export async function fetchProcedureDetail(id: string): Promise<ProcedureDetail | null> {
  await delay();
  return findProcedure(id);
}

/** 城市費用參考（費用查詢） */
export async function fetchFeeReference(city: string): Promise<FeeReference> {
  await delay();
  return findFeeReference(city);
}

/** 城市政策（聯辦入口與差異提示） */
export async function fetchCityPolicy(city: string): Promise<CityPolicy | null> {
  await delay();
  return findCityPolicy(city);
}

/** 常見問題 */
export async function fetchFaqs(): Promise<FaqEntry[]> {
  await delay();
  return FAQS;
}
