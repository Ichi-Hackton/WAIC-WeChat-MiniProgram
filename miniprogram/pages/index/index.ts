/**
 * 首頁：溫暖的開場與入口。
 * 首次使用時彈出隱私告知（Agent.md 隱私承諾）。
 */
import { CONDOLENCE_SHORT } from '../../knowledge';
import { ackFirstUse, getChecklist, getGuideSession, isFirstUse } from '../../services/storage';
import { goAbout, goChecklistTab, goFeeTab, goGuide } from '../../services/navigation';

Page({
  data: {
    showPrivacy: false,
    canResume: false,
    hasChecklist: false,
    primaryLabel: '開始引導',
    condolence: CONDOLENCE_SHORT,
  },
  onShow() {
    const session = getGuideSession();
    const hasChecklist = !!getChecklist();
    const canResume = !!session && !session.finished;
    let primaryLabel = '開始引導';
    if (canResume) {
      primaryLabel = '繼續上次引導';
    } else if (hasChecklist) {
      primaryLabel = '再次生成清單';
    }
    this.setData({
      showPrivacy: isFirstUse(),
      canResume,
      hasChecklist,
      primaryLabel,
    });
  },
  onAckPrivacy() {
    ackFirstUse();
    this.setData({ showPrivacy: false });
  },
  onPrimaryTap() {
    goGuide();
  },
  onChecklistTap() {
    goChecklistTab();
  },
  onFeeTap() {
    goFeeTab();
  },
  onAboutTap() {
    goAbout();
  },
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return {
      title: '身後事導航助手｜把複雜流程變成能照著辦的清單',
      path: '/pages/index/index',
    };
  },
});
