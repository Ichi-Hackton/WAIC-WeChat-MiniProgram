/**
 * 滴滴出行打車 SKILL 端點（2026-10 國民級 App MCP 接入）
 *
 * 端點（與小程序端 ride-didi SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.ride.didi/estimate_ride —— 車型與價格預估
 *   POST /api/skill/skill.ride.didi/place_ride    —— 建立打車訂單（真實訂單！）
 *   POST /api/skill/skill.ride.didi/query_ride    —— 訂單狀態輪詢
 *   POST /api/skill/skill.ride.didi/place_ride/cancel —— 取消（rollback）
 *
 * 資料來源（兩層降級，端點協議不變）：
 *   1. 滴滴官方 MCP（https://mcp.didichuxing.com，Streamable HTTP +
 *      JSON-RPC 2.0，Key 走 URL query）：taxi_estimate / taxi_create_order /
 *      taxi_query_order / taxi_cancel_order / maps_textsearch。
 *      DIDI_MCP_KEY 已配置時啟用；DIDI_MCP_SANDBOX=1 時改走 sandbox
 *      端點（Mock 數據，不產生真實訂單，開發驗證用）
 *   2. 確定性模擬：未配置 Key / 連線層失敗時降級，保證離線演示可用
 *
 * 滴滴官方約束的落地（https://mcp.didichuxing.com/api）：
 *   - 經緯度一律字符串傳遞（數字參數觸發 -32010）
 *   - 坐標格式 lng,lat（經度在前）
 *   - taxi_create_order 產生真實訂單：上游文檔明令「下單前必須取得
 *     用戶確認，禁止自動下單」——由小程序端 SKILL meta 的
 *     requiresHumanConfirm=true 觸發 checkpoint 彈窗承擔，本端點
 *     收到請求即視為已確認
 *   - traceId 有時效性：過期（-32021）如實透傳業務失敗，引導重新預估
 *
 * 訂單落庫 MySQL（db.ts domain=ride），以 x-wx-openid 歸屬鑒權。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';
import { callMcpTool, callMcpToolStructured, McpToolError } from './mcp-client';
import { createOrder, getOrder, cancelOrder } from './db';

/** 滴滴 MCP 生產端點模板（Key 以 URL query 攜帶，官方接入方式） */
const DIDI_MCP_BASE = 'https://mcp.didichuxing.com';

/** 單次上游工具調用超時（官方長尾：估價含地圖解析可達 10s+） */
const DIDI_TIMEOUT_MS = 20_000;

/** 未配置 Key 時的降級提示僅記一次（避免每次調用刷屏） */
let mockLogged = false;

/** 取滴滴 MCP 端點（含 Key；未配置 Key 回 null → 呼叫方降級模擬） */
function didiEndpoint(): string | null {
  const key = process.env.DIDI_MCP_KEY;
  if (!key) {
    if (!mockLogged) {
      console.warn('[skill-didi] DIDI_MCP_KEY 未配置，打車能力降級為確定性模擬（離線演示）');
      mockLogged = true;
    }
    return null;
  }
  const sandbox = process.env.DIDI_MCP_SANDBOX === '1';
  return `${DIDI_MCP_BASE}/${sandbox ? 'mcp-servers-sandbox' : 'mcp-servers'}?key=${encodeURIComponent(key)}`;
}

/** 簡易確定性字串雜湊（模擬價格與穩定訂單號用，與 skill-train 同款） */
function stableHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/* ==================== 上游工具呼叫薄封裝 ==================== */

/** 滴地圖工具（maps_*）僅返回 content[0].text（JSON 字串），無 structuredContent */
async function didiMaps(endpoint: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const text = await callMcpTool(endpoint, tool, args, DIDI_TIMEOUT_MS);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new McpToolError(`滴滴地圖工具 ${tool} 回應無法解析：${text.slice(0, 160)}`);
  }
}

/** maps_textsearch 單條 POI 記錄（僅聲明用到的欄位） */
interface DidiPoi {
  display_name?: string;
  address?: string;
  city?: string;
  location?: { lng?: number; lat?: number };
}

