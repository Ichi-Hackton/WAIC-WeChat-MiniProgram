/**
 * 國內機票 SKILL 端點（skill.flight.variflight）
 *
 * 端點（與小程序端 flight-variflight SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.flight.variflight/search_flights
 *   POST /api/skill/skill.flight.variflight/book_flight
 *   POST /api/skill/skill.flight.variflight/book_flight/cancel （rollback 專用）
 *   POST /api/skill/skill.flight.variflight/book_flight/complete
 *
 * 資料來源（分層降級，與 skill-train.ts 同構，端點協議不變）：
 *   1. 真實數據：VARIFLIGHT_API_KEY 已配置時，直連飛常準 AI 開放平台
 *      REST（POST https://mcp.variflight.com/api/v1/mcp/data，X-VARIFLIGHT-KEY
 *      鑑權，協議反解自官方 npm 包 @variflight-ai/variflight-mcp），併發拉取
 *      航班時刻（endpoint: flights）與艙位票價（getFlightPriceByCities）。
 *      Key 申請：mcp.variflight.com（郵箱自助註冊，無需企業資質，有試用額度）
 *   2. 確定性模擬：未配置 Key / 連線層失敗時降級（djb2 種子，同參恆同果，
 *      離線演示可用）
 *
 * 注意：上游業務性錯誤（城市不支援 / 無此航線 / 額度耗盡）如實透傳為
 * 業務失敗（HTTP 200 + 非 0 code），不降級模擬——與 skill-train 的
 * McpToolError 分流語義一致。
 *
 * 2026-10 真實渠道上線：下單改為「跳轉模式」——國内機票出票需 OTA 分銷
 * 資質（個人不可得），book_flight 生成 pending_external 跳轉訂單（含真實
 * 票價的購票資訊卡 + OTA 小程序跳轉），真實購票與支付在 OTA 側完成。
 * 訂單落庫 MySQL（db.ts，重啟不丟）。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';
import { createOrder, getOrder, cancelOrder, completeOrder } from './db';
import { buildJump } from './external-jump';

/** 飛常準 AI 開放平台數據端點（單端點多 endpoint，body 區分） */
const VF_DATA_URL = 'https://mcp.variflight.com/api/v1/mcp/data';

/** 上游單次請求超時（覆蓋長尾響應；超出視為連線層失敗降級模擬） */
const VF_TIMEOUT_MS = 20_000;

/** 連線層錯誤（呼叫方應降級模擬） */
class VfTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VfTransportError';
  }
}

/** 上游業務性錯誤（呼叫方應如實透傳，不得降級模擬） */
class VfToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VfToolError';
  }
}

/**
 * 常用城市中文名 → IATA 城市碼（飛常準入參要求三字碼）
 *
 * 覆蓋 rule-planner CITIES 詞表與主要航線城市；未收錄城市返回業務失敗
 * 提示（比靜默映射錯城市安全）。正式版可換全量站名表。
 */
const CITY_IATA: Record<string, string> = {
  北京: 'BJS', 上海: 'SHA', 廣州: 'CAN', 广州: 'CAN', 深圳: 'SZX',
  杭州: 'HGH', 南京: 'NKG', 成都: 'CTU', 武漢: 'WUH', 武汉: 'WUH',
  西安: 'SIA', 重慶: 'CKG', 重庆: 'CKG', 天津: 'TSN', 長沙: 'CSX', 长沙: 'CSX',
  鄭州: 'CGO', 郑州: 'CGO', 青島: 'TAO', 青岛: 'TAO', 廈門: 'XMN', 厦门: 'XMN',
  昆明: 'KMG', 海口: 'HAK', 三亞: 'SYX', 三亚: 'SYX', 貴陽: 'KWE', 贵阳: 'KWE',
  蘭州: 'LHW', 兰州: 'LHW', 烏魯木齊: 'URC', 乌鲁木齐: 'URC', 沈陽: 'SHE', 沈阳: 'SHE',
  哈爾濱: 'HRB', 哈尔滨: 'HRB', 大連: 'DLC', 大连: 'DLC', 濟南: 'TNA', 济南: 'TNA',
  福州: 'FOC', 溫州: 'WNZ', 温州: 'WNZ', 寧波: 'NGB', 宁波: 'NGB', 無錫: 'WUX', 无锡: 'WUX',
  珠海: 'ZUH', 桂林: 'KWL', 南寧: 'NNG', 南宁: 'NNG', 西寧: 'XNN', 西宁: 'XNN',
  銀川: 'INC', 银川: 'INC', 呼和浩特: 'HET', 石家莊: 'SJW', 石家庄: 'SJW',
  太原: 'TYN', 合肥: 'HFE', 南昌: 'KHN', 泉州: 'JJN', 煙台: 'YNT', 烟台: 'YNT',
  威海: 'WEH', 洛陽: 'LYA', 洛阳: 'LYA', 綿陽: 'MIG', 绵阳: 'MIG',
  麗江: 'LJG', 丽江: 'LJG', 大理: 'DLU', 張家界: 'DYX', 张家界: 'DYX',
};

