/**
 * 微信小程序 App 入口
 *
 * 此檔案為微信運行時唯一的 App({...}) 入口，位於 miniprogram/ 目錄下
 * （project.config.json 的 miniprogramRoot 指向本目錄）。
 * 與 src/app.ts（Agent Runtime 組裝）的職責區分：
 *   - miniprogram/app.ts：微信生命周期、頁面路由、全域資料注入
 *   - src/app.ts：Agent Runtime 工廠（SKILL 註冊、雲端初始化、Orchestrator）
 *
 * 規範來源：.qoder/rules/Agent.md
 *
 * 所有可見品牌字串（banner、globalData 暴露）皆引用 BRAND_NAME，
 * **禁止硬編碼**。
 */

import { BRAND_NAME, BRAND_TAGLINE, BRAND_VERSION } from './src/types/brand';
import { info as logInfo } from './src/utils/logger';
import { createAgentRuntime, CLOUD_ENV } from './src/app';
import type { AgentRuntime } from './src/app';
import { ensureLogin } from './src/services/identity';
import { markDailyActive } from './src/services/metrics';

/** Agent Runtime 模組級持有（懶載入：首次存取 globalData.agent 時建構） */
let agentRuntime: AgentRuntime | null = null;

App({
  onLaunch(): void {
    // 僅輸出單條啟動日誌，保持 onLaunch 輕量：基礎庫對耗時超過 100ms 的
    // onLaunch 會拋 [Perf] 警告。Agent Runtime 改由 globalData.agent
    // getter 懶載入 —— 首次存取（頁面 onLoad / dispatch）時才建構；
    // createAgentRuntime 為冪等單例，且 onLaunch 同步段必先於頁面
    // onLoad 執行，時序安全。
    logInfo(`微信 App 生命週期啟動 — ${BRAND_NAME} v${BRAND_VERSION}`);
    // 靜默微信登入：wx.login → 雲托管換取 openid 並緩存。fire-and-forget，
    // 同步段僅發起（wx.login 回調異步），不佔 onLaunch 耗時預算；
    // ensureLogin 內部自行冪等 ensureCloudInit，不依賴懶載入的
    // Agent Runtime（見 globalData.agent 註釋的時序契約）。
    void ensureLogin(CLOUD_ENV);
  },
  onShow(): void {
    logInfo(`${BRAND_NAME} 進入前台`);
    // 日活打點（2026-10 評審 #5 複訪率分子；同日去重，fire-and-forget）
    markDailyActive(CLOUD_ENV);
  },
  onHide(): void {
    logInfo(`${BRAND_NAME} 進入後台`);
  },
  globalData: {
    brandName: BRAND_NAME,
    brandTagline: BRAND_TAGLINE,
    brandVersion: BRAND_VERSION,
    /** Agent 運行時（頁面透過 getApp().globalData.agent 取用；懶載入，首次存取時建構） */
    get agent(): AgentRuntime | null {
      if (!agentRuntime) agentRuntime = createAgentRuntime();
      return agentRuntime;
    },
  },
});
