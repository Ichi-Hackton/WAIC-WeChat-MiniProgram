/**
 * 微信雲開發 - Cloud Container 呼叫封裝
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1, § 11.2
 *
 * 為什麼要在 services/ 而非直接呼叫 wx.cloud.callContainer：
 *   1. SKILL 不得直接 import wx.*（規範 § 7.1）
 *   2. 統一錯誤結構（SkillError）
 *   3. 統一超時與重試策略
 *   4. 集中埋點
 */

import { retry, markRetryable } from '../utils/retry';
import { error as logError, info as logInfo, warn as logWarn } from '../utils/logger';

export interface CloudCallOptions {
  /** 雲端環境 ID */
  env: string;
  /** Container 路徑 */
  path: string;
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** 業務資料 */
  data?: unknown;
  /** 自訂 header */
  header?: Record<string, string>;
  /** 超時毫秒，預設 15s */
  timeoutMs?: number;
  /** 是否走重試，預設 true */
  retry?: boolean;
  /** Session ID（傳入雲端做關聯） */
  sessionId?: string;
}

/** 雲端標準回應格式 */
export interface CloudResponse<T = unknown> {
  /** 業務狀態碼，0 表示成功 */
  code: number;
  /** 人類可讀訊息 */
  message?: string;
  /** 業務資料 */
  data?: T;
}

/** 網路層錯誤（含重試標記） */
export class CloudNetworkError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'CloudNetworkError';
    this.retryable = retryable;
  }
}

/** 提取錯誤簡訊供降級 warn 日誌用（截斷避免長堆疊噪音） */
function errBrief(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** 預設單次雲呼叫超時（毫秒） */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 統一入口：呼叫 wx.cloud.callContainer */
export async function callContainer<T = unknown>(
  opts: CloudCallOptions,
): Promise<CloudResponse<T>> {
  const invoke = async (): Promise<CloudResponse<T>> => {
    return new Promise((resolve, reject) => {
      const header: Record<string, string> = {
        'content-type': 'application/json',
        ...(opts.header ?? {}),
      };
      if (opts.sessionId) header['x-micromate-session'] = opts.sessionId;

      // 真實呼叫：微信運行時會注入 wx 全域
      // 開發環境下若 wx 不存在，給出明確錯誤
      const wxApi = (globalThis as { wx?: { cloud?: { callContainer: (o: unknown) => Promise<unknown> } } }).wx;
      if (!wxApi?.cloud?.callContainer) {
        // 開發預覽 / 測試環境下的佔位
        // 透過錯誤攔截避免阻塞呼叫鏈
        return resolve({ code: -1, message: 'wx.cloud.callContainer 不可用（開發模式）' });
      }
      wxApi.cloud
        .callContainer({
          config: { env: opts.env },
          path: opts.path,
          method: opts.method,
          data: opts.data,
          header,
        })
        .then((res) => {
          // 微信容器返回的結構為 { statusCode, data }
          const r = res as { statusCode?: number; data?: CloudResponse<T> } | undefined;
          if (!r || typeof r !== 'object') {
            reject(markRetryable(new CloudNetworkError('雲端回應為空', true), true));
            return;
          }
          if (r.statusCode && r.statusCode >= 500) {
            reject(markRetryable(new CloudNetworkError(`雲端 ${r.statusCode}`, true), true));
            return;
          }
          resolve((r.data ?? { code: -1 }) as CloudResponse<T>);
        })
        .catch((err: unknown) => {
          // 開發 / 體驗環境（如開發者工具未開通雲開發、遊客模式）下，
          // 把雲端呼叫失敗歸一為開發模式占位碼（code:-1），
          // 讓 SKILL mock 與 LLM 規則規劃器兜底生效，保證本地可演示；
          // 此為預期路徑，僅記 warn 短訊（避免 ERROR 級完整堆疊造成誤導）。
          if (isDevEnv()) {
            logWarn(`callContainer 不可用（開發環境），降級為 code:-1：${errBrief(err)}`);
            resolve({ code: -1, message: `wx.cloud.callContainer 不可用（開發模式）：${String(err)}` });
            return;
          }
          // 正式環境（release）保持 CloudNetworkError 重試語義，
          // 避免真實網路閃斷被誤判為開發模式。
          logError('callContainer 失敗', err);
          reject(markRetryable(new CloudNetworkError(String(err), true), true));
        });
    });
  };

  /**
   * 單次呼叫包裝超時（Promise.race）：每次重試獨立計時；
   * 開發環境 code:-1 降級路徑走 resolve，不受超時影響。
   */
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const invokeWithTimeout = (): Promise<CloudResponse<T>> =>
    Promise.race([
      invoke(),
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(markRetryable(new CloudNetworkError(`雲端呼叫超時（${timeoutMs}ms）`, true), true)),
          timeoutMs,
        );
      }),
    ]);

  if (opts.retry === false) {
    return invokeWithTimeout();
  }
  return retry(invokeWithTimeout, {
    maxAttempts: 3,
    baseDelayMs: 600,
    shouldRetry: (e) =>
      e instanceof CloudNetworkError ? e.retryable : true,
  });
}

