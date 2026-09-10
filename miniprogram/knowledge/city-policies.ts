/**
 * 地區政策（對應 Agent.md 知識庫「地區政策／」目錄）。
 *
 * 收錄 8 個城市（北京/上海/廣州/杭州/深圳/成都/南京/武漢），未收錄城市回退到「通用指引」。
 *
 * 內容準則：
 * - 只記錄公開可查的聯辦入口與注意事項，不羅列窗口電話等易變信息；
 * - 統一推薦 12345 作為預問入口，與 Agent.md「用戶教育」原則一致；
 * - 不介入地域歧視、不評判各城市流程優劣；
 * - 來源一律標記為「MVP 示例數據（待 RAG 核驗）」，與 Agent.md「不幻覺」原則一致。
 */

import type { CityPolicy } from './types';

const SRC = [{ name: 'MVP示例數據（待接入RAG知識庫：地區政策）', updatedAt: '2026年9月' }];
const HOTLINES = [{ label: '政務服務熱線', number: '12345' }];

const CITY_POLICIES: Record<string, CityPolicy> = {
  杭州: {
    city: '杭州',
    oneStop: true,
    oneStopChannel: '「浙里辦」App／支付寶「浙里辦」小程序搜索「身後一件事」',
    summary: '杭州支持「身後一件事」聯辦：死亡證明後續的戶籍註銷、社保醫保結算、補助申領等可一站式申請。',
    notes: [
      '殯儀館基礎服務為政府定價（見「費用參考」），預約時可要求出示收費明細。',
      '各區縣窗口材料要求可能略有差異，前往前建議先撥打 12345 確認。',
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
    notes: ['部分事項仍需線下核驗原件，前往前建議先撥打 12345 確認。'],
    hotlines: HOTLINES,
    sources: SRC,
  },
  深圳: {
    city: '深圳',
    oneStop: true,
    oneStopChannel: '「i 深圳」App／「粵省事」小程序搜索「身後一件事」',
    summary: '深圳支持「身後一件事」聯辦，戶籍註銷、社保醫保結算、補助申領等可在線發起；因毗鄰港澳，涉港澳台及外籍人士後事有專門指引。',
    notes: [
      '作為移民城市，逝者家屬可能遍佈全國甚至海外，建議儘早委託一名在深親友代為跑流程。',
      '大灣區試點城市之一，部分事項可跨城辦理，具體清單以聯辦頁面提示為準。',
      '前往任何窗口前，先撥打 12345 確認材料清單。',
    ],
    hotlines: HOTLINES,
    sources: SRC,
  },
  成都: {
    city: '成都',
    oneStop: true,
    oneStopChannel: '「天府市民雲」App／四川政務服務網搜索「身後一件事」',
    summary: '成都支持「身後一件事」聯辦，少數民族（藏、彝等）安葬政策有專門對接，符合條件者按習俗辦理。',
    notes: [
      '西部中心城市，少數民族安葬需提前與當地民政部門對接政策。',
      '成都市殯儀館提供多檔次服務，預約時主動詢問政府定價項目。',
      '前往窗口前先撥打 12345 確認材料清單。',
    ],
    hotlines: HOTLINES,
    sources: SRC,
  },
  南京: {
    city: '南京',
    oneStop: true,
    oneStopChannel: '「江蘇政務服務」App／小程序搜索「身後一件事」',
    summary: '南京支持「身後一件事」聯辦，江蘇省內聯辦推廣較早，多個區縣已實現一窗受理。',
    notes: [
      '南京各區政務中心均設綜合窗口，材料以窗口要求為準。',
      '蘇南地區殯儀館基礎服務為政府定價，預約時可要求出示收費明細。',
      '前往窗口前先撥打 12345 確認材料清單。',
    ],
    hotlines: HOTLINES,
    sources: SRC,
  },
  武漢: {
    city: '武漢',
    oneStop: true,
    oneStopChannel: '「鄂匯辦」App／湖北政務服務網搜索「身後一件事」',
    summary: '武漢支持「身後一件事」聯辦，市級與區級綜合窗口分工清晰。',
    notes: [
      '作為中部中心城市，跨省辦理事項相對便捷。',
      '武漢市殯儀館政府定價服務基礎，可提前電話預約。',
      '前往窗口前先撥打 12345 確認材料清單。',
    ],
    hotlines: HOTLINES,
    sources: SRC,
  },
};

const GENERAL_POLICY: CityPolicy = {
  city: '通用指引',
  oneStop: false,
  oneStopChannel: '',
  summary:
    '暫未收錄該城市的聯辦信息。多數事項需分別前往派出所、社保經辦機構、公積金中心辦理；可先撥打 12345 詢問當地是否有「身後一件事」聯辦服務。',
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
