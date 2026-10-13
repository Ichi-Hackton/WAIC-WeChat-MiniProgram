/**
 * 微信收貨地址導入封裝（2026-10 恢復落地）
 *
 * wx.chooseAddress 唯一封裝層（§ 12.3：services/ 為 wx API 唯一封裝層）。
 * 拉起微信原生收貨地址選擇器，返回原始結構（WechatAddress），由
 * storage/address 的 fromWechatAddress 做表單映射——本層不做業務加工。
 *
 * 前置要求：app.json requiredPrivateInfos 需含 "chooseAddress"，
 * 且用戶需授權（拒絕時上層 toast 引導，不強拉 openSetting）。
 */

import type { WechatAddress } from '../storage/address';

/** 拉起微信收貨地址選擇器；用戶取消 / 授權拒絕 / 無可用地址時返回 null */
export function pickWechatAddress(): Promise<WechatAddress | null> {
  return new Promise((resolve) => {
    const wxApi = (globalThis as { wx?: {
      chooseAddress?: (o: unknown) => void;
    } }).wx;
    if (!wxApi?.chooseAddress) {
      resolve(null);
      return;
    }
    wxApi.chooseAddress({
      success: (res: unknown) => {
        resolve((res ?? null) as WechatAddress | null);
      },
      fail: () => {
        // 用戶取消 / 授權拒絕 / 未填地址均走此分支，統一靜默為 null，
        // 由上層按場景決定提示（表單頁與空簿入口文案不同）
        resolve(null);
      },
    });
  });
}
