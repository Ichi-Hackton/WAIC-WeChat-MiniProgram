/**
 * 用戶偏好長期記憶（本地優先，雲端同步預留）
 *
 * 演進規劃（2026-10 架構決策：本地 + 雲端同步；寫入雙軌——隱式沉澱 +
 * 顯式管理；本次僅數據層）：
 *   1. 當前（數據層 MVP）：wx storage 本地落盤；buildContext 讀回注入
 *      userProfile.preferences，planner 上下文「用戶偏好」行消費；
 *      隱式沉澱雙路徑——LLM 規劃輸出 memory 欄位（主）與句式匹配
 *      extractPreferenceMemory（DEV 規則路徑兜底），統一經
 *      updatePreferences 白名單過濾落盤。
 *   2. 下一步（雲端同步）：cloudrun 新增 user_profiles 表（owner =
 *      openid 歸屬鑒權，複用 db.ts 模式），端側「寫後異步 push + 啟動
 *      pull 合併」，以 updatedAt last-write-wins——本模組函數按同步形態
 *      設計，屆時疊加同步層，現有調用方零改動。
 *   3. 再下一步（顯式管理）：profile 頁偏好分區——查看 / 修改 / 一鍵
 *      清空，source 標記「自動沉澱 / 手動設置」（個人信息長期存儲須
 *      用戶可控，微信小程序隱私規範導向）。
 *
 * 隱私（§ 10 紅線）：白名單域 + 短值截斷 + sanitizeIntent 打碼；偏好域
 * 不含姓名 / 證號等身份信息（乘車人簿獨立承擔，加密落盤）。
 */

import { setItem, getItem } from '../services/storage';
import { sanitizeIntent } from './session';
import type { MemoryProposalEntry } from '../types/agent-state';

const PREF_KEY = 'user:preferences';
/** 待確認偏好提議（推斷路徑：一次性需求推斷習慣 → 確認卡詢問） */
const PENDING_KEY = 'user:preferences:pending';
/** 問過記錄（拒絕或忽略皆同）——同鍵同值不再重複提議，避免反覆打擾 */
const ASKED_KEY = 'user:preferences:asked';
/** 本輪已直接記住的回執條目（顯式路徑；讀即清） */
const REMEMBERED_KEY = 'user:preferences:remembered';

/** 偏好值截斷上限（短值形態，控制注入 planner 的 token） */
const PREF_VALUE_MAX = 40;

/**
 * 偏好白名單域（鍵 → 中文標籤）——LLM memory 欄位與抽取正則的鍵空間，
 * 隨 SKILL 域擴展（新域接入時同步擴充 DOMAIN_PATTERNS 與 prompt 規則 12）
 */
export const PREFERENCE_DOMAINS = {
  seat: '高鐵座位', // 靠窗 / 靠過道
  cabin: '機艙等級', // 經濟艙 / 商務艙 / 頭等艙
  coffee: '常用咖啡', // 拿鐵 / 美式 等
  diet: '飲食偏好', // 忌辣 / 清淡 / 清真 / 素食
  budget: '預算檔位', // 性價比 / 輕奢 等
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_DOMAINS;

/** 鍵窄化（LLM 輸出 / storage JSON 皆為不可信形態，落盤前必須過白名單） */
export function isPreferenceKey(k: string): k is PreferenceKey {
  return k in PREFERENCE_DOMAINS;
}

/** 單條偏好（元信息供顯式管理 UI 展示來源與雲端同步 LWW 合併） */
export interface PreferenceEntry {
  value: string;
  updatedAt: number;
  /** 沉澱來源：implicit = 對話自動抽取；explicit = 用戶手動設置 */
  source: 'implicit' | 'explicit';
}

/** 偏好存儲全量形態 */
export type PreferenceStore = Partial<Record<PreferenceKey, PreferenceEntry>>;

/** 讀取全量偏好（含元信息；顯式管理 UI 與雲端同步用） */
export function getPreferences(): PreferenceStore {
  return getItem<PreferenceStore>(PREF_KEY, {}) ?? {};
}

/**
 * 讀取注入用摘要（純鍵值）：buildContext → userProfile.preferences →
 * planner 上下文消費；窄化防禦 storage JSON 畸形條目
 */
export function getPreferenceSummary(): Record<string, string> {
  const store = getPreferences();
  const out: Record<string, string> = {};
  for (const k of Object.keys(store)) {
    if (!isPreferenceKey(k)) continue;
    const e = store[k];
    if (e && typeof e?.value === 'string' && e.value) out[k] = e.value;
  }
  return out;
}

/**
 * 寫入偏好增量（隱式 / 顯式統一入口）
 *
 * 白名單過濾 + sanitizeIntent 打碼 + 截斷；值無變化不刷新 updatedAt
 * （雲端 last-write-wins 合併穩定性）。@returns 實際寫入的鍵（供日誌）
 */
export function updatePreferences(
  patch: Record<string, unknown>,
  source: PreferenceEntry['source'],
): PreferenceKey[] {
  const store = getPreferences();
  const written: PreferenceKey[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!isPreferenceKey(k) || typeof v !== 'string') continue;
    const value = sanitizeIntent(v.trim()).slice(0, PREF_VALUE_MAX);
    if (!value) continue;
    const prev = store[k];
    if (prev && prev.value === value) continue;
    store[k] = { value, updatedAt: Date.now(), source };
    written.push(k);
  }
  if (written.length > 0) setItem(PREF_KEY, store);
  return written;
}

