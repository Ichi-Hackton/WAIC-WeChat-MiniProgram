/**
 * 個人資料對話捕獲管線（乘車人 / 收貨地址 → 確認卡 → 落盤）
 *
 * 規範來源：.qoder/rules/Agent.md § 10（隱私紅線）、§ 12.3（分層依賴）
 *
 * 與 storage/preferences 的分層記憶同構（2026-10 交互修訂範式）：
 *   顯式路徑——「記住 / 保存」指令 + 提取值合法 → 直接落盤（回執卡告知，
 *   告知而非詢問，用戶指令明確再問一遍是打擾）；
 *   推斷路徑——對話中口述完整信息但無保存指令 → suggested 確認卡詢問，
 *   用戶點「保存」才落盤（從單次行為推斷長期資料須徵求同意）。
 *   問過記錄（asked）：拒絕 / 忽略皆同，同鍵同值不再重複打擾。
 *
 * 安全設計（§ 10 紅線落地）：
 *   1. 提取寬鬆、落盤嚴格——detect 與 confirm 兩處都必過全量校驗
 *      （checkIdNo / validateAddressForm），UI 回傳數據一律視為不可信
 *      形態（防禦式雙保險，與 confirmProposal 白名單兜底同理）；
 *   2. 查重不覆蓋——簿內已有同證號乘車人 / 同姓名電話詳址地址時不重複
 *      寫入（顯式指令冪等回執，推斷路徑靜默放棄）；
 *   3. 明文不落提議層——pending / remembered 為內存態中轉（同一輪寫入
 *      → 讀即清），asked 僅存哈希查重鍵，完整證號只經由 confirm 時的
 *      UI 回傳（內存態）直達 storage/passenger 的加密落盤（v1 XOR）；
 *   4. 日誌零明文——本模組所有 logInfo 不攜帶姓名 / 證號 / 手機號。
 */

import { getItem, setItem } from '../services/storage';
import { extractPassenger, checkIdNo } from '../utils/passenger';
import { extractAddressFromText, isExplicitSaveText, maskPhone } from '../utils/profile-extract';
import { info as logInfo } from '../utils/logger';
import { addAddress, listAddresses, validateAddressForm } from './address';
import type { AddressFormInput } from './address';
import { addPassenger, listPassengers, maskIdNo, validatePassengerForm } from './passenger';
import type { PassengerFormInput } from './passenger';
import type { ProfileProposalEntry } from '../types/agent-state';

/** 舊版明文中轉鍵（已改內存態；首次捕獲時一次性清除歷史殘留） */
const LEGACY_PENDING_KEY = 'profile:proposal:pending';
const LEGACY_REMEMBERED_KEY = 'profile:proposal:remembered';
/** 問過記錄（拒絕 / 忽略皆同）——同鍵同值不再重複提議 */
const ASKED_KEY = 'profile:proposal:asked';

/** 問過記錄形態（鍵為 PII 單向哈希 h1:xxxx——明文證號 / 地址鍵不駐留本機） */
interface AskedStore {
  passenger: string[];
  address: string[];
}

/** 待確認提議內存中轉（同一輪 detect 寫入 → orchestrator 讀即清；
 *  input 攜完整證號 / 手機號，僅存活於內存與對話輪次，不落盤） */
let pendingEntries: ProfileProposalEntry[] = [];
/** 本輪顯式已保存的回執條目（讀即清，同上內存態） */
let rememberedEntries: ProfileProposalEntry[] = [];

/** 問過記錄容量上限（防無限膨脹；保留最近 N 條） */
const ASKED_LIMIT = 40;

/** 過濾保留哈希鍵（h1: 前綴；舊版明文條目在讀取與遷移時一併剔除） */
function keepHashedKeys(xs: unknown): string[] {
  return Array.isArray(xs)
    ? xs.filter((k): k is string => typeof k === 'string' && k.startsWith('h1:'))
    : [];
}

function getAsked(): AskedStore {
  const raw = getItem<Partial<AskedStore>>(ASKED_KEY, {});
  return {
    passenger: keepHashedKeys(raw?.passenger),
    address: keepHashedKeys(raw?.address),
  };
}

