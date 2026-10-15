/**
 * 新增 / 編輯收貨地址頁（2026-10 恢復落地）
 *
 * 視覺系統與乘車人編輯頁一致（侘寂極簡：米白基底 + hairline 分隔 + 襯線標籤）。
 *
 * 兩種進入形態：
 *   - 新增態：/pages/address-edit/index（個人資料頁「新增」入口）
 *   - 編輯態：/pages/address-edit/index?id=addr_xxx（個人資料頁列表行傳入，
 *     標題切換為「編輯收貨地址」，保存走 updateAddress，另提供刪除入口）
 *
 * 一鍵帶入微信地址：wx.chooseAddress 原生選擇器拉起後回填表單
 * （services/address 封裝 → storage/address 的 fromWechatAddress 映射），
 * 僅回填不落盤——由用戶檢查後主動保存；回填後表單上方常駐
 * 「尚未保存」提示條（防誤解為已保存直接返回丟失，2026-10 反饋修復）。
 *
 * 草稿接收：profile 空簿一鍵帶入遇欄位不完整時，經 EventChannel
 * （事件 'address:draft'）攜 AddressFormInput 草稿跳入本頁補全。
 *
 * 與 src/storage/address 的關係：本頁只做表單狀態與交互，
 * 校驗 / 持久化 / 默認唯一性維護全部下沉數據層。
 */

import {
  addAddress,
  getAddress,
  updateAddress,
  removeAddress,
  validateAddressForm,
  fromWechatAddress,
  ADDRESS_LIMIT,
} from '../../src/storage/address';
import type { AddressFormInput } from '../../src/storage/address';
import { pickWechatAddress } from '../../src/services/address';

/** 頁面資料結構 */
interface AddressEditPageData {
  /** 收貨人姓名 */
  receiverName: string;
  /** 11 位手機號 */
  phone: string;
  /** 省市區三段（region picker 綁定值） */
  region: string[];
  /** 詳細地址 */
  detail: string;
  /** 設為默認地址 */
  isDefault: boolean;
  /** 已帶入微信地址但尚未保存（表單上方常駐提示條的顯示開關） */
  imported: boolean;
  /** 編輯態標記（切換標題 / 保存文案 / 顯示刪除按鈕） */
  editing: boolean;
  [key: string]: unknown;
}

/** Page 內部 this 實例 */
interface AddressEditPageThis {
  data: AddressEditPageData;
  setData: (patch: Partial<AddressEditPageData>) => void;
  /** 編輯態地址 ID（新增態為空串） */
  editId: string;
  /** 頁面間事件通道（接收 profile 攜草稿跳入；基礎庫 2.7.3+） */
  getOpenerEventChannel?: () => EventChannel;
  onLoad: (options: { id?: string } | undefined) => void;
  onNameInput: (e: { detail: { value: string } }) => void;
  onPhoneInput: (e: { detail: { value: string } }) => void;
  onRegionChange: (e: { detail: { value: string[] } }) => void;
  onDetailInput: (e: { detail: { value: string } }) => void;
  onDefaultChange: (e: { detail: { value: boolean } }) => void;
  onTapImportAddress: () => void;
  onTapSave: () => void;
  onTapRemove: () => void;
}

