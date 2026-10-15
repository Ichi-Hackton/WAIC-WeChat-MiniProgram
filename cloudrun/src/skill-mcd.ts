/**
 * 麥當勞點餐 SKILL 端點（skill.food.mcdonalds）
 *
 * 端點（與小程序端 mcdonalds SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.food.mcdonalds/search_mcd_store
 *   POST /api/skill/skill.food.mcdonalds/query_mcd_menu
 *   POST /api/skill/skill.food.mcdonalds/place_mcd_order
 *   POST /api/skill/skill.food.mcdonalds/query_mcd_order
 *   POST /api/skill/skill.food.mcdonalds/cancel_mcd_order
 *
 * 資料來源：麥當勞中國官方 MCP（https://mcp.mcd.cn，Streamable HTTP +
 * Bearer Token 鑑權，限流 600 次/分；open.mcd.cn 手機號即可申請 Token）。
 *
 * 協議特性（2026-10-14 實測，區別於 12306-mcp / Tripmatch）：
 *   1. 無狀態服務：不返回 Mc-Session-Id，鑑權頭需隨每次請求攜帶
 *      （mcp-client.ts 已支持 extraHeaders）
 *   2. 業務錯誤不走協議 isError：tools/call 恆返回 isError=false，
 *      業務成敗在 text 內嵌 JSON 負載的 success 欄位（如城市名缺失
 *      返回 {"success":false,"code":600058,...}）
 *   3. text 為「展示指引 + JSON 負載 + 尾部提示」混合體，需括號平衡
 *      掃描提取 {"success":...} 完整 JSON（負載後還有 markdown 文本）
 *
 * 語義定位（區別於六域跳轉模式）：麥當勞 MCP 提供真實 create-order
 * 能力（返回訂單 + 支付鏈接），是首個「真實下單」寫操作 SKILL——
 * 訂單在麥當勞側真實創建，支付由用戶掃碼 / 跳麥當勞 App 完成（未
 * 支付前可 cancel-order，rollback 語義真實可達）。訂單落庫 MySQL
 * （db.ts domain=mcd，x-wx-openid 歸屬鑒權）。
 *
 * 降級策略：查詢類（門市 / 菜單）MCP 不可用時降級確定性模擬（離線
 * 演示可用）；寫操作（下單 / 取消 / 查單）**不降級**——真實交易鏈路
 * 嚴禁模擬數據，一律業務 503 如實透傳。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';
import { callMcpTool } from './mcp-client';
import { createOrder, getOrder, cancelOrder } from './db';

/** 麥當勞 MCP 服務端點（open.mcd.cn 申請 Token） */
const MCD_MCP_URL = process.env.MCD_MCP_URL ?? 'https://mcp.mcd.cn';

/** 單次工具調用超時（官方限流 600 次/分，正常回應秒級；預留長尾） */
const MCD_TIMEOUT_MS = 20_000;

/** 業務性錯誤（success=false / Token 無效 / 限流）：呼叫方應如實透傳 */
class McdToolError extends Error {}

/* ==================== 混合文本 → JSON 負載提取 ==================== */

/**
 * 從麥當勞工具回傳的混合文本中提取 {"success":...} JSON 負載
 *
 * 回傳形態（實測）：markdown 展示指引 + 單個 JSON 對象 + 尾部 markdown，
 * JSON 之後仍有文本，故不能簡單「從首個 { 截到尾」——以括號平衡掃描
 * （處理字串內花括號與反斜線轉義）截出完整 JSON 文檔。
 * @returns 解析後的負載物件；無法定位 / 解析時返回 null（連線層語義，呼叫方降級）
 */
