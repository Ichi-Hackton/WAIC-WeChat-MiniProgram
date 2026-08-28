/**
 * 剪貼板服務（wx API 唯一入口）：用於「一鍵複製」家庭協作清單。
 */

export function copyText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.setClipboardData({
      data: text,
      success: () => resolve(),
      fail: (err) => reject(err),
    });
  });
}