Page({
  data: {
    receiverName: '',
    phone: '',
    region: [],
    detail: '',
    isDefault: false,
    imported: false,
    editing: false,
  } as AddressEditPageData,

  onLoad(this: AddressEditPageThis, options: { id?: string } | undefined): void {
    // profile 空簿導入缺欄位時攜草稿跳入：回填已有內容待用戶補全（優先級低於顯式 id 編輯態）
    const channel =
      typeof this.getOpenerEventChannel === 'function' ? this.getOpenerEventChannel() : null;
    channel?.on('address:draft', (draft) => {
      const d = draft as Partial<AddressFormInput> | undefined;
      if (!d) return;
      this.setData({
        receiverName: d.receiverName ?? '',
        phone: d.phone ?? '',
        region: [d.province ?? '', d.city ?? '', d.district ?? ''],
        detail: d.detail ?? '',
        imported: true,
      });
    });
    const id = typeof options?.id === 'string' ? options.id : '';
    if (!id) return;
    // 編輯態：載入既有地址回填表單；id 無效時提示後返回
    const entry = getAddress(id);
    if (!entry) {
      wx.showToast({ title: '地址不存在，請返回重試', icon: 'none' });
      setTimeout(() => wx.navigateBack({}), 800);
      return;
    }
    this.editId = id;
    wx.setNavigationBarTitle({ title: '編輯收貨地址' });
    this.setData({
      receiverName: entry.receiverName,
      phone: entry.phone,
      region: [entry.province, entry.city, entry.district],
      detail: entry.detail,
      isDefault: entry.isDefault,
      editing: true,
    });
  },

  /** 收貨人輸入（受控） */
  onNameInput(this: AddressEditPageThis, e: { detail: { value: string } }): void {
    this.setData({ receiverName: e.detail.value });
  },

  /** 手機號輸入（number 鍵盤 + maxlength=11） */
  onPhoneInput(this: AddressEditPageThis, e: { detail: { value: string } }): void {
    this.setData({ phone: e.detail.value });
  },

  /** 省市區選擇（region picker 三段聯動） */
  onRegionChange(this: AddressEditPageThis, e: { detail: { value: string[] } }): void {
    this.setData({ region: e.detail.value ?? [] });
  },

  /** 詳細地址輸入（textarea，auto-height） */
  onDetailInput(this: AddressEditPageThis, e: { detail: { value: string } }): void {
    this.setData({ detail: e.detail.value });
  },

  /** 默認地址開關 */
  onDefaultChange(this: AddressEditPageThis, e: { detail: { value: boolean } }): void {
    this.setData({ isDefault: e.detail.value });
  },

  /**
   * 一鍵帶入微信地址：拉起原生選擇器，回填表單（不落盤，由用戶檢查後保存）
   *
   * 取消 / 授權拒絕 / 微信內未填地址均靜默返回（fail 分支歸一 null），
   * 僅授權拒絕場景給出開啟引導提示。回填後亮起「尚未保存」提示條。
   */
  async onTapImportAddress(this: AddressEditPageThis): Promise<void> {
    const picked = await pickWechatAddress();
    if (!picked) {
      wx.showToast({ title: '未獲取到微信地址（可在授權設置中開啟後重試）', icon: 'none' });
      return;
    }
    const form = fromWechatAddress(picked);
    this.setData({
      receiverName: form.receiverName,
      phone: form.phone,
      region: [form.province, form.city, form.district],
      detail: form.detail,
      imported: true,
    });
  },

  /**
   * 保存：校驗 → 新增 / 覆寫 → toast 回饋 → 返回上一頁
   *
   * 校驗文案由 validateAddressForm 統一給出（數據層純函數），
   * 上限（ADDRESS_LIMIT）與默認唯一性等業務規則均在數據層收口。
   * 失敗一律 modal 彈窗（2026-10 反饋修復：toast 短提示易漏看，
   * 用戶誤以為已保存導致「填了卻沒存」；成功信號 = 綠勾 toast + 自動返回）。
   */
  onTapSave(this: AddressEditPageThis): void {
    const [province = '', city = '', district = ''] = this.data.region;
    const input: AddressFormInput = {
      receiverName: this.data.receiverName,
      phone: this.data.phone,
      province,
      city,
      district,
      detail: this.data.detail,
      isDefault: this.data.isDefault,
    };
    const err = validateAddressForm(input);
    if (err) {
      wx.showModal({ title: '無法保存', content: err, showCancel: false, confirmText: '知道了' });
      return;
    }
    if (this.editId) {
      const updated = updateAddress(this.editId, input);
      if (!updated) {
        wx.showModal({
          title: '無法保存',
          content: '地址已被刪除，請返回重試',
          showCancel: false,
          confirmText: '知道了',
        });
        return;
      }
    } else {
      const added = addAddress(input);
      if (!added) {
        wx.showModal({
          title: '無法保存',
          content: `地址數量已達上限（${ADDRESS_LIMIT} 條），請先刪除不再使用的地址`,
          showCancel: false,
          confirmText: '知道了',
        });
        return;
      }
    }
    wx.showToast({ title: this.editId ? '已保存' : '已新增', icon: 'success' });
    setTimeout(() => wx.navigateBack({}), 500);
  },

  /** 刪除（僅編輯態）：modal 確認後下沉數據層，默認刪除後由首條遞補 */
  onTapRemove(this: AddressEditPageThis): void {
    if (!this.editId) return;
    wx.showModal({
      title: '刪除地址',
      content: '刪除後出行規劃將不再自動帶入此出發城市，確定刪除？',
      confirmText: '刪除',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) return;
        removeAddress(this.editId);
        wx.showToast({ title: '已刪除', icon: 'success' });
        setTimeout(() => wx.navigateBack({}), 500);
      },
    });
  },
} as unknown as Parameters<typeof Page>[0]);
