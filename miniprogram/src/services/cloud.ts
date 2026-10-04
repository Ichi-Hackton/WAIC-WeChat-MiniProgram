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

/** 回應體是否為標準 CloudResponse（帶數字 code 欄位） */
function isStandardCloudBody<T>(d: unknown): d is CloudResponse<T> {
  return typeof d === 'object' && d !== null && typeof (d as CloudResponse<T>).code === 'number';
}

/** 預設單次雲呼叫超時（毫秒） */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 本地雲托管服務位址（開發直連模式，見 localRunRequest 註釋）。
 * 匯出供 App 組裝層注入日誌旁路 sink（logger → /api/dev-log 落盤）復用。
 */
export const LOCAL_RUN_BASE = 'http://127.0.0.1:8787';

/** 開發直連佔位身份（寫操作鑑權用，見 localRunRequest 註釋） */
const LOCAL_RUN_OPENID = 'dev-local-user';

/**
 * 容器回應統一歸一（wx.cloud.callContainer 與本地直連共用）
 *
 * 處理順序：空回應 → 拒（可重試）；5xx → 拒（可重試）；
 * 開發環境非標準回應（INVALID_ENV resolve 錯誤體形態，見 callContainer
 * 內註釋）→ code:-1 佔位；標準回應體（含 4xx 業務失敗）→ 透傳
 * （data 缺失時補 code:-1）。
 */
function normalizeContainerResponse<T>(
  r: { statusCode?: number; data?: CloudResponse<T> } | undefined,
): CloudResponse<T> {
  if (!r || typeof r !== 'object') {
    throw markRetryable(new CloudNetworkError('雲端回應為空', true), true);
  }
  if (r.statusCode && r.statusCode >= 500) {
    throw markRetryable(new CloudNetworkError(`雲端 ${r.statusCode}`, true), true);
  }
  if (isDevEnv() && !isStandardCloudBody<T>(r.data)) {
    // 僅歸一「非標準回應體」（INVALID_ENV resolve 的錯誤體形態，必然無數值 code）；
    // 標準 4xx 業務失敗體（含數值 code，如 quantity 非法 / 缺鑑權）必須透傳，
    // 否則會被誤判為雲基礎設施故障而走 mock 降級偽成功，掩蓋服務端校驗缺陷
    logWarn(`callContainer 非標準回應（開發環境），降級為 code:-1：HTTP ${r.statusCode ?? 200}`);
    return { code: -1, message: 'wx.cloud.callContainer 不可用（開發模式）：非標準回應' };
  }
  return (r.data ?? { code: -1 }) as CloudResponse<T>;
}

/**
 * 直連本地雲托管服務（開發直連模式）
 *
 * 開發者工具未開通雲開發時 wx.cloud.callContainer 恆為 INVALID_ENV，
 * 真實 LLM / SKILL 端點無法觸達；開發環境改以 wx.request 直連本機
 * 自托管的 cloudrun 服務（cloudrun/ 目錄 npm start，PORT=8787）。
 *
 * 合規說明（規範 § 7.1「禁止小程序端直連第三方 API」）：目標為我們
 * 自己的雲托管容器本地實例而非第三方，LLM API Key 仍僅存於服務端。
 *
 * 回應形態與 wx.cloud.callContainer 對齊（{ statusCode, data }），
 * 交由 normalizeContainerResponse 統一歸一；連線失敗（服務未啟動）
 * reject，由呼叫方回落雲開發鏈路。
 *
 * x-wx-openid 為開發佔位身份（寫操作鑑權）：正式雲托管部署時微信
 * 網關注入真實調用方身份並覆蓋客戶端偽造頭，本地直連無此機制。
 */
function localRunRequest<T>(
  opts: CloudCallOptions,
): Promise<{ statusCode?: number; data?: CloudResponse<T> }> {
  return new Promise((resolve, reject) => {
    const wxApi = (globalThis as { wx?: { request?: (o: Record<string, unknown>) => void } }).wx;
    if (typeof wxApi?.request !== 'function') {
      reject(new Error('wx.request 不可用（開發直連模式）'));
      return;
    }
    wxApi.request({
      url: `${LOCAL_RUN_BASE}${opts.path}`,
      method: opts.method,
      data: opts.data,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      header: {
        'content-type': 'application/json',
        ...(opts.header ?? {}),
        ...(opts.sessionId ? { 'x-micromate-session': opts.sessionId } : {}),
        'x-wx-openid': LOCAL_RUN_OPENID,
      },
      success: (res: { statusCode?: number; data?: unknown }) => {
        resolve({ statusCode: res.statusCode, data: res.data as CloudResponse<T> });
      },
      fail: (err: unknown) => reject(err),
    });
  });
}

/** 統一入口：呼叫 wx.cloud.callContainer */
export async function callContainer<T = unknown>(
  opts: CloudCallOptions,
): Promise<CloudResponse<T>> {
  const invoke = async (): Promise<CloudResponse<T>> => {
    // 開發環境優先直連本地雲托管服務（見 localRunRequest 註釋）：
    // 本地服務在線時走真實 LLM / SKILL 端點。僅「連線失敗」（服務未
    // 啟動，localRunRequest reject → null）才回落雲開發鏈路；服務已回應
    // （含 5xx，如 LLM 未配 Key 的 503）則正常走歸一 / 重試 / 降級語義，
    // 不因業務性失敗意外改道路由。僅 develop / trial 生效，release 恆走
    // 雲開發，保證正式環境安全。
    if (isDevEnv()) {
      const local = await localRunRequest<T>(opts).catch(() => null);
      if (local) {
        return normalizeContainerResponse<T>(local);
      }
      logWarn('本地雲托管服務不可達（127.0.0.1:8787），回落雲開發鏈路');
    }
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
          // 微信容器返回的結構為 { statusCode, data }，歸一邏輯與本地直連共用；
          // normalize 拋出（空回應 / 5xx）時經 then 鏈轉為 reject，由下方
          // catch 統一處理（dev 歸一 code:-1 / release 保留重試語義）
          resolve(normalizeContainerResponse<T>(res as { statusCode?: number; data?: CloudResponse<T> } | undefined));
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

/** 業務快捷方法：GET（目前僅 /api/config 狀態查詢使用） */
export function getContainer<T = unknown>(
  env: string,
  path: string,
  extra: Partial<CloudCallOptions> = {},
): Promise<CloudResponse<T>> {
  return callContainer<T>({
    env,
    path,
    method: 'GET',
    ...extra,
  });
}