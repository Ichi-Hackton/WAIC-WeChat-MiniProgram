/**
 * 費用參考（Agent.md「流程三：費用查詢」）。
 * 基礎服務（政府定價）→ 用品區間 → 喪葬補助 → ⚠️常見加價陷阱 → 地區聯辦提示。
 * 數據經 services/knowledge 異步加載（RAG 對接預留）。
 */
import type { CityPolicy, FeeReference } from '../../knowledge';
import { POLICY_CITIES } from '../../knowledge';
import { fetchCityPolicy, fetchFeeReference } from '../../services/knowledge';
import { goDetail } from '../../services/navigation';
import { toast } from '../../services/feedback';

Page({
  data: {
    cities: POLICY_CITIES,
    activeCity: '',
    loading: true,
    fee: null as FeeReference | null,
    policy: null as CityPolicy | null,
  },

  onLoad() {
    void this.pickCity(this.data.cities[0] || '杭州');
  },

  async pickCity(city: string) {
    this.setData({ loading: true, activeCity: city });
    try {
      const [fee, policy] = await Promise.all([
        fetchFeeReference(city),
        fetchCityPolicy(city),
      ]);
      this.setData({ loading: false, fee, policy });
    } catch (_e) {
      this.setData({ loading: false });
      toast('加載失敗，請重試', 'none');
    }
  },

  onPickCity(e: WechatMiniprogram.TouchEvent) {
    const { city } = e.currentTarget.dataset as { city: string };
    if (city && city !== this.data.activeCity) {
      void this.pickCity(city);
    }
  },

  onSubsidyGuide() {
    goDetail('subsidy');
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return {
      title: '殯儀館費用參考與加價陷阱，轉給需要的家人',
      path: '/pages/index/index',
    };
  },
});
