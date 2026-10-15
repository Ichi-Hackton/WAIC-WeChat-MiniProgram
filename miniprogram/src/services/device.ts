/**
 * 設備通訊 API 封裝（撥打電話 / 剪貼簿）
 *
 * 規範來源：Agent.md § 12.3（services/ 為 wx API 唯一封裝層，業務層勿直接呼叫）
 *
 * 2026-10 設備通訊域（skill.device.comm）隨 SKILL 上線新增。與既有
 * skills 的差異：撥號與複製為**設備本地能力**（wx 原生 API），非第三方
 * API——不經雲端容器（§ 7.1 禁止的是小程序端直連第三方 API，本地設備
 * API 不在此列），離線可用。
 *
 * 降級語義：wx API 不可用（測試環境等）時 reject，由 SKILL 層轉為
 * 用戶可讀錯誤；不靜默假裝成功（「真實或誠實缺失，不演」原則）。
 */

import { error as logError } from '../utils/logger';

/**
 * 撥打電話：拉起微信內建撥號確認面板（用戶仍需手動點「呼叫」，
 * 天然 human-in-the-loop，故 capability 無需再設 requiresHumanConfirm）
 *
 * @param phoneNumber 電話號碼（手機號 / 座機 / 5-6 位公共熱線如 10086）
 * @throws wx API 不可用或用戶取消撥號面板時 reject
 */
export function dialPhone(phoneNumber: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const wxApi = (globalThis as { wx?: { makePhoneCall?: (o: unknown) => void } }).wx;
    if (!wxApi?.makePhoneCall) {
      reject(new Error('makePhoneCall 不可用'));
      return;
    }
    wxApi.makePhoneCall({
      phoneNumber,
      success: () => resolve(),
      fail: (err: unknown) => {
        // 用戶取消撥號面板屬正常路徑（非故障），日誌記錄取證即可
        logError(`撥號面板失敗或取消（${phoneNumber}）`, err);
        reject(err instanceof Error ? err : new Error(JSON.stringify(err)));
      },
    });
  });
}

/**
 * 複製文本到系統剪貼簿（發郵件引導鏈路：小程序無原生郵件 API，
 * 以「複製郵件內容 + 引導用戶到郵件 App 貼上發送」誠實實現）
 *
 * @param text 待複製文本
 * @throws wx API 不可用或系統拒絕時 reject
 */
export function copyText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const wxApi = (globalThis as { wx?: { setClipboardData?: (o: unknown) => void } }).wx;
    if (!wxApi?.setClipboardData) {
      reject(new Error('setClipboardData 不可用'));
      return;
    }
    wxApi.setClipboardData({
      data: text,
      success: () => resolve(),
      fail: (err: unknown) => {
        logError('剪貼簿寫入失敗', err);
        reject(err instanceof Error ? err : new Error(JSON.stringify(err)));
      },
    });
  });
}
