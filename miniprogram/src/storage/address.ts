/**
 * 收貨地址簿（本地持久化；2026-10 恢復落地）
 *
 * 規範來源：.qoder/rules/Agent.md § 4（storage/ 業務持久化）、§ 12.3（分層依賴）
 *
 * 職責：
 *   - 收貨地址（收貨人 / 手機號 / 省市區 / 詳細地址）的本地 CRUD，
 *     與乘車人簿（storage/passenger）完全同構：首條自動默認、默認唯一、
 *     刪除默認後首條遞補、容量上限
 *   - 出發城市供給：默認地址的市級城市為 Agent 出發城市的第一優先級
 *     （地址簿 > 定位 > 追問用戶），由 core/context.ts 合併進 UserLocation
 *
 * 歷史說明：隨購物域（2026-10 技能收斂）下架時曾被移除；本次因「出發城市
 * 取值優先級」需求恢復——市級城市同時服務交通規劃的出發地推斷。
 *
 * 隱私說明：地址屬個人敏感信息，僅存本機不上雲（§ 10 紅線）；手機號 /
 * 詳址為明文（無證件號類強加密需求），列表展示只出摘要。
 */

import { getItem, setItem } from '../services/storage';

/** 存儲鍵（實際落盤為 micromate:address:book） */
const BOOK_KEY = 'address:book';

/** 地址簿容量上限（防無限膨脹；達上限時新增返回 null 由頁面提示） */
export const ADDRESS_LIMIT = 20;

/** 地址條目 */
export interface AddressEntry {
  /** 全域唯一 ID：addr_{timestamp}_{rand} */
  id: string;
  /** 收貨人姓名（2-20 字） */
  receiverName: string;
  /** 11 位手機號 */
  phone: string;
  /** 省級行政區（region picker 第一段，如「廣東省」） */
  province: string;
  /** 市級行政區（region picker 第二段，如「深圳市」；出發城市取此段） */
  city: string;
  /** 區級行政區（region picker 第三段） */
  district: string;
  /** 詳細地址（4-120 字） */
  detail: string;
  /** 是否默認地址（簿內至多一條；出發城市推斷與 checkout 注入優先取此條） */
  isDefault: boolean;
  /** 條目來源：manual=表單錄入（含微信導入）；conversation=對話捕獲保存
   *  （2026-10；缺席 = 歷史數據，視同 manual） */
  source?: 'manual' | 'conversation';
  createdAt: number;
  updatedAt: number;
}

/** 表單輸入（新增 / 編輯共用；id 由數據層管理） */
export interface AddressFormInput {
  receiverName: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault: boolean;
}

/** 微信收貨地址（wx.chooseAddress 原始回應，由 services/address 透傳） */
export interface WechatAddress {
  userName?: string;
  telNumber?: string;
  provinceName?: string;
  cityName?: string;
  countyName?: string;
  detailInfo?: string;
}

/** 微信地址 → 表單輸入映射（純函數；一鍵導入用） */
export function fromWechatAddress(a: WechatAddress): AddressFormInput {
  return {
    receiverName: (a.userName ?? '').trim(),
    phone: (a.telNumber ?? '').trim(),
    province: a.provinceName ?? '',
    city: a.cityName ?? '',
    district: a.countyName ?? '',
    detail: (a.detailInfo ?? '').trim(),
    isDefault: false,
  };
}

/**
 * 表單校驗（純函數；新增 / 編輯頁共用）
 *
 * @returns 首個錯誤的用戶可讀文案；全部通過返回 null
 */
export function validateAddressForm(input: AddressFormInput): string | null {
  const name = input.receiverName.trim();
  if (name.length < 2 || name.length > 20) return '請輸入 2-20 字的收貨人姓名';
  if (/\d/.test(name)) return '姓名不得包含數字';
  if (!/^1\d{10}$/.test(input.phone.trim())) return '請輸入正確的 11 位手機號碼';
  if (!input.province || !input.city || !input.district) return '請選擇所在地區（省 / 市 / 區）';
  const detail = input.detail.trim();
  if (detail.length < 4 || detail.length > 120) return '詳細地址需 4-120 字';
  return null;
}

