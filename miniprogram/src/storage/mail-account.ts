/**
 * 郵箱帳戶（用戶自有發件通道，本地持久化）
 *
 * 職責：
 *   - 用戶為「真實發送郵件」綁定自己的郵箱（地址 + SMTP 授權碼），
 *     發送時由 device-comm SKILL 隨請求透傳雲端代發（雲端不落庫）
 *   - SMTP 服務器按郵箱後綴自動推斷（QQ / 163 / 126 等零額外輸入），
 *     亦可手填（企業郵箱 / 自建服務器）
 *   - 表單欄位校驗（純函數，編輯頁共用）
 *
 * 隱私說明：授權碼屬高敏 憑據，僅存本機且加密落盤（與乘車人證號共用
 * utils/crypto v1 XOR 流 + sec:key 分鍵存放，Agent.md § 10 紅線）；
 * 不隨 Context 跨會話、不寫任何日誌；僅在用戶明確發送郵件時經
 * 微信雲托管 TLS 通道瞬態透傳。列表展示走 maskEmail 脫敏。
 */

import { getItem, setItem, removeItem } from '../services/storage';
import { generateStorageKey, encryptText, decryptText } from '../utils/crypto';

/** 存儲鍵（實際落盤為 micromate:mail:account，authCode 為 v1 密文） */
const ACCOUNT_KEY = 'mail:account';

/** 金鑰存儲鍵（與乘車人簿共用同一把安裝級金鑰：密文仍與金鑰分鍵存放） */
const SEC_KEY = 'sec:key';

/** 郵箱地址形態（與 device-comm SKILL / 雲端 skill-mail.ts 逐字對齊） */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** 授權碼長度上限（QQ / 163 授權碼 16 位左右；企業自建可能更長，放寬） */
const MAX_AUTH_CODE_LEN = 64;

/** 安裝級金鑰（模組級快取；與 passenger.ts 讀寫同一個 sec:key） */
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

/** 郵箱帳戶（內部 / 讀取形態：authCode 為明文，僅供發送瞬態使用） */
export interface MailAccount {
  /** 發件郵箱地址（同時作為 SMTP 用戶名與 From 地址） */
  email: string;
  /** SMTP 授權碼（非郵箱登入密碼） */
  authCode: string;
  /** SMTP 服務器域名 */
  smtpHost: string;
  /** SMTP 端口（465 隱式 TLS / 587 STARTTLS） */
  smtpPort: number;
  createdAt: number;
  updatedAt: number;
}

/** 表單輸入（編輯頁；authCode 留空 = 編輯態沿用原授權碼） */
export interface MailAccountFormInput {
  email: string;
  authCode: string;
  smtpHost: string;
  smtpPort: number;
}

/**
 * 常見郵箱後綴 → SMTP 服務器推斷表（端口 465 隱式 TLS）
 *
 * 覆蓋國內個人郵箱主流（QQ / 163 / 126 / foxmail 即 QQ 郵箱別名域）；
 * 未列舉後綴返回 null，由表單要求手填（企業郵箱 / outlook 等）。
 */
const SMTP_BY_SUFFIX: Record<string, { host: string; port: number }> = {
  'qq.com': { host: 'smtp.qq.com', port: 465 },
  'foxmail.com': { host: 'smtp.qq.com', port: 465 },
  '163.com': { host: 'smtp.163.com', port: 465 },
  '126.com': { host: 'smtp.126.com', port: 465 },
  'yeah.net': { host: 'smtp.yeah.net', port: 465 },
  'sina.com': { host: 'smtp.sina.com', port: 465 },
  'sohu.com': { host: 'smtp.sohu.com', port: 465 },
  'aliyun.com': { host: 'smtp.qiye.aliyun.com', port: 465 },
};

/** 按郵箱後綴推斷 SMTP 服務器（未識別後綴返回 null） */
export function suggestSmtp(email: string): { host: string; port: number } | null {
  const suffix = email.trim().toLowerCase().split('@')[1] ?? '';
  return SMTP_BY_SUFFIX[suffix] ?? null;
}

