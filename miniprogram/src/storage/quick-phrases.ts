/**
 * 常用話語儲存（快捷入口個人化數據源）
 *
 * 記錄用戶 dispatch 過的自然語言意圖（精確匹配計頻次 + 最近使用時間），
 * 首頁快捷入口依此展示「你常問的」話語，無記錄時由頁面回退出廠範例。
 *
 * 記錄口徑：dispatch 統一入口呼叫（輸入框 / 語音 / chip 點選皆匯聚於此）；
 * 預訂類指令（「預訂 2026-10-04 …」）帶具體日期車次，時效性強且已由
 * 車次 / 航班卡的預訂按鈕自然承載，不作為候選記錄。
 */

import { getItem, setItem } from '../services/storage';

const PHRASES_KEY = 'quick:phrases';

/** 常用話語容量上限（超出淘汰頻次最低且最久未用，防無界增長） */
const MAX_PHRASES = 40;

/** 單條話語長度上限（過長語句不適合作為快捷入口，不記錄） */
const MAX_PHRASE_LEN = 60;

/** 常用話語條目 */
export interface QuickPhrase {
  /** 用戶原話（點擊 chip 原樣發送） */
  text: string;
  /** 使用頻次 */
  count: number;
  /** 最近一次使用時間（同頻次排序用） */
  lastUsedAt: number;
}

/** 記錄一次用戶意圖（冪等於話語維度：重複話語僅累加頻次） */
export function recordQuickPhrase(raw: string): void {
  const text = raw.trim();
  if (!text || text.length > MAX_PHRASE_LEN) return;
  if (text.startsWith('預訂 ')) return;
  const list = getPhrases();
  const now = Date.now();
  const hit = list.find((p) => p.text === text);
  if (hit) {
    hit.count += 1;
    hit.lastUsedAt = now;
  } else {
    list.push({ text, count: 1, lastUsedAt: now });
    if (list.length > MAX_PHRASES) {
      // 淘汰後保留頻次最高（平手取最近使用）的前 MAX_PHRASES 條
      list.sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt);
      list.length = MAX_PHRASES;
    }
  }
  setItem(PHRASES_KEY, list);
}

/** 取常用話語 Top N（頻次降序，同頻次最近使用優先），無記錄時為空陣列 */
export function topQuickPhrases(limit: number): QuickPhrase[] {
  return getPhrases()
    .slice()
    .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt)
    .slice(0, limit);
}

/** 讀取並窄化（防髒數據：形狀不符的條目靜默丟棄） */
function getPhrases(): QuickPhrase[] {
  const raw = getItem<unknown>(PHRASES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is QuickPhrase =>
    typeof p === 'object' && p !== null
      && typeof (p as QuickPhrase).text === 'string'
      && typeof (p as QuickPhrase).count === 'number'
      && typeof (p as QuickPhrase).lastUsedAt === 'number');
}
