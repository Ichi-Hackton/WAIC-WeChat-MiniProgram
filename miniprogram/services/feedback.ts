/**
 * 操作反饋服務（wx API 唯一入口）：輕提示與加載狀態，
 * 保證每次操作（生成清單、複製、切換勾選等）都有可感知的反饋。
 */

type ToastIcon = 'success' | 'error' | 'loading' | 'none';

export function toast(title: string, icon: ToastIcon = 'success', duration = 1800): void {
  wx.showToast({ title, icon, duration });
}

export function showLoading(title: string): void {
  wx.showLoading({ title, mask: true });
}

export function hideLoading(): void {
  wx.hideLoading();
}

/** 確認對話框（如清除數據前的二次確認） */
export function confirmModal(title: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      confirmText: '確認',
      cancelText: '再想想',
      success: (res) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
}