/**
 * 城市名歸一化（純函數）：去行政區後綴，與交通查詢城市表口徑對齊
 *
 * region picker / 逆地理編碼返回的市段通常帶「市」尾（如「深圳市」），
 * 而 12306 查詢與演示城市表用短名（「深圳」）。只剝常見後綴，
 * 少數民族自治區劃不強行歸一（保持原樣由上游接受）。
 */
export function normalizeCityName(name: string): string {
  return name.replace(/(市|自治州|地区|地區)$/, '');
}

/** 讀取整本地址簿（新增在前，與寫入順序一致） */
export function listAddresses(): AddressEntry[] {
  return getItem<AddressEntry[]>(BOOK_KEY, []) ?? [];
}

/** 按 ID 取單條地址（編輯頁載入用） */
export function getAddress(id: string): AddressEntry | null {
  return listAddresses().find((a) => a.id === id) ?? null;
}

/**
 * 新增地址
 *
 * 首條自動設為默認（保證出發城市推斷恆有可帶入來源）；
 * 勾選默認時自動取消既有默認，維持簿內默認唯一。
 *
 * @param source 條目來源（對話捕獲路徑傳 'conversation'；表單 / 微信導入缺省 manual）
 * @returns 新條目；容量達上限（ADDRESS_LIMIT）時返回 null
 */
export function addAddress(
  input: AddressFormInput,
  source: AddressEntry['source'] = 'manual',
): AddressEntry | null {
  const book = listAddresses();
  if (book.length >= ADDRESS_LIMIT) return null;
  const now = Date.now();
  const entry: AddressEntry = {
    id: `addr_${now}_${Math.random().toString(36).slice(2, 8)}`,
    receiverName: input.receiverName.trim(),
    phone: input.phone.trim(),
    province: input.province,
    city: input.city,
    district: input.district,
    detail: input.detail.trim(),
    isDefault: input.isDefault || book.length === 0,
    source,
    createdAt: now,
    updatedAt: now,
  };
  if (entry.isDefault) {
    for (const a of book) a.isDefault = false;
  }
  book.push(entry);
  setItem(BOOK_KEY, book);
  return entry;
}

/**
 * 按 ID 覆寫地址（保留原 id / createdAt）
 *
 * @returns 更新後條目；id 不存在返回 null
 */
export function updateAddress(id: string, input: AddressFormInput): AddressEntry | null {
  const book = listAddresses();
  const idx = book.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const next: AddressEntry = {
    ...book[idx],
    receiverName: input.receiverName.trim(),
    phone: input.phone.trim(),
    province: input.province,
    city: input.city,
    district: input.district,
    detail: input.detail.trim(),
    isDefault: input.isDefault,
    updatedAt: Date.now(),
  };
  if (next.isDefault) {
    // 設為默認 → 清除其他默認；取消默認則允許簿內暫無默認（尊重用戶意圖）
    for (const a of book) a.isDefault = a.id === id;
  }
  book[idx] = next;
  setItem(BOOK_KEY, book);
  return next;
}

/**
 * 刪除地址
 *
 * 刪除的是默認地址且簿內仍有餘量時，首條自動遞補為默認。
 *
 * @returns 是否真的刪除（id 不存在返回 false）
 */
export function removeAddress(id: string): boolean {
  const book = listAddresses();
  const idx = book.findIndex((a) => a.id === id);
  if (idx < 0) return false;
  const wasDefault = book[idx].isDefault;
  book.splice(idx, 1);
  if (wasDefault && book.length > 0) {
    for (const a of book) a.isDefault = a.id === book[0].id;
  }
  setItem(BOOK_KEY, book);
  return true;
}

/** 顯式設默認（列表頁切換默認用） */
export function setDefaultAddress(id: string): boolean {
  const book = listAddresses();
  if (!book.some((a) => a.id === id)) return false;
  for (const a of book) a.isDefault = a.id === id;
  setItem(BOOK_KEY, book);
  return true;
}

/**
 * 取默認地址：無顯式默認時回退首條（出發城市推斷帶入用）
 *
 * @returns 默認地址；空簿返回 null
 */
export function getDefaultAddress(): AddressEntry | null {
  const book = listAddresses();
  return book.find((a) => a.isDefault) ?? book[0] ?? null;
}
