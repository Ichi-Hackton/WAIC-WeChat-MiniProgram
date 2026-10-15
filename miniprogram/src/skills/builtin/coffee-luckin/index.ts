/**
 * 瑞幸咖啡 SKILL（skill.coffee.luckin）
 *
 * 規範來源：.qoder/rules/Agent.md § 7
 *
 * 提供能力：
 *   - search_luckin_store   ：按位置查附近瑞幸門店（idempotent）
 *   - search_luckin_product ：門店內自然語言搜商品（idempotent）
 *   - place_luckin_order    ：點單（真實訂單！需確認後執行，reversible）
 *   - place_luckin_order/cancel 為 rollback 通道（非獨立 capability）
 *
 * 2026-10-14 國民級 App MCP 接入：瑞幸官方 AI 開放平台
 * （gwmcp.lkcoffee.com，Streamable HTTP + Bearer Token）提供真實
 * createOrder 能力——訂單在 Token 持有人本人瑞幸賬號創建，支付由
 * 用戶掃 payOrderUrl 二維碼自行完成（官方明令：下單前必須向用戶
 * 復述門店、商品、價格並獲得明確同意）。
 *
 * requiresHumanConfirm 判定（Agent.md § 7.1 第 4 條例外條款）：
 * place_luckin_order 設 true——上游 Skill 說明明令「下單前向用戶
 * 復述並獲得明確同意」，且訂單掛在用戶本人賬號（優惠券權益變動），
 * 屬「支付前置的不可逆場景」，重啟 checkpoint 彈窗承擔確認職責。
 *
 * 降級策略（與雲端兩層設計對齊）：查詢域雲端不可用（code<0）時本地
 * mock 兜底；下單在 Token 未配置時雲端降級為 copy-only 跳轉需求卡
 * （真實點單在瑞幸小程序側完成），雲基礎設施不可用時本地亦生成
 * 同構跳轉卡——與星巴克 place_order 的跳轉模式完全同構。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta, JumpPackage } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';
import { error as logError } from '../../../utils/logger';

export interface SearchStoreInput {
  /** 用戶定位（GCJ-02；瑞幸上游以經緯度查店，無城市搜索模式） */
  lat: number;
  lng: number;
  city?: string;
  limit?: number;
}

export interface LuckinStore {
  deptId: string;
  name: string;
  address: string;
  distanceM: number;
}

export interface SearchStoreOutput {
  stores: LuckinStore[];
  source: string;
}

export interface SearchProductInput {
  deptId: string;
  query: string;
  limit?: number;
}

export interface LuckinProduct {
  productId: string;
  skuCode: string;
  name: string;
  priceText: string;
}

export interface SearchProductOutput {
  products: LuckinProduct[];
  source: string;
}

export interface PlaceOrderInput {
  deptId: string;
  items: Array<{ productId: string; skuCode: string; name: string; quantity: number }>;
  /** 從 search 任務注入的 bindings */
  storeName?: string;
  lng?: number;
  lat?: number;
}

export interface PlaceOrderOutput {
  orderId: string;
  upstreamOrderId?: string;
  status: 'pending_external';
  payOrderUrl?: string;
  items: Array<{ productId?: string; skuCode?: string; name?: string; quantity?: number }>;
  jump?: JumpPackage;
  note?: string;
  source: string;
}

