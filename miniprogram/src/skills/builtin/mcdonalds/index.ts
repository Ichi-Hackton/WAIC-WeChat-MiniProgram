/**
 * 麥當勞點餐 SKILL（skill.food.mcdonalds）
 *
 * 規範來源：.qoder/rules/Agent.md § 7
 *
 * 提供能力：
 *   - search_mcd_store ：查附近麥當勞門市（idempotent, no confirm）
 *   - query_mcd_menu   ：查門市菜單與餐品編碼（idempotent, no confirm）
 *   - place_mcd_order  ：真實下單（calculate-price 試算 → create-order；NOT idempotent, reversible）
 *   - query_mcd_order  ：查訂單狀態（idempotent）
 *   - cancel_mcd_order ：取消未支付訂單（reversible 語義的真實落地）
 *
 * 與六域跳轉模式的本質區別（2026-10-14 接入）：麥當勞官方 MCP 提供
 * 真實 create-order / cancel-order 能力，訂單在麥當勞側真實創建——
 * 這是首個「真實下單」SKILL。降級策略嚴格分流：
 *   - 查詢域（search / menu）：雲端不可用（code<0）時本地 mock 兜底，
 *     與星巴克 search_store 同構
 *   - 寫操作域（place / query / cancel）：**一律不降級**——真實交易
 *     鏈路嚴禁模擬數據，雲端不可用即如實失敗（工程判斷：離線 mock
 *     訂單會誤導用戶以為真實下單成功）
 *
 * requiresHumanConfirm 判定（Agent.md § 7.1 第 4 條，2026-10 修訂）：
 * place_mcd_order 設 false——下單不扣款（支付由用戶掃碼自主完成），
 * 未支付前 cancel-order 隨時可撤，rollback 安全网完整，符合「最小
 * 打擾」原則的適用前提；支付 / 不可逆場景不存在於本 SKILL。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';
import { error as logError } from '../../../utils/logger';

export interface SearchStoreInput {
  city: string;
  /** 搜尋關鍵詞（商圈 / 地標）；上游 searchType=2 要求 city+keyword+座標四者齊全，
   * 缺省由雲端以城市名充當（2026-10-14 實測） */
  keyword?: string;
  lat?: number;
  lng?: number;
  /** 到店自提（預設）或得來速車道取餐 */
  pickupType?: 'in_store' | 'drive_thru';
  limit?: number;
}

export interface McdStore {
  storeId: string;
  name: string;
  address: string;
  distanceM: number;
  beCode: string;
  openNow: boolean;
  businessHours: string;
}

export interface SearchStoreOutput {
  city: string;
  stores: McdStore[];
  source: string;
}

export interface QueryMenuInput {
  storeId: string;
  orderType?: 'in_store' | 'delivery';
}

export interface MenuCategory {
  name: string;
  meals: Array<{ code: string; tags: string[] }>;
}

export interface QueryMenuOutput {
  storeId: string;
  categories: MenuCategory[];
  source: string;
}

export interface PlaceOrderInput {
  storeId: string;
  /** 得來速門市需攜帶（search 結果 bindings 注入）；到店自提不傳 */
  beCode?: string;
  /** 缺省時由雲端自動選「人氣熱賣」首品（模糊點單路徑） */
  items?: Array<{ productCode: string; quantity: number }>;
  /** 堂食（預設）或店內自提外帶 */
  takeWay?: string;
  needTableware?: boolean;
  /** 從 search / menu 任務注入的 bindings */
  storeName?: string;
}

export interface PlaceOrderOutput {
  orderId: string;
  mcdOrderId: string;
  storeId: string;
  items: Array<{ productCode: string; productName: string; quantity: number }>;
  amountCent: number;
  status: 'pending_external';
  takeWay: string;
  autoPicked: boolean;
  payUrl?: string;
  note: string;
}

export interface QueryOrderInput {
  orderId: string;
}

export interface QueryOrderOutput {
  orderId: string;
  mcdOrderId: string;
  localStatus: string;
  mcdStatus: string;
  amountCent: number;
}

export interface CancelInput {
  orderId: string;
  reasonCode?: number;
}

export interface CancelOutput {
  ok: boolean;
  orderId: string;
  status: 'cancelled';
}

