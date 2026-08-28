/**
 * 撥號服務（wx API 唯一入口）：熱線一鍵撥打。
 */

export function callPhone(number: string): void {
  wx.makePhoneCall({
    phoneNumber: number,
    fail: () => {
      // 用戶取消撥打屬正常行為，靜默處理
    },
  });
}