/** 滴滴雙通道工具（taxi_*）的 structuredContent 形態（僅聲明用到的欄位） */
interface TaxiStructured {
  traceId?: string;
  orderId?: string;
  status?: string;
  statusCode?: number;
  statusText?: string;
  items?: Array<{ productName?: string; productCategory?: string; priceText?: string }>;
  from?: { name?: string };
  to?: { name?: string };
  driver?: { name?: string; phone?: string; carModel?: string; carPlate?: string };
  map?: { distanceKm?: string; eta?: string };
  phoneNumberSuffix?: string;
  success?: boolean;
}

/**
 * 地點名稱 → GCJ-02 坐標（滴滴約束 2：坐標必須來自工具實時獲取）
 *
 * city 為滴滴 required 參數（tools/list schema：["keywords","city"]）——
 * 缺省時上游 backend 直接 400（2026-10-14 實測），呼叫方必須保證傳入
 *
 * @returns 首個 POI 的名稱與坐標；無結果拋 McpToolError（業務性，透傳）
 */
async function resolvePoi(
  endpoint: string,
  name: string,
  city: string | undefined,
): Promise<{ name: string; lng: number; lat: number }> {
  const args: Record<string, unknown> = { keywords: name };
  if (city) args.city = city; // 官方要求完整市名（如「北京市」），缺省由上游按關鍵詞推斷
  const pois = (await didiMaps(endpoint, 'maps_textsearch', args)) as DidiPoi[];
  if (!Array.isArray(pois) || pois.length === 0) {
    throw new McpToolError(`找不到地點「${name}」，請更具體描述（可帶城市名）`);
  }
  const hit = pois[0];
  if (typeof hit.location?.lng !== 'number' || typeof hit.location?.lat !== 'number') {
    throw new McpToolError(`地點「${name}」回應缺少坐標`);
  }
  return { name: hit.display_name ?? name, lng: hit.location.lng, lat: hit.location.lat };
}

/* ==================== estimate_ride ==================== */

interface EstimateRideInput {
  fromName?: string;
  toName?: string;
  fromCity?: string;
  toCity?: string;
  /** 已有定位坐標時直接使用（GCJ-02），跳過地點檢索 */
  fromLng?: number;
  fromLat?: number;
  toLng?: number;
  toLat?: number;
}

const handleEstimate: RouteHandler = async (body) => {
  const input = (body ?? {}) as EstimateRideInput;
  // fromCity 必填：滴滴 maps_textsearch 的 city 為 required 參數；打車預設同城，
  // 終點城市缺省回退出發城市（跨城場景以 toCity 顯式覆蓋）
  if (!input.fromName || !input.toName || !input.fromCity) {
    return badRequest('fromName / toName / fromCity 必填（起終點名稱 + 城市）');
  }

  const endpoint = didiEndpoint();
  if (!endpoint) return ok(mockEstimate(input));

  try {
    // 坐標準備：顯式坐標優先（小程序定位），否則地點檢索（滴滴約束 2）
    const from =
      typeof input.fromLng === 'number' && typeof input.fromLat === 'number'
        ? { name: input.fromName, lng: input.fromLng, lat: input.fromLat }
        : await resolvePoi(endpoint, input.fromName, input.fromCity);
    const to =
      typeof input.toLng === 'number' && typeof input.toLat === 'number'
        ? { name: input.toName, lng: input.toLng, lat: input.toLat }
        : await resolvePoi(endpoint, input.toName, input.toCity ?? input.fromCity);

    // 滴滴約束 1：經緯度必須字符串（數字觸發 -32010）
    const res = await callMcpToolStructured(endpoint, 'taxi_estimate', {
      from_lng: String(from.lng),
      from_lat: String(from.lat),
      from_name: from.name,
      to_lng: String(to.lng),
      to_lat: String(to.lat),
      to_name: to.name,
    }, DIDI_TIMEOUT_MS);
    const s = (res.structured ?? {}) as TaxiStructured;
    if (!s.traceId || !Array.isArray(s.items)) {
      return fail(502, '滴滴預估回應缺少 traceId / 車型列表（structuredContent 異常）');
    }
    return ok({
      from,
      to,
      traceId: s.traceId,
      options: (s.items as NonNullable<TaxiStructured['items']>).map((it) => ({
        productCategory: it.productCategory ?? '',
        productName: it.productName ?? '未知車型',
        priceText: it.priceText ?? '',
      })),
      source: 'didi_mcp_realtime',
    });
  } catch (e) {
    if (e instanceof McpToolError) {
      // 業務性錯誤（地點不存在 / 參數問題）：如實透傳，不降級假數據
      return fail(503, e.message.slice(0, 200));
    }
    // 連線層失敗：降級確定性模擬，記日誌供排查
    console.error('[skill-didi] 滴滴 MCP 不可用，降級模擬數據：', e instanceof Error ? e.message : e);
    return ok(mockEstimate(input));
  }
};

