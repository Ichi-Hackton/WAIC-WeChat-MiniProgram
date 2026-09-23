/**
 * MicroMate 全域品牌常數
 *
 * 規範來源：.qoder/rules/Agent.md
 *
 * 所有跨層級引用品牌名稱時（日誌、UI、配置、文件、API 標識），
 * 必須從本檔案匯入，**禁止硬編碼**「MicroMate」字串。
 *
 * 維護須知：
 *   - 修改 BRAND_NAME 時，須同步人工更新下列位置（無法被 TS 編譯器涵蓋）：
 *     · miniprogram/app.json 的 window.navigationBarTitleText
 *     · package.json 的 name 與 description
 *     · project.config.json 的 projectname
 *   - BRAND_VERSION 由 CI 建置時自動替換
 *
 * 檔案副檔名說明：本檔案副檔名為 .ts（非 .d.ts），理由——
 * .d.ts 僅承載型別宣告，runtime 無法取到實際值；對於「需要被印出、
 * 被拼接、被傳給 wx API」的常數，必須用 .ts 才能產出 JS bundle。
 */

export const BRAND_NAME = 'MicroMate';

/** 對外中文標語，用於 UI 啟動畫面與行銷文案 */
export const BRAND_TAGLINE = '你的隨身個人 AI 助理';

/** 英文副標語（i18n / 國際化預留） */
export const BRAND_TAGLINE_EN = 'Your Pocket AI Mate';

/** 品牌短代號，用於 CLI 前綴、長度受限場景 */
export const BRAND_SHORT = 'MM';

/** 內部版本號，CI 建置時由 build script 注入實際版本 */
export const BRAND_VERSION = '0.0.0-dev';

/** ai_generated 內容的品牌溯源標識（用於 LLM 輸出合規） */
export const BRAND_AI_GENERATED_BY = 'MicroMate';
