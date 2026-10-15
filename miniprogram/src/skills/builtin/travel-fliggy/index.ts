/**
 * 飛豬旅行 SKILL（skill.travel.fliggy）
 *
 * 規範來源：.qoder/rules/Agent.md § 7
 *
 * 提供能力：
 *   - search_hotels ：結構化酒店搜索（目的地 / 景點 / 日期 / 星級，idempotent）
 *   - ai_search     ：自然語言全域旅行搜索（LLM 生成推薦文本，idempotent）
 *
 * 2026-10-14 國民級 App MCP 接入：飛豬官方 FlyAI MCP
 * （flyai.open.fliggy.com/mcp，HMAC-SHA256 請求簽名）。與麥當勞 / 瑞幸 /
 * 滴滴不同：飛豬內置公共 Key（體驗模式）開箱即真實數據（價格脫敏、
 * 結果受限），無需用戶憑證；正式 Key 由雲端 FLIGGY_API_KEY 配置。
 *
 * 域互斥（rule-planner 側路由約定）：
 *   - 機票 / 航班詞歸 skill.flight（飛豬 MCP 亦有 search_flight，不接入）
 *   - 火車詞歸 skill.train.12306（飛豬 MCP 亦有 search_domestic_train，不接入）
 *   - 酒店域為本 SKILL 獨佔（「酒店 / 住宿 / 民宿 / 客棧 / 訂房」）
 *
 * 只讀查詢域：無下單、無 rollback；降級策略與查詢域慣例一致——雲端
 * 不可用（code<0）時本地 mock 兜底，業務失敗（code>0）如實報錯。
 *
 * 合規紅線（Agent.md § 10）：ai_search 回應為上游 LLM 生成內容，
 * outputSchema 以 aiGenerated=true 標識，卡片渲染必須展示 ai_generated 標記。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';

export interface SearchHotelsInput {
  destName: string;
  poiName?: string;
  keyWords?: string;
  checkInDate?: string;
  checkOutDate?: string;
  /** 星级（"4,5"，逗号分隔） */
  hotelStars?: string;
  /** 床型（大床房 / 双床房 / 多床房） */
  hotelBedTypes?: string;
  /** 类型（酒店 / 民宿 / 客栈） */
  hotelTypes?: string;
  maxPrice?: number;
  sort?: string;
  limit?: number;
}

export interface FliggyHotel {
  name: string;
  address: string;
  priceText: string;
  star: string;
  shId: string;
  detailUrl: string;
  interestsPoi: string;
  rate: string;
}

export interface SearchHotelsOutput {
  hotels: FliggyHotel[];
  notice: string;
  source: string;
}

export interface AiSearchInput {
  query: string;
}

export interface AiSearchOutput {
  answer: string;
  aiGenerated: boolean;
  notice: string;
  source: string;
}

