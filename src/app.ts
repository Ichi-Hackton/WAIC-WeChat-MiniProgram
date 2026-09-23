/**
 * MicroMate App 入口（Agent 編排層）
 *
 * 規範來源：.qoder/rules/Agent.md § 15
 *
 * 此檔案位於 src/ 層，負責：
 *   1. 註冊所有 SKILL（待核心模組落地）
 *   2. 暴露對外的語音 / 文本入口
 *   3. onLaunch 輸出品牌 banner
 *
 * 與 miniprogram/app.ts 的區分：
 *   - src/app.ts：Agent 編排器的組裝與業務呼叫（orchestration 層）
 *   - miniprogram/app.ts：微信生命周期、頁面路由、全域資料
 *
 * 業務邏輯（Orchestrator / Planner / Scheduler）的實作位於
 * src/core/、src/skills/，本檔案僅做「組裝 + 入口暴露」。
 */

import { BRAND_NAME, BRAND_TAGLINE } from './types/brand';
import { banner as logBanner, info as logInfo, error as logError } from './utils/logger';

/* TODO: Orchestrator、SkillRegistry 與各 SKILL 實作落地後取消下方註解。
import { Orchestrator } from './core/orchestrator';
import { SkillRegistry } from './skills/registry';
import { instance as train12306 } from './skills/builtin/train-12306';
import { instance as starbucks } from './skills/builtin/coffee-starbucks';
*/

App({
  onLaunch(): void {
    logBanner();
    logInfo(`${BRAND_NAME} — ${BRAND_TAGLINE}`);
    /* TODO: 完成核心實作後註冊
    SkillRegistry.register(train12306);
    SkillRegistry.register(starbucks);
    */
  },
  globalData: {
    /**
     * 對外暴露的語音 / 文本入口，由頁面呼叫
     */
    async handleVoice(text: string): Promise<void> {
      try {
        logInfo(`收到語音輸入：${text}`);
        /* TODO: 接入 Orchestrator 後取消下方註解
        const ctx = buildContext();
        const agent = new Orchestrator(ctx);
        const res = await agent.handle(text);
        wx.showToast({ title: res.message });
        */
        wx.showToast({ title: `${BRAND_NAME}: ${text}` });
      } catch (e) {
        logError('handleVoice 執行失敗', e);
      }
    },
  },
});
