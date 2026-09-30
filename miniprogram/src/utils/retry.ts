/**
 * 指數退避重試工具
 *
 * 規範來源：.qoder/rules/Agent.md § 9
 *
 * 用法：
 *   const data = await retry(
 *     () => wx.cloud.callContainer({ ... }),
 *     { maxAttempts: 3, baseDelayMs: 500, shouldRetry: e => e.retryable },
 *   );
 */

import { debug, warn, error as logError } from './logger';

export interface RetryOptions {
  /** 最大嘗試次數（含首次），預設 3 */
  maxAttempts?: number;
  /** 基礎延遲毫秒，預設 500ms */
  baseDelayMs?: number;
  /** 最大延遲毫秒，預設 5000ms */
  maxDelayMs?: number;
  /** 判斷錯誤是否值得重試；預設所有錯誤都重試 */
  shouldRetry?: (err: unknown) => boolean;
  /** 重試前 hook（用於埋點） */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

/** 判斷值是否為 PromiseLike */
function isPromiseLike<T>(v: T | PromiseLike<T>): v is PromiseLike<T> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}

/**
 * 帶指數退避的非同步重試包裝器
 *
 * 退避公式：min(baseDelayMs * 2^(attempt-1), maxDelayMs) + 隨機抖動
 */
export async function retry<T>(
  fn: () => Promise<T> | T,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 5000,
    shouldRetry = () => true,
    onRetry,
  } = options;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const ret = fn();
      if (isPromiseLike(ret)) {
        return await ret;
      }
      return ret;
    } catch (err) {
      lastErr = err;
      const retryable = shouldRetry(err);
      if (!retryable || attempt === maxAttempts) {
        if (attempt === maxAttempts) {
          logError(`retry 最終失敗（已嘗試 ${attempt} 次）`, err);
        }
        throw err;
      }
      // 指數退避 + ±25% 抖動避免雪崩
      const exp = baseDelayMs * Math.pow(2, attempt - 1);
      const delay = Math.min(exp, maxDelayMs);
      const jitter = delay * (0.75 + Math.random() * 0.5);
      warn(
        `retry 第 ${attempt}/${maxAttempts} 次失敗，${Math.round(jitter)}ms 後重試`,
        err,
      );
      if (onRetry) onRetry(attempt, err, jitter);
      await sleep(jitter);
    }
  }
  // 理論上不可達，保險用
  throw lastErr;
}

/** 簡單 sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 為錯誤物件加上重試屬性
 * 用於包裝第三方錯誤，讓 retry 統一判斷
 */
export function markRetryable<T extends Error>(err: T, retryable: boolean): T {
  (err as Error & { retryable?: boolean }).retryable = retryable;
  return err;
}

void debug; // 維持 logger 引用