/**
 * 頁面導航服務（wx API 唯一入口）。
 */

export function goGuide(): void {
  wx.navigateTo({ url: '/pages/guide/guide' });
}

export function goDetail(detailId: string): void {
  wx.navigateTo({ url: `/pages/detail/detail?id=${detailId}` });
}

export function goAbout(): void {
  wx.navigateTo({ url: '/pages/about/about' });
}

export function goChecklistTab(): void {
  wx.switchTab({ url: '/pages/checklist/checklist' });
}

export function goFeeTab(): void {
  wx.switchTab({ url: '/pages/fee/fee' });
}

export function goHomeTab(): void {
  wx.switchTab({ url: '/pages/index/index' });
}
