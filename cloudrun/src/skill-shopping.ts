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
 * 2026-10 真實渠道上線（資料層重寫）：
 *   search_products —— 京東聯盟 + 淘寶聯盟雙渠道真實商品聚合（任一渠道
 *     失敗跳過、雙渠道均不可用時誠實失敗 503，不提供演示目錄）
 *   add_to_cart     —— 心願單（落庫 shop_cart 域；真實商品不校驗庫存，
 *     聯盟無實時庫存，以渠道頁面為準）
 *   checkout        —— 轉鏈跳轉模式：京東商品經聯盟轉鏈取小程序跳轉
 *     指令（jCommand），淘寶商品生成淘口令複製；訂單 status=
 *     'pending_external' 落庫，真實下單支付在京東 / 淘寶側完成
 *
 * 購物車明細與訂單均落庫 MySQL（db.ts，重啟不丟），以 x-wx-openid
 * 歸屬鑒權（規範 § 10）。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';
import { createOrder, getOrder, cancelOrder, deleteOrder, listOrders } from './db';
import { buildJump, type JumpTargetKey } from './external-jump';
import { jdConfigured, searchJdGoods, jdPromotion, JdUnionError } from './union-jd';
import { tbConfigured, searchTbGoods, tbkTpwd } from './union-taobao';

/** 歸一化商品（雙渠道聯盟同構） */
interface Product {
  productId: string;
  name: string;
  category: string;
  priceCent: number;
  stock: number;
  rating: number;
  /** 商品所屬渠道 */
  channel: 'jd' | 'taobao';
  shop: string;
  /** 商品落地頁（轉鏈 / 淘口令入參） */
  jumpUrl: string;
}

interface SearchProductsInput {
  keyword?: string;
  category?: string;
  limit?: number;
}

const handleSearchProducts: RouteHandler = async (body) => {
  const input = (body ?? {}) as SearchProductsInput;
  const kw = input.keyword?.trim() ?? '';
  const cat = input.category?.trim() ?? '';
  const limit = Math.min(Math.max(input.limit ?? 6, 1), 20);

  // 雙渠道並行真實查詢：任一渠道失敗跳過（記日誌），雙渠道聚合去重截斷
  const sources: string[] = [];
  const collected: Product[] = [];

  if (jdConfigured()) {
    try {
      const jd = await searchJdGoods(kw || cat || '好物', limit);
      collected.push(...jd);
      if (jd.length > 0) sources.push('jd');
    } catch (e) {
      console.error('[skill-shopping] 京東渠道不可用，跳過：', e instanceof Error ? e.message : e);
    }
  }
  if (tbConfigured()) {
    try {
      const tb = await searchTbGoods(kw || cat || '好物', limit);
      collected.push(...tb);
      if (tb.length > 0) sources.push('taobao');
    } catch (e) {
      console.error('[skill-shopping] 淘寶渠道不可用，跳過：', e instanceof Error ? e.message : e);
    }
  }

  // 雙渠道均未命中（未配置憑證 / 連線失敗 / 零結果）→ 誠實失敗：
  // 2026-10 技能收斂後不再提供演示目錄（真實或失敗，不演）
  if (collected.length === 0) {
    return fail(503, '購物渠道暫不可用（聯盟憑證未配置或連線失敗），請稍後再試');
  }

  const products = collected.slice(0, limit);
  const priceCentByProduct: Record<string, number> = {};
  for (const p of products) priceCentByProduct[p.productId] = p.priceCent;

  return ok({ products, priceCentByProduct, source: sources.join('+') });
};

/** 依 productId 前缀判別渠道（歷史演示前綴 p_ 不再識別，回商品不存在） */
function channelOf(productId: string): 'jd' | 'taobao' | null {
  if (productId.startsWith('jd_')) return 'jd';
  if (productId.startsWith('tb_')) return 'taobao';
  return null;
}

/** 購物車明細結構（shop_cart 域 payload） */
interface CartItemPayload {
  productId: string;
  name: string;
  quantity: number;
  priceCent: number;
  /** 'demo' 僅為歷史落庫數據的寬容值（演示目錄已於 2026-10 摘除） */
  channel: 'jd' | 'taobao' | 'demo';
  jumpUrl: string;
}