/** 清空全部偏好（顯式管理「一鍵清除」用；連帶清理提議 / 問過 / 回執記錄） */
export function clearPreferences(): void {
  setItem(PREF_KEY, {});
  setItem(PENDING_KEY, {});
  setItem(ASKED_KEY, {});
  setItem(REMEMBERED_KEY, []);
}

/**
 * 長期意圖詞：僅顯式表達長期偏好才沉澱——「這次靠窗」類一次性需求
 * 誤存會污染後續所有規劃（prompt 規則 12 對 LLM 同口徑約束）
 */
const LONG_TERM_RE = /以後|以后|記住|记住|我喜歡|我喜欢|我偏好|總是|总是|每次都|習慣|习惯|都幫我|都帮我/;

/**
 * 域詞模式（簡繁並列）：長詞必須在前（正則交替從左到右優先匹配，
 * 「燕麥拿鐵」在後會被「拿鐵」截斷——與 utils/passenger.ts STOP_WORDS 同理）
 */
const DOMAIN_PATTERNS: Array<readonly [PreferenceKey, RegExp]> = [
  ['seat', /靠窗|靠过道|靠過道|靠走道/],
  ['cabin', /商务舱|商務艙|头等舱|頭等艙|经济舱|經濟艙/],
  ['coffee', /燕麦拿铁|燕麥拿鐵|拿铁|拿鐵|美式|卡布奇诺|卡布奇諾|摩卡|星冰乐|星冰樂|冷萃/],
  ['diet', /不吃辣|忌辣|不吃香菜|清淡|清真|素食|全素/],
  ['budget', /性价比|性價比|经济实惠|經濟實惠|省钱|省錢|越贵越好|越貴越好|轻奢|輕奢/],
];

/**
 * 判定意圖文本是否顯式表達長期偏好（「以後都…」「記住我…」等）。
 *
 * 顯式判定的唯一權威：LLM 輸出的 memory 欄位僅在意圖文本印證後才
 * 直接落盤（llm/client.sinkMemory）——防 LLM 把一次性需求誤判為長期
 * 偏好直接寫入（未經印證的一律轉推斷提議，確認卡徵求同意）。
 */
export function isExplicitLongTerm(text: string): boolean {
  return LONG_TERM_RE.test(text);
}

/**
 * 從意圖文本抽取長期偏好（顯式路徑；純函數）
 *
 * 雙重約束：命中長期意圖詞 且 命中白名單域詞，值 = 域詞短語本身。
 * 顯式長期指令直接落盤（用戶意圖明確，再詢問是打擾）。
 */
export function extractPreferenceMemory(text: string): Record<string, string> {
  if (!isExplicitLongTerm(text)) return {};
  return matchDomains(text);
}

/**
 * 推斷提議（推斷路徑；純函數）：無長期意圖詞但命中白名單域詞——
 * 本輪一次性需求（如「幫我訂靠窗的票」）推斷潛在習慣，經確認卡
 * 詢問「以後都這樣做嗎？」，用戶確認才落盤（推斷須徵求同意）。
 * 顯式命中時返回空（兩路徑互斥，無雙重打擾）。
 */
export function extractPreferenceSuggestion(text: string): Record<string, string> {
  if (isExplicitLongTerm(text)) return {};
  return matchDomains(text);
}

/** 域詞匹配共用（值 = 域詞短語本身，僅依賴本輪意圖文本） */
function matchDomains(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, re] of DOMAIN_PATTERNS) {
    const m = re.exec(text);
    if (m && m[0]) out[key] = m[0];
  }
  return out;
}

/* ============ 分層記憶（顯式直記 + 推斷詢問） ============
 *
 * 2026-10 交互修訂（確認卡打擾問題回歸後重設計）：
 *   顯式路徑——用戶說「以後都…」「記住我…」（LLM memory 欄位 /
 *   規則 LONG_TERM 命中）：直接落盤，回執卡「已記住 ✓」告知（告知而非
 *   詢問，用戶指令明確，再問一遍是打擾）。
 *   推斷路徑——本輪一次性需求命中偏好域詞（「幫我訂靠窗的票」）：
 *   暫存 pending，確認卡詢問「以後都這樣做嗎？」，用戶確認才落盤
 *   （從單次行為推斷習慣須徵求同意）。問過（拒絕 / 忽略皆同）記入
 *   asked，同鍵同值不再重複打擾。
 */

