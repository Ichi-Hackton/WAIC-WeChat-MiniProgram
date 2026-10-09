/**
 * 外部渠道跳轉統一入口（2026-10 半屏跳轉升級 + 支付閉環）
 *
 * 半屏模式（wx.openEmbeddedMiniProgram，基礎庫 2.20.1+）：用戶在半屏內
 * 完成 12306 / OTA 的選座與支付（渠道收銀台，對方主體資質），關閉後回到
 * MicroMate 對話流——消除「跳出去回不來」的斷裂感。前置條件：後台
 * 「半屏小程序管理」申請通過目標 appId（個人小程序能否獲官方大渠道通過
 * 需實測）；不滿足時微信自動降級普通跳轉，本模組再加一層顯式兜底，
 * 保證任何環境下下單路徑不斷裂。
 *
 * 成交確認：真實支付發生在渠道側，本系統不可見、也不碰（個人主體無
 * 支付資質的合規形態）。用戶支付完成回到行程頁點「標記已支付」，
 * 經雲端 complete 端點將訂單歸檔 completed——用戶自證成交，是跳轉
 * 模式下漏斗的最深可觀測點（埋點 order_confirmed）。
 */

import { postContainer } from './cloud';
import type { CloudResponse } from './cloud';
import { recordEvent } from './metrics';
import { METRIC_NAMES } from '../utils/metrics';
import { info as logInfo } from '../utils/logger';

/** 跳轉入參（env / 半屏白名單由頁面層傳入，services 層不反向依賴組裝層） */
export interface JumpOptions {
  /** 雲端環境 ID（埋點上報用） */
  env: string;
  /** 目標小程序 appId（空串 = 渠道未接入，走 copy-only 提示） */
  appId: string;
  /** 目標頁面路徑（jCommand 轉鏈指令優先；空串開首頁） */
  path: string;
  /** 半屏白名單（src/app.ts EMBEDDED_JUMP_APPIDS；空數組 = 全部普通跳轉） */
  embeddedAppIds: readonly string[];
}

/** 跳轉成功統一埋點（漏斗：首頁跳轉卡與行程頁重跳轉同口徑） */
function onLaunched(env: string): void {
  recordEvent(env, METRIC_NAMES.jumpClicked);
}

/** 跳轉最終失敗（半屏與普通跳轉都不可用）：日誌取證 + 引導手動渠道 */
function onJumpFailed(appId: string, err: unknown): void {
  logInfo(`[jump] 跳轉小程序失敗（appId=${appId}）：${JSON.stringify(err)}`);
  wx.showToast({ title: '此環境不支援跳轉（請用真機驗證），可複製資訊後打開對應 App', icon: 'none' });
}

/**
 * 跳轉外部官方小程序（首頁跳轉卡與行程頁「去下單」共用入口）
 *
 * appId 空串 = 渠道未接入小程序跳轉（copy-only），提示複製後手動打開
 * 渠道 App；白名單命中走半屏（allowFullScreen 授權渠道支付時自行轉
 * 全屏），fail 時顯式降級普通跳轉再兜底提示。
 */
export function jumpExternal(opts: JumpOptions): void {
  const { env, appId, path } = opts;
  if (!appId) {
    wx.showToast({ title: '該渠道暫未接入小程序跳轉，請複製資訊後打開對應 App', icon: 'none' });
    return;
  }

  if (opts.embeddedAppIds.includes(appId)) {
    wx.openEmbeddedMiniProgram({
      appId,
      ...(path ? { path } : {}),
      allowFullScreen: true,
      success: () => onLaunched(env),
      fail: (err: unknown) => {
        // 半屏不可用（後台未通過 / 基礎庫過低 / 開發者工具）：微信側本會
        // 自動降級普通跳轉，此處顯式兜底再走一次，路徑不斷裂
        logInfo(`[jump] 半屏不可用，降級普通跳轉（appId=${appId}）：${JSON.stringify(err)}`);
        wx.navigateToMiniProgram({
          appId,
          ...(path ? { path } : {}),
          success: () => onLaunched(env),
          fail: (e: unknown) => onJumpFailed(appId, e),
        });
      },
    });
    return;
  }

  wx.navigateToMiniProgram({
    appId,
    ...(path ? { path } : {}),
    success: () => onLaunched(env),
    fail: (err: unknown) => onJumpFailed(appId, err),
  });
}

/**
 * 成交確認：將渠道跳轉訂單歸檔為 completed
 *
 * @param skillId 下單 SKILL ID（如 skill.train.12306，路由拼徑用）
 * @param action  下單 capability（如 book_ticket）
 * @param orderId 渠道跳轉訂單號（trn_ / flg_ 前綴）
 * @returns 成功返回 true；業務失敗返回用戶可讀原因（訂單不存在 / 已取消等）
 * @throws    網路層失敗拋錯，由頁面 catch 提示重試
 */
export async function confirmExternalPaid(
  env: string,
  skillId: string,
  action: string,
  orderId: string,
): Promise<true | string> {
  const res: CloudResponse<{ ok: boolean; orderId: string }> = await postContainer<{ ok: boolean; orderId: string }>(
    env,
    `/api/skill/${skillId}/${action}/complete`,
    { orderId },
    { retry: false, timeoutMs: 10_000 },
  );
  if (res.code === 0) return true;
  return res.message ?? '成交確認失敗，請稍後再試';
}