/**
 * PII 查重鍵單向哈希（djb2 32 位十六進制 + h1: 版本前綴）
 *
 * 僅用於「問過」去重——碰撞後果只是多問 / 少問一次提議，無安全影響；
 * 前綴與舊版明文鍵區分，配合 keepHashedKeys 實現讀取即剔除。
 */
function hashPii(plain: string): string {
  let h = 5381;
  for (let i = 0; i < plain.length; i++) {
    h = ((h << 5) + h + plain.charCodeAt(i)) >>> 0;
  }
  return `h1:${h.toString(16)}`;
}

/** 是否已問過（明文統一大寫後哈希比對；乘車人證號尾位 x 大小寫歸一） */
function hasAsked(kind: 'passenger' | 'address', plain: string): boolean {
  return getAsked()[kind].includes(hashPii(plain.toUpperCase()));
}

function pushAsked(kind: 'passenger' | 'address', plain: string): void {
  const key = hashPii(plain.toUpperCase());
  const asked = getAsked();
  if (asked[kind].includes(key)) return;
  asked[kind] = [...asked[kind], key].slice(-ASKED_LIMIT);
  setItem(ASKED_KEY, asked);
}

/** 追加透出條目（rem remembered / pending suggested-invalid 分流內存中轉） */
function pushRemembered(entry: ProfileProposalEntry): void {
  rememberedEntries.push(entry);
}

function pushPending(entry: ProfileProposalEntry): void {
  pendingEntries.push(entry);
}

/* ============ 乘車人捕獲 ============ */

/** 乘車人條目構建（卡面證號脫敏；input 攜完整值供確認回傳） */
function passengerEntry(
  name: string,
  idNo: string,
  status: ProfileProposalEntry['status'],
  note?: string,
): ProfileProposalEntry {
  return {
    key: 'passenger',
    label: '乘車人',
    lines: [
      { label: '姓名', value: name },
      { label: '證件號', value: maskIdNo(idNo) },
    ],
    input: { name, idNo },
    status,
    ...(note ? { note } : {}),
  };
}

/**
 * 乘車人捕獲分支：本輪口述「姓名 + 證號」（復用 extractPassenger 單輪形態）
 *
 * 分流：顯式 → 校驗過直存（冪等回執）/ 不過告知卡；推斷 → 校驗過且未
 * 問過才提議（口誤證號大概率噪音，靜默放棄——寧可不存也不存錯）。
 */
function detectPassenger(intent: string, explicit: boolean): void {
  const p = extractPassenger([{ role: 'user', content: intent }]);
  if (!p) return;

  const exists = listPassengers().some((x) => x.idNo.toUpperCase() === p.idNo);
  if (exists) {
    // 冪等：簿內已有此人，顯式指令回執告知（靜默會讓用戶以為沒存上），
    // 推斷路徑無須打擾
    if (explicit) {
      pushRemembered(passengerEntry(p.name, p.idNo, 'remembered', '已在乘車人簿中，無需重複保存'));
      logInfo('個人資料捕獲：乘車人已存在（冪等回執，不重複寫入）');
    }
    return;
  }

  const idErr = checkIdNo(p.idNo);
  if (idErr !== null) {
    if (explicit) {
      const errText = validatePassengerForm({ name: p.name, idNo: p.idNo, isDefault: false });
      pushPending(
        passengerEntry(p.name, p.idNo, 'invalid', errText ?? '證件號校驗未通過，請核對後重試'),
      );
      logInfo('個人資料捕獲：乘車人證號校驗未過（顯式指令 → 告知卡引導核對）');
    }
    return;
  }

  if (explicit) {
    const form: PassengerFormInput = { name: p.name, idNo: p.idNo, isDefault: false };
    const added = addPassenger(form, 'conversation');
    if (added) {
      pushRemembered(passengerEntry(p.name, p.idNo, 'remembered', '已存入乘車人簿（證號加密存於本機），下單自動帶入'));
      logInfo('個人資料捕獲：乘車人顯式保存成功（證號加密落盤）');
    } else {
      pushPending(passengerEntry(p.name, p.idNo, 'invalid', '乘車人數量已達上限，請到「我的」頁清理後重試'));
      logInfo('個人資料捕獲：乘車人簿已滿（告知卡）');
    }
    return;
  }

  // 推斷路徑：問過同證號不再提議（asked 即問即記，忽略視同拒絕；
  // 鍵為證號單向哈希，明文不駐留）
  if (!hasAsked('passenger', p.idNo)) {
    pushAsked('passenger', p.idNo);
    pushPending(passengerEntry(p.name, p.idNo, 'suggested', '常用人員可保存到乘車人簿，之後購票自動帶入'));
    logInfo('個人資料捕獲：乘車人推斷提議（待確認卡）');
  }
}

