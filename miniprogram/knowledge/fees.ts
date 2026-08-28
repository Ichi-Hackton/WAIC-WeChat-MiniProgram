/**
 * 費用參考示例數據（對應 Agent.md 知識庫「費用參考／」目錄）。
 *
 * 基礎服務（政府定價）與用品區間引用 Agent.md 中杭州市殯儀館公開收費標準示例；
 * 未收錄的城市返回全國通用區間，並明確標註「以當地實際收費為準」。
 */

import type { FeeReference } from './types';

const HANGZHOU_SRC = [
  { name: '杭州市殯儀館公開收費標準（示例數據，待接入RAG核驗）', updatedAt: '2026年8月' },
];

const GENERAL_SRC = [
  { name: 'MVP示例數據（全國通用區間，待接入RAG知識庫：費用參考）', updatedAt: '2026年8月' },
];

/** 常見加價陷阱（Agent.md 示例2） */
const COMMON_TRAPS = [
  '「選號費」「加急費」「開光費」都是非必要收費，可以拒絕。',
  '骨灰盒推銷：殯儀館內骨灰盒利潤極高；「不能自帶骨灰盒」是部分殯儀館的霸王條款，建議先問清楚。',
  '簽約前先問清全部費用明細，對高於市場價的收費逐項確認再決定。',
];

const SUBSIDY_NOTE =
  '喪葬補助金（喪葬費）一般按當地上年度社平工資2-4個月計發，各地標準不同，通常可覆蓋大部分基礎殯儀費用；以當地社保經辦機構核定為準（熱線12333）。';

const CITY_FEES: Record<string, FeeReference> = {
  杭州: {
    city: '杭州',
    baseServices: [
      { name: '遺體接運', price: '約200-400元（按距離，政府定價）' },
      { name: '遺體冷藏', price: '約50-80元／天' },
      { name: '火化', price: '約400-600元（政府定價）' },
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
    sources: HANGZHOU_SRC,
  },
};

/** 全國通用區間（未收錄城市的回退數據） */
const GENERAL_FEES: FeeReference = {
  city: '全國通用參考',
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
  sources: GENERAL_SRC,
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
