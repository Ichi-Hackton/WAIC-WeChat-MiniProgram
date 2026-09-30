/**
 * 微信小程序全域 API 型別宣告（完整版）
 *
 * 規範來源：.qoder/rules/Agent.md
 *
 * 此檔案覆蓋 MicroMate MVP 階段所有用到的 wx API。
 * 不引入 `@types/wechat-miniprogram` 外部依賴。
 */

// ----- App / Page / getApp -----

declare const App: (options: {
  onLaunch?: (opts: { query?: Record<string, string> }) => void;
  onShow?: (opts: { query?: Record<string, string> }) => void;
  onHide?: () => void;
  onError?: (err: unknown) => void;
  onPageNotFound?: (opts: { path: string; query?: Record<string, string>; isEntryPage?: boolean }) => void;
  globalData?: Record<string, unknown>;
}) => void;

declare const Page: (options: {
  data?: Record<string, unknown>;
  onLoad?: (query: Record<string, string | undefined>) => void;
  onShow?: () => void;
  onReady?: () => void;
  onHide?: () => void;
  onUnload?: () => void;
  onPullDownRefresh?: () => void;
  onReachBottom?: () => void;
  onShareAppMessage?: () => { title?: string; path?: string; imageUrl?: string };
  [key: string]: unknown;
}) => void;

declare const getApp: () => {
  globalData: Record<string, unknown>;
  [key: string]: unknown;
};

// ----- wx 全域 -----

declare const wx: {
  // UI
  showToast(opts: {
    title: string;
    icon?: 'success' | 'error' | 'loading' | 'none';
    duration?: number;
    mask?: boolean;
    success?: () => void;
    fail?: (err: unknown) => void;
  }): void;
  showModal(opts: {
    title: string;
    content: string;
    confirmText?: string;
    cancelText?: string;
    showCancel?: boolean;
    success?: (res: { confirm: boolean; cancel: boolean }) => void;
    fail?: (err: unknown) => void;
  }): void;
  showLoading(opts: { title: string; mask?: boolean }): void;
  hideLoading(opts?: { fail?: (err: unknown) => void }): void;
  showActionSheet(opts: {
    itemList: string[];
    success?: (res: { tapIndex: number }) => void;
    fail?: (err: unknown) => void;
  }): void;

  // 導航
  navigateTo(opts: { url: string; success?: () => void; fail?: (err: unknown) => void }): void;
  redirectTo(opts: { url: string }): void;
  switchTab(opts: { url: string }): void;
  navigateBack(opts?: { delta?: number }): void;
  reLaunch(opts: { url: string }): void;

  // 儲存
  getStorageSync<T = unknown>(key: string): T;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
  getStorageInfoSync(): { keys: string[]; currentSize: number; limitSize: number };

  // 系統資訊
  getSystemInfoSync(): {
    model: string;
    pixelRatio: number;
    screenWidth: number;
    screenHeight: number;
    statusBarHeight: number;
    language: string;
    version: string;
    platform: string;
    SDKVersion: string;
  };
  getWindowInfo?(): { windowWidth: number; windowHeight: number; pixelRatio: number };
  getAccountInfoSync?(): { miniProgram?: { appId?: string; envVersion?: 'develop' | 'trial' | 'release' } };

  // 地理位置
  getLocation(opts: {
    type?: 'wgs84' | 'gcj02';
    success?: (res: { latitude: number; longitude: number; accuracy: number; city?: string }) => void;
    fail?: (err: unknown) => void;
  }): Promise<unknown>;

  // 登入
  login(opts: {
    success?: (res: { code: string }) => void;
    fail?: (err: unknown) => void;
  }): void;

  // 雲開發
  cloud: {
    init(opts: { env: string; traceUser?: boolean }): void;
    callContainer(opts: {
      config: { env: string };
      path: string;
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      data?: unknown;
      header?: Record<string, string>;
    }): Promise<unknown>;
    callFunction(opts: { name: string; data?: unknown }): Promise<unknown>;
  };

  // 支付
  requestPayment(opts: {
    provider?: string;
    timeStamp: string;
    nonceStr?: string;
    package?: string;
    signType?: string;
    paySign?: string;
    orderIds?: string[];
    agentSessionId?: string;
    orderItems?: Array<{ title: string; amountCent: number; quantity: number }>;
    success?: (res: unknown) => void;
    fail?: (err: unknown) => void;
    complete?: () => void;
  }): Promise<unknown>;

  // 錄音（新舊版本）
  startRecord(opts?: { fail?: (err: unknown) => void }): void;
  stopRecord(opts?: { success?: (res: { tempFilePath: string }) => void; fail?: (err: unknown) => void }): void;
  getRecorderManager(): unknown;

  // 分享 / 觸發
  showShareMenu(opts?: { withShareTicket?: boolean }): void;

  // 網路
  request(opts: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    data?: unknown;
    header?: Record<string, string>;
    success?: (res: { statusCode: number; data: unknown }) => void;
    fail?: (err: unknown) => void;
  }): void;

  // 動畫 / 振動
  vibrateShort(opts?: { type?: 'light' | 'medium' | 'heavy' }): void;

  // 剪貼簿
  setClipboardData(opts: { data: string; success?: () => void }): void;

  // 文本選擇
  setEnableAlertBeforeUnload(opts: { message: string; success?: () => void }): void;
};

