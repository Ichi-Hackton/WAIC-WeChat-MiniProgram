/**
 * 網購商城 SKILL
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1
 *
 * 提供能力：
 *   - search_products ：搜商品（idempotent, no confirm）
 *   - add_to_cart     ：加入購物車（NOT idempotent, requires confirm, reversible）
 *   - checkout        ：購物車結算下單（NOT idempotent, requires confirm, reversible）
 *
 * 與雲端 skill-shopping.ts 的端點路徑逐字對齊；雲端不可用時（負數碼 =
 * 雲基礎設施錯誤）以模擬數據降級，保證開發者工具離線演示可用。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';
import { error as logError } from '../../../utils/logger';

export interface Product {
  productId: string;
  name: string;
  category: string;
  priceCent: number;
  stock: number;
  rating: number;
}

export interface SearchProductsInput {
  keyword?: string;
  category?: string;
  limit?: number;
}

export interface SearchProductsOutput {
  products: Product[];
  priceCentByProduct: Record<string, number>;
}

export interface AddToCartInput {
  productId: string;
  quantity: number;
  /** 從 search_products 注入的 bindings（展示用，可選） */
  name?: string;
}

export interface AddToCartOutput {
  cartItemId: string;
  productId: string;
  name: string;
  quantity: number;
  priceCent: number;
  cartCount: number;
  cartAmountCent: number;
}

export interface CheckoutOutput {
  orderId: string;
  items: Array<{ sku: string; name: string; quantity: number; amountCent: number }>;
  amountCent: number;
  status: 'pending_payment' | 'paid';
}

export const meta = {
  id: 'skill.shopping.mall',
  name: '網購商城',
  description:
    '【能做】搜索商品（search_products，支持關鍵詞與類目）、加入購物車（add_to_cart）、購物車結算下單（checkout）。' +
    '【不能做】不能修改已下單訂單、不能查物流。' +
    '【觸發時機】用戶提到「買/購物/加購/結算」或點名商品（耳機、手錶、保溫杯、咖啡豆、按摩儀、跑步鞋）時。',
  version: '1.0.0',
  owner: 'wx-shopping-mock',
  tags: ['購物', '電商'],
  capabilities: [
    {
      action: 'search_products',
      description: '按關鍵詞或類目搜索商品',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '關鍵詞（匹配商品名或類目）' },
          category: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
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
                productId: { type: 'string' },
                name: { type: 'string' },
                category: { type: 'string' },
                priceCent: { type: 'integer' },
                stock: { type: 'integer' },
                rating: { type: 'number' },
              },
            },
          },
          priceCentByProduct: { type: 'object', description: 'productId → 即時價（供 inputBindings 取價）' },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1000,
    },
    {
      action: 'add_to_cart',
      description: '把指定商品加入購物車',
      inputSchema: {
        type: 'object',
        required: ['productId', 'quantity'],
        properties: {
          productId: { type: 'string' },
          quantity: { type: 'integer', minimum: 1, maximum: 99 },
          name: { type: 'string' },
          priceCent: {
            type: 'integer',
            description: '即時價（分），由 inputBindings 從 search_products 注入，僅供確認彈窗展示',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['cartItemId', 'cartCount'],
        properties: {
          cartItemId: { type: 'string' },
          cartCount: { type: 'integer' },
          cartAmountCent: { type: 'integer' },
        },
      },
      idempotent: false,
      reversible: true,
      requiresHumanConfirm: true,
      estimatedLatencyMs: 1000,
    },
    {
      action: 'checkout',
      description: '結算購物車全部商品並建立訂單（會清空購物車）',
      inputSchema: {
        type: 'object',
        properties: {
          remark: { type: 'string' },
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
      requiresHumanConfirm: true,
      estimatedLatencyMs: 1500,
    },
  ],
} as unknown as SkillMeta;

/**
 * 模擬商品表（與雲端 skill-shopping.ts 的演示數據逐字對齊，
 * 保證降級前後展示一致）
 */
const MOCK_PRODUCTS: Product[] = [
  { productId: 'p_001', name: '無線降噪耳機 Pro', category: '電子數碼', priceCent: 129900, stock: 12, rating: 4.8 },
  { productId: 'p_002', name: '智能手錶 S6', category: '電子數碼', priceCent: 199900, stock: 5, rating: 4.7 },
  { productId: 'p_003', name: '恆溫保溫杯 500ml', category: '日用百貨', priceCent: 8900, stock: 66, rating: 4.6 },
  { productId: 'p_004', name: '精品咖啡豆 1kg', category: '食品', priceCent: 12800, stock: 30, rating: 4.9 },
  { productId: 'p_005', name: '頸部按摩儀', category: '家用電器', priceCent: 29900, stock: 8, rating: 4.5 },
  { productId: 'p_006', name: '輕量跑步鞋', category: '運動戶外', priceCent: 49900, stock: 0, rating: 4.4 },
];

/** 模擬購物車（模組級單例：mock 降級路徑下 add_to_cart → checkout 的會話內狀態） */
const mockCart: Array<{ cartItemId: string; productId: string; name: string; quantity: number; priceCent: number }> = [];
let mockCartSeq = 0;

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    const env = ctx.globals.cloudEnv as string;
    if (action === 'search_products') {
      return invokeSearch(env, input as SearchProductsInput, ctx.sessionId);
    }
    if (action === 'add_to_cart') {
      return invokeAddToCart(env, input as AddToCartInput, ctx.sessionId);
    }
    if (action === 'checkout') {
      return invokeCheckout(env, ctx.sessionId);
    }
    return {
      success: false,
      error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
    };
  },
  async rollback(action, _input, result, ctx) {
    if (action !== 'add_to_cart' && action !== 'checkout') return;
    const env = ctx.globals.cloudEnv as string;
    const path =
      action === 'add_to_cart'
        ? '/api/skill/skill.shopping.mall/add_to_cart/remove'
        : '/api/skill/skill.shopping.mall/checkout/cancel';
    const payload =
      action === 'add_to_cart'
        ? { cartItemId: (result.data as AddToCartOutput).cartItemId }
        : { orderId: (result.data as CheckoutOutput).orderId };
    const res = await postContainer<{ ok: boolean }>(env, path, payload, { sessionId: ctx.sessionId, retry: false });
    if (res.code !== 0) {
      logError('shopping rollback 失敗', res);
      throw new Error(action === 'add_to_cart' ? '購物車明細移除失敗' : '購物訂單取消失敗');
    }
  },
};

