/**
 * 個人資料頁（實名證件管理）
 *
 * 單分區列表：乘車人簿（src/storage/passenger），點行進編輯，
 * 證號一律脫敏展示（maskIdNo）。
 *
 * 本頁只做列表展示與導航；增刪改校驗全部下沉編輯頁與數據層。
 * onShow 刷新：從編輯頁返回後即時反映最新簿內容。
 */

import { listPassengers, maskIdNo } from '../../src/storage/passenger';

/** 乘車人列表行（脫敏後的展示形態） */
interface PassengerRow {
  id: string;
  name: string;
  idNoMasked: string;
  isDefault: boolean;
}

/** 頁面資料結構 */
interface ProfilePageData {
  passengers: PassengerRow[];
  [key: string]: unknown;
}

/** Page 內部 this 實例 */
interface ProfilePageThis {
  data: ProfilePageData;
  setData: (patch: Partial<ProfilePageData>) => void;
  onShow: () => void;
  onAddPassenger: () => void;
  onTapPassenger: (e: { currentTarget?: { dataset?: { id?: string } } }) => void;
}

Page({
  data: {
    passengers: [],
  } as ProfilePageData,

  /** 每次現身刷新乘車人簿（編輯頁保存 / 刪除返回後即時同步） */
  onShow(this: ProfilePageThis): void {
    this.setData({
      passengers: listPassengers().map((p) => ({
        id: p.id,
        name: p.name,
        idNoMasked: maskIdNo(p.idNo),
        isDefault: p.isDefault,
      })),
    });
  },

  /** 新增乘車人（無參進入編輯頁新增態） */
  onAddPassenger(this: ProfilePageThis): void {
    wx.navigateTo({ url: '/pages/passenger-edit/index' });
  },

  /** 編輯乘車人（列表行點擊，攜 id 進編輯態） */
  onTapPassenger(this: ProfilePageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const id = e.currentTarget?.dataset?.id ?? '';
    if (!id) return;
    wx.navigateTo({ url: `/pages/passenger-edit/index?id=${id}` });
  },
} as unknown as Parameters<typeof Page>[0]);