/** shop_cart 域 payload 窄化（寬容：畸形欄位回預設值，記憶體 / JSON 兩形態通用） */
function asCartPayload(raw: Record<string, unknown>): CartItemPayload {
  return {
    productId: typeof raw.productId === 'string' ? raw.productId : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    quantity: typeof raw.quantity === 'number' && raw.quantity > 0 ? raw.quantity : 1,
    priceCent: typeof raw.priceCent === 'number' && raw.priceCent >= 0 ? raw.priceCent : 0,
    channel: raw.channel === 'jd' || raw.channel === 'taobao' || raw.channel === 'demo' ? raw.channel : 'demo',
    jumpUrl: typeof raw.jumpUrl === 'string' ? raw.jumpUrl : '',
  };
}

interface AddToCartInput {
  productId?: string;
  quantity?: number;
  /** 真實商品名（規劃鏈路透傳，心願單展示用） */
  name?: string;
  /** 查詢時即時價（分，估算展示用；結算以渠道頁為準） */
  priceCent?: number;
  /** 商品落地頁（checkout 轉鏈入參） */
  jumpUrl?: string;
}

/** 心願單條目序號（進程內遞增，跨實例由 orderId 時間戳保唯一） */
let cartSeq = 0;

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

  const channel = channelOf(input.productId);
  if (!channel) {
    return fail(404, `商品不存在：${input.productId}`);
  }
  // 真實商品：聯盟無實時庫存，價格以結算時渠道頁為準；名稱 / 價格由
  // 規劃鏈路 inputBindings 帶入（add_to_cart 入參擴展 name / priceCent）
  const priceCent = typeof input.priceCent === 'number' && input.priceCent > 0 ? input.priceCent : 0;
  await addToCartStore(ctx.openid, {
    productId: input.productId,
    name: input.name?.trim() || input.productId,
    quantity: input.quantity,
    priceCent,
    channel,
    jumpUrl: input.jumpUrl?.trim() ?? '',
  });
  return cartSummary(ctx.openid, input.productId, input.quantity);
};

/** 心願單落庫（shop_cart 域單條記錄 = 一條明細） */
async function addToCartStore(owner: string, payload: CartItemPayload): Promise<string> {
  cartSeq += 1;
  const cartItemId = `cart_${Date.now()}_${cartSeq}`;
  await createOrder({
    orderId: cartItemId,
    owner,
    domain: 'shop_cart',
    status: 'pending_external',
    payload: { ...payload },
    createdAt: Date.now(),
  });
  return cartItemId;
}

/** 回應加購結果（含當前心願單彙總） */
async function cartSummary(owner: string, productId: string, quantity: number): Promise<ReturnType<typeof ok>> {
  const cart = await listOrders(owner, 'shop_cart');
  const latest = cart[0] ? asCartPayload(cart[0].payload) : undefined;
  let cartCount = 0;
  let cartAmountCent = 0;
  for (const it of cart) {
    const p = asCartPayload(it.payload);
    cartCount += p.quantity;
    cartAmountCent += p.priceCent * p.quantity;
  }
  return ok({
    cartItemId: cart[0]?.orderId ?? '',
    productId,
    name: latest?.name ?? productId,
    quantity,
    priceCent: latest?.priceCent ?? 0,
    cartCount,
    cartAmountCent,
  });
}

interface RemoveCartItemInput {
  cartItemId?: string;
}

/** rollback 專用：從心願單移除指定明細 */
const handleRemoveCartItem: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as RemoveCartItemInput;
  if (!input.cartItemId) {
    return badRequest('cartItemId 必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕移除');
  }
  const result = await deleteOrder(input.cartItemId, ctx.openid);
  if (result === 'not_found') {
    return fail(404, `購物車明細不存在：${input.cartItemId}`);
  }
  if (result === 'forbidden') {
    return forbidden('無權移除他人購物車明細');
  }
  return ok({ ok: true, cartItemId: input.cartItemId });
};

interface CheckoutAddress {
  receiverName?: string;
  receiverPhone?: string;
  region?: string;
  detail?: string;
}

interface CheckoutInput extends CheckoutAddress {
  remark?: string;
}

/** checkout 逐商品跳轉項（jumps 陣列元素，前端跳轉卡渲染依據） */
interface JumpItem {
  channel: JumpTargetKey;
  name: string;
  /** miniapp = 跳小程序；copy = 僅複製（淘口令 / 轉鏈降級 / 演示） */
  action: 'miniapp' | 'copy';
  appId?: string;
  jCommand?: string;
  copyText: string;
}