/**
 * 表單校驗（純函數）
 *
 * @param keepOldAuth 編輯態沿用原授權碼時為 true（authCode 允許留空）
 * @returns 首個錯誤的用戶可讀文案；全部通過返回 null
 */
export function validateMailAccountForm(input: MailAccountFormInput, keepOldAuth: boolean): string | null {
  const email = input.email.trim();
  if (!email || !EMAIL_RE.test(email)) return '請輸入正確的郵箱地址（如 name@example.com）';
  const code = input.authCode.trim();
  if (!code && !keepOldAuth) return '請輸入郵箱 SMTP 授權碼（在郵箱設置中開啟 SMTP 服務後生成，非登入密碼）';
  if (code && code.length > MAX_AUTH_CODE_LEN) return `授權碼過長（應 ≤ ${MAX_AUTH_CODE_LEN} 字元）`;
  const host = input.smtpHost.trim();
  if (!host || !/^[A-Za-z0-9.-]+$/.test(host) || host.length > 100) {
    return 'SMTP 服務器地址不合法（域名形式，如 smtp.qq.com）';
  }
  const port = input.smtpPort;
  if (!Number.isInteger(port) || port < 25 || port > 65535) return 'SMTP 端口應為 25-65535（常用 465 或 587）';
  return null;
}

/** 郵箱脫敏（列表展示用）：local 部分保留首 2 位，其餘摺疊 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  return `${local.slice(0, 2)}***${email.slice(at)}`;
}

/**
 * 讀取已綁定郵箱帳戶（authCode 解密後透出；未綁定返回 null）
 *
 * 金鑰不符解出亂碼時（極端：跨安裝遷移數據），一律視為未綁定並清除
 * 舊值待重錄（憑據類欄位無法像證號那樣有格式校驗兜底，寧可重錄）。
 */
export function getMailAccount(): MailAccount | null {
  const raw = getItem<Partial<MailAccount>>(ACCOUNT_KEY);
  if (!raw || typeof raw !== 'object' || typeof raw.email !== 'string') return null;
  const cipher = typeof raw.authCode === 'string' ? raw.authCode : '';
  if (!cipher.startsWith('v1:')) return null; // 形態不符（歷史明文 / 損壞）→ 視為未綁定
  const plain = decryptText(cipher, sensitiveKey());
  if (plain === null || plain.length === 0) return null;
  return {
    email: raw.email,
    authCode: plain,
    smtpHost: raw.smtpHost ?? '',
    smtpPort: typeof raw.smtpPort === 'number' ? raw.smtpPort : 465,
    createdAt: raw.createdAt ?? 0,
    updatedAt: raw.updatedAt ?? 0,
  };
}

/** 是否已綁定（不觸發解密；列表展示用輕量探測） */
export function hasMailAccount(): boolean {
  const raw = getItem<Partial<MailAccount>>(ACCOUNT_KEY);
  return !!raw && typeof raw.email === 'string' && typeof raw.authCode === 'string';
}

/**
 * 綁定 / 覆寫郵箱帳戶（單帳戶模型，後寫覆蓋前寫）
 *
 * @param prevAuth 編輯態沿用原授權碼（表單 authCode 為空時由調用方傳入）
 */
export function saveMailAccount(input: MailAccountFormInput, prevAuth?: string): MailAccount {
  const authCode = input.authCode.trim() || prevAuth || '';
  const existing = getMailAccount();
  const now = Date.now();
  const account: MailAccount = {
    email: input.email.trim(),
    authCode,
    smtpHost: input.smtpHost.trim(),
    smtpPort: input.smtpPort,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  setItem(ACCOUNT_KEY, {
    ...account,
    authCode: encryptText(authCode, sensitiveKey()),
  } as MailAccount);
  return account;
}

/** 解除綁定（一併清除密文；雲端無副本，本地清除即全域失效） */
export function clearMailAccount(): void {
  removeItem(ACCOUNT_KEY);
}
