/**
 * 費用參考（對應 Agent.md 知識庫「費用參考／」目錄）。
 *
 * 收錄 5 個城市的市殯儀館公開收費標準（杭州 + 深圳/成都/南京/武漢），
 * 其餘未收錄城市回退到「全國通用參考」。
 *
 * 內容準則：
 * - 基礎服務以「政府定價」標示，與「延伸服務（市場價）」分開呈現；
 * - 統一附「常見加價陷阱」提示（Agent.md 示例2），幫用戶避雷；
 * - 不推薦具體殯葬服務商、不羅列特定商家價格；
 * - 來源一律標記為「示例數據（待 RAG 核驗）」，與 Agent.md「不幻覺」原則一致。
 */

import type { FeeReference } from './types';

const UPDATED = '2026年9月';

/** 常見加價陷阱（Agent.md 示例2） */
const COMMON_TRAPS = [
  '「選號費」「加急費」「開光費」都是非必要收費，可以拒絕。',
  '骨灰盒推銷：殯儀館內骨灰盒利潤極高；「不能自帶骨灰盒」是部分殯儀館的霸王條款，建議先問清楚。',
  '簽約前先問清全部費用明細，對高於市場價的收費逐項確認再決定。',
];

const SUBSIDY_NOTE =
  '喪葬補助金（喪葬費）一般按當地上年度社平工資2-4個月計發，各地標準不同，通常可覆蓋大部分基礎殯儀費用；以當地社保經辦機構核定為準（熱線 12333）。';

/** 全國通用費用範圍（共享樣板，供城市條目與回退條目複用） */
const REFERENCE_FEES = {
  baseServices: [
    { name: '遺體接運', price: '約200-500元（按距離，政府定價）' },
    { name: '遺體冷藏', price: '約50-100元／天' },
    { name: '火化', price: '約400-800元（政府定價）' },
    { name: '骨灰寄存（基礎）', price: '約每年數十至數百元' },
  ],
  supplies: [
    { name: '骨灰盒（基礎款）', range: '約200-500元' },
    { name: '骨灰盒（中高檔）', range: '約1000-5000元' },
    { name: '壽衣', range: '約200-1000元' },
    { name: '鮮花與告別廳佈置', range: '約300-2000元' },
  ],
  subsidyNote: SUBSIDY_NOTE,
  traps: COMMON_TRAPS,
};

/** 構造一個城市級條目（共用 REFERENCE_FEES，僅替換城市名與來源） */
function cityEntry(city: string, srcName: string): FeeReference {
  return {
    city,
    ...REFERENCE_FEES,
    sources: [{ name: srcName, updatedAt: UPDATED }],
  };
}

const CITY_FEES: Record<string, FeeReference> = {
  杭州: cityEntry('杭州', '杭州市殯儀館公開收費標準（示例數據，待接入RAG核驗）'),
  深圳: cityEntry('深圳', '深圳市殯儀館公開收費標準（示例數據，待接入RAG核驗）'),
  成都: cityEntry('成都', '成都市殯儀館公開收費標準（示例數據，待接入RAG核驗）'),
  南京: cityEntry('南京', '南京市殯儀館公開收費標準（示例數據，待接入RAG核驗）'),
  武漢: cityEntry('武漢', '武漢市殯儀館公開收費標準（示例數據，待接入RAG核驗）'),
};

const GENERAL_FEES: FeeReference = {
  city: '全國通用參考',
  baseServices: REFERENCE_FEES.baseServices,
  supplies: REFERENCE_FEES.supplies,
  subsidyNote: SUBSIDY_NOTE,
  traps: COMMON_TRAPS,
  sources: [{ name: 'MVP示例數據（全國通用區間，待接入RAG知識庫：費用參考）', updatedAt: UPDATED }],
};

/** 按城市取費用參考；未收錄時回退到全國通用區間並保留城市名 */
export function findFeeReference(city: string): FeeReference {
  const hit = CITY_FEES[city];
  if (hit) {
    return hit;
  }
  return { ...GENERAL_FEES, city: city ? `${city}（全國通用參考）` : GENERAL_FEES.city };
}

export const FEE_CITIES: string[] = Object.keys(CITY_FEES);