/** 確定性模擬預估（三檔車型；價格以起終點名稱為種子穩定浮動） */
function mockEstimate(input: EstimateRideInput): Record<string, unknown> {
  const seed = stableHash(`${input.fromName}|${input.toName}`);
  const baseYuan = 30 + (seed % 40);
  const productSeedCategory = String(1 + (seed % 3));
  return {
    from: { name: input.fromName as string, lng: input.fromLng ?? 0, lat: input.fromLat ?? 0 },
    to: { name: input.toName as string, lng: input.toLng ?? 0, lat: input.toLat ?? 0 },
    traceId: `mock_trace_${seed}`,
    options: [
      { productCategory: productSeedCategory, productName: '特惠快車', priceText: `約 ${baseYuan} 元` },
      { productCategory: productSeedCategory, productName: '快車', priceText: `約 ${baseYuan + 5} 元` },
      { productCategory: productSeedCategory, productName: '專車', priceText: `約 ${Math.round(baseYuan * 1.8)} 元` },
    ],
    source: 'mock_deterministic',
  };
}

/* ==================== place_ride（真實訂單，checkpoint 後調用） ==================== */

interface PlaceRideInput {
  estimateTraceId?: string;
  productCategory?: string;
  productName?: string;
  fromName?: string;
  toName?: string;
  /** 叫車人手機號（缺省用 Key 綁定賬號手機號） */
  callerCarPhone?: string;
}

