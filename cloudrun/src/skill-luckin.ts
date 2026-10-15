/**
 * 瑞幸咖啡 SKILL 端點（2026-10 國民級 App MCP 接入）
 *
 * 端點（與小程序端 coffee-luckin SKILL 呼叫路徑逐字對齊；action 名帶
 * luckin 前綴，避免與星巴克 search_store / place_order 的全局鍵衝突）：
 *   POST /api/skill/skill.coffee.luckin/search_luckin_store   —— 按位置查附近門店
 *   POST /api/skill/skill.coffee.luckin/search_luckin_product  —— 門市內自然語言搜商品
 *   POST /api/skill/skill.coffee.luckin/place_luckin_order     —— 點單（真實扣費！）
 *   POST /api/skill/skill.coffee.luckin/place_luckin_order/cancel —— 取消（rollback）
 *
 * 資料來源（兩層降級，端點協議不變）：
 *   1. 瑞幸官方 AI 開放平台 MCP（open.lkcoffee.com；Streamable HTTP，
 *      Authorization: Bearer <token>）：LUCKIN_MCP_TOKEN 已配置時啟用。
 *      工具名依官方 MCP 文檔（openluckin CLI 快照 camelCase 映射）：
 *        queryShopList        —— 經緯度（GCJ-02）查門市 → deptId
 *        searchProductForMcp  —— 門市內按 query 匹配商品 → productId/skuCode
 *        createOrder          —— 創建訂單（真實消費）→ payOrderUrl
 *        cancelOrder          —— 取消訂單（rollback 用）
 *      官方接口變更時調整下方 TOOL_* 常量即可（端點協議不動）
 *   2. 未配置 Token / 連線層失敗：降級確定性模擬 + copy-only 需求卡
 *      （跳轉模式：真實點單與支付在瑞幸小程序 / App 側完成）
 *
 * 支付紅線：createOrder 產生真實消費。上游點單流程（官方 Skill 說明）
 * 明令「下單前向用戶復述門店、商品、價格並獲得明確同意」——由小程序端
 * SKILL meta 的 requiresHumanConfirm=true 觸發 checkpoint 承擔；支付由
 * 用戶掃 payOrderUrl 二維碼自行完成，Agent 不代付（與全行業口徑一致）。
 *
 * 訂單落庫 MySQL（db.ts domain=luckin），以 x-wx-openid 歸屬鑒權。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized } from './api';
import { callMcpTool, McpToolError } from './mcp-client';
import { createOrder, getOrder, cancelOrder } from './db';
import { buildJump } from './external-jump';

/** 瑞幸官方 MCP 端點（可用 LUCKIN_MCP_URL 覆蓋，如代理位址） */
const LUCKIN_MCP_URL = process.env.LUCKIN_MCP_URL ?? 'https://gwmcp.lkcoffee.com/order/user/mcp';

/** 上游工具名集中宣告（官方 MCP 工具 schema 的 camelCase 形態） */
const TOOL_QUERY_SHOP = 'queryShopList';
const TOOL_SEARCH_PRODUCT = 'searchProductForMcp';
const TOOL_CREATE_ORDER = 'createOrder';
const TOOL_CANCEL_ORDER = 'cancelOrder';

/** 單次上游工具調用超時 */
const LUCKIN_TIMEOUT_MS = 20_000;

/** 未配置 Token 時的降級提示僅記一次 */
let mockLogged = false;

/** Bearer 鑑權頭（Token 未配置時回 null → 呼叫方降級模擬） */
function luckinAuth(): Record<string, string> | null {
  const token = process.env.LUCKIN_MCP_TOKEN;
  if (!token) {
    if (!mockLogged) {
      console.warn('[skill-luckin] LUCKIN_MCP_TOKEN 未配置，瑞幸點單降級為模擬 + 跳轉模式（離線演示）');
      mockLogged = true;
    }
    return null;
  }
  return { Authorization: `Bearer ${token}` };
}

