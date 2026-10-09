/**
 * 用戶身份服務（取得 openid / session）
 *
 * 規範：所有用戶標識統一從此入口，避免散落
 */

import { ensureCloudInit, postContainer } from './cloud';
import type { CloudResponse } from './cloud';
import { info as logInfo, warn as logWarn } from '../utils/logger';

export interface UserIdentity {
  openid: string;
  /** 會話 ID（雲端回顯，可選） */
  sessionId?: string;
  unionid?: string;
}

/** 透過雲函式換取 openid */
export async function fetchIdentity(env: string, code: string): Promise<UserIdentity | null> {
  const res: CloudResponse<UserIdentity> = await postContainer<UserIdentity>(
    env,
    '/api/auth/identity',
    { code },
    { retry: false },
  );
  if (res.code !== 0 || !res.data) return null;
  return res.data;
}

/** 本地緩存的 openid（測試 / 開發用） */
export function getCachedOpenid(): string | null {
  try {
    const wxApi = (globalThis as { wx?: { getStorageSync?: (k: string) => unknown } }).wx;
    if (!wxApi?.getStorageSync) return null;
    const v = wxApi.getStorageSync('micromate:openid');
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

/** 緩存 openid */
export function cacheOpenid(openid: string): void {
  try {
    const wxApi = (globalThis as { wx?: { setStorageSync?: (k: string, v: unknown) => void } }).wx;
    wxApi?.setStorageSync?.('micromate:openid', openid);
  } catch {
    /* noop */
  }
}

/** wx.login 取臨時 code（回調風格 → Promise） */
function wxLogin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const wxApi = (globalThis as { wx?: { login?: (o: Record<string, unknown>) => void } }).wx;
    if (!wxApi?.login) {
      reject(new Error('wx.login 不可用'));
      return;
    }
    wxApi.login({
      success: (res: { code: string }) => resolve(res.code),
      fail: (err: unknown) => reject(err),
    });
  });
}

/**
 * 靜默微信登入（冪等）
 *
 * 進入小程序即呼叫（miniprogram/app.ts onLaunch，fire-and-forget）：
 *   wx.login 取 code → 雲托管 /api/auth/identity 換取 openid（由微信
 *   雲托管網關注入，客戶端不可偽造）→ 本地緩存（micromate:openid）。
 *
 * 冪等：已有緩存 openid 直接返回，不重複請求。
 * 失敗靜默降級（僅 warn 日誌）：登入為前置增強，不阻斷啟動；
 * 後續寫操作 SKILL 由雲端鑑權統一攔截並給出明確錯誤。
 *
 * 時序：ensureCloudInit 刻意置於首個 await 之後 —— ensureLogin 由
 * onLaunch 同步段發起，await 前的同步碼會計入 onLaunch 耗時
 * （基礎庫 100ms [Perf] 紅線），wx.cloud.init 屬重操作必須後置。
 */
export async function ensureLogin(env: string): Promise<UserIdentity | null> {
  const cached = getCachedOpenid();
  if (cached) return { openid: cached };
  try {
    const code = await wxLogin();
    ensureCloudInit(env);
    const identity = await fetchIdentity(env, code);
    if (!identity) {
      logWarn('微信登入未取得身份（雲托管不可用或未鑑權），已靜默降級');
      return null;
    }
    cacheOpenid(identity.openid);
    logInfo(`微信登入完成（openid=${identity.openid.slice(0, 6)}…已緩存）`);
    return identity;
  } catch (e) {
    logWarn('微信登入異常，已靜默降級', e);
    return null;
  }
}