/** 協議艙位枚舉 → 中文關鍵字（用於在上游艙位陣列中定位目標艙位） */
const CABIN_TO_NAMES: Record<string, string[]> = {
  economy: ['經濟', '经济'],
  business: ['商務', '商务'],
  first: ['頭等', '头等', '公務', '公务'],
};

/** 模擬價目基準（分）：與艙位枚舉對齊 */
const CABIN_BASE_PRICE_CENT: Record<string, number> = {
  economy: 98000,
  business: 280000,
  first: 420000,
};

/** djb2 字串雜湊（確定性模擬的種子來源，與 skill-booking 同算法） */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * 呼叫飛常準數據端點
 *
 * @throws VfToolError      上游業務性錯誤（城市不支援 / 額度耗盡等），呼叫方應透傳
 * @throws VfTransportError 連線層失敗（不可達 / 超時 / 非 2xx / 回應畸形），呼叫方應降級模擬
 */
async function vfCall(
  key: string,
  endpoint: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VF_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(VF_DATA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VARIFLIGHT-KEY': key },
      body: JSON.stringify({ endpoint, params }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new VfTransportError(`飛常準端點不可達：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    // 額度耗盡 / Key 無效等以 HTTP 4xx 呈現的業務性錯誤：透傳而非降級假數據
    throw new VfToolError(`飛常準回應 HTTP ${resp.status}：${bodyText.slice(0, 120)}`);
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new VfTransportError('飛常準回應非合法 JSON');
  }
  // 防禦式業務錯誤識別（上游錯誤形態未實測，覆蓋 error 物件與非零 code 兩種慣例）
  const b = body as { error?: unknown; code?: unknown; message?: unknown };
  if (b && typeof b === 'object' && (b.error !== undefined || (typeof b.code === 'number' && b.code !== 0))) {
    throw new VfToolError(`飛常準業務失敗：${String(b.message ?? JSON.stringify(b.error ?? b.code)).slice(0, 160)}`);
  }
  return body;
}

interface SearchFlightsInput {
  from?: string;
  to?: string;
  date?: string;
  cabin?: string;
}

/** 上游 flights 端點單條航班記錄（僅聲明用到的欄位，名稱反解自官方 npm 包 FLIGHT_SUMMARY_FIELDS） */
interface VfFlight {
  FlightNo?: string;
  FlightCompany?: string;
  FlightDepcode?: string;
  FlightArrcode?: string;
  FlightDepAirport?: string;
  FlightArrAirport?: string;
  /** 出發航站樓 */
  FlightTerminal?: string;
  /** 到達航站樓 */
  FlightHTerminal?: string;
  /** 計劃起飛 "YYYY-MM-DD HH:mm:ss" */
  FlightDeptimePlanDate?: string;
  /** 計劃到達 */
  FlightArrtimePlanDate?: string;
}

/** "YYYY-MM-DD HH:mm:ss" → "HH:mm"；畸形輸入回空串 */
function hhmm(dt: string | undefined): string {
  return typeof dt === 'string' && dt.length >= 16 ? dt.slice(11, 16) : '';
}

/** 計劃起降時刻 → 飛行分鐘數（跨天 +24h 補償；時刻缺失回 0） */
function flightDurationMin(dep: string | undefined, arr: string | undefined): number {
  const d = hhmm(dep);
  const a = hhmm(arr);
  if (!d || !a) return 0;
  const toMin = (s: string): number => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3), 10);
  const diff = toMin(a) - toMin(d);
  return diff >= 0 ? diff : diff + 24 * 60;
}

/**
 * 上游 getFlightPriceByCities 結果中按航班號取目標艙位價（分）
 *
 * 回應欄位名未實測（官方包原樣透傳），做寬容探測：艙位陣列（cabins /
 * prices / price_list）優先，其次單值（price / min_price）；均無命中回 -1
 * 表示「未取到價」，由展示層特判，不展示誤導性 ¥0。
 */
function pickPriceCent(
  priceRecord: Record<string, unknown> | undefined,
  flightNo: string,
  cabin: string,
): number {
  if (!priceRecord) return -1;
  const wanted = CABIN_TO_NAMES[cabin] ?? CABIN_TO_NAMES.economy;
  const toCent = (v: unknown): number => (typeof v === 'number' && v > 0 ? Math.round(v * 100) : -1);

  for (const listKey of ['cabins', 'prices', 'price_list', 'cabin_prices']) {
    const list = priceRecord[listKey];
    if (!Array.isArray(list) || list.length === 0) continue;
    // 目標艙位優先，取不到再取最低價（上游 price_mode=lowest 語義）
    let fallback = -1;
    for (const raw of list as Array<Record<string, unknown>>) {
      const name = String(raw.name ?? raw.cabin_name ?? raw.seat_name ?? '');
      const cent = toCent(raw.price ?? raw.adult_price ?? raw.min_price);
      if (cent < 0) continue;
      if (wanted.some((w) => name.includes(w))) return cent;
      if (fallback < 0 || cent < fallback) fallback = cent;
    }
    return fallback;
  }
  return toCent(priceRecord.price ?? priceRecord.min_price ?? priceRecord.minPrice);
}

/** 協議艙位枚舉 → 中文名（copyText 展示用，與 CABIN_TO_NAMES 對齊） */
const CABIN_LABEL: Record<string, string> = {
  economy: '經濟艙',
  business: '商務艙',
  first: '頭等艙',
};

const handleSearch: RouteHandler = async (body) => {
  const input = (body ?? {}) as SearchFlightsInput;
  if (!input.from || !input.to || !input.date) {
    return badRequest('from / to / date 必填');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return badRequest('date 格式必須為 YYYY-MM-DD');
  }
  const cabin = input.cabin ?? 'economy';
  if (!(cabin in CABIN_TO_NAMES)) {
    return badRequest('cabin 必須為 economy / business / first');
  }

  const depCode = CITY_IATA[input.from];
  const arrCode = CITY_IATA[input.to];
  if (!depCode || !arrCode) {
    return fail(400, `不支援的城市：${!depCode ? input.from : input.to}（請使用常用大中城市名）`);
  }

  // 資料源 1：飛常準真實實時數據（VARIFLIGHT_API_KEY 已配置時）
  const key = process.env.VARIFLIGHT_API_KEY;
  if (key) {
    try {
      // 時刻與票價併發拉取：票價端點整體失敗僅損失價格（標 -1），不拖垮時刻
      const [schedRes, priceRes] = await Promise.allSettled([
        vfCall(key, 'flights', { depcity: depCode, arrcity: arrCode, date: input.date }),
        vfCall(key, 'getFlightPriceByCities', { dep_city: depCode, arr_city: arrCode, dep_date: input.date, price_mode: 'lowest' }),
      ]);

      if (schedRes.status === 'rejected') throw schedRes.reason; // 時刻為主數據，失敗即整體降級

      const sched = (schedRes.value as { data?: unknown }).data;
      if (!Array.isArray(sched)) throw new VfTransportError('飛常準航班回應缺少 data 陣列');

      // 票價按航班號建索引（FlightNo → 原始記錄）， tolerate 大小寫差異
      const priceByFlight = new Map<string, Record<string, unknown>>();
      if (priceRes.status === 'fulfilled') {
        const prices = (priceRes.value as { data?: unknown }).data;
        if (Array.isArray(prices)) {
          for (const p of prices as Array<Record<string, unknown>>) {
            const no = typeof p.FlightNo === 'string' ? p.FlightNo.toUpperCase() : '';
            if (no && !priceByFlight.has(no)) priceByFlight.set(no, p);
          }
        }
      }

      const flights = (sched as VfFlight[])
        .filter((f) => typeof f.FlightNo === 'string' && f.FlightNo)
        .slice(0, 8) // 摘要式返回，與 search_train 的 limitedNum 語義對齊
        .map((f) => {
          const no = (f.FlightNo as string).toUpperCase();
          return {
            flightNo: no,
            airline: f.FlightCompany ?? '',
            from: input.from as string,
            to: input.to as string,
            fromAirport: [f.FlightDepAirport ?? f.FlightDepcode, f.FlightTerminal].filter(Boolean).join(' '),
            toAirport: [f.FlightArrAirport ?? f.FlightArrcode, f.FlightHTerminal].filter(Boolean).join(' '),
            departTime: hhmm(f.FlightDeptimePlanDate),
            arriveTime: hhmm(f.FlightArrtimePlanDate),
            durationMin: flightDurationMin(f.FlightDeptimePlanDate, f.FlightArrtimePlanDate),
            cabin,
            priceCent: priceByFlight.has(no) ? pickPriceCent(priceByFlight.get(no), no, cabin) : -1,
          };
        });

      return ok({ from: input.from, to: input.to, date: input.date, cabin, flights, source: 'variflight_realtime' });
    } catch (e) {
      if (e instanceof VfToolError) {
        return fail(503, e.message.slice(0, 200));
      }
      console.error('[skill-flight] 飛常準查詢不可用，降級模擬數據：', e instanceof Error ? e.message : e);
    }
  }

  // 資料源 2：確定性模擬數據（未配置 Key / 連線層失敗）
  const basePrice = CABIN_BASE_PRICE_CENT[cabin] ?? CABIN_BASE_PRICE_CENT.economy;
  const MOCK_FLIGHTS: Array<[string, string, string, string]> = [
    ['CA1501', '中國國航', '07:30', '09:50'],
    ['MU5101', '中國東航', '09:00', '11:15'],
    ['CZ3907', '中國南航', '11:30', '13:45'],
    ['HU7603', '海南航空', '14:00', '16:10'],
    ['MF8116', '廈門航空', '16:30', '18:40'],
    ['9C8882', '春秋航空', '19:00', '21:20'],
  ];
  const toMin = (s: string): number => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3), 10);
  const flights = MOCK_FLIGHTS.map(([flightNo, airline, dep, arr]) => {
    // 以日期 + 航班號 + 艙位做種子：同日同航班恆同價、不同日期略有浮動
    const seed = hashStr(`${input.date}:${flightNo}:${cabin}`);
    return {
      flightNo,
      airline,
      from: input.from as string,
      to: input.to as string,
      fromAirport: `${input.from}出發機場 T2`,
      toAirport: `${input.to}到達機場 T1`,
      departTime: dep,
      arriveTime: arr,
      durationMin: toMin(arr) - toMin(dep),
      cabin,
      priceCent: Math.round(basePrice * (0.85 + (seed % 30) / 100)), // ±15% 確定性浮動
    };
  });

  return ok({ from: input.from, to: input.to, date: input.date, cabin, flights, source: 'mock_deterministic' });
};

interface BookFlightInput {
  flightNo?: string;
  date?: string;
  cabin?: string;
  passengerName?: string;
  passengerIdNo?: string;
  from?: string;
  to?: string;
  /** 查詢時即時票價（分）：僅供 checkpoint 展示，下單金額以雲端再核實為準 */
  priceCent?: number;
}

const handleBook: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as BookFlightInput;
  if (!input.flightNo || !input.date || !input.cabin || !input.passengerName || !input.passengerIdNo) {
    return badRequest('flightNo / date / cabin / passengerName / passengerIdNo 必填');
  }
  // 歸屬鑒權：寫操作必須攜帶雲托管注入的調用方身份（規範 § 10）
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕下單');
  }

  /*
   * 下單金額優先取飛常準真實票價（與查詢展示一致，語義同 skill-train）：
   * Key 可用且 from/to 齊備時，查當日城市對票價並按航班號 + 艙位精確匹配；
   * 查不到（未配置 / 航班已消失 / 連線失敗 / 艙位不存在）回退靜態價目表。
   */
  let amountCent = CABIN_BASE_PRICE_CENT[input.cabin] ?? CABIN_BASE_PRICE_CENT.economy;
  const key = process.env.VARIFLIGHT_API_KEY;
  const depCode = input.from ? CITY_IATA[input.from] : undefined;
  const arrCode = input.to ? CITY_IATA[input.to] : undefined;
  if (key && depCode && arrCode) {
    try {
      const raw = await vfCall(key, 'getFlightPriceByCities', {
        dep_city: depCode,
        arr_city: arrCode,
        dep_date: input.date,
        price_mode: 'lowest',
      });
      const list = (raw as { data?: unknown }).data;
      if (Array.isArray(list)) {
        const target = (list as Array<Record<string, unknown>>).find(
          (p) => typeof p.FlightNo === 'string' && p.FlightNo.toUpperCase() === input.flightNo?.toUpperCase(),
        );
        const cent = pickPriceCent(target, input.flightNo, input.cabin);
        if (cent > 0) amountCent = cent;
      }
    } catch (e) {
      console.error('[skill-flight] 下單真實票價查詢失敗，回退靜態價目表：', e instanceof Error ? e.message : e);
    }
  }

  /*
   * 跳轉模式：生成購票資訊卡訂單（pending_external）。真實購票與支付在
   * OTA（攜程/飛豬等）小程序側完成，本系統留存跳轉記錄供行程頁重跳轉。
   * 金額取上方核實的真實票價（未取到時為靜態基準價，僅供參考）。
   */
  const orderId = `flg_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const cabinLabel = CABIN_LABEL[input.cabin] ?? input.cabin;
  const copyText = [
    `航班 ${input.flightNo}（${input.date}）`,
    `${input.from ?? ''} → ${input.to ?? ''}`,
    `${cabinLabel} ¥${(amountCent / 100).toFixed(2)}`,
    `乘機人 ${input.passengerName}`,
  ].join('\n');
  await createOrder({
    orderId,
    owner: ctx.openid,
    domain: 'flight',
    status: 'pending_external',
    payload: {
      flightNo: input.flightNo,
      date: input.date,
      cabin: input.cabin,
      from: input.from,
      to: input.to,
      passengerName: input.passengerName,
      amountCent,
    },
    createdAt: Date.now(),
  });

  return ok({
    orderId,
    flightNo: input.flightNo,
    amountCent,
    status: 'pending_external',
    jump: buildJump('ota_flight', copyText),
  });
};

interface CancelInput {
  orderId?: string;
}

/** rollback 與用戶主動取消共用：刪除訂單（歸屬鑒權防 IDOR） */
const handleCancel: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CancelInput;
  if (!input.orderId) {
    return badRequest('orderId 必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕取消');
  }
  const order = await getOrder(input.orderId);
  if (!order || order.domain !== 'flight') {
    return fail(404, `訂單不存在或已取消：${input.orderId}`);
  }
  const result = await cancelOrder(input.orderId, ctx.openid);
  if (result === 'forbidden') {
    return forbidden('無權取消他人訂單');
  }
  return ok({ ok: true, orderId: input.orderId });
};

/*
 * 成交確認（2026-10 半屏跳轉 + 支付閉環）：用戶在 OTA 側完成真實支付後，
 * 回到行程頁點「標記已支付」將訂單歸檔為 completed（與 skill-train
 * handleComplete 同構；漏斗最深可觀測點，同步埋點 order_confirmed）。
 */
const handleComplete: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CancelInput;
  if (!input.orderId) {
    return badRequest('orderId 必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕成交確認');
  }
  const order = await getOrder(input.orderId);
  if (!order || order.domain !== 'flight') {
    return fail(404, `訂單不存在或已取消：${input.orderId}`);
  }
  if (order.status === 'cancelled') {
    return fail(410, '訂單已取消，不可標記成交');
  }
  const result = await completeOrder(input.orderId, ctx.openid);
  if (result === 'forbidden') {
    return forbidden('無權確認他人訂單');
  }
  return ok({ ok: true, orderId: input.orderId, status: 'completed' });
};

export const flightRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.flight.variflight/search_flights', handleSearch],
  ['POST /api/skill/skill.flight.variflight/book_flight', handleBook],
  ['POST /api/skill/skill.flight.variflight/book_flight/cancel', handleCancel],
  ['POST /api/skill/skill.flight.variflight/book_flight/complete', handleComplete],
];