const handleCheckout: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CheckoutInput;
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕結算');
  }
  const cart = await listOrders(ctx.openid, 'shop_cart');
  if (cart.length === 0) {
    return fail(409, '購物車為空，請先加購商品');
  }

  const items = cart.map((it) => {
    const p = asCartPayload(it.payload);
    return {
      sku: p.productId,
      name: p.name,
      quantity: p.quantity,
      amountCent: p.priceCent * p.quantity,
      channel: p.channel,
      jumpUrl: p.jumpUrl,
    };
  });
  // 估算金額僅供展示：真實價格以京東 / 淘寶結算頁為準（聯盟價可能浮動）
  const amountCent = items.reduce((s, it) => s + it.amountCent, 0);
  const orderId = `shop_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // 收貨地址：僅記錄備用（真實收貨地址在京東 / 淘寶下單時填寫）
  const address: CheckoutAddress | undefined = input.receiverName
    ? { receiverName: input.receiverName, receiverPhone: input.receiverPhone, region: input.region, detail: input.detail }
    : undefined;

  // 逐商品生成跳轉項：京東轉鏈（失敗降級複製連結）/ 淘寶淘口令 / 演示僅清單
  const jumps: JumpItem[] = [];
  for (const it of items) {
    if (it.channel === 'jd' && it.jumpUrl && jdConfigured()) {
      try {
        const promo = await jdPromotion(it.jumpUrl);
        const jump = buildJump('jd', `${it.name} ¥${(it.amountCent / 100).toFixed(2)}`, { jCommand: promo.jCommand });
        jumps.push({
          channel: 'jd',
          name: it.name,
          action: promo.jCommand ? 'miniapp' : 'copy',
          ...(jump.appId ? { appId: jump.appId } : {}),
          ...(promo.jCommand ? { jCommand: promo.jCommand } : {}),
          copyText: promo.clickUrl ?? it.jumpUrl,
        });
        continue;
      } catch (e) {
        console.error('[skill-shopping] 京東轉鏈失敗，降級複製：', e instanceof JdUnionError ? e.message : e instanceof Error ? e.message : e);
      }
    }
    if (it.channel === 'taobao' && it.jumpUrl && tbConfigured()) {
      try {
        const tpwd = await tbkTpwd(it.jumpUrl, it.name);
        jumps.push({ channel: 'taobao', name: it.name, action: 'copy', copyText: `淘口令【${it.name.slice(0, 10)}】：${tpwd}，複製後打開淘寶 App 下單` });
        continue;
      } catch (e) {
        console.error('[skill-shopping] 淘口令生成失敗，降級複製連結：', e instanceof Error ? e.message : e);
      }
    }
    // 兕底：轉鏈失敗 / 歷史演示條目 → 複製明細（無真實跳轉）
    jumps.push({
      channel: 'none',
      name: it.name,
      action: 'copy',
      copyText: `${it.name} ×${it.quantity}（約 ¥${(it.amountCent / 100).toFixed(2)}）${it.jumpUrl ? ' ' + it.jumpUrl : ''}`,
    });
  }

  await createOrder({
    orderId,
    owner: ctx.openid,
    domain: 'shop',
    status: 'pending_external',
    payload: { items, amountCent, jumps, ...(address ? { address } : {}) },
    createdAt: Date.now(),
  });
  // 結算完成清空心願單（逐條刪除，歸屬即本人）
  for (const it of cart) await deleteOrder(it.orderId, ctx.openid);

  const summaryCopy = items.map((it) => `${it.name} ×${it.quantity}`).join('、');
  return ok({
    orderId,
    items,
    amountCent,
    status: 'pending_external',
    jumps,
    jump: buildJump(jumps[0]?.channel === 'jd' ? 'jd' : 'none', summaryCopy),
    ...(address ? { address } : {}),
  });
};

interface CancelOrderInput {
  orderId?: string;
}

/** rollback 專用：取消跳轉訂單（放棄購買） */
const handleCancelOrder: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CancelOrderInput;
  if (!input.orderId) {
    return badRequest('orderId 必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕取消');
  }
  const order = await getOrder(input.orderId);
  if (!order || order.domain !== 'shop') {
    return fail(404, `訂單不存在或已取消：${input.orderId}`);
  }
  // 歸屬鑒權：僅訂單擁有者可取消（防 IDOR）
  const result = await cancelOrder(input.orderId, ctx.openid);
  if (result === 'forbidden') {
    return forbidden('無權取消他人訂單');
  }
  return ok({ ok: true, orderId: input.orderId });
};

export const shoppingRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.shopping.mall/search_products', handleSearchProducts],
  ['POST /api/skill/skill.shopping.mall/add_to_cart', handleAddToCart],
  ['POST /api/skill/skill.shopping.mall/add_to_cart/remove', handleRemoveCartItem],
  ['POST /api/skill/skill.shopping.mall/checkout', handleCheckout],
  ['POST /api/skill/skill.shopping.mall/checkout/cancel', handleCancelOrder],
];
