/**
 * 地區政策示例數據（對應 Agent.md 知識庫「地區政策／」目錄）。
 *
 * 差異點：是否支持「身後一件事」聯辦、聯辦入口、注意事項。
 * MVP 收錄四個城市，未收錄城市回退到通用指引。
 */

import type { CityPolicy } from './types';

const SRC = [{ name: 'MVP示例數據（待接入RAG知識庫：地區政策）', updatedAt: '2026年8月' }];

const HOTLINES = [{ label: '政務服務熱線', number: '12345' }];

const CITY_POLICIES: Record<string, CityPolicy> = {
  杭州: {
    city: '杭州',
    oneStop: true,
    oneStopChannel: '「浙里辦」App／支付寶「浙里辦」小程序搜索「身後一件事」',
    summary: '杭州支持「身後一件事」聯辦：死亡證明後續的戶籍註銷、社保醫保結算、補助申領等可一站式申請。',
    notes: [
      '殯儀館基礎服務為政府定價（見「費用參考」），預約時可要求出示收費明細。',
      '各區縣窗口材料要求可能略有差異，前往前建議先撥打12345確認。',
    ],
    hotlines: HOTLINES,
    sources: SRC,
  },
  北京: {
    city: '北京',
    oneStop: true,
    oneStopChannel: '北京市政務服務網／「京通」小程序搜索「身後一件事」',
    summary: '北京支持「身後一件事」聯辦，可一站式辦理戶籍註銷、社保醫保及補助相關事項。',
    notes: ['各區政務服務大廳均設綜合窗口，材料以窗口要求為準。'],
    hotlines: HOTLINES,
    sources: SRC,
  },
  上海: {
    city: '上海',
    oneStop: true,
    oneStopChannel: '「隨申辦」App／小程序搜索「身後一件事」',
    summary: '上海支持「身後一件事」聯辦，家屬可在線發起多部門事項聯合辦理。',
    notes: ['殯儀館服務可通過殯葬服務平台預約，注意核對政府定價項目。'],
    hotlines: HOTLINES,
    sources: SRC,
  },
  廣州: {
    city: '廣州',
    oneStop: true,
    oneStopChannel: '「粵省事」小程序搜索身後事相關聯辦服務',
    summary: '廣州可通過「粵省事」辦理身後事相關事項的預約與申請。',
    notes: ['部分事項仍需線下核驗原件，前往前建議先撥打12345確認。'],
    hotlines: HOTLINES,
    sources: SRC,
  },
};

const GENERAL_POLICY: CityPolicy = {
  city: '通用指引',
  oneStop: false,
  oneStopChannel: '',
  summary:
    '暫未收錄該城市的聯辦信息。多數事項需分別前往派出所、社保經辦機構、公積金中心辦理；可先撥打12345詢問當地是否有「身後一件事」聯辦服務。',
  notes: [
    '城鎮與農村流程可能有差異（如土葬政策、村委會角色），農村戶籍建議同步諮詢村委會。',
    '前往任何窗口前，先電話確認材料清單，避免白跑一趟。',
  ],
  hotlines: HOTLINES,
  sources: SRC,
};

export function findCityPolicy(city: string): CityPolicy | null {
  if (!city) {
    return null;
  }
  return CITY_POLICIES[city] || { ...GENERAL_POLICY, city: `${city}（通用指引）` };
}

export const POLICY_CITIES: string[] = Object.keys(CITY_POLICIES);