/** 簡易確定性字串雜湊（模擬數據種子） */
function stableHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/** 上游 JSON 包絡 {"code":0,"msg":"success","data":...} 的 data 提取與業務碼檢查 */
function unwrapLuckin(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // 非 JSON 文本（上游錯誤描述等）：按業務性錯誤透傳
    throw new McpToolError(`瑞幸回應無法解析：${text.slice(0, 160)}`);
  }
  const env = parsed as { code?: unknown; msg?: unknown; data?: unknown };
  if (typeof env.code === 'number' && env.code !== 0) {
    throw new McpToolError(`瑞幸業務失敗（code ${env.code}）：${String(env.msg ?? '').slice(0, 160)}`);
  }
  return env.data;
}

/* ==================== search_store ==================== */

interface SearchStoreInput {
  lng?: number;
  lat?: number;
  city?: string;
  limit?: number;
}

/** queryShopList 回應單條門店（僅聲明用到的欄位） */
interface LuckinShop {
  deptId?: number | string;
  deptName?: string;
  address?: string;
  distance?: number | string;
}

const handleSearchStore: RouteHandler = async (body) => {
  const input = (body ?? {}) as SearchStoreInput;
  if (typeof input.lng !== 'number' || typeof input.lat !== 'number') {
    return badRequest('lng / lat 必填（用戶位置，GCJ-02）');
  }

  const auth = luckinAuth();
  if (!auth) return ok(mockShops(input));

  try {
    const text = await callMcpTool(
      LUCKIN_MCP_URL,
      TOOL_QUERY_SHOP,
      { longitude: input.lng, latitude: input.lat },
      LUCKIN_TIMEOUT_MS,
      auth,
    );
    const data = unwrapLuckin(text);
    const shops = (Array.isArray(data) ? data : ((data as { list?: unknown[] })?.list ?? [])) as LuckinShop[];
    return ok({
      stores: shops.slice(0, input.limit ?? 5).map((s) => ({
        deptId: String(s.deptId ?? ''),
        name: s.deptName ?? '',
        address: s.address ?? '',
        distanceM: Math.round(Number(s.distance ?? 0)) || 0,
      })),
      source: 'luckin_mcp_realtime',
    });
  } catch (e) {
    if (e instanceof McpToolError) return fail(503, e.message.slice(0, 200));
    console.error('[skill-luckin] 瑞幸 MCP 不可用，降級模擬門店：', e instanceof Error ? e.message : e);
    return ok(mockShops(input));
  }
};

/** 確定性模擬門店（與星巴克 mockStores 同款口徑） */
function mockShops(input: SearchStoreInput): Record<string, unknown> {
  const city = input.city ?? '當前城市';
  return {
    stores: [
      { deptId: '610001', name: `${city}中心店`, address: `${city}中山路 8 號`, distanceM: 300 },
      { deptId: '610002', name: `${city}地鐵站店`, address: `${city}地鐵 1 號線 B 口`, distanceM: 800 },
      { deptId: '610003', name: `${city}萬象城店`, address: `${city}萬象城 L2`, distanceM: 1500 },
    ].slice(0, input.limit ?? 3),
    source: 'mock_deterministic',
  };
}

/* ==================== search_product ==================== */

interface SearchProductInput {
  deptId?: string;
  query?: string;
  limit?: number;
}

/** searchProductForMcp 回應單條商品（僅聲明用到的欄位） */
interface LuckinProduct {
  productId?: number | string;
  productName?: string;
  skuCode?: string;
  /** 上游實測（2026-10-14）無 productPrice 舊字段，價格在 estimatePrice（優惠後估價）/ initialPrice（原價） */
  productPrice?: number | string;
  initialPrice?: number | string;
  estimatePrice?: number | string;
}

/** 商品價格文本：估價優先，回退原價 → 舊字段，均無則空串（下單不受影響） */
function luckinPriceText(p: LuckinProduct): string {
  const price = p.estimatePrice ?? p.initialPrice ?? p.productPrice;
  return typeof price === 'number' ? `¥${price.toFixed(2)}` : String(price ?? '');
}

