/**
 * 隱私與說明（Agent.md「隱私承諾」與「回答約束」）。
 * 包含：隱私要點、心理援助熱線、免責聲明、一鍵清除數據、版本信息。
 */
import { CRISIS_HOTLINES, DISCLAIMER, PRIVACY_POINTS } from '../../knowledge';
import { callPhone } from '../../services/phone';
import { confirmModal, toast } from '../../services/feedback';
import { clearAllData } from '../../services/storage';

Page({
  data: {
    privacyPoints: PRIVACY_POINTS,
    hotlines: CRISIS_HOTLINES,
    disclaimer: DISCLAIMER,
    version: 'v0.1.0（MVP）',
  },

  onCall(e: WechatMiniprogram.TouchEvent) {
    const { number } = e.currentTarget.dataset as { number: string };
    callPhone(number);
  },

  async onClearData() {
    const ok = await confirmModal(
      '清除全部數據',
      '將刪除引導對話、辦理清單與勾選進度，且無法恢復。確定清除嗎？',
    );
    if (!ok) {
      return;
    }
    clearAllData();
    toast('已清除全部本地數據');
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return {
      title: '身後事導航助手｜數據僅存本地，可一鍵清除',
      path: '/pages/index/index',
    };
  },
});
