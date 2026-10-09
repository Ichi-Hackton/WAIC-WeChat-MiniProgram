/**
 * 實名乘車人簿（本地持久化）
 *
 * 規範來源：.qoder/rules/Agent.md § 4（storage/ 業務持久化）、§ 12.3（分層依賴）
 *
 * 職責：
 *   - 乘車人（姓名 + 18 位身份證號）的本地 CRUD，供火車 / 機票 / 演出票
 *     下單任務自動帶入（llm/client 後處理，見 utils/passenger 的回填協作）
 *   - 表單欄位校驗（純函數，新增 / 編輯頁共用）
 *   - 默認乘車人唯一性維護（設默認時自動取消既有默認；首條自動默認）
 *
 * 隱私說明：證件號屬個人敏感信息，僅存本機且**加密落盤**（v1 XOR 流 +
 * 本機隨機金鑰分鍵存放，見 utils/crypto；2026-10 落地 Agent.md § 10
 * 紅線「敏感欄位加密儲存」），不隨 Context 跨會話上雲；列表展示一律
 * 走 maskIdNo 脫敏。歷史明文於首次讀取時自動遷移為密文（fromDisk）。
 */

import { getItem, setItem } from '../services/storage';
import { checkIdNo } from '../utils/passenger';
import { generateStorageKey, encryptText, decryptText } from '../utils/crypto';

/** 存儲鍵（實際落盤為 micromate:passenger:book，idNo 為 v1 密文） */
const BOOK_KEY = 'passenger:book';

/** 金鑰存儲鍵（與密文分鍵存放：sec:key 僅存金鑰本體） */
const SEC_KEY = 'sec:key';

/** 安裝級金鑰（模組級快取；首次存取時生成並落盤） */
let cachedKey: string | null = null;

function sensitiveKey(): string {
  if (cachedKey) return cachedKey;
  cachedKey = getItem<string>(SEC_KEY, '') ?? '';
  if (!cachedKey) {
    cachedKey = generateStorageKey();
    setItem(SEC_KEY, cachedKey);
  }
  return cachedKey;
}

/** 落盤形態：idNo 加密；姓名 / 標記等非高敏欄位明文（列表直讀） */
function toDisk(book: PassengerEntry[]): PassengerEntry[] {
  const key = sensitiveKey();
  return book.map((p) => ({ ...p, idNo: encryptText(p.idNo, key) }));
}

/** 讀取形態：idNo 解密；歷史明文 / 金鑰不符時由證號校驗把關（不合法即清空待重錄） */
function fromDisk(raw: PassengerEntry[]): PassengerEntry[] {
  const key = sensitiveKey();
  let dirty = false;
  const book = raw.map((p) => {
    const plain = decryptText(p.idNo, key);
    if (plain !== null) {
      // 已加密態：解密結果過證號校驗即透出（金鑰不符解出亂碼 → 清空重錄）
      if (checkIdNo(plain) === null) return { ...p, idNo: plain };
      dirty = true;
      return { ...p, idNo: '' };
    }
    // 無 v1 前綴 = 歷史明文：合法則透出並標記遷移；非法清空待重錄
    if (checkIdNo(p.idNo) === null) {
      dirty = true;
      return { ...p, idNo: p.idNo };
    }
    dirty = true;
    return { ...p, idNo: '' };
  });
  // 首次讀取即完成明文 → 密文遷移（含損壞值清空後的重寫）
  if (dirty) setItem(BOOK_KEY, toDisk(book));
  return book;
}

/** 乘車人簿容量上限（防無限膨脹；達上限時新增返回 null 由頁面提示） */
export const PASSENGER_LIMIT = 20;

/** 乘車人條目 */
export interface PassengerEntry {
  /** 全域唯一 ID：psg_{timestamp}_{rand} */
  id: string;
  /** 姓名（2-20 字） */
  name: string;
  /** 18 位身份證號（末位 X 統一大寫後存儲） */
  idNo: string;
  /** 是否默認乘車人（簿內至多一條；下單回填優先取此人） */
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 表單輸入（新增 / 編輯共用；id 由數據層管理） */
export interface PassengerFormInput {
  name: string;
  idNo: string;
  isDefault: boolean;
}

/**
 * 表單校驗（純函數）
 *
 * 證件號接入 checkIdNo 三級校驗（格式 / 出生日期 / GB 11643-1999 校驗碼，
 * 見 utils/passenger 的分層決策），分級文案讓用戶知道錯在哪一段。
 *
 * @returns 首個錯誤的用戶可讀文案；全部通過返回 null
 */
export function validatePassengerForm(input: PassengerFormInput): string | null {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 20) return '請輸入 2-20 字的姓名';
  if (/\d/.test(name)) return '姓名不得包含數字';
  const idErr = checkIdNo(input.idNo);
  if (idErr === 'format') return '請輸入正確的 18 位身份證號碼';
  if (idErr === 'birthdate') return '身份證出生日期無效，請核對';
  if (idErr === 'checksum') return '身份證校驗碼不符，請核對後重新輸入';
  return null;
}