const handleSearchProduct: RouteHandler = async (body) => {
  const input = (body ?? {}) as SearchProductInput;
  if (!input.deptId || !input.query) {
    return badRequest('deptId / query 必填');
  }

  const auth = luckinAuth();
  if (!auth) return ok(mockProducts(input));

  try {
    const text = await callMcpTool(
      LUCKIN_MCP_URL,
      TOOL_SEARCH_PRODUCT,
      { deptId: Number(input.deptId), query: input.query },
      LUCKIN_TIMEOUT_MS,
      auth,
    );
    const data = unwrapLuckin(text);
    const products = (Array.isArray(data) ? data : ((data as { list?: unknown[] })?.list ?? [])) as LuckinProduct[];
    return ok({
      products: products.slice(0, input.limit ?? 6).map((p) => ({
        productId: String(p.productId ?? ''),
        skuCode: p.skuCode ?? '',
        name: p.productName ?? '',
        priceText: luckinPriceText(p),
      })),
      source: 'luckin_mcp_realtime',
    });
  } catch (e) {
    if (e instanceof McpToolError) return fail(503, e.message.slice(0, 200));
    console.error('[skill-luckin] 瑞幸商品搜索不可用，降級模擬：', e instanceof Error ? e.message : e);
    return ok(mockProducts(input));
  }
};

/** 模擬商品（瑞幸經典 SKU 口徑） */
function mockProducts(input: SearchProductInput): Record<string, unknown> {
  const all = [
    { productId: '1262', skuCode: 'SP2077-00347', name: '生椰拿鐵', priceText: '¥18.00' },
    { productId: '1001', skuCode: 'SP2077-00001', name: '經典拿鐵', priceText: '¥17.00' },
    { productId: '1002', skuCode: 'SP2077-00002', name: '美式咖啡', priceText: '¥13.00' },
    { productId: '1003', skuCode: 'SP2077-00003', name: '橙 C 美式', priceText: '¥16.00' },
  ];
  const q = (input.query ?? '').trim();
  const hit = q ? all.filter((p) => p.name.includes(q)) : all;
  return { products: (hit.length > 0 ? hit : all).slice(0, input.limit ?? 6), source: 'mock_deterministic' };
}

/* ==================== place_order（checkpoint 後調用） ==================== */

interface LuckinOrderItem {
  productId?: string;
  skuCode?: string;
  name?: string;
  quantity?: number;
}

interface PlaceOrderInput {
  deptId?: string;
  storeName?: string;
  items?: LuckinOrderItem[];
  lng?: number;
  lat?: number;
  /** 平鋪單品欄位（規則規劃器綁定注入友好；items 缺省時由此組裝單品 productList） */
  productId?: string;
  skuCode?: string;
  productName?: string;
  quantity?: number;
}

