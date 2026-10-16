/**
 * 星巴克咖啡 SKILL
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1
 *
 * 提供能力：
 *   - search_store   ：查附近門市（idempotent, no confirm）
 *   - place_order    ：生成點單需求卡並跳轉星巴克小程序（NOT idempotent, no confirm, reversible）
 *
 * 2026-10 六域回補（跳轉模式）：星巴克開放平台僅面向企業資質 ISV，
 * 個人主體拿不到 API，place_order 改為「點單需求卡（pending_external）
 * + 跳轉星巴克官方小程序完成真實點單與支付」——與 train/flight 同構。
 *
 * requiresHumanConfirm 判定（Agent.md § 7.1 第 4 條，2026-10-16 黑盒測試
 * D6 修訂）：place_order 設 false——跳轉模式下本端不扣款（真實點單與
 * 支付由用戶在星巴克小程序側自主完成），pending_external 可隨時 cancel /
 * rollback，與 mcdonalds place_mcd_order 論證同構，屬 T4 執行可逆檔位，
 * 按「最小打擾」原則不攔確認（此前 true 為跳轉模式改造前的舊口徑殘留，
 * 與 SKILL 層 2026-10 修訂及 prompt 規則 4 新口徑衝突）。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta, JumpPackage } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';
import { error as logError } from '../../../utils/logger';

export interface SearchStoreInput {
  city: string;
  lat?: number;
  lng?: number;
  limit?: number;
}

export interface StoreInfo {
  storeId: string;
  name: string;
  address: string;
  distanceM: number;
  openNow: boolean;
}

export interface SearchStoreOutput {
  stores: StoreInfo[];
}

export interface PlaceOrderInput {
  storeId: string;
  items: Array<{ sku: string; name: string; quantity: number; size?: string }>;
  pickupType: 'in_store' | 'takeaway';
  /** 從 search_store 注入的 bindings */
  storeName?: string;
}

export interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  amountCent: number;
}

export interface PlaceOrderOutput {
  orderId: string;
  storeId: string;
  items: OrderItem[];
  amountCent: number;
  /** 跳轉模式：真實點單與支付在星巴克小程序側完成 */
  status: 'pending_external' | 'completed' | 'cancelled';
  /** 渠道跳轉包（appId 空 = copy-only，EXTERNAL_JUMP 配置後生效） */
  jump?: JumpPackage;
}

export const meta = {
  id: 'skill.coffee.starbucks',
  name: '星巴克咖啡',
  description:
    '【能做】查詢附近星巴克門市（search_store）、生成點單需求卡並跳轉星巴克小程序完成真實點單（place_order，真實交易在星巴克側）。' +
    '【不能做】不能儲值、不能修改訂單（須走星巴克小程序或官方 App）。' +
    '【觸發時機】用戶提到「星巴克/咖啡/拿鐵/美式」並表達找門市或點單意圖時。',
  version: '1.0.0',
  owner: 'wx-starbucks-mock',
  tags: ['餐飲', '咖啡'],
  capabilities: [
    {
      action: 'search_store',
      description: '查詢附近星巴克門市',
      inputSchema: {
        type: 'object',
        required: ['city'],
        properties: {
          city: { type: 'string' },
          lat: { type: 'number', description: '緯度（用戶位置）' },
          lng: { type: 'number' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
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
              required: ['storeId', 'name'],
              properties: {
                storeId: { type: 'string' },
                name: { type: 'string' },
                address: { type: 'string' },
                distanceM: { type: 'number' },
                openNow: { type: 'boolean' },
              },
            },
          },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1000,
    },
    {
      action: 'place_order',
      description: '在指定門市下單',
      inputSchema: {
        type: 'object',
        required: ['storeId', 'items', 'pickupType'],
        properties: {
          storeId: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['sku', 'quantity'],
              properties: {
                sku: { type: 'string' },
                name: { type: 'string' },
                quantity: { type: 'integer', minimum: 1 },
                size: { type: 'string' },
              },
            },
          },
          pickupType: { type: 'string', enum: ['in_store', 'takeaway'] },
          storeName: { type: 'string' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['orderId', 'amountCent'],
        properties: {
          orderId: { type: 'string' },
          amountCent: { type: 'integer' },
        },
      },
      idempotent: false,
      reversible: true,
      // T4 執行可逆（見檔案頭注釋 D6 修訂說明）：不攔確認，靠 rollback + 渠道側支付把关
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1500,
    },
  ],
} as unknown as SkillMeta;

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    const env = ctx.globals.cloudEnv as string;
    if (action === 'search_store') {
      return invokeSearch(env, input as SearchStoreInput, ctx.sessionId);
    }
    if (action === 'place_order') {
      return invokePlace(env, input as PlaceOrderInput, ctx.sessionId);
    }
    return {
      success: false,
      error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
    };
  },
  async rollback(action, _input, result, ctx) {
    if (action !== 'place_order') return;
    const env = ctx.globals.cloudEnv as string;
    const res = await postContainer<{ ok: boolean }>(
      env,
      '/api/skill/skill.coffee.starbucks/place_order/cancel',
      { orderId: (result.data as PlaceOrderOutput).orderId },
      { sessionId: ctx.sessionId, retry: false },
    );
    if (res.code !== 0) {
      logError('starbucks rollback 失敗', res);
      throw new Error('星巴克訂單取消失敗');
    }
  },
};