async function invokeSearch(env: string, input: SearchProductsInput, sessionId: string): Promise<SkillResult<SearchProductsOutput>> {
  const res: CloudResponse<SearchProductsOutput> = await postContainer<SearchProductsOutput>(
    env,
    '/api/skill/skill.shopping.mall/search_products',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲端不可用時返回 mock：負數碼 = 雲基礎設施錯誤（見 coffee SKILL 說明）
  if (res.code < 0) return { success: true, data: mockSearch(input) };
  return {
    success: false,
    error: { code: 'PRODUCT_SEARCH_FAILED', message: res.message ?? '商品搜索失敗', retryable: true },
  };
}

async function invokeAddToCart(env: string, input: AddToCartInput, sessionId: string): Promise<SkillResult<AddToCartOutput>> {
  const res: CloudResponse<AddToCartOutput> = await postContainer<AddToCartOutput>(
    env,
    '/api/skill/skill.shopping.mall/add_to_cart',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) {
    // mock 降級：查本地商品表（與雲端同構），模擬加購
    const product = MOCK_PRODUCTS.find((p) => p.productId === input.productId);
    if (!product) {
      return { success: false, error: { code: 'PRODUCT_NOT_FOUND', message: `商品不存在：${input.productId}`, retryable: false } };
    }
    if (product.stock <= 0) {
      return { success: false, error: { code: 'SOLD_OUT', message: `商品已售罄：${product.name}`, retryable: false } };
    }
    mockCartSeq += 1;
    mockCart.push({ cartItemId: `mock_cart_${Date.now()}_${mockCartSeq}`, ...product, quantity: input.quantity });
    return { success: true, data: mockCartSummary(product, input.quantity) };
  }
  return {
    success: false,
    error: { code: 'ADD_TO_CART_FAILED', message: res.message ?? '加購失敗', retryable: false },
  };
}

async function invokeCheckout(env: string, sessionId: string): Promise<SkillResult<CheckoutOutput>> {
  const res: CloudResponse<CheckoutOutput> = await postContainer<CheckoutOutput>(
    env,
    '/api/skill/skill.shopping.mall/checkout',
    {},
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) {
    if (mockCart.length === 0) {
      return { success: false, error: { code: 'CART_EMPTY', message: '購物車為空，請先加購商品', retryable: false } };
    }
    const items = mockCart.map((it) => ({ sku: it.productId, name: it.name, quantity: it.quantity, amountCent: it.priceCent * it.quantity }));
    const amountCent = items.reduce((s, it) => s + it.amountCent, 0);
    mockCart.length = 0; // 結算成功清空
    return {
      success: true,
      data: { orderId: `mock_shop_${Date.now()}`, items, amountCent, status: 'pending_payment' },
    };
  }
  return {
    success: false,
    error: { code: 'CHECKOUT_FAILED', message: res.message ?? '結算失敗', retryable: false },
  };
}

function mockSearch(input: SearchProductsInput): SearchProductsOutput {
  const kw = input.keyword?.trim() ?? '';
  const cat = input.category?.trim() ?? '';
  let list = MOCK_PRODUCTS;
  if (kw) list = list.filter((p) => p.name.includes(kw) || p.category.includes(kw));
  if (cat) list = list.filter((p) => p.category.includes(cat));
  const products = list.slice(0, input.limit ?? 6);
  const priceCentByProduct: Record<string, number> = {};
  for (const p of products) priceCentByProduct[p.productId] = p.priceCent;
  return { products, priceCentByProduct };
}

function mockCartSummary(product: Product, quantity: number): AddToCartOutput {
  const cartCount = mockCart.reduce((s, it) => s + it.quantity, 0);
  const cartAmountCent = mockCart.reduce((s, it) => s + it.priceCent * it.quantity, 0);
  return {
    cartItemId: mockCart[mockCart.length - 1].cartItemId,
    productId: product.productId,
    name: product.name,
    quantity,
    priceCent: product.priceCent,
    cartCount,
    cartAmountCent,
  };
}