function extractMcdPayload(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{"success"');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 呼叫麥當勞 MCP 工具並返回 data 負載
 *
 * @throws McdToolError 業務性錯誤（success=false / 401 / 429），呼叫方應如實透傳
 * @throws Error        連線層失敗（不可達 / 超時 / 負載無法解析），呼叫方按域分流降級
 */
async function mcdCall(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const token = process.env.MCD_MCP_TOKEN;
  if (!token) {
    // 憑證未配置屬部署問題而非業務失敗：以業務性錯誤透傳（查詢域呼叫方降級模擬）
    throw new McdToolError('麥當勞 MCP Token 未配置（MCD_MCP_TOKEN）');
  }
  const text = await callMcpTool(MCD_MCP_URL, tool, args, MCD_TIMEOUT_MS, {
    Authorization: `Bearer ${token}`,
  });
  const payload = extractMcdPayload(text);
  if (!payload) {
    throw new Error(`麥當勞 MCP 工具 ${tool} 回應無法解析：${text.slice(0, 120)}`);
  }
  if (payload.success !== true) {
    const code = typeof payload.code === 'number' ? payload.code : '';
    const message = typeof payload.message === 'string' ? payload.message : '未知業務錯誤';
    throw new McdToolError(`麥當勞業務失敗（${code}）：${message.slice(0, 160)}`);
  }
  return payload.data;
}

/** 未知形態的 MCP data 負載 → 物件窄化（非物件形態統一為空物件） */
function asObj(data: unknown): Record<string, unknown> {
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/* ==================== 查店：query-nearby-stores ==================== */

interface SearchStoreInput {
  city?: string;
  /** 搜尋關鍵詞（商圈 / 地標，如「國貿」）；缺省以城市名充當（2026-10-14
   * 實測：searchType=2 要求 city + keyword + latitude + longitude 四者齊全，
   * 少任一即 600058「城市名或者關鍵詞不能為空」） */
  keyword?: string;
  lat?: number;
  lng?: number;
  /** 到店自提（預設）或得來速車道取餐 */
  pickupType?: 'in_store' | 'drive_thru';
  limit?: number;
}

/** query-nearby-stores 單條門店記錄（僅聲明用到的欄位） */
interface McdStore {
  storeCode?: string;
  storeName?: string;
  address?: string;
  distance?: number;
  beCode?: string;
  businessStatus?: boolean;
  businessStartTime?: string;
  businessEndTime?: string;
  reservation?: boolean;
}

const handleSearchStore: RouteHandler = async (body) => {
  const input = (body ?? {}) as SearchStoreInput;
  if (!input.city) {
    return badRequest('city 必填');
  }

  try {
    const data = await mcdCall('query-nearby-stores', {
      beType: input.pickupType === 'drive_thru' ? 5 : 1,
      searchType: 2, // 按位置搜索：四參數齊全才不報 600058（見 SearchStoreInput.keyword 註解）
      city: input.city,
      keyword: input.keyword ?? input.city,
      latitude: input.lat ?? 39.9087, // 北京國貿兜底座標（規劃器已注入用戶定位，此處僅防缺省）
      longitude: input.lng ?? 116.4575,
    });
    const raw = Array.isArray(data) ? (data as McdStore[]) : [];
    const stores = raw
      .filter((s) => typeof s.storeCode === 'string' && s.storeCode)
      .slice(0, Math.min(Math.max(input.limit ?? 5, 1), 20))
      .map((s) => ({
        storeId: s.storeCode as string,
        name: s.storeName ?? '',
        address: s.address ?? '',
        distanceM: typeof s.distance === 'number' ? s.distance : 0,
        beCode: s.beCode ?? '',
        openNow: s.businessStatus === true,
        businessHours:
          typeof s.businessStartTime === 'string' && typeof s.businessEndTime === 'string'
            ? `${s.businessStartTime}-${s.businessEndTime}`
            : '',
      }));
    return ok({ city: input.city, stores, source: 'mcd_realtime' });
  } catch (e) {
    if (e instanceof McdToolError) {
      return fail(503, e.message.slice(0, 200));
    }
    // 連線層失敗：降級確定性模擬（查店為只讀演示，不產生交易風險）
    console.error('[skill-mcd] 門市查詢不可用，降級模擬數據：', e instanceof Error ? e.message : e);
  }

  const stores = [1, 2, 3].map((i) => ({
    storeId: `mcd_00${i}`,
    name: `${input.city}麥當勞中心餐廳 ${i} 號店`,
    address: `${input.city}中山路 ${i * 100} 號`,
    distanceM: 300 * i,
    beCode: '',
    openNow: true,
    businessHours: '07:00-22:00',
  }));
  return ok({ city: input.city, stores, source: 'mock_deterministic' });
};

/* ==================== 查菜單：query-meals ==================== */

interface QueryMenuInput {
  storeId?: string;
  /** 到店（orderType=1）或外送（orderType=2）；MVP 僅支持到店（外送需地址鏈路） */
  orderType?: 'in_store' | 'delivery';
}

const handleQueryMenu: RouteHandler = async (body) => {
  const input = (body ?? {}) as QueryMenuInput;
  if (!input.storeId) {
    return badRequest('storeId 必填');
  }
  if (input.orderType === 'delivery') {
    return badRequest('外送場景需先建立配送地址（MVP 暫僅支持到店點餐）');
  }

  try {
    const data = await mcdCall('query-meals', {
      storeCode: input.storeId,
      orderType: 1, // 到店（含到店自取 + 得來速）
      beType: 1, // 到店取餐不攜帶 beCode（官方契約：攜帶反而報錯）
    });
    const d = asObj(data);
    const categories = (Array.isArray(d.categories) ? d.categories : []).slice(0, 10).map((c) => {
      const cat = asObj(c);
      const meals = (Array.isArray(cat.meals) ? cat.meals : []).slice(0, 12).map((m) => {
        const meal = asObj(m);
        return {
          code: typeof meal.code === 'string' ? meal.code : '',
          tags: Array.isArray(meal.tags) ? (meal.tags as unknown[]).map(String) : [],
        };
      });
      return { name: typeof cat.name === 'string' ? cat.name : '', meals };
    });
    return ok({ storeId: input.storeId, categories, source: 'mcd_realtime' });
  } catch (e) {
    if (e instanceof McdToolError) {
      return fail(503, e.message.slice(0, 200));
    }
    console.error('[skill-mcd] 菜單查詢不可用，降級模擬數據：', e instanceof Error ? e.message : e);
  }

  // 確定性模擬菜單（code 為演示編碼；真實路徑的金額由 place_mcd_order 試算核實）
  const categories = [
    { name: '人氣熱賣', meals: [{ code: 'demo_9900016081', tags: ['心形薯餅同款比心'] }, { code: 'demo_9900004064', tags: ['爆款'] }] },
    { name: '漢堡', meals: [{ code: 'demo_9900016075', tags: ['濃郁奶香拉絲芝士'] }, { code: 'demo_9900016073', tags: ['韓式辣椒黃油風味'] }] },
  ];
  return ok({ storeId: input.storeId, categories, source: 'mock_deterministic' });
};

/* ==================== 下單：calculate-price → create-order ==================== */

interface PlaceOrderInput {
  storeId?: string;
  /** 得來速門市需攜帶 beCode（查店結果透傳）；到店自提不傳 */
  beCode?: string;
  /** 待購餐品；缺省時自動選「人氣熱賣」首品（演示 / 模糊點單路徑） */
  items?: Array<{ productCode?: string; quantity?: number }>;
  /** 堂食（預設）或店內自提外帶；取值為 calculate-price 返回的 takeWayList[].code */
  takeWay?: string;
  needTableware?: boolean;
}

/** calculate-price / create-order 回應的共用明細結構（僅聲明用到的欄位） */
interface McdPriceData {
  price?: number; // 應付總價（分）
  originalPrice?: number;
  discount?: number;
  productList?: Array<{ productCode?: string; productName?: string; quantity?: number; subtotal?: number }>;
  takeWayList?: Array<{ code?: string; title?: string; subtitle?: string }>;
}

/**
 * 下單前試算（金額同源核實，與 train 域「查價即下單價」原則對齊）：
 * 返回應付總價（分）+ 餐品名稱明細 + 取餐方式列表。
 * @throws McdToolError 業務性錯誤（門市不可用 / 餐品下架等）
 */
async function calcPrice(
  storeCode: string,
  items: Array<{ productCode: string; quantity: number }>,
): Promise<McdPriceData> {
  return asObj(
    await mcdCall('calculate-price', {
      storeCode,
      orderType: 1,
      beType: 1,
      items: items.map((it) => ({ productCode: it.productCode, quantity: it.quantity })),
    }),
  ) as McdPriceData;
}

/**
 * 從 create-order 回應防禦式提取訂單關鍵欄位
 *
 * 官方工具聲明「返回訂單詳情與支付鏈接」，但欄位名未在 schema 列出
 * （2026-10-14 未做真實下單探測）——按常見命名逐一試探，全部未命中
 * 時把原始 data 附在 mcdRaw 供排查與後續契約修正。
 */
function pickOrderFields(data: unknown): { mcdOrderId: string; payUrl: string } {
  const d = asObj(data);
  // 試探清單元素型態為 unknown：以型別守衝謂詞窄化為 string（TS 對 unknown[].find
  // 不做隱式窄化，顯式 v is string 才能賦值給 string 欄位）
  const orderId =
    [d.orderId, d.orderNo, d.order_id, asObj(d.orderInfo).orderId, asObj(d.orderDetail).orderId]
      .find((v): v is string => typeof v === 'string' && v.length > 0) ?? '';
  const payObj = [asObj(d.payInfo), asObj(d.payment)].find((p) => Object.keys(p).length > 0) ?? {};
  const payUrl =
    [d.payUrl, d.payLink, d.paymentUrl, payObj.payUrl, payObj.payLink, payObj.url]
      .find((v): v is string => typeof v === 'string' && v.length > 0) ?? '';
  return { mcdOrderId: orderId, payUrl };
}

const handlePlaceOrder: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as PlaceOrderInput;
  if (!input.storeId) {
    return badRequest('storeId 必填');
  }
  // 歸屬鑒權：寫操作必須攜帶雲托管注入的調用方身份（規範 § 10 SKILL 越權防護）
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕下單');
  }

  let items = (input.items ?? [])
    .filter((it) => typeof it.productCode === 'string' && it.productCode && typeof it.quantity === 'number' && it.quantity >= 1)
    .map((it) => ({ productCode: it.productCode as string, quantity: it.quantity as number }));

  let autoPicked = false;
  try {
    // 未指定餐品：自動取「人氣熱賣」分類首品（規則規劃器「幫我點份麥當勞」的兜底路徑，
    // 卡面與 copyText 會如實標註自動選品，不冒充用戶指定）
    if (items.length === 0) {
      const menuData = asObj(
        await mcdCall('query-meals', { storeCode: input.storeId, orderType: 1, beType: 1 }),
      );
      const firstCat = asObj((Array.isArray(menuData.categories) ? menuData.categories : [])[0]);
      const firstMeal = asObj((Array.isArray(firstCat.meals) ? firstCat.meals : [])[0]);
      if (typeof firstMeal.code !== 'string' || !firstMeal.code) {
        return fail(503, '菜單暫不可用，無法自動選品，請指定餐品編碼後重試');
      }
      items = [{ productCode: firstMeal.code, quantity: 1 }];
      autoPicked = true;
    }

    // ① 試算：核實金額 + 取餐方式（takeWayCode 必須取自 takeWayList）
    const priceData = await calcPrice(input.storeId, items);
    const amountCent = typeof priceData.price === 'number' ? priceData.price : 0;
    const takeWayList = Array.isArray(priceData.takeWayList) ? priceData.takeWayList : [];
    const matched = takeWayList.find((t) => typeof t.code === 'string' && t.code === input.takeWay);
    const takeWayCode = (matched ?? takeWayList[0])?.code;
    if (!takeWayCode) {
      return fail(503, '上游未返回可用取餐方式（takeWayList 為空），暫不能下單');
    }

    // ② 真實創建訂單（未支付狀態；支付由用戶掃碼 / 跳麥當勞 App 完成）
    const orderData = await mcdCall('create-order', {
      storeCode: input.storeId,
      orderType: 1,
      beType: 1,
      items: items.map((it) => ({ productCode: it.productCode, quantity: it.quantity })),
      takeWayCode,
      ...(typeof input.needTableware === 'boolean' ? { needTableware: input.needTableware } : {}),
    });
    const { mcdOrderId, payUrl } = pickOrderFields(orderData);
    if (!mcdOrderId) {
      // 訂單號是後續查單 / 取消的唯一鑰匙，缺失即視為下單失敗（不留半單）
      console.error('[skill-mcd] create-order 回應未識別訂單號，原始數據：', JSON.stringify(orderData).slice(0, 400));
      return fail(503, '上游訂單回應格式未識別（缺少訂單號），請稍後重試');
    }

    // ③ 本地落庫（pending_external：真實支付在麥當勞側完成，本端留存供查單 / 取消 / 行程回溯）
    const orderId = `mcd_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const productList = Array.isArray(priceData.productList) ? priceData.productList : [];
    const detail = items.map((it, i) => ({
      productCode: it.productCode,
      productName: productList[i]?.productName ?? it.productCode,
      quantity: it.quantity,
    }));
    const takeWayLabel = (matched ?? takeWayList[0])?.title ?? takeWayCode;
    await createOrder({
      orderId,
      owner: ctx.openid,
      domain: 'mcd',
      status: 'pending_external',
      payload: {
        mcdOrderId,
        storeId: input.storeId,
        items: detail,
        amountCent,
        takeWayCode,
        takeWayLabel,
        ...(payUrl ? { payUrl } : {}),
      },
      createdAt: Date.now(),
    });

    return ok({
      orderId,
      mcdOrderId,
      storeId: input.storeId,
      items: detail,
      amountCent,
      status: 'pending_external',
      takeWay: takeWayLabel,
      autoPicked,
      ...(payUrl ? { payUrl } : {}),
      note: '訂單已在麥當勞真實創建（未支付）；請經支付鏈接或麥當勞 App 完成支付',
    });
  } catch (e) {
    // 寫操作不降級模擬：業務錯誤與連線失敗均如實透傳（真實交易嚴禁假數據）
    if (e instanceof McdToolError) {
      return fail(503, e.message.slice(0, 200));
    }
    console.error('[skill-mcd] 下單失敗：', e instanceof Error ? e.message : e);
    return fail(503, '麥當勞下單通道不可用，請稍後重試');
  }
};

/* ==================== 查單：query-order ==================== */

interface QueryOrderInput {
  orderId?: string;
}

const handleQueryOrder: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as QueryOrderInput;
  if (!input.orderId) {
    return badRequest('orderId 必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕查單');
  }
  const order = await getOrder(input.orderId);
  // 歸屬鑒權（防 IDOR）：本地訂單號可枚舉，僅本人可查
  // （與取消口徑一致，他人訂單一律 404 不泄漏存在性）
  if (!order || order.domain !== 'mcd' || order.owner !== ctx.openid) {
    return fail(404, `訂單不存在：${input.orderId}`);
  }

  try {
    const mcdOrderId = typeof order.payload.mcdOrderId === 'string' ? order.payload.mcdOrderId : '';
    const data = asObj(await mcdCall('query-order', { orderId: mcdOrderId }));
    // 麥當勞訂單狀態欄位名未知（同 pickOrderFields 的防禦式契約）：試探常見命名，
    // 未命中時透傳上游原始 data 的淺層字串化摘要，保證查單可用
    const statusVal = [data.orderStatus, data.status, asObj(data.orderInfo).status].find(
      (v) => typeof v === 'string' && v,
    ) as string | undefined;
    return ok({
      orderId: order.orderId,
      mcdOrderId,
      localStatus: order.status,
      mcdStatus: statusVal ?? '未知（上游欄位待契約核實）',
      mcdRawKeys: Object.keys(data).slice(0, 12),
      amountCent: typeof order.payload.amountCent === 'number' ? order.payload.amountCent : 0,
    });
  } catch (e) {
    if (e instanceof McdToolError) {
      return fail(503, e.message.slice(0, 200));
    }
    console.error('[skill-mcd] 查單失敗：', e instanceof Error ? e.message : e);
    return fail(503, '麥當勞查單通道不可用，請稍後重試');
  }
};

/* ==================== 取消：cancel-order ==================== */

interface CancelInput {
  orderId?: string;
  /** 麥當勞取消原因碼：1=改主意了（預設）2=重複下單 3=點錯了 4=地址/電話填錯 5=送達時間選錯 -1=其它 */
  reasonCode?: number;
}

const handleCancelOrder: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CancelInput;
  if (!input.orderId) {
    return badRequest('orderId 必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕取消');
  }
  const order = await getOrder(input.orderId);
  if (!order || order.domain !== 'mcd') {
    return fail(404, `訂單不存在或已取消：${input.orderId}`);
  }
  // 歸屬前置鑒權（防 IDOR）：必須先於上游取消——歸屬檢查若只靠
  // cancelOrder 歸檔層，越權請求已對他人訂單觸發真實上游取消後才被拒
  if (order.owner !== ctx.openid) {
    return forbidden('無權取消他人訂單');
  }

  try {
    const mcdOrderId = typeof order.payload.mcdOrderId === 'string' ? order.payload.mcdOrderId : '';
    await mcdCall('cancel-order', {
      orderId: mcdOrderId,
      cancelReasonCode: String(input.reasonCode ?? 1),
    });
  } catch (e) {
    if (e instanceof McdToolError) {
      // 上游取消被拒（如已支付 / 已出餐）：如實透傳，本地訂單不動
      return fail(503, e.message.slice(0, 200));
    }
    console.error('[skill-mcd] 取消失敗：', e instanceof Error ? e.message : e);
    return fail(503, '麥當勞取消通道不可用，請稍後重試');
  }

  // 本地歸檔（歸屬鑒權內建於 cancelOrder，雙重防線——前置檢查已攔越權）
  const result = await cancelOrder(input.orderId, ctx.openid);
  if (result === 'forbidden') {
    return forbidden('無權取消他人訂單');
  }
  return ok({ ok: true, orderId: input.orderId, status: 'cancelled' });
};

export const mcdRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.food.mcdonalds/search_mcd_store', handleSearchStore],
  ['POST /api/skill/skill.food.mcdonalds/query_mcd_menu', handleQueryMenu],
  ['POST /api/skill/skill.food.mcdonalds/place_mcd_order', handlePlaceOrder],
  ['POST /api/skill/skill.food.mcdonalds/query_mcd_order', handleQueryOrder],
  ['POST /api/skill/skill.food.mcdonalds/cancel_mcd_order', handleCancelOrder],
];