export const meta = {
  id: 'skill.coffee.luckin',
  name: '瑞幸咖啡',
  description:
    '【能做】查詢附近瑞幸門店（search_luckin_store）、門店內搜商品與價格（search_luckin_product，如生椰拿鐵）、' +
    '確認後在本人瑞幸賬號真實下單（place_luckin_order，返回支付二維碼鏈接，掃碼支付後到店自取）、' +
    '取消未支付訂單（rollback 通道）。' +
    '【不能做】不支持外送配送（僅到店自取）、不能代用戶支付、已支付訂單不可由本端取消。' +
    '【觸發時機】用戶提到「瑞幸/生椰拿鐵/橙C美式」並表達查店或點單意圖時（提到「星巴克」歸星巴克域）。' +
    '【注意】下單會消耗本人瑞幸賬號優惠券，必須先確認。',
  version: '1.0.0',
  owner: 'wx-luckin-open',
  tags: ['餐飲', '咖啡'],
  capabilities: [
    {
      action: 'search_luckin_store',
      description: '按用戶位置查詢附近瑞幸門店',
      inputSchema: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number', description: '緯度（GCJ-02）' },
          lng: { type: 'number', description: '經度（GCJ-02）' },
          city: { type: 'string', description: '城市名（展示用）' },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['stores'],
        properties: {
          stores: {
            type: 'array',
            items: {
              type: 'object',
              required: ['deptId', 'name'],
              properties: {
                deptId: { type: 'string', description: '門店 ID（下單必傳）' },
                name: { type: 'string' },
                address: { type: 'string' },
                distanceM: { type: 'number' },
              },
            },
          },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1500,
    },
    {
      action: 'search_luckin_product',
      description: '在指定門店內按關鍵詞搜商品（名稱、規格、價格）',
      inputSchema: {
        type: 'object',
        required: ['deptId', 'query'],
        properties: {
          deptId: { type: 'string', description: 'search_luckin_store 結果的 deptId' },
          query: { type: 'string', description: '商品關鍵詞（如「生椰拿鐵」「美式」）' },
          limit: { type: 'integer', minimum: 1, maximum: 10 },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['products'],
        properties: {
          products: {
            type: 'array',
            items: {
              type: 'object',
              required: ['productId', 'name'],
              properties: {
                productId: { type: 'string', description: '商品 ID（下單必傳）' },
                skuCode: { type: 'string', description: 'SKU 編碼（下單必傳）' },
                name: { type: 'string' },
                priceText: { type: 'string', description: '價格展示（如 ¥18.00）' },
              },
            },
          },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1500,
    },
    {
      action: 'place_luckin_order',
      description: '在指定門店下單（本人瑞幸賬號真實訂單；需確認，返回支付二維碼鏈接）',
      inputSchema: {
        type: 'object',
        required: ['deptId', 'items'],
        properties: {
          deptId: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['productId', 'skuCode', 'quantity'],
              properties: {
                productId: { type: 'string' },
                skuCode: { type: 'string' },
                name: { type: 'string' },
                quantity: { type: 'integer', minimum: 1 },
              },
            },
          },
          storeName: { type: 'string' },
          lng: { type: 'number' },
          lat: { type: 'number' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['orderId', 'status'],
        properties: {
          orderId: { type: 'string' },
          payOrderUrl: { type: 'string', description: '支付二維碼鏈接（掃碼支付）' },
          status: { type: 'string' },
        },
      },
      idempotent: false,
      reversible: true,
      requiresHumanConfirm: true,
      estimatedLatencyMs: 2500,
    },
  ],
} as unknown as SkillMeta;

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    const env = ctx.globals.cloudEnv as string;
    const i = input as Record<string, unknown>;
    switch (action) {
      case 'search_luckin_store':
        return invokeSearchStore(env, i as unknown as SearchStoreInput, ctx.sessionId);
      case 'search_luckin_product':
        return invokeSearchProduct(env, i as unknown as SearchProductInput, ctx.sessionId);
      case 'place_luckin_order':
        return invokePlace(env, i as unknown as PlaceOrderInput, ctx.sessionId);
      default:
        return {
          success: false,
          error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
        };
    }
  },
  async rollback(action, _input, result, ctx) {
    if (action !== 'place_luckin_order') return;
    // 真實回滾：上游 cancelOrder（未支付訂單可撤）+ 本地歸檔
    const env = ctx.globals.cloudEnv as string;
    const out = result.data as PlaceOrderOutput;
    const res = await postContainer<{ ok: boolean }>(
      env,
      '/api/skill/skill.coffee.luckin/place_luckin_order/cancel',
      { orderId: out.orderId },
      { sessionId: ctx.sessionId, retry: false },
    );
    if (res.code !== 0) {
      logError('luckin rollback 失敗', res);
      throw new Error('瑞幸訂單取消失敗（請及時在瑞幸 App 內取消）');
    }
  },
};

async function invokeSearchStore(
  env: string,
  input: SearchStoreInput,
  sessionId: string,
): Promise<SkillResult<SearchStoreOutput>> {
  const res: CloudResponse<SearchStoreOutput> = await postContainer<SearchStoreOutput>(
    env,
    '/api/skill/skill.coffee.luckin/search_luckin_store',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲端不可用（負數碼 = 雲基礎設施錯誤）：查詢域本地 mock 兜底（與星巴克同構）
  if (res.code < 0) return { success: true, data: mockStores(input) };
  return {
    success: false,
    error: { code: 'STORE_SEARCH_FAILED', message: res.message ?? '門店查詢失敗', retryable: true },
  };
}

async function invokeSearchProduct(
  env: string,
  input: SearchProductInput,
  sessionId: string,
): Promise<SkillResult<SearchProductOutput>> {
  const res: CloudResponse<SearchProductOutput> = await postContainer<SearchProductOutput>(
    env,
    '/api/skill/skill.coffee.luckin/search_luckin_product',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) return { success: true, data: mockProducts(input) };
  return {
    success: false,
    error: { code: 'PRODUCT_SEARCH_FAILED', message: res.message ?? '商品搜尋失敗', retryable: true },
  };
}

async function invokePlace(
  env: string,
  input: PlaceOrderInput,
  sessionId: string,
): Promise<SkillResult<PlaceOrderOutput>> {
  const res: CloudResponse<PlaceOrderOutput> = await postContainer<PlaceOrderOutput>(
    env,
    '/api/skill/skill.coffee.luckin/place_luckin_order',
    input,
    // 寫操作禁用自動重試：逾時重試會重複下單（雲端尚無 clientToken 冪等鍵；
    // 訂單掛本人瑞幸賬號，重複訂單即重複佔用優惠券權益）
    { sessionId, retry: false },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲基礎設施不可用（code<0）：本地生成 copy-only 跳轉卡（與雲端降級同構——
  // 瑞幸 Token 未配置 / 雲端不可用時，真實點單引導至瑞幸小程序側完成）
  if (res.code < 0) {
    const copyText = [
      `瑞幸點單（到店自取）：${input.storeName ?? `門店 ${input.deptId}`}`,
      ...input.items.map((it) => `${it.name ?? it.productId} ×${it.quantity}`),
      '支付與取餐碼以瑞幸小程序實際價格為準',
    ].join('\n');
    return {
      success: true,
      data: {
        orderId: `mock_lkn_${Date.now()}`,
        status: 'pending_external',
        items: input.items,
        jump: { target: 'luckin', appId: '', copyText, note: '真實交易於瑞幸小程序完成，價格與優惠以門市為準' },
        source: 'mock_local',
      },
    };
  }
  return {
    success: false,
    error: { code: 'PLACE_ORDER_FAILED', message: res.message ?? '點單失敗', retryable: false },
  };
}

function mockStores(input: SearchStoreInput): SearchStoreOutput {
  const city = input.city ?? '當前城市';
  return {
    stores: [
      { deptId: '610001', name: `${city}中心店`, address: `${city}中山路 8 號`, distanceM: 300 },
      { deptId: '610002', name: `${city}地鐵站店`, address: `${city}地鐵 1 號線 B 口`, distanceM: 800 },
      { deptId: '610003', name: `${city}萬象城店`, address: `${city}萬象城 L2`, distanceM: 1500 },
    ].slice(0, input.limit ?? 3),
    source: 'mock_local',
  };
}

function mockProducts(input: SearchProductInput): SearchProductOutput {
  const all: LuckinProduct[] = [
    { productId: '1262', skuCode: 'SP2077-00347', name: '生椰拿鐵', priceText: '¥18.00' },
    { productId: '1001', skuCode: 'SP2077-00001', name: '經典拿鐵', priceText: '¥17.00' },
    { productId: '1002', skuCode: 'SP2077-00002', name: '美式咖啡', priceText: '¥13.00' },
    { productId: '1003', skuCode: 'SP2077-00003', name: '橙 C 美式', priceText: '¥16.00' },
  ];
  const q = (input.query ?? '').trim();
  const hit = q ? all.filter((p) => p.name.includes(q)) : all;
  return { products: (hit.length > 0 ? hit : all).slice(0, input.limit ?? 6), source: 'mock_local' };
}