/** 待確認提議條目 */
interface PendingEntry {
  value: string;
  at: number;
}

type PendingStore = Partial<Record<PreferenceKey, PendingEntry>>;

function getPending(): PendingStore {
  return getItem<PendingStore>(PENDING_KEY, {}) ?? {};
}

function getAsked(): Partial<Record<PreferenceKey, PendingEntry>> {
  return getItem<Partial<Record<PreferenceKey, PendingEntry>>>(ASKED_KEY, {}) ?? {};
}

/**
 * 顯式直接落盤（llm/client 顯式路徑調用）
 *
 * LLM memory 欄位與規則 LONG_TERM 命中統一入口；落盤後回執條目
 * 暫存 REMEMBERED_KEY（orchestrator takeRememberedProposal 讀即清）。
 * @returns 實際落盤的鍵
 */
export function rememberExplicit(patch: Record<string, unknown>): PreferenceKey[] {
  const written = updatePreferences(patch, 'implicit');
  if (written.length === 0) return written;
  const store = getPreferences();
  setItem(
    REMEMBERED_KEY,
    written.map((k) => ({
      key: k,
      label: PREFERENCE_DOMAINS[k],
      value: store[k]?.value ?? '',
      status: 'remembered' as const,
    })),
  );
  return written;
}

/** 讀取並清空本輪回執條目（顯式已記住；讀即清保證不重複透出） */
export function takeRememberedProposal(): MemoryProposalEntry[] | null {
  const entries = getItem<MemoryProposalEntry[]>(REMEMBERED_KEY, []);
  if (!Array.isArray(entries) || entries.length === 0) return null;
  setItem(REMEMBERED_KEY, []);
  return entries;
}

/**
 * 暫存推斷提議（llm/client 推斷路徑調用；不直接落盤）
 *
 * 清洗與剔除規則：白名單鍵 + sanitizeIntent + 截斷；已有同值（正式偏
 * 好）或已問過同值（拒絕 / 忽略）不重複提議。提議即記入 asked（未處
 * 理的忽略視同隐性拒絕，下輪不再問）。@returns 有效提議的鍵
 */
export function setPendingMemory(patch: Record<string, unknown>): PreferenceKey[] {
  const store = getPreferences();
  const asked = getAsked();
  const pending: PendingStore = {};
  const keys: PreferenceKey[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!isPreferenceKey(k) || typeof v !== 'string') continue;
    const value = sanitizeIntent(v.trim()).slice(0, PREF_VALUE_MAX);
    if (!value) continue;
    if (store[k]?.value === value) continue; // 已記住同值
    if (asked[k]?.value === value) continue; // 已問過同值（拒絕 / 忽略）
    pending[k] = { value, at: Date.now() };
    asked[k] = { value, at: Date.now() };
    keys.push(k);
  }
  if (keys.length > 0) {
    setItem(PENDING_KEY, pending);
    setItem(ASKED_KEY, asked);
  }
  return keys;
}

/**
 * 讀取並清空待確認提議（讀即清：orchestrator 於最終響應附加，保證
 * 不重複透出）；空提議返回 null
 */
export function takePendingProposal(): MemoryProposalEntry[] | null {
  const pending = getPending();
  const keys = Object.keys(pending).filter(isPreferenceKey);
  if (keys.length === 0) return null;
  setItem(PENDING_KEY, {});
  return keys.map((k) => ({
    key: k,
    label: PREFERENCE_DOMAINS[k],
    value: pending[k]?.value ?? '',
    status: 'suggested' as const,
  }));
}

/**
 * 確認落盤：UI 回傳的提議條目 → 正式偏好（source implicit = 對話沉澱且經用戶確認）
 *
 * 2026-10 修訂：確認數據由確認卡條目回傳（所見即所寫），不讀 pending——
 * orchestrator 透出提議時已讀即清空 pending（讀後 confirm 會落空，實測
 * 復現），且 UI 確認前新一輪規劃可能覆蓋 pending（確認到非所見內容）。
 * 白名單 + 清洗仍由 updatePreferences 兜底（條目雖為本模組產出，防禦
 * 式雙保險）。確認後清空 pending（殘留視為過期）。
 * @returns 實際落盤的鍵（供 UI 回執提示）
 */
export function confirmProposal(entries: Array<{ key: string; value: string }>): PreferenceKey[] {
  const patch: Record<string, string> = {};
  for (const e of entries) {
    if (isPreferenceKey(e.key) && typeof e.value === 'string' && e.value) patch[e.key] = e.value;
  }
  setItem(PENDING_KEY, {});
  return updatePreferences(patch, 'implicit');
}

/** 拒絕提議：清空 pending（問過記錄已在提議時寫入，拒絕與忽略同語義） */
export function dismissPendingMemory(): void {
  setItem(PENDING_KEY, {});
}
