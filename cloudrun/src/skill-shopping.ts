/**
 * 網購商城 SKILL 端點（skill.shopping.mall）
 *
 * 端點（與小程序端 shopping-mall SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.shopping.mall/search_products
 *   POST /api/skill/skill.shopping.mall/add_to_cart
 *   POST /api/skill/skill.shopping.mall/add_to_cart/remove   （rollback 專用）
 *   POST /api/skill/skill.shopping.mall/checkout
 *   POST /api/skill/skill.shopping.mall/checkout/cancel      （rollback 專用）
 *
 * 資料來源：MVP 階段為確定性演示商品表（六件商品覆蓋電子數碼 /
 * 日用百貨 / 食品 / 家用電器 / 運動戶外），正式版替換為電商開放
 * 平台（協議不變，僅內部實作，參照 skill-coffee 的分層降級模式）。
 *
 * 購物車與訂單存於記憶體 Map（重啟丟失、實例間不共享，正式版應落庫），
 * 以 x-wx-openid 歸屬鑒權（防越權讀改他人購物車，規範 § 10）。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';

/** 演示商品表（確定性：離線演示與自動化驗證可復現） */
interface Product {
  productId: string;
  name: string;
  category: string;
  priceCent: number;
  stock: number;
  rating: number;
}

const PRODUCTS: Product[] = [
  { productId: 'p_001', name: '無線降噪耳機 Pro', category: '電子數碼', priceCent: 129900, stock: 12, rating: 4.8 },
  { productId: 'p_002', name: '智能手錶 S6', category: '電子數碼', priceCent: 199900, stock: 5, rating: 4.7 },
  { productId: 'p_003', name: '恆溫保溫杯 500ml', category: '日用百貨', priceCent: 8900, stock: 66, rating: 4.6 },
  { productId: 'p_004', name: '精品咖啡豆 1kg', category: '食品', priceCent: 12800, stock: 30, rating: 4.9 },
  { productId: 'p_005', name: '頸部按摩儀', category: '家用電器', priceCent: 29900, stock: 8, rating: 4.5 },
  { productId: 'p_006', name: '輕量跑步鞋', category: '運動戶外', priceCent: 49900, stock: 0, rating: 4.4 },
];

/** 記憶體購物車：openid → 已加購明細（cartItemId 全域遞增保證唯一） */
const carts = new Map<string, Array<{ cartItemId: string; productId: string; name: string; quantity: number; priceCent: number }>>();

/** 記憶體訂單表（owner 用於歸屬鑒權與 rollback 取消） */
const shopOrders = new Map<string, { owner: string; amountCent: number; items: Array<{ sku: string; name: string; quantity: number; amountCent: number }>; createdAt: number }>();

/** 購物車明細 ID 序號（進程內遞增） */
let cartSeq = 0;

interface SearchProductsInput {
  keyword?: string;
  category?: string;
  limit?: number;
}

const handleSearchProducts: RouteHandler = async (body) => {
  const input = (body ?? {}) as SearchProductsInput;
  const kw = input.keyword?.trim() ?? '';
  const cat = input.category?.trim() ?? '';

  let list = PRODUCTS;
  if (kw) {
    // 關鍵詞同時比對商品名與類目（「電子」「耳機」都能命中）
    list = list.filter((p) => p.name.includes(kw) || p.category.includes(kw));
  }
  if (cat) {
    list = list.filter((p) => p.category.includes(cat));
  }
  const products = list.slice(0, Math.min(Math.max(input.limit ?? 6, 1), 20));

  // 與 search_train 的 priceCentByTrain 同構：後續任務以
  // inputBindings 取即時價，checkpoint 彈窗得以在確認前展示真實金額
  const priceCentByProduct: Record<string, number> = {};
  for (const p of products) priceCentByProduct[p.productId] = p.priceCent;

  return ok({ products, priceCentByProduct });
};

interface AddToCartInput {
  productId?: string;
  quantity?: number;
}

