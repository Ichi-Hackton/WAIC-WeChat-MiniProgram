/**
 * 新增 / 編輯乘車人頁
 *
 * 視覺系統與地址編輯頁一致（侘寂極簡：米白基底 + hairline 分隔 + 襯線標籤）。
 *
 * 兩種進入形態：
 *   - 新增態：/pages/passenger-edit/index（個人資料頁「新增」入口）
 *   - 編輯態：/pages/passenger-edit/index?id=psg_xxx（個人資料頁列表行傳入，
 *     標題切換為「編輯乘車人」，保存走 updatePassenger，另提供刪除入口）
 *
 * 與 src/storage/passenger 的關係：本頁只做表單狀態與交互，
 * 校驗 / 持久化 / 默認唯一性維護全部下沉數據層。
 */

import {
  addPassenger,
  getPassenger,
  updatePassenger,
  removePassenger,
  validatePassengerForm,
  PASSENGER_LIMIT,
  type PassengerFormInput,
} from '../../src/storage/passenger';

/** 頁面資料結構 */
interface PassengerEditPageData {
  /** 姓名（與證件一致） */
  name: string;
  /** 18 位身份證號（輸入原樣保存，數據層統一末位大寫） */
  idNo: string;
  /** 設為默認乘車人 */
  isDefault: boolean;
  /** 編輯態標記（切換標題 / 保存文案 / 顯示刪除按鈕） */
  editing: boolean;
  [key: string]: unknown;
}

/** Page 內部 this 實例 */
interface PassengerEditPageThis {
  data: PassengerEditPageData;
  setData: (patch: Partial<PassengerEditPageData>) => void;
  /** 編輯態乘車人 ID（新增態為空串） */
  editId: string;
  onLoad: (options: { id?: string } | undefined) => void;
  onNameInput: (e: { detail: { value: string } }) => void;
  onIdNoInput: (e: { detail: { value: string } }) => void;
  onDefaultChange: (e: { detail: { value: boolean } }) => void;
  onTapSave: () => void;
  onTapRemove: () => void;
}

Page({
  data: {
    name: '',
    idNo: '',
    isDefault: false,
    editing: false,
  } as PassengerEditPageData,

  onLoad(this: PassengerEditPageThis, options: { id?: string } | undefined): void {
    const id = typeof options?.id === 'string' ? options.id : '';
    if (!id) return;
    // 編輯態：載入既有乘車人回填表單；id 無效時提示後返回
    const entry = getPassenger(id);
    if (!entry) {
      wx.showToast({ title: '乘車人不存在，請返回重試', icon: 'none' });
      setTimeout(() => wx.navigateBack({}), 800);
      return;
    }
    this.editId = id;
    wx.setNavigationBarTitle({ title: '編輯乘車人' });
    this.setData({
      name: entry.name,
      idNo: entry.idNo,
      isDefault: entry.isDefault,
      editing: true,
    });
  },

  /** 姓名輸入（受控） */
  onNameInput(this: PassengerEditPageThis, e: { detail: { value: string } }): void {
    this.setData({ name: e.detail.value });
  },

  /** 證號輸入（idcard 鍵盤 + maxlength=18） */
  onIdNoInput(this: PassengerEditPageThis, e: { detail: { value: string } }): void {
    this.setData({ idNo: e.detail.value });
  },

  /** 默認乘車人開關 */
  onDefaultChange(this: PassengerEditPageThis, e: { detail: { value: boolean } }): void {
    this.setData({ isDefault: e.detail.value });
  },

  /**
   * 保存：校驗 → 新增 / 覆寫 → toast 回饋 → 返回上一頁
   *
   * 校驗文案由 validatePassengerForm 統一給出（數據層純函數），
   * 上限（PASSENGER_LIMIT）與默認唯一性等業務規則均在數據層收口。
   */
  onTapSave(this: PassengerEditPageThis): void {
    const input: PassengerFormInput = {
      name: this.data.name,
      idNo: this.data.idNo,
      isDefault: this.data.isDefault,
    };
    const err = validatePassengerForm(input);
    if (err) {
      wx.showToast({ title: err, icon: 'none' });
      return;
    }
    if (this.editId) {
      const updated = updatePassenger(this.editId, input);
      if (!updated) {
        wx.showToast({ title: '乘車人已被刪除，請返回重試', icon: 'none' });
        return;
      }
    } else {
      const added = addPassenger(input);
      if (!added) {
        wx.showToast({ title: `乘車人數量已達上限（${PASSENGER_LIMIT} 人）`, icon: 'none' });
        return;
      }
    }
    wx.showToast({ title: this.editId ? '已保存' : '已新增', icon: 'success' });
    setTimeout(() => wx.navigateBack({}), 500);
  },

  /** 刪除（僅編輯態）：modal 確認後下沉數據層，默認刪除後由首條遞補 */
  onTapRemove(this: PassengerEditPageThis): void {
    if (!this.editId) return;
    wx.showModal({
      title: '刪除乘車人',
      content: '刪除後購票將不再自動帶入此人，確定刪除？',
      confirmText: '刪除',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        removePassenger(this.editId);
        wx.showToast({ title: '已刪除', icon: 'success' });
        setTimeout(() => wx.navigateBack({}), 500);
      },
    });
  },
} as unknown as Parameters<typeof Page>[0]);
