/**
 * 個人資料頁（實名證件 + 收貨地址；2026-10 恢復雙分區）
 *
 * 雙分區列表：乘車人簿（src/storage/passenger）+ 地址簿
 * （src/storage/address），點行進編輯；證號 / 手機號一律脫敏展示。
 *
 * 地址簿的出發城市職責：默認地址市級為 Agent 出發城市第一優先級
 * （地址簿 > 定位 > 追問，見 core/context.ts fetchLocation）。
 * 空簿提供「一鍵帶入微信地址」直存入口（表單頁的導入僅回填）。
 *
 * 本頁只做列表展示與導航；增刪改校驗全部下沉編輯頁與數據層。
 * onShow 刷新：從編輯頁返回後即時反映最新簿內容。
 */

import { listPassengers, maskIdNo } from '../../src/storage/passenger';
import {
  listAddresses,
  addAddress,
  validateAddressForm,
  fromWechatAddress,
} from '../../src/storage/address';
import { pickWechatAddress } from '../../src/services/address';

/** 乘車人列表行（脫敏後的展示形態） */
interface PassengerRow {
  id: string;
  name: string;
  idNoMasked: string;
  isDefault: boolean;
}

/** 地址列表行（脫敏後的展示形態） */
interface AddressRow {
  id: string;
  receiverName: string;
  phoneMasked: string;
  regionLine: string;
  detail: string;
  isDefault: boolean;
}

/** 頁面資料結構 */
interface ProfilePageData {
  passengers: PassengerRow[];
  addresses: AddressRow[];
  [key: string]: unknown;
}

/** Page 內部 this 實例 */
interface ProfilePageThis {
  data: ProfilePageData;
  setData: (patch: Partial<ProfilePageData>) => void;
  onShow: () => void;
  onAddPassenger: () => void;
  onTapPassenger: (e: { currentTarget?: { dataset?: { id?: string } } }) => void;
  onAddAddress: () => void;
  onTapAddress: (e: { currentTarget?: { dataset?: { id?: string } } }) => void;
  onTapImportAddress: () => void;
}

/** 手機號脫敏（列表展示用）：保留前 3 位與後 4 位 */
function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;
}

Page({
  data: {
    passengers: [],
    addresses: [],
  } as ProfilePageData,

  /** 每次現身刷新兩簿（編輯頁保存 / 刪除返回後即時同步） */
  onShow(this: ProfilePageThis): void {
    this.setData({
      passengers: listPassengers().map((p) => ({
        id: p.id,
        name: p.name,
        idNoMasked: maskIdNo(p.idNo),
        isDefault: p.isDefault,
      })),
      addresses: listAddresses().map((a) => ({
        id: a.id,
        receiverName: a.receiverName,
        phoneMasked: maskPhone(a.phone),
        regionLine: `${a.province} ${a.city} ${a.district}`,
        detail: a.detail,
        isDefault: a.isDefault,
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

  /** 新增地址（無參進入編輯頁新增態） */
  onAddAddress(this: ProfilePageThis): void {
    wx.navigateTo({ url: '/pages/address-edit/index' });
  },

  /** 編輯地址（列表行點擊，攜 id 進編輯態） */
  onTapAddress(this: ProfilePageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const id = e.currentTarget?.dataset?.id ?? '';
    if (!id) return;
    wx.navigateTo({ url: `/pages/address-edit/index?id=${id}` });
  },

  /**
   * 空簿一鍵帶入微信地址：導入即存（與表單頁僅回填不同——空簿場景
   * 用戶意圖明確，直接落盤最快建立出發城市來源；首條自動設默認）。
   *
   * 微信地址缺必填欄位時（暱稱含數字 / 詳址過短等），攜草稿導去表單
   * 頁補全（EventChannel 傳遞，URL query 不承載中文長文本），
   * 避免「提示補全卻開了張空表單」造成導入內容丢失。
   */
  async onTapImportAddress(this: ProfilePageThis): Promise<void> {
    const picked = await pickWechatAddress();
    if (!picked) {
      wx.showToast({ title: '未獲取到微信地址（可在授權設置中開啟後重試）', icon: 'none' });
      return;
    }
    const input = fromWechatAddress(picked);
    const err = validateAddressForm(input);
    if (err) {
      wx.showToast({ title: '微信地址信息不完整，已為你帶入表單', icon: 'none' });
      wx.navigateTo({
        url: '/pages/address-edit/index',
        success: (res) => res.eventChannel.emit('address:draft', input),
      });
      return;
    }
    const added = addAddress(input);
    if (!added) {
      wx.showToast({ title: '地址數量已達上限', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已帶入並設為默認', icon: 'success' });
    this.onShow();
  },
} as unknown as Parameters<typeof Page>[0]);