/* ============ 收貨地址捕獲 ============ */

/** 地址條目構建（卡面手機號脫敏；input 攜完整六字段供確認回傳） */
function addressEntry(
  form: AddressFormInput,
  status: ProfileProposalEntry['status'],
  note?: string,
): ProfileProposalEntry {
  return {
    key: 'address',
    label: '收貨地址',
    lines: [
      { label: '收貨人', value: form.receiverName || '（未識別）' },
      { label: '電話', value: form.phone ? maskPhone(form.phone) : '（未識別）' },
      { label: '地區', value: `${form.province} ${form.city} ${form.district}` },
      { label: '詳細地址', value: form.detail || '（未識別）' },
    ],
    input: { ...form },
    status,
    ...(note ? { note } : {}),
  };
}

/** 地址查重鍵（姓名 + 電話 + 詳址；省市區不同即視為新地址） */
function addressKey(form: AddressFormInput): string {
  return `${form.receiverName}|${form.phone}|${form.detail}`;
}

/**
 * 地址捕獲分支：本輪命中省市區結構（extractAddressFromText）
 *
 * 分流與乘車人同構；推斷路徑僅在六字段齊全（強信號組合，閒聊湊不齊）
 * 且校驗通過時提議——鬆散命中（如僅城市名）一律不打擾。
 */
function detectAddress(intent: string, explicit: boolean): void {
  const raw = extractAddressFromText(intent);
  if (!raw) return;

  const form: AddressFormInput = {
    receiverName: raw.receiverName,
    phone: raw.phone,
    province: raw.province,
    city: raw.city,
    district: raw.district,
    detail: raw.detail,
    isDefault: false,
  };

  const exists = listAddresses().some(
    (a) => addressKey({ ...a, isDefault: false }) === addressKey(form),
  );
  if (exists) {
    if (explicit) {
      pushRemembered(addressEntry(form, 'remembered', '地址簿已有此地址，無需重複保存'));
      logInfo('個人資料捕獲：地址已存在（冪等回執，不重複寫入）');
    }
    return;
  }

  const err = validateAddressForm(form);
  if (err !== null) {
    if (explicit) {
      pushPending(addressEntry(form, 'invalid', `${err}。可到「我的 → 收貨地址」手動補錄`));
      logInfo('個人資料捕獲：地址校驗未過（顯式指令 → 告知卡）');
    }
    return;
  }

  if (explicit) {
    const added = addAddress(form, 'conversation');
    if (added) {
      pushRemembered(addressEntry(form, 'remembered', '已存入地址簿（僅存本機），購物下單與出行規劃自動帶入'));
      logInfo('個人資料捕獲：地址顯式保存成功');
    } else {
      pushPending(addressEntry(form, 'invalid', '地址數量已達上限，請到「我的」頁清理後重試'));
      logInfo('個人資料捕獲：地址簿已滿（告知卡）');
    }
    return;
  }

  if (!hasAsked('address', addressKey(form))) {
    pushAsked('address', addressKey(form));
    pushPending(addressEntry(form, 'suggested', '保存後購物下單自動帶入此地址'));
    logInfo('個人資料捕獲：地址推斷提議（待確認卡）');
  }
}

/* ============ 對外接口 ============ */

/** 舊版明文遷移標誌（模組生命週期內僅執行一次） */
let legacyMigrated = false;

/**
 * 舊版明文殘留一次性清理（冪等，惰性執行——首次捕獲調用時，避開模組
 * 載入時序對 wx storage 的依賴）：pending / remembered 曾以 storage
 * 中轉完整證號，asked 曾存明文鍵——改內存態 / 哈希鍵後，歷史明文
 * 於此清除（asked 僅保留 h1: 哈希條目）。
 */
function migrateLegacyPlaintext(): void {
  if (legacyMigrated) return;
  legacyMigrated = true;
  setItem(LEGACY_PENDING_KEY, []);
  setItem(LEGACY_REMEMBERED_KEY, []);
  const raw = getItem<Partial<AskedStore>>(ASKED_KEY, {});
  setItem(ASKED_KEY, {
    passenger: keepHashedKeys(raw?.passenger),
    address: keepHashedKeys(raw?.address),
  });
}

