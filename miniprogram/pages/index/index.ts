/**
 * MicroMate 首頁
 *
 * 規範來源：.qoder/rules/Agent.md
 *
 * 此頁為 mini program 啟動後的首頁，目前僅展示品牌名稱與標語；
 * 後續真實業務由 src/interaction/voice 與 src/core/orchestrator 接管，
 * 本頁會隨 Phase 演進替換為互動式 Agent 介面。
 */

import { BRAND_NAME, BRAND_TAGLINE } from '../../../src/types/brand';
import { info as logInfo } from '../../../src/utils/logger';

interface HomePageData {
  brandName: string;
  brandTagline: string;
  [key: string]: unknown;
}

Page({
  data: {
    brandName: BRAND_NAME,
    brandTagline: BRAND_TAGLINE,
  } as Record<string, unknown>,
  onLoad(): void {
    logInfo(`${BRAND_NAME} 首頁載入`);
  },
});
