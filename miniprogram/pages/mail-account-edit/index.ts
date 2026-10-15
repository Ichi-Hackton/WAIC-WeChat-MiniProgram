/**
 * 綁定 / 編輯郵箱帳戶頁（用戶自有發件通道，2026-10-14 新增）
 *
 * 視覺系統與收貨地址 / 乘車人編輯頁同族（侘寂極簡：米白基底 +
 * hairline 分隔 + 襯線標籤）。
 *
 * 單帳戶模型（非列表）：
 *   - 未綁定進入 = 新增態（「綁定郵箱帳戶」）
 *   - 已綁定進入 = 編輯態（標題切換；授權碼不回填，留空 = 沿用原碼；
 *     另提供「解除綁定」）
 *
 * SMTP 服務器按郵箱後綴自動推斷（QQ / 163 等零額外輸入）；用戶手動
 * 改過服務器 / 端口後不再自動覆蓋（尊重企業郵箱等自定義場景）。
 *
 * 與 src/storage/mail-account 的關係：本頁只做表單狀態與交互，
 * 校驗 / 加密持久化全部下沉數據層（§ 12.3 分層依賴）。
 */

import {
  getMailAccount,
  saveMailAccount,
  clearMailAccount,
  validateMailAccountForm,
  suggestSmtp,
} from '../../src/storage/mail-account';
import type { MailAccountFormInput } from '../../src/storage/mail-account';

/** 頁面資料結構 */
interface MailAccountEditPageData {
  email: string;
  authCode: string;
  smtpHost: string;
  smtpPort: string;
  /** 已綁定進入（切換標題 / 保存文案 / 顯示解綁按鈕） */
  editing: boolean;
  [key: string]: unknown;
}

/** Page 內部 this 實例 */
interface MailAccountEditPageThis {
  data: MailAccountEditPageData;
  setData: (patch: Partial<MailAccountEditPageData>) => void;
  /** 用戶已手動修改 SMTP 服務器 / 端口（之後不再自動推斷覆蓋） */
  hostLocked: boolean;
  /** 編輯態原授權碼（保存留空時沿用；絕不進 data / 渲染層） */
  prevAuthCode: string;
  onLoad: () => void;
  onEmailInput: (e: { detail: { value: string } }) => void;
  onAuthCodeInput: (e: { detail: { value: string } }) => void;
  onHostInput: (e: { detail: { value: string } }) => void;
  onPortInput: (e: { detail: { value: string } }) => void;
  onTapSave: () => void;
  onTapUnbind: () => void;
}

Page({
  data: {
    email: '',
    authCode: '',
    smtpHost: '',
    smtpPort: '',
    editing: false,
  } as MailAccountEditPageData,

  onLoad(this: MailAccountEditPageThis): void {
    this.hostLocked = false;
    this.prevAuthCode = '';
    const account = getMailAccount();
    if (!account) return;
    // 編輯態：回填非敏感欄位；授權碼不回填（密碼框留空 = 沿用）
    this.prevAuthCode = account.authCode;
    this.hostLocked = true; // 已綁定帳戶的服務器視為用戶選定，不自動覆蓋
    wx.setNavigationBarTitle({ title: '編輯郵箱帳戶' });
    this.setData({
      email: account.email,
      smtpHost: account.smtpHost,
      smtpPort: String(account.smtpPort),
      editing: true,
    });
  },

  /** 郵箱輸入：同步自動推斷 SMTP 服務器（僅未手動鎖定時） */
  onEmailInput(this: MailAccountEditPageThis, e: { detail: { value: string } }): void {
    const email = e.detail.value;
    const patch: Partial<MailAccountEditPageData> = { email };
    if (!this.hostLocked) {
      const guess = suggestSmtp(email);
      if (guess) {
        patch.smtpHost = guess.host;
        patch.smtpPort = String(guess.port);
      }
    }
    this.setData(patch);
  },

  /** 授權碼輸入（password 型輸入框，不進截圖 / 不回填） */
  onAuthCodeInput(this: MailAccountEditPageThis, e: { detail: { value: string } }): void {
    this.setData({ authCode: e.detail.value });
  },

  /** SMTP 服務器手動修改（此後凍結自動推斷） */
  onHostInput(this: MailAccountEditPageThis, e: { detail: { value: string } }): void {
    this.hostLocked = true;
    this.setData({ smtpHost: e.detail.value });
  },

  /** SMTP 端口手動修改（同上凍結） */
  onPortInput(this: MailAccountEditPageThis, e: { detail: { value: string } }): void {
    this.hostLocked = true;
    this.setData({ smtpPort: e.detail.value });
  },

  /**
   * 保存：校驗 → 加密落盤 → toast 回饋 → 返回上一頁
   *
   * 校驗文案由 validateMailAccountForm 統一給出（數據層純函數）；
   * 授權碼加密持久化在數據層收口。失敗 modal 彈窗（與地址頁同規：
   * toast 短提示易漏看）。
   */
  onTapSave(this: MailAccountEditPageThis): void {
    const input: MailAccountFormInput = {
      email: this.data.email,
      authCode: this.data.authCode,
      smtpHost: this.data.smtpHost,
      smtpPort: Number(this.data.smtpPort) || 0,
    };
    const err = validateMailAccountForm(input, this.data.editing && !!this.prevAuthCode);
    if (err) {
      wx.showModal({ title: '無法保存', content: err, showCancel: false, confirmText: '知道了' });
      return;
    }
    saveMailAccount(input, this.data.editing ? this.prevAuthCode : undefined);
    wx.showToast({ title: this.data.editing ? '已保存' : '已綁定', icon: 'success' });
    setTimeout(() => wx.navigateBack({}), 500);
  },

  /** 解除綁定（僅編輯態）：modal 確認後下沉數據層（本地清除即全域失效） */
  onTapUnbind(this: MailAccountEditPageThis): void {
    if (!this.data.editing) return;
    wx.showModal({
      title: '解除綁定',
      content: '解除後「發送郵件」將回落複製引導（不再透過你的郵箱發出），確定解除？',
      confirmText: '解除',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        clearMailAccount();
        wx.showToast({ title: '已解除綁定', icon: 'success' });
        setTimeout(() => wx.navigateBack({}), 500);
      },
    });
  },
} as unknown as Parameters<typeof Page>[0]);