export const meta = {
  id: 'skill.food.mcdonalds',
  name: '麥當勞點餐',
  description:
    '【能做】查詢附近麥當勞門市（search_mcd_store）、查門市菜單與餐品編碼（query_mcd_menu）、' +
    '真實下單到麥當勞並返回支付鏈接（place_mcd_order，訂單真實創建、支付由用戶掃碼完成）、' +
    '查訂單狀態（query_mcd_order）、取消未支付訂單（cancel_mcd_order）。' +
    '【不能做】不支持外送（僅到店自提 / 得來速）、不能代用戶支付、已支付訂單不能由本端取消。' +
    '【觸發時機】用戶提到「麥當勞/M記/巨無霸/薯條/麥辣」並表達查店、看菜單或點餐意圖時。',
  version: '1.0.0',
  owner: 'wx-mcdonalds-open',
  tags: ['餐飲', '快餐'],
  capabilities: [
    {
      action: 'search_mcd_store',
      description: '查詢附近麥當勞門市（支援到店 / 得來速篩選）',
      inputSchema: {
        type: 'object',
        required: ['city'],
        properties: {
          city: { type: 'string' },
          keyword: { type: 'string', description: '商圈 / 地標關鍵詞（如「國貿」）' },
          lat: { type: 'number', description: '緯度（用戶位置，距離排序依據）' },
          lng: { type: 'number' },
          pickupType: { type: 'string', enum: ['in_store', 'drive_thru'] },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['stores'],
        properties: {
          city: { type: 'string' },
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
                beCode: { type: 'string', description: '得來速門市下單需透傳' },
                openNow: { type: 'boolean' },
                businessHours: { type: 'string' },
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
      action: 'query_mcd_menu',
      description: '查詢門市菜單分類與餐品編碼（下單 items 的 productCode 來源）',
      inputSchema: {
        type: 'object',
        required: ['storeId'],
        properties: {
          storeId: { type: 'string', description: 'search_mcd_store 結果的 storeId' },
          orderType: { type: 'string', enum: ['in_store'] },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['categories'],
        properties: {
          storeId: { type: 'string' },
          categories: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'meals'],
              properties: {
                name: { type: 'string' },
                meals: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['code'],
                    properties: {
                      code: { type: 'string' },
                      tags: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
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
      action: 'place_mcd_order',
      description: '真實下單：雲端先試算金額再創建麥當勞訂單，返回支付鏈接（未支付前可取消）',
      inputSchema: {
        type: 'object',
        required: ['storeId'],
        properties: {
          storeId: { type: 'string' },
          beCode: { type: 'string', description: '得來速門市必傳（search 結果帶出）' },
          items: {
            type: 'array',
            description: '缺省時自動選人氣熱賣首品',
            items: {
              type: 'object',
              required: ['productCode', 'quantity'],
              properties: {
                productCode: { type: 'string', description: 'query_mcd_menu 結果的 code' },
                quantity: { type: 'integer', minimum: 1 },
              },
            },
          },
          takeWay: { type: 'string', enum: ['eat-in', 'take-in-store'] },
          needTableware: { type: 'boolean' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['orderId', 'amountCent', 'payUrl'],
        properties: {
          orderId: { type: 'string' },
          mcdOrderId: { type: 'string' },
          amountCent: { type: 'integer', description: '應付金額（分）' },
          payUrl: { type: 'string', description: '掃碼 / 跳轉支付鏈接' },
          autoPicked: { type: 'boolean' },
          takeWay: { type: 'string' },
        },
      },
      idempotent: false,
      reversible: true,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 3000,
    },
    {
      action: 'query_mcd_order',
      description: '查詢麥當勞訂單狀態（本地 + 上游雙狀態）',
      inputSchema: {
        type: 'object',
        required: ['orderId'],
        properties: { orderId: { type: 'string' } },
      },
      outputSchema: {
        type: 'object',
        required: ['orderId'],
        properties: {
          orderId: { type: 'string' },
          mcdStatus: { type: 'string' },
          localStatus: { type: 'string' },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1500,
    },
    {
      action: 'cancel_mcd_order',
      description: '取消未支付的麥當勞訂單（上游 cancel-order + 本地歸檔）',
      inputSchema: {
        type: 'object',
        required: ['orderId'],
        properties: {
          orderId: { type: 'string' },
          reasonCode: { type: 'integer', description: '1=改主意了（預設）2=重複下單 3=點錯了 -1=其它' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['orderId'],
        properties: { orderId: { type: 'string' }, status: { type: 'string' } },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1500,
    },
  ],
} as unknown as SkillMeta;

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    const env = ctx.globals.cloudEnv as string;
    const i = input as Record<string, unknown>;
    switch (action) {
      case 'search_mcd_store':
        return invokeSearch(env, i as unknown as SearchStoreInput, ctx.sessionId);
      case 'query_mcd_menu':
        return invokeMenu(env, i as unknown as QueryMenuInput, ctx.sessionId);
      case 'place_mcd_order':
        return invokePlace(env, i as unknown as PlaceOrderInput, ctx.sessionId);
      case 'query_mcd_order':
        return invokeQueryOrder(env, i as unknown as QueryOrderInput, ctx.sessionId);
      case 'cancel_mcd_order':
        return invokeCancel(env, i as unknown as CancelInput, ctx.sessionId);
      default:
        return {
          success: false,
          error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
        };
    }
  },
  async rollback(action, _input, result, ctx) {
    if (action !== 'place_mcd_order') return;
    // 真實回滾：上游 cancel-order（未支付訂單可撤）+ 本地歸檔
    const env = ctx.globals.cloudEnv as string;
    const out = result.data as PlaceOrderOutput;
    const res = await postContainer<CancelOutput>(
      env,
      '/api/skill/skill.food.mcdonalds/cancel_mcd_order',
      { orderId: out.orderId, reasonCode: 1 },
      { sessionId: ctx.sessionId, retry: false },
    );
    if (res.code !== 0) {
      logError('mcdonalds rollback 失敗', res);
      throw new Error('麥當勞訂單取消失敗（請稍後在訂單卡手動取消）');
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
    '/api/skill/skill.food.mcdonalds/search_mcd_store',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲端不可用（負數碼 = 雲基礎設施錯誤）：查詢域本地 mock 兜底（與星巴克同構）
  if (res.code < 0) return { success: true, data: mockStores(input) };
  return {
    success: false,
    error: { code: 'STORE_SEARCH_FAILED', message: res.message ?? '門市查詢失敗', retryable: true },
  };
}

async function invokeMenu(
  env: string,
  input: QueryMenuInput,
  sessionId: string,
): Promise<SkillResult<QueryMenuOutput>> {
  const res: CloudResponse<QueryMenuOutput> = await postContainer<QueryMenuOutput>(
    env,
    '/api/skill/skill.food.mcdonalds/query_mcd_menu',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) return { success: true, data: mockMenu(input) };
  return {
    success: false,
    error: { code: 'MENU_QUERY_FAILED', message: res.message ?? '菜單查詢失敗', retryable: true },
  };
}

async function invokePlace(
  env: string,
  input: PlaceOrderInput,
  sessionId: string,
): Promise<SkillResult<PlaceOrderOutput>> {
  const res: CloudResponse<PlaceOrderOutput> = await postContainer<PlaceOrderOutput>(
    env,
    '/api/skill/skill.food.mcdonalds/place_mcd_order',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 真實下單嚴禁降級 mock：雲基礎設施錯誤（code<0）同樣如實失敗——
  // 離線 mock 訂單會誤導用戶以為真實下單成功（與星巴克跳轉模式的關鍵差異）
  return {
    success: false,
    error: {
      code: res.code < 0 ? 'CLOUD_UNAVAILABLE' : 'PLACE_ORDER_FAILED',
      message: res.code < 0 ? '雲端服務不可用，無法下單（真實交易不提供離線模擬）' : res.message ?? '下單失敗',
      retryable: res.code < 0,
    },
  };
}

async function invokeQueryOrder(
  env: string,
  input: QueryOrderInput,
  sessionId: string,
): Promise<SkillResult<QueryOrderOutput>> {
  const res: CloudResponse<QueryOrderOutput> = await postContainer<QueryOrderOutput>(
    env,
    '/api/skill/skill.food.mcdonalds/query_mcd_order',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  return {
    success: false,
    error: { code: 'ORDER_QUERY_FAILED', message: res.message ?? '訂單查詢失敗', retryable: true },
  };
}

async function invokeCancel(
  env: string,
  input: CancelInput,
  sessionId: string,
): Promise<SkillResult<CancelOutput>> {
  const res: CloudResponse<CancelOutput> = await postContainer<CancelOutput>(
    env,
    '/api/skill/skill.food.mcdonalds/cancel_mcd_order',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  return {
    success: false,
    error: {
      code: 'CANCEL_FAILED',
      message: res.message ?? '取消失敗（已支付 / 已出餐訂單不可由本端取消）',
      retryable: false,
    },
  };
}

function mockStores(input: SearchStoreInput): SearchStoreOutput {
  return {
    city: input.city,
    stores: [
      { storeId: 'mcd_001', name: `${input.city}麥當勞中心餐廳`, address: `${input.city}中山路 100 號`, distanceM: 300, beCode: '', openNow: true, businessHours: '07:00-22:00' },
      { storeId: 'mcd_002', name: `${input.city}麥當勞高鐵站餐廳`, address: `${input.city}站前廣場`, distanceM: 900, beCode: '', openNow: true, businessHours: '06:00-23:00' },
      { storeId: 'mcd_003', name: `${input.city}麥當勞萬象城得來速`, address: `${input.city}萬象城 B1`, distanceM: 1800, beCode: 'DT001', openNow: true, businessHours: '07:00-23:00' },
    ].slice(0, input.limit ?? 3),
    source: 'mock_local',
  };
}

function mockMenu(input: QueryMenuInput): QueryMenuOutput {
  return {
    storeId: input.storeId,
    categories: [
      { name: '人氣熱賣', meals: [{ code: 'demo_9900016081', tags: ['心形薯餅同款比心'] }, { code: 'demo_9900004064', tags: ['爆款'] }] },
      { name: '漢堡', meals: [{ code: 'demo_9900016075', tags: ['濃郁奶香拉絲芝士'] }, { code: 'demo_9900016073', tags: ['韓式辣椒黃油風味'] }] },
    ],
    source: 'mock_local',
  };
}