async function invokeSearch(
  env: string,
  input: SearchStoreInput,
  sessionId: string,
): Promise<SkillResult<SearchStoreOutput>> {
  const res: CloudResponse<SearchStoreOutput> = await postContainer<SearchStoreOutput>(
    env,
    '/api/skill/skill.coffee.starbucks/search_store',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲端不可用時返回 mock：負數碼 = 雲基礎設施錯誤（-1 開發佔位 /
  // -501000 INVALID_ENV 等），業務錯誤碼為正數不受影響
  if (res.code < 0) return { success: true, data: mockStores(input) };
  return {
    success: false,
    error: { code: 'STORE_SEARCH_FAILED', message: res.message ?? '門市查詢失敗', retryable: true },
  };
}

async function invokePlace(
  env: string,
  input: PlaceOrderInput,
  sessionId: string,
): Promise<SkillResult<PlaceOrderOutput>> {
  const res: CloudResponse<PlaceOrderOutput> = await postContainer<PlaceOrderOutput>(
    env,
    '/api/skill/skill.coffee.starbucks/place_order',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲端不可用時返回 mock：負數碼 = 雲基礎設施錯誤（見 invokeSearch 說明）。
  // 與雲端同構：pending_external + copy-only 跳轉包（copyText 口徑一致）
  if (res.code < 0) {
    // 與雲端同構：門市白名單校驗（模擬目錄固定 sb_001~sb_003，跨城市同號）
    if (!['sb_001', 'sb_002', 'sb_003'].includes(input.storeId)) {
      return { success: false, error: { code: 'STORE_NOT_FOUND', message: `門市不存在：${input.storeId}`, retryable: false } };
    }
    const amountCent = input.items.reduce((s, it) => s + 3000 * it.quantity, 0);
    const pickupLabel = input.pickupType === 'takeaway' ? '外送' : '店內取餐';
    const copyText = [
      `星巴克點單（${pickupLabel}）`,
      ...input.items.map((it) => `${it.name ?? it.sku} ×${it.quantity}（約 ¥${((3000 * it.quantity) / 100).toFixed(2)}）`),
      `合計約 ¥${(amountCent / 100).toFixed(2)}（以星巴克小程序實際價格為準）`,
    ].join('\n');
    return {
      success: true,
      data: {
        orderId: `mock_sb_${Date.now()}`,
        storeId: input.storeId,
        items: input.items.map((it) => ({ ...it, amountCent: 3000 * it.quantity })),
        amountCent,
        status: 'pending_external',
        jump: { target: 'starbucks', appId: '', copyText, note: '真實交易於外部官方渠道完成，支付與售後以渠道為準' },
      },
    };
  }
  return {
    success: false,
    error: { code: 'PLACE_ORDER_FAILED', message: res.message ?? '點單失敗', retryable: false },
  };
}

function mockStores(input: SearchStoreInput): SearchStoreOutput {
  return {
    stores: [
      { storeId: 'sb_001', name: `${input.city}中心門市`, address: `${input.city}中山路 1 號`, distanceM: 350, openNow: true },
      { storeId: 'sb_002', name: `${input.city}高鐵站門市`, address: `${input.city}站前廣場`, distanceM: 1200, openNow: true },
      { storeId: 'sb_003', name: `${input.city}萬象城門市`, address: `${input.city}萬象城 L1`, distanceM: 2300, openNow: true },
    ].slice(0, input.limit ?? 3),
  };
}