/** 證號脫敏（列表展示用）：保留前 6 位地區碼與後 4 位，中間以 * 折疊 */
export function maskIdNo(idNo: string): string {
  if (idNo.length !== 18) return idNo;
  return `${idNo.slice(0, 6)}********${idNo.slice(-4)}`;
}

/** 讀取整本乘車人簿（新增在前，與寫入順序一致；idNo 解密後透出） */
export function listPassengers(): PassengerEntry[] {
  return fromDisk(getItem<PassengerEntry[]>(BOOK_KEY, []) ?? []);
}

/** 按 ID 取單條乘車人（編輯頁載入用） */
export function getPassenger(id: string): PassengerEntry | null {
  return listPassengers().find((p) => p.id === id) ?? null;
}

/**
 * 新增乘車人
 *
 * 首條自動設為默認（保證下單回填恆有可帶入人）；
 * 勾選默認時自動取消既有默認，維持簿內默認唯一。
 *
 * @returns 新條目；容量達上限（PASSENGER_LIMIT）時返回 null
 */
export function addPassenger(input: PassengerFormInput): PassengerEntry | null {
  const book = listPassengers();
  if (book.length >= PASSENGER_LIMIT) return null;
  const now = Date.now();
  const entry: PassengerEntry = {
    id: `psg_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim(),
    idNo: input.idNo.trim().toUpperCase(),
    isDefault: input.isDefault || book.length === 0,
    createdAt: now,
    updatedAt: now,
  };
  if (entry.isDefault) clearDefault(book);
  book.push(entry);
  setItem(BOOK_KEY, toDisk(book));
  return entry;
}

/**
 * 按 ID 覆寫乘車人（保留原 id / createdAt）
 *
 * @returns 更新後條目；id 不存在返回 null
 */
export function updatePassenger(id: string, input: PassengerFormInput): PassengerEntry | null {
  const book = listPassengers();
  const idx = book.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const next: PassengerEntry = {
    ...book[idx],
    name: input.name.trim(),
    idNo: input.idNo.trim().toUpperCase(),
    isDefault: input.isDefault,
    updatedAt: Date.now(),
  };
  if (next.isDefault) {
    // 設為默認 → 清除其他默認；取消默認則允許簿內暫無默認（尊重用戶意圖）
    for (const p of book) p.isDefault = p.id === id;
  }
  book[idx] = next;
  setItem(BOOK_KEY, toDisk(book));
  return next;
}

/**
 * 刪除乘車人
 *
 * 刪除的是默認乘車人且簿內仍有餘量時，首條自動遞補為默認。
 *
 * @returns 是否真的刪除（id 不存在返回 false）
 */
export function removePassenger(id: string): boolean {
  const book = listPassengers();
  const idx = book.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  const wasDefault = book[idx].isDefault;
  book.splice(idx, 1);
  if (wasDefault && book.length > 0) {
    for (const p of book) p.isDefault = p.id === book[0].id;
  }
  setItem(BOOK_KEY, toDisk(book));
  return true;
}

/** 顯式設默認（列表頁切換默認用） */
export function setDefaultPassenger(id: string): boolean {
  const book = listPassengers();
  if (!book.some((p) => p.id === id)) return false;
  for (const p of book) p.isDefault = p.id === id;
  setItem(BOOK_KEY, toDisk(book));
  return true;
}

/**
 * 取默認乘車人：無顯式默認時回退首條（下單回填帶入用）
 *
 * @returns 默認乘車人；空簿返回 null
 */
export function getDefaultPassenger(): PassengerEntry | null {
  const book = listPassengers();
  return book.find((p) => p.isDefault) ?? book[0] ?? null;
}

/** 清除簿內全部默認標記（僅供本模組內部使用） */
function clearDefault(book: PassengerEntry[]): void {
  for (const p of book) p.isDefault = false;
}