const handlePlace: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as PlaceOrderInput;
  // items 陣列優先；缺省時以平鋪單品欄位組裝（陣列內字段不支援綁定注入，
  // 規則規劃器以 productId/skuCode/productName 平鋪綁定 + quantity 字面值傳入）
  const items: LuckinOrderItem[] = Array.isArray(input.items) && input.items.length > 0
    ? input.items
    : typeof input.productId === 'string' && input.productId
      ? [{ productId: input.productId, skuCode: input.skuCode ?? '', name: input.productName, quantity: input.quantity ?? 1 }]
      : [];
  if (!input.deptId || items.length === 0) {
    return badRequest('deptId / items（或平鋪 productId）必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕下單');
  }

  const orderId = `lkn_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const auth = luckinAuth();

  if (!auth) {
    // 降級：需求卡 + 跳轉模式（真實點單與支付在瑞幸小程序側完成）
    const copyText = [
      `瑞幸點單（到店自取）：${input.storeName ?? `門店 ${input.deptId}`}`,
      ...items.map((it) => `${it.name ?? it.productId} ×${it.quantity ?? 1}`),
      '支付與取餐碼以瑞幸小程序實際價格為準',
    ].join('\n');
    await createOrder({
      orderId,
      owner: ctx.openid,
      domain: 'luckin',
      status: 'pending_external',
      payload: {
        deptId: input.deptId,
        storeName: input.storeName ?? '',
        items,
      },
      createdAt: Date.now(),
    });
    return ok({
      orderId,
      status: 'pending_external',
      items,
      jump: buildJump('luckin', copyText),
      source: 'mock_deterministic',
    });
  }

  try {
    // 官方契約：productList 為對象陣列（productId + skuCode + amount）
    const text = await callMcpTool(
      LUCKIN_MCP_URL,
      TOOL_CREATE_ORDER,
      {
        deptId: Number(input.deptId),
        ...(typeof input.lng === 'number' && typeof input.lat === 'number'
          ? { longitude: input.lng, latitude: input.lat }
          : {}),
        productList: items.map((it) => ({
          productId: Number(it.productId ?? 0),
          skuCode: it.skuCode ?? '',
          amount: it.quantity ?? 1,
        })),
      },
      LUCKIN_TIMEOUT_MS,
      auth,
    );
    const data = (unwrapLuckin(text) ?? {}) as { orderId?: string; order_id?: string; payOrderUrl?: string };
    const upstreamId = data.orderId ?? data.order_id ?? '';
    if (!upstreamId) {
      return fail(502, '瑞幸下單回應缺少訂單號（回應結構異常）');
    }
    await createOrder({
      orderId,
      owner: ctx.openid,
      domain: 'luckin',
      status: 'pending_external',
      payload: {
        upstreamOrderId: upstreamId,
        deptId: input.deptId,
        storeName: input.storeName ?? '',
        items,
        payOrderUrl: data.payOrderUrl ?? '',
      },
      createdAt: Date.now(),
    });
    return ok({
      orderId,
      upstreamOrderId: upstreamId,
      status: 'pending_external',
      payOrderUrl: data.payOrderUrl ?? '',
      items,
      note: '請在支付時效內掃碼完成支付，逾期訂單自動取消',
      source: 'luckin_mcp_realtime',
    });
  } catch (e) {
    if (e instanceof McpToolError) return fail(503, e.message.slice(0, 200));
    console.error('[skill-luckin] 瑞幸下單不可用：', e instanceof Error ? e.message : e);
    return fail(502, '瑞幸服務暫不可用，請稍後再試');
  }
};

/* ==================== place_order/cancel（rollback） ==================== */

interface CancelOrderInput {
  orderId?: string;
}

const handleCancel: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CancelOrderInput;
  if (!input.orderId) return badRequest('orderId 必填');
  if (!ctx.openid) return unauthorized('缺少調用方身份（x-wx-openid），拒絕取消');

  const order = await getOrder(input.orderId);
  if (!order || order.domain !== 'luckin') {
    return fail(404, `訂單不存在或已取消：${input.orderId}`);
  }
  const payload = order.payload as Record<string, unknown>;
  const upstreamId = typeof payload.upstreamOrderId === 'string' ? payload.upstreamOrderId : '';

  const auth = luckinAuth();
  if (auth && upstreamId) {
    try {
      await callMcpTool(LUCKIN_MCP_URL, TOOL_CANCEL_ORDER, { orderId: upstreamId }, LUCKIN_TIMEOUT_MS, auth);
    } catch (e) {
      if (e instanceof McpToolError) return fail(503, e.message.slice(0, 200));
      console.error('[skill-luckin] 瑞幸取消不可用，僅取消本地記錄：', e instanceof Error ? e.message : e);
    }
  }
  const result = await cancelOrder(input.orderId, ctx.openid);
  if (result === 'forbidden') {
    return fail(403, '無權取消他人訂單');
  }
  return ok({ ok: true, orderId: input.orderId });
};

export const luckinRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.coffee.luckin/search_luckin_store', handleSearchStore],
  ['POST /api/skill/skill.coffee.luckin/search_luckin_product', handleSearchProduct],
  ['POST /api/skill/skill.coffee.luckin/place_luckin_order', handlePlace],
  ['POST /api/skill/skill.coffee.luckin/place_luckin_order/cancel', handleCancel],
];