/** 已完成 init 的雲端環境 ID（冪等保護） */
let initedEnv: string | null = null;

/** 開發環境判定結果快取（null 表示尚未判定） */
let devEnvCache: boolean | null = null;

/**
 * 是否為開發 / 體驗環境
 *
 * 決定雲端不可用時是否允許本地降級，兩處消費：
 *   1. 本檔 callContainer：開發環境把雲呼叫失敗歸一為 code:-1 佔位碼，
 *      讓 SKILL mock 與 LLM 規則規劃器兜底生效
 *   2. llm/client.ts：開發環境把雲端 5xx / 網路失敗（重試耗盡）降級為
 *      本地規則式規劃器
 *
 * 判定依據 getAccountInfoSync().miniProgram.envVersion：
 *   - 'develop' / 'trial'：開發者工具、真機預覽、體驗版 → 允許降級
 *   - 'release'：正式版 → 不降級，保留嚴格失敗語義（LLM 真實故障
 *     不應被規則規劃器靜默掩蓋，網路閃斷保留重試語義）
 * 取不到 envVersion 時保守視為開發環境（便於本地演示）。
 */
export function isDevEnv(): boolean {
  if (devEnvCache !== null) return devEnvCache;
  try {
    const wxApi = (globalThis as { wx?: { getAccountInfoSync?: () => { miniProgram?: { envVersion?: string } } } }).wx;
    const v = wxApi?.getAccountInfoSync?.().miniProgram?.envVersion;
    devEnvCache = v ? v !== 'release' : true;
  } catch {
    devEnvCache = true;
  }
  return devEnvCache;
}

/**
 * 冪等初始化微信雲開發環境
 *
 * wx.cloud.callContainer 使用前必須先 init；以模組級變數保證
 * 同一 env 僅初始化一次。wx 不可用（開發者工具未開通雲開發 /
 * 單元測試環境）時靜默跳過，由 callContainer 既有的 code:-1
 * 降級鏈路兜底，不阻斷啟動流程。
 */
export function ensureCloudInit(env: string): void {
  if (initedEnv === env) return;
  const wxApi = (globalThis as { wx?: { cloud?: { init?: (o: unknown) => void } } }).wx;
  if (!wxApi?.cloud?.init) {
    logWarn(`wx.cloud.init 不可用，跳過初始化（env=${env}）`);
    return;
  }
  try {
    wxApi.cloud.init({ env });
    initedEnv = env;
    logInfo(`wx.cloud.init 完成（env=${env}）`);
  } catch (e) {
    // 部分基礎庫在環境無效時會同步抛錯，不應阻斷 App 啟動
    logWarn(`wx.cloud.init 失敗（env=${env}）`, e);
  }
}

/** 業務快捷方法：POST */
export function postContainer<T = unknown>(
  env: string,
  path: string,
  data?: unknown,
  extra: Partial<CloudCallOptions> = {},
): Promise<CloudResponse<T>> {
  return callContainer<T>({
    env,
    path,
    method: 'POST',
    data,
    ...extra,
  });
}