const handlePlace: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as PlaceRideInput;
  if (!input.estimateTraceId || !input.productCategory) {
    return badRequest('estimateTraceId / productCategory 必填（來自 estimate_ride 的 bindings）');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕下單');
  }

  const orderId = `ride_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const endpoint = didiEndpoint();

  if (!endpoint) {
    // 模擬訂單：上游訂單號以 traceId 種子穩定生成，供 query/cancel 演示閉環
    const upstreamId = `mock_didi_${stableHash(input.estimateTraceId)}`;
    await createOrder({
      orderId,
      owner: ctx.openid,
      domain: 'ride',
      status: 'pending_external',
      payload: {
        upstreamOrderId: upstreamId,
        productCategory: input.productCategory,
        productName: input.productName ?? '',
        fromName: input.fromName ?? '',
        toName: input.toName ?? '',
        createdAt: Date.now(),
      },
      createdAt: Date.now(),
    });
    return ok({
      orderId,
      upstreamOrderId: upstreamId,
      status: 'pending_external',
      fromName: input.fromName ?? '',
      toName: input.toName ?? '',
      productName: input.productName ?? '',
      source: 'mock_deterministic',
    });
  }

  try {
    const args: Record<string, unknown> = {
      product_category: input.productCategory,
      estimate_trace_id: input.estimateTraceId,
    };
    if (input.callerCarPhone) args.caller_car_phone = input.callerCarPhone;
    const res = await callMcpToolStructured(endpoint, 'taxi_create_order', args, DIDI_TIMEOUT_MS);
    const s = (res.structured ?? {}) as TaxiStructured;
    if (!s.orderId) {
      return fail(502, '滴滴下單回應缺少 orderId（structuredContent 異常）');
    }
    // 落庫失敗補償（2026-10 審計 P1-2）：上游叫車已真實受理，本地寫入失敗時
    // 必須補償取消上游，否則形成「滴滴已派單、本地無記錄」的孤行訂單
    //（用戶無從查單 / 取消，司機空跑並可能產生取消費爭議）
    try {
      await createOrder({
        orderId,
        owner: ctx.openid,
        domain: 'ride',
        status: 'pending_external',
        payload: {
          upstreamOrderId: s.orderId,
          productCategory: input.productCategory,
          productName: input.productName ?? '',
          fromName: s.from?.name ?? input.fromName ?? '',
          toName: s.to?.name ?? input.toName ?? '',
        },
        createdAt: Date.now(),
      });
    } catch (dbErr) {
      console.error('[skill-didi] 落庫失敗，嘗試補償取消上游訂單：', dbErr instanceof Error ? dbErr.message : dbErr);
      try {
        await callMcpToolStructured(endpoint, 'taxi_cancel_order', { order_id: s.orderId }, DIDI_TIMEOUT_MS);
        return fail(503, '訂單落庫失敗，已自動取消上游叫車，請重試下單');
      } catch (cancelErr) {
        // 補償也失敗（含 -32041 行程中不可取消等業務拒絕）：上游訂單極可能仍在
        // 派單，以 CRITICAL 級日誌留痕供人工核銷，拒絕靜默吞掉
        console.error(
          '[skill-didi][CRITICAL] 落庫與補償取消均失敗，上游訂單可能仍在派單：',
          'upstreamOrderId=', s.orderId,
          cancelErr instanceof Error ? cancelErr.message : cancelErr,
        );
        return fail(503, '訂單落庫與自動取消均失敗，請立即查看滴滴 App 核實行程，勿重複叫車');
      }
    }
    return ok({
      orderId,
      upstreamOrderId: s.orderId,
      status: 'pending_external',
      fromName: s.from?.name ?? input.fromName ?? '',
      toName: s.to?.name ?? input.toName ?? '',
      productName: input.productName ?? '',
      phoneSuffix: s.phoneNumberSuffix ?? '',
      source: 'didi_mcp_realtime',
    });
  } catch (e) {
    if (e instanceof McpToolError) {
      // -32021 預估過期 / -32010 參數錯 / -32001 限流：如實透傳引導重新預估
      return fail(503, e.message.slice(0, 200));
    }
    console.error('[skill-didi] 滴滴下單不可用：', e instanceof Error ? e.message : e);
    return fail(502, '滴滴服務暫不可用，請稍後再試');
  }
};

/* ==================== query_ride ==================== */

interface QueryRideInput {
  orderId?: string;
}

const handleQuery: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as QueryRideInput;
  if (!input.orderId) return badRequest('orderId 必填');
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕查單');
  }

  // 歸屬鑒權（防 IDOR）：與下單 / 取消同口徑，僅本人本地訂單可查；
  // 非本地單不再透傳上游——歷史缺陷：任意 orderId 直查滴滴上游，
  // 回應含司機姓名 / 手機 / 車牌等隱私資訊（本地訂單號可枚舉）
  const local = await getOrder(input.orderId);
  if (!local || local.domain !== 'ride' || local.owner !== ctx.openid) {
    return fail(404, `訂單不存在：${input.orderId}`);
  }
  const payload = local.payload as Record<string, unknown>;
  const upstreamId = typeof payload.upstreamOrderId === 'string' ? payload.upstreamOrderId : input.orderId;

  const endpoint = didiEndpoint();
  if (!endpoint) return ok(mockQuery(upstreamId));

  try {
    const res = await callMcpToolStructured(endpoint, 'taxi_query_order', { order_id: upstreamId }, DIDI_TIMEOUT_MS);
    const s = (res.structured ?? {}) as TaxiStructured;
    return ok({
      orderId: input.orderId,
      upstreamOrderId: upstreamId,
      statusCode: s.statusCode ?? -1,
      statusText: s.statusText ?? s.status ?? '',
      driver: s.driver
        ? {
            name: s.driver.name ?? '',
            phone: s.driver.phone ?? '',
            carModel: s.driver.carModel ?? '',
            carPlate: s.driver.carPlate ?? '',
          }
        : null,
      driverDistanceKm: s.map?.distanceKm ?? '',
      etaMin: s.map?.eta ?? '',
      source: 'didi_mcp_realtime',
    });
  } catch (e) {
    if (e instanceof McpToolError) {
      // -32011 訂單不存在等：如實透傳
      return fail(503, e.message.slice(0, 200));
    }
    console.error('[skill-didi] 滴滴訂單查詢不可用，降級模擬：', e instanceof Error ? e.message : e);
    return ok(mockQuery(upstreamId));
  }
};

/** 模擬訂單狀態：以訂單號種子落在穩定狀態（演示可預期） */
function mockQuery(upstreamId: string): Record<string, unknown> {
  const state = stableHash(upstreamId) % 3;
  const states = [
    { statusCode: 0, statusText: '匹配中' },
    { statusCode: 1, statusText: '司機已接單' },
    { statusCode: 2, statusText: '司機已到達' },
  ];
  const s = states[state];
  return {
    orderId: upstreamId,
    upstreamOrderId: upstreamId,
    statusCode: s.statusCode,
    statusText: s.statusText,
    driver: state > 0 ? { name: '王師傅', phone: '138****0000', carModel: '白·大眾·帕薩特', carPlate: '京A·88888' } : null,
    driverDistanceKm: state > 0 ? '1.2' : '',
    etaMin: state > 0 ? '5' : '',
    source: 'mock_deterministic',
  };
}

/* ==================== place_ride/cancel（rollback） ==================== */

interface CancelRideInput {
  orderId?: string;
  reason?: string;
}

const handleCancel: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CancelRideInput;
  if (!input.orderId) return badRequest('orderId 必填');
  if (!ctx.openid) return unauthorized('缺少調用方身份（x-wx-openid），拒絕取消');

  const order = await getOrder(input.orderId);
  if (!order || order.domain !== 'ride') {
    return fail(404, `訂單不存在或已取消：${input.orderId}`);
  }
  // 歸屬前置鑒權（防 IDOR）：必須先於上游取消——歸屬檢查若只靠
  // cancelOrder 歸檔層，越權請求已對他人訂單觸發真實上游取消後才被拒
  if (order.owner !== ctx.openid) {
    return forbidden('無權取消他人訂單');
  }
  const payload = order.payload as Record<string, unknown>;
  const upstreamId = typeof payload.upstreamOrderId === 'string' ? payload.upstreamOrderId : input.orderId;

  const endpoint = didiEndpoint();
  if (endpoint) {
    try {
      await callMcpToolStructured(endpoint, 'taxi_cancel_order', {
        order_id: upstreamId,
        ...(input.reason ? { reason: input.reason } : {}),
      }, DIDI_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof McpToolError) {
        // -32041 行程中不可取消等：如實透傳（rollback 由上層匯報失敗）
        return fail(503, e.message.slice(0, 200));
      }
      // 連線層失敗（2026-10 審計 P2-3）：上游行程可能仍在派單，保留本地記錄讓
      // 用戶可重試取消；原「僅取消本地」會造成本地已刪而滴滴行程仍活躍
      //（司機空跑 + 取消費爭議源），取消可安全重試故引導重試而非刪檔
      console.error('[skill-didi] 滴滴取消連線失敗，保留本地記錄待重試：', e instanceof Error ? e.message : e);
      return fail(502, '滴滴取消通道暫時不可用（連線失敗），行程狀態未知；請稍後重試取消，勿假設已取消');
    }
  }
  // 本地歸檔（歸屬鑒權內建於 cancelOrder，雙重防線——前置檢查已攔越權）
  const result = await cancelOrder(input.orderId, ctx.openid);
  if (result === 'forbidden') {
    return fail(403, '無權取消他人訂單');
  }
  return ok({ ok: true, orderId: input.orderId });
};

export const didiRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.ride.didi/estimate_ride', handleEstimate],
  ['POST /api/skill/skill.ride.didi/place_ride', handlePlace],
  ['POST /api/skill/skill.ride.didi/query_ride', handleQuery],
  ['POST /api/skill/skill.ride.didi/place_ride/cancel', handleCancel],
];
