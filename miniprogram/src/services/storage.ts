/**
 * 微信儲存封裝（同步 / 非同步版本）
 *
 * 規範：
 *   - sessionStorage（會話內）→ wx.setStorageSync
 *   - 安全序列化（JSON）
 *   - 集中錯誤處理，避免污染業務流程
 */

const PREFIX = 'micromate:';

/** 同步取值（帶型別） */
export function getItem<T = unknown>(key: string, fallback: T | null = null): T | null {
  try {
    const wxApi = (globalThis as { wx?: { getStorageSync?: (k: string) => unknown } }).wx;
    if (!wxApi?.getStorageSync) return fallback;
    const raw = wxApi.getStorageSync(PREFIX + key);
    if (raw === '' || raw === undefined || raw === null) return fallback;
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

/** 同步寫入 */
export function setItem<T>(key: string, value: T): void {
  try {
    const wxApi = (globalThis as { wx?: { setStorageSync?: (k: string, v: unknown) => void } }).wx;
    if (!wxApi?.setStorageSync) return;
    wxApi.setStorageSync(PREFIX + key, JSON.stringify(value));
  } catch {
    // 儲存失敗不拋錯（避免阻塞主流程）
  }
}

/** 同步刪除 */
export function removeItem(key: string): void {
  try {
    const wxApi = (globalThis as { wx?: { removeStorageSync?: (k: string) => void } }).wx;
    if (!wxApi?.removeStorageSync) return;
    wxApi.removeStorageSync(PREFIX + key);
  } catch {
    /* noop */
  }
}

/** 清空所有 MicroMate 命名空間下的 keys */
export function clearAll(): void {
  try {
    const wxApi = (globalThis as { wx?: {
      getStorageInfoSync?: () => { keys: string[] };
      removeStorageSync?: (k: string) => void;
    } }).wx;
    if (!wxApi?.getStorageInfoSync) return;
    const { keys } = wxApi.getStorageInfoSync();
    for (const k of keys) {
      if (k.startsWith(PREFIX)) wxApi.removeStorageSync?.(k);
    }
  } catch {
    /* noop */
  }
}