const handleAddToCart: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as AddToCartInput;
  if (!input.productId) {
    return badRequest('productId 必填');
  }
  if (typeof input.quantity !== 'number' || input.quantity < 1 || input.quantity > 99) {
    return badRequest('quantity 必須為 1-99 的整數');
  }
  // 歸屬鑒權：寫操作必須攜帶雲托管注入的調用方身份（規範 § 10）
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕加購');
  }
  const product = PRODUCTS.find((p) => p.productId === input.productId);
  if (!product) {
    return fail(404, `商品不存在：${input.productId}`);
  }
  if (product.stock <= 0) {
    return fail(409, `商品已售罄：${product.name}`);
  }

  const cart = carts.get(ctx.openid) ?? [];
  cartSeq += 1;
  const cartItemId = `cart_${Date.now()}_${cartSeq}`;
  cart.push({ cartItemId, productId: product.productId, name: product.name, quantity: input.quantity, priceCent: product.priceCent });
  carts.set(ctx.openid, cart);

  const cartCount = cart.reduce((s, it) => s + it.quantity, 0);
  const cartAmountCent = cart.reduce((s, it) => s + it.priceCent * it.quantity, 0);

  return ok({
    cartItemId,
    productId: product.productId,
    name: product.name,
    quantity: input.quantity,
    priceCent: product.priceCent,
    cartCount,
    cartAmountCent,
  });
};

interface RemoveCartItemInput {
  cartItemId?: string;
}

/** rollback 專用：從調用方購物車移除指定明細 */
const handleRemoveCartItem: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as RemoveCartItemInput;
  if (!input.cartItemId) {
    return badRequest('cartItemId 必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕移除');
  }
  const cart = carts.get(ctx.openid);
  if (!cart) {
    return fail(404, `購物車明細不存在：${input.cartItemId}`);
  }
  const idx = cart.findIndex((it) => it.cartItemId === input.cartItemId);
  if (idx < 0) {
    return fail(404, `購物車明細不存在：${input.cartItemId}`);
  }
  cart.splice(idx, 1);
  return ok({ ok: true, cartItemId: input.cartItemId });
};

interface CheckoutInput {
  /** 預留：合併支付場景由 AI 專屬卡承接，此處僅收單 */
  remark?: string;
}

const handleCheckout: RouteHandler = async (body, ctx) => {
  void body as CheckoutInput | undefined;
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕結算');
  }
  const cart = carts.get(ctx.openid) ?? [];
  if (cart.length === 0) {
    return fail(409, '購物車為空，請先加購商品');
  }

  const items = cart.map((it) => ({
    sku: it.productId,
    name: it.name,
    quantity: it.quantity,
    amountCent: it.priceCent * it.quantity,
  }));
  const amountCent = items.reduce((s, it) => s + it.amountCent, 0);
  const orderId = `shop_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  shopOrders.set(orderId, { owner: ctx.openid, amountCent, items, createdAt: Date.now() });
  carts.delete(ctx.openid); // 結算成功清空購物車

  return ok({ orderId, items, amountCent, status: 'pending_payment' });
};

interface CancelOrderInput {
  orderId?: string;
}

/** rollback 專用：取消尚未支付的購物訂單 */
const handleCancelOrder: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CancelOrderInput;
  if (!input.orderId) {
    return badRequest('orderId 必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕取消');
  }
  const order = shopOrders.get(input.orderId);
  if (!order) {
    return fail(404, `訂單不存在或已取消：${input.orderId}`);
  }
  // 歸屬鑒權：僅訂單擁有者可取消（防 IDOR）
  if (order.owner !== ctx.openid) {
    return forbidden('無權取消他人訂單');
  }
  shopOrders.delete(input.orderId);
  return ok({ ok: true, orderId: input.orderId });
};

export const shoppingRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.shopping.mall/search_products', handleSearchProducts],
  ['POST /api/skill/skill.shopping.mall/add_to_cart', handleAddToCart],
  ['POST /api/skill/skill.shopping.mall/add_to_cart/remove', handleRemoveCartItem],
  ['POST /api/skill/skill.shopping.mall/checkout', handleCheckout],
  ['POST /api/skill/skill.shopping.mall/checkout/cancel', handleCancelOrder],
];
