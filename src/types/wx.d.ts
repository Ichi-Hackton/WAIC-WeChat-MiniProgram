/**
 * 微信小程序全域 API 型別宣告
 *
 * 完整覆蓋請裝官方 `@types/wechat-miniprogram`；本檔案僅覆蓋
 * MicroMate bootstrap 階段用到的方法，避免外部型別依賴。
 *
 * 規範來源：.qoder/rules/Agent.md
 */

declare const wx: {
  showToast(opts: {
    title: string;
    icon?: 'success' | 'error' | 'loading' | 'none';
    duration?: number;
  }): void;
  showModal(opts: {
    title: string;
    content: string;
    confirmText?: string;
    cancelText?: string;
    success?: (res: { confirm: boolean; cancel: boolean }) => void;
    fail?: (err: unknown) => void;
  }): void;
  showLoading(opts: { title: string; mask?: boolean }): void;
  hideLoading(): void;
  getStorageSync<T = unknown>(key: string): T;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
  cloud: {
    callContainer(opts: {
      config: { env: string };
      path: string;
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      data?: unknown;
      header?: Record<string, string>;
    }): Promise<unknown>;
  };
};

declare const App: (options: {
  onLaunch?: () => void;
  onShow?: () => void;
  onHide?: () => void;
  onError?: (err: unknown) => void;
  onPageNotFound?: (opts: { path: string }) => void;
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
  onShareAppMessage?: () => void;
  [key: string]: unknown;
}) => void;

declare const getApp: () => {
  globalData: Record<string, unknown>;
  [key: string]: unknown;
};
