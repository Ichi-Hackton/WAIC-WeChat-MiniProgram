/**
 * 敏感欄位本地加密 — 純函數（不得 import wx.*，規範 § 12.1）
 *
 * 規範來源：.qoder/rules/Agent.md § 10 紅線「敏感欄位加密儲存」（2026-10
 * 產品評審合規排雷項：證件號此前明文落盤，規範自立的紅線未落地）。
 *
 * 強度定位（誠實聲明）：小程序運行時無系統級金鑰庫（Keychain / SE），
 * 本模組是「對抗儲存轉儲 / 備份提取的最低成本防線」——XOR 流加密 +
 * 本機隨機金鑰（與密文分鍵存放）。做到了：密文落盤（任何 storage dump
 * 中不出現明文證號）、金鑰與密文分離、逐字元位置獨立金鑰流（證號前
 * 6 位地區碼等已知明文結構無法用於還原其他位置）。做不到：抵禦能完整
 * 讀取本機全部 storage 的定向攻擊者——此威脅在小程序沙箱模型下由
 * 微信容器自身承擔。
 *
 * v1 密文格式：'v1:' + 每字元 4 hex（UTF-16 code unit XOR 金鑰流）
 * 遷移判定：無 'v1:' 前綴 = 歷史明文（讀取側透出並回寫加密，見
 * storage/passenger.ts fromDisk）。
 */

/** 密文版本前綴（無此前綴 = 歷史明文） */
const V1_PREFIX = 'v1:';

/**
 * FNV-1a 32bit 雜湊（金鑰流派生基元）
 *
 * 小程序運行時無 WebCrypto / node:crypto，自帶輕量實現；僅用於金鑰流
 * 展開而非密碼學承諾（見檔頂強度定位）。
 */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 位置 i 的金鑰流字元（16bit）
 *
 * 兩輪 FNV 混合：第二輪摻入首輪輸出做擴散，保證相鄰位置流值無規律；
 * 每個位置獨立派生（key + 位置），無流重用。
 */
function streamChar(key: string, i: number): number {
  const a = fnv1a(`${key}:${i}`);
  const b = fnv1a(`${key}#${a}`);
  return (a ^ b) & 0xffff;
}

/**
 * 生成安裝級隨機金鑰（32 hex 字元）
 *
 * Math.random 熵源在「對抗儲存轉儲」威脅模型下足夠（金鑰本身與密文
 * 同存於 storage，更強的熵源不改變威脅邊界）。
 */
export function generateStorageKey(): string {
  let k = '';
  for (let i = 0; i < 32; i += 1) k += Math.floor(Math.random() * 16).toString(16);
  return k;
}

/** 加密：'v1:' + hex(明文 XOR 金鑰流) */
export function encryptText(plain: string, key: string): string {
  let hex = '';
  for (let i = 0; i < plain.length; i += 1) {
    const c = plain.charCodeAt(i) ^ streamChar(key, i);
    hex += c.toString(16).padStart(4, '0');
  }
  return `${V1_PREFIX}${hex}`;
}

/**
 * 解密：返回明文
 *
 * @returns 非 v1 格式（歷史明文）或 hex 形態非法時返回 null；
 *          金鑰不符會解出亂碼而非 null——由呼叫方以業務校驗
 *          （如證號 checkIdNo）兜底識別（見 passenger.ts fromDisk）
 */
export function decryptText(cipher: string, key: string): string | null {
  if (!cipher.startsWith(V1_PREFIX)) return null;
  const hex = cipher.slice(V1_PREFIX.length);
  if (hex.length === 0 || hex.length % 4 !== 0) return null;
  let out = '';
  for (let i = 0; i < hex.length; i += 4) {
    const c = Number.parseInt(hex.slice(i, i + 4), 16);
    if (!Number.isFinite(c)) return null;
    out += String.fromCharCode(c ^ streamChar(key, i / 4));
  }
  return out;
}
