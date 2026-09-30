/**
 * 用戶身份服務（取得 openid / session）
 *
 * 規範：所有用戶標識統一從此入口，避免散落
 */

import { postContainer, type CloudResponse } from './cloud';

export interface UserIdentity {
  openid: string;
  sessionId: string;
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