export const meta = {
  id: 'skill.travel.fliggy',
  name: '飛豬旅行',
  description:
    '【能做】結構化酒店搜索（search_hotels：按目的地 / 景點 / 入住日期 / 星級 / 床型 / 價格上限篩選，' +
    '如「杭州西湖附近 4 星酒店，下週五入住兩晚」）、自然語言全域旅行搜索（ai_search：酒店 / 景點 / ' +
    '行程規劃混合意圖，返回 AI 推薦文本與飛豬詳情鏈接）。' +
    '【不能做】不支持在線下單與支付（搜索結果附 detailUrl，預訂在飛豬 App 側完成）、' +
    '不支持機票與火車票查詢（機票歸機票域、火車歸 12306 域）。' +
    '【觸發時機】用戶提到「飛豬」或表達酒店 / 住宿 / 民宿 / 訂房意圖時。' +
    '【數據】飛豬官方商品庫實時數據（體驗模式下價格可能脫敏顯示）。',
  version: '1.0.0',
  owner: 'wx-fliggy-open',
  tags: ['旅行', '酒店'],
  capabilities: [
    {
      action: 'search_hotels',
      description: '按目的地與篩選條件搜索酒店（名稱 / 地址 / 價格 / 星級 / 詳情鏈接）',
      inputSchema: {
        type: 'object',
        required: ['destName'],
        properties: {
          destName: { type: 'string', description: '目的地（國家 / 省 / 市 / 區縣）' },
          poiName: { type: 'string', description: '附近景點名（如「西湖」）' },
          keyWords: { type: 'string', description: '酒店關鍵詞' },
          checkInDate: { type: 'string', description: '入住日期（YYYY-MM-DD）' },
          checkOutDate: { type: 'string', description: '退房日期（YYYY-MM-DD）' },
          hotelStars: { type: 'string', description: '星級 1-5（逗號分隔，如 "4,5"）' },
          hotelBedTypes: { type: 'string', description: '床型：大床房 / 双床房 / 多床房' },
          hotelTypes: { type: 'string', description: '類型：酒店 / 民宿 / 客栈' },
          maxPrice: { type: 'integer', description: '每晚價格上限（元）' },
          sort: { type: 'string', description: '排序（distance_asc / rate_desc / price_asc / price_desc）' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['hotels'],
        properties: {
          hotels: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name'],
              properties: {
                name: { type: 'string' },
                address: { type: 'string' },
                priceText: { type: 'string', description: '價格展示（體驗模式可能脫敏，如 ¥5xx）' },
                star: { type: 'string', description: '檔次（如 舒適型 / 豪華型）' },
                shId: { type: 'string' },
                detailUrl: { type: 'string', description: '飛豬詳情鏈接（預訂入口）' },
                interestsPoi: { type: 'string', description: '鄰近地標' },
              },
            },
          },
          notice: { type: 'string' },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 3000,
    },
    {
      action: 'ai_search',
      description: '自然語言旅行搜索（混合意圖：酒店 / 景點 / 行程；返回 AI 生成推薦文本）',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: '自然語言旅行意圖（如「帶娃去迪士尼有什麼推薦」）' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['answer', 'aiGenerated'],
        properties: {
          answer: { type: 'string', description: 'AI 生成的推薦文本（Markdown）' },
          aiGenerated: { type: 'boolean', description: '恒為 true（合規標識）' },
          notice: { type: 'string' },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 12000,
    },
  ],
} as unknown as SkillMeta;

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    const env = ctx.globals.cloudEnv as string;
    const i = input as Record<string, unknown>;
    switch (action) {
      case 'search_hotels':
        return invokeSearchHotels(env, i as unknown as SearchHotelsInput, ctx.sessionId);
      case 'ai_search':
        return invokeAiSearch(env, i as unknown as AiSearchInput, ctx.sessionId);
      default:
        return {
          success: false,
          error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
        };
    }
  },
};

async function invokeSearchHotels(
  env: string,
  input: SearchHotelsInput,
  sessionId: string,
): Promise<SkillResult<SearchHotelsOutput>> {
  const res: CloudResponse<SearchHotelsOutput> = await postContainer<SearchHotelsOutput>(
    env,
    '/api/skill/skill.travel.fliggy/search_hotels',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲端不可用（負數碼 = 雲基礎設施錯誤）：查詢域本地 mock 兜底
  if (res.code < 0) return { success: true, data: mockHotels(input) };
  return {
    success: false,
    error: { code: 'HOTEL_SEARCH_FAILED', message: res.message ?? '酒店搜索失敗', retryable: true },
  };
}

async function invokeAiSearch(
  env: string,
  input: AiSearchInput,
  sessionId: string,
): Promise<SkillResult<AiSearchOutput>> {
  const res: CloudResponse<AiSearchOutput> = await postContainer<AiSearchOutput>(
    env,
    '/api/skill/skill.travel.fliggy/ai_search',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) return { success: true, data: mockAiAnswer(input) };
  return {
    success: false,
    error: { code: 'AI_SEARCH_FAILED', message: res.message ?? 'AI 搜索失敗', retryable: true },
  };
}

/** 確定性模擬酒店（雲端不可用時的離線演示兜底） */
function mockHotels(input: SearchHotelsInput): SearchHotelsOutput {
  const dest = input.destName;
  const poi = input.poiName ?? '市中心';
  return {
    hotels: [
      { name: `${dest}${poi}精品酒店`, address: `${dest}${poi}步行街 1 號`, priceText: '¥4xx', star: '舒適型', shId: 'mock_1', detailUrl: '', interestsPoi: `近${poi}`, rate: '4.6' },
      { name: `${dest}中心智選假日`, address: `${dest}中心路 88 號`, priceText: '¥3xx', star: '經濟型', shId: 'mock_2', detailUrl: '', interestsPoi: `近${poi}`, rate: '4.4' },
      { name: `${dest}${poi}度假民宿`, address: `${dest}風景區 6 號`, priceText: '¥5xx', star: '豪華型', shId: 'mock_3', detailUrl: '', interestsPoi: `近${poi}`, rate: '4.8' },
    ],
    notice: '本地模擬數據（雲端不可用）',
    source: 'mock_local',
  };
}

/** 確定性模擬 AI 推薦（離線演示兜底；同樣帶 aiGenerated 標識） */
function mockAiAnswer(input: AiSearchInput): AiSearchOutput {
  return {
    answer: `關於「${input.query}」的旅行建議（本地模擬）：\n\n1. 建議先確定出行日期與預算區間\n2. 住宿優先選擇交通便利的連鎖品牌\n3. 熱門景點門票建議提前 1-3 天預訂\n\n（雲端恢復後可獲取飛豬實時推薦）`,
    aiGenerated: true,
    notice: '本地模擬數據（雲端不可用）',
    source: 'mock_local',
  };
}
