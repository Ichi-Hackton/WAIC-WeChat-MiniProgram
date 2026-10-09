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
  /** 轉發內容（menu=右上角菜单 / button=open-type=share 按鈕；可返回 Promise 支持異步取分享 path） */
  onShareAppMessage?: (res?: {
    from?: 'button' | 'menu';
    target?: { dataset?: Record<string, string> };
  }) =>
    | { title?: string; path?: string; imageUrl?: string }
    | Promise<{ title?: string; path?: string; imageUrl?: string }>;
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
  /** 跳轉外部小程序（2026-10 跳轉模式：12306 / OTA 官方渠道下單）；開發者工具不支援，僅真機可用 */
  navigateToMiniProgram(opts: {
    appId: string;
    path?: string;
    success?: () => void;
    fail?: (err: unknown) => void;
  }): void;
  /**
   * 半屏打開外部小程序（基礎庫 2.20.1+；2026-10 半屏跳轉升級）
   *
   * 前置條件：後台「設置 → 第三方設置 → 半屏小程序管理」申請並通過目標
   * appId；不滿足時微信自動降級為普通跳轉（navigateToMiniProgram 形態）。
   * 支付等複雜交互由 allowFullScreen 授權目標自行轉全屏（基礎庫 3.10.0
   * 起強制 true）。開發者工具不支援，僅真機可驗證。
   */
  openEmbeddedMiniProgram(opts: {
    appId: string;
    path?: string;
    extraData?: Record<string, unknown>;
    /** 授權目標小程序自行轉全屏（支付 / 複雜交互需要） */
    allowFullScreen?: boolean;
    success?: () => void;
    fail?: (err: unknown) => void;
  }): void;
  setNavigationBarTitle(opts: { title: string }): void;

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

  // 地理位置（注意：基礎庫回應不含 city 欄位，此處僅防未來擴展；
  // 城市名由雲端逆地理編碼補全，見 services/geo.ts）
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

  // 授權設置（定位等授權被拒後引導重開）
  openSetting(opts?: {
    success?: (res: { authSetting: Record<string, boolean> }) => void;
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
  /** 訂閱消息授權（必須由用戶 tap 動作觸發；模板 ID 未配置時呼叫方不渲染入口） */
  requestSubscribeMessage(opts: {
    tmplIds: string[];
    success?: (res: { [tmplId: string]: 'accept' | 'reject' | 'ban' | 'filter' }) => void;
    fail?: (err: unknown) => void;
  }): void;

  // 下拉刷新
  stopPullDownRefresh(opts?: { complete?: () => void }): void;

  // 網路
  request(opts: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    data?: unknown;
    header?: Record<string, string>;
    /** 超時毫秒（僅開發直連本地服務使用，見 services/cloud.ts） */
    timeout?: number;
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

