/**
 * 微信小程序 App 入口
 *
 * 此檔案為微信運行時的 App({...}) 入口，位於 miniprogram/ 目錄下。
 * 與 src/app.ts（Agent 編排層）區分：
 *   - miniprogram/app.ts：微信生命周期、頁面路由、全域資料
 *   - src/app.ts：Agent 編排器的組裝與業務呼叫
 *
 * 規範來源：.qoder/rules/Agent.md
 *
 * 所有可見品牌字串（banner、globalData 暴露）皆引用 BRAND_NAME，
 * **禁止硬編碼**。
 */

import { BRAND_NAME, BRAND_TAGLINE, BRAND_VERSION } from '../src/types/brand';
import { banner as logBanner, info as logInfo } from '../src/utils/logger';

App({
  onLaunch(): void {
    logBanner();
    logInfo(`微信 App 生命週期啟動 — ${BRAND_NAME} v${BRAND_VERSION}`);
  },
  onShow(): void {
    logInfo(`${BRAND_NAME} 進入前台`);
  },
  onHide(): void {
    logInfo(`${BRAND_NAME} 進入後台`);
  },
  globalData: {
    brandName: BRAND_NAME,
    brandTagline: BRAND_TAGLINE,
    brandVersion: BRAND_VERSION,
  },
});