/**
 * 對話捕獲入口（orchestrator 每輪調用，置於 understand 之前——純保存
 * 指令常被分類為閒聊，掛在規劃後處理會漏掉 chat 分支）
 *
 * 僅消費本輪意圖文本（歷史輪次的信息由 applyPassengerSlot 回填鏈路
 * 負責）；任何分支都不拋出（捕獲失敗不阻斷主流程）。
 */
export function detectProfileCapture(intent: string): void {
  try {
    migrateLegacyPlaintext();
    const explicit = isExplicitSaveText(intent);
    detectPassenger(intent, explicit);
    detectAddress(intent, explicit);
  } catch (e) {
    logInfo(`個人資料捕獲：檢測異常已吞掉（不阻斷主流程）：${String(e).slice(0, 60)}`);
  }
}

/** 讀取並清空顯式已保存回執（orchestrator 於最終響應附加，讀即清；內存態） */
export function takeRememberedProfile(): ProfileProposalEntry[] | null {
  if (rememberedEntries.length === 0) return null;
  const list = rememberedEntries;
  rememberedEntries = [];
  return list;
}

/** 讀取並清空待確認提議（讀即清；確認數據由 UI 卡面回傳，不讀此中間態） */
export function takePendingProfile(): ProfileProposalEntry[] | null {
  if (pendingEntries.length === 0) return null;
  const list = pendingEntries;
  pendingEntries = [];
  return list;
}

/**
 * 確認落盤（確認卡「保存」按鈕；UI 回傳卡面條目——所見即所寫）
 *
 * 防禦式雙保險：UI 回傳數據一律視為不可信形態——kind 窄化 + 欄位型別
 * 檢查 + 全量校驗 + 查重後才落盤（與 preferences.confirmProposal 的
 * 白名單兜底同理）；僅處理 status='suggested' 條目（remembered 已落盤、
 * invalid 不可保存）。
 *
 * @returns 實際保存的條目中文標籤（供 UI 回執提示；空 = 無有效條目）
 */
export function confirmProfileSave(entries: ProfileProposalEntry[]): string[] {
  const saved: string[] = [];
  for (const entry of entries) {
    if (entry?.status !== 'suggested') continue;
    try {
      if (entry.key === 'passenger') {
        const { name, idNo } = entry.input as Partial<PassengerFormInput>;
        if (typeof name !== 'string' || typeof idNo !== 'string') continue;
        const form: PassengerFormInput = { name, idNo, isDefault: false };
        if (validatePassengerForm(form) !== null) continue;
        if (listPassengers().some((x) => x.idNo.toUpperCase() === idNo.toUpperCase())) continue;
        if (addPassenger(form, 'conversation')) saved.push(entry.label);
      } else if (entry.key === 'address') {
        const raw = entry.input as Partial<AddressFormInput>;
        if (
          typeof raw.receiverName !== 'string' ||
          typeof raw.phone !== 'string' ||
          typeof raw.province !== 'string' ||
          typeof raw.city !== 'string' ||
          typeof raw.district !== 'string' ||
          typeof raw.detail !== 'string'
        ) {
          continue;
        }
        const form: AddressFormInput = {
          receiverName: raw.receiverName,
          phone: raw.phone,
          province: raw.province,
          city: raw.city,
          district: raw.district,
          detail: raw.detail,
          isDefault: false,
        };
        if (validateAddressForm(form) !== null) continue;
        if (listAddresses().some((a) => addressKey({ ...a, isDefault: false }) === addressKey(form))) continue;
        if (addAddress(form, 'conversation')) saved.push(entry.label);
      }
    } catch (e) {
      logInfo(`個人資料捕獲：確認保存單條異常已跳過：${String(e).slice(0, 60)}`);
    }
  }
  pendingEntries = [];
  if (saved.length > 0) logInfo(`個人資料捕獲：確認保存 ${saved.length} 條（詳情見簿）`);
  return saved;
}

/** 拒絕提議（確認卡「不用了」）：清空 pending（問過記錄已於提議時寫入；內存態） */
export function dismissProfileProposal(): void {
  pendingEntries = [];
}
