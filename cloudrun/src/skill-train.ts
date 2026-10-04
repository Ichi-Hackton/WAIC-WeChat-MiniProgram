/**
 * 12306 火車票 SKILL 端點
 *
 * 端點（與小程序端 train-12306 SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.train.12306/search_train
 *   POST /api/skill/skill.train.12306/book_ticket
 *   POST /api/skill/skill.train.12306/book_ticket/cancel
 *
 * 資料來源（分層降級，端點協議不變）：
 *   1. 真實數據：MCP_12306_URL 已配置時，經 12306-mcp（Joooook/12306-MCP，
 *      本地 .mcp/12306 目錄，埠 3001）查詢 12306 官方實時餘票與票價；
 *      下單金額亦取當日該車次該席別的真實票價
 *   2. 確定性模擬：未配置 MCP / 連線層失敗（不可達、超時）時降級，同一
 *      入參恆得同一結果，保證離線演示可用
 *   注意：上游工具的業務性錯誤（站名不存在、無此線路）如實透傳為業務
 *   失敗（HTTP 200 + 非 0 code），**不**降級模擬——避免對不存在的線路
 *   展示假數據誤導用戶
 *
 * 訂單存於記憶體 Map：容器重啟後丟失、多實例不共享（MVP 可接受，正式版應落庫）。
 * 下單/取消屬模擬閉環：12306-mcp 為只讀查詢服務（無下單能力），真實購票
 * 需對接官方或聚合商渠道，屆時僅替換本模組內部實作。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';
import { callMcpTool, McpToolError } from './mcp-client';

/** 座位類型 → 票價（分），與 SKILL meta 的 seatType 枚舉對齊 */
const SEAT_PRICE_CENT: Record<string, number> = {
  business: 174300,
  first_class: 93300,
  second_class: 55300,
  hard_seat: 40100,
};

/** 記憶體訂單表（MVP：重啟丟失、實例間不共享，見檔頭說明；owner 用於歸屬鑒權） */
const orders = new Map<string, { trainNo: string; date: string; amountCent: number; owner: string; createdAt: number }>();

/** 簡易確定性字串雜湊（生成穩定的餘票數，同一入參恆得同一結果） */
function stableHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

interface SearchTrainInput {
  from?: string;
  to?: string;
  date?: string;
  seatType?: string;
  highSpeedOnly?: boolean;
}

/** 12306-mcp get-tickets（format=json）回應的單條車次記錄（僅聲明用到的欄位） */
interface McpTicket {
  train_no?: string;
  start_train_code?: string;
  start_time?: string;
  arrive_time?: string;
  lishi?: string; // 歷時 hh:mm
  from_station?: string;
  to_station?: string;
  prices?: Array<{ seat_name?: string; short?: string; num?: string; price?: number }>;
}

/** 協議席別枚舉 → 中文席別關鍵字（用於在 prices 陣列中定位目標席別） */
const SEAT_TYPE_TO_NAMES: Record<string, string[]> = {
  business: ['商務座', '特等座'],
  first_class: ['一等座', '優選一等座'],
  second_class: ['二等座', '二等包座'],
  hard_seat: ['硬座', '軟座', '無座'],
};


/** MCP 餘票描述 → 數字餘票（「有」=充裕取 9999；無/候補/-- = 0） */
function parseRemain(num: string | undefined): number {
  if (!num) return 0;
  if (/^\d+$/.test(num)) return parseInt(num, 10);
  if (num === '有' || num === '充足') return 9999;
  return 0; // 無 / -- / 候補 / 其他狀態
}

/** hh:mm 歷時 → 分鐘數 */
function durationToMin(lishi: string | undefined): number {
  if (!lishi || !/^\d{1,2}:\d{2}$/.test(lishi)) return 0;
  const [h, m] = lishi.split(':').map((x) => parseInt(x, 10));
  return h * 60 + m;
}

/** 從 MCP 車次的 prices 陣列中按協議席別選取（找不到時回退二等座→首個席別） */
function pickSeat(
  prices: McpTicket['prices'],
  seatType: string,
): { name: string; priceCent: number; remain: number } | null {
  if (!Array.isArray(prices) || prices.length === 0) return null;
  const wanted = SEAT_TYPE_TO_NAMES[seatType] ?? SEAT_TYPE_TO_NAMES.second_class;
  const fallbackNames = SEAT_TYPE_TO_NAMES.second_class;
  const hit =
    prices.find((p) => wanted.includes(p.seat_name ?? '')) ??
    prices.find((p) => fallbackNames.includes(p.seat_name ?? '')) ??
    prices[0];
  return {
    name: hit.seat_name ?? '未知席別',
    priceCent: Math.round((hit.price ?? 0) * 100),
    remain: parseRemain(hit.num),
  };
}

/**
 * 經 12306-mcp 查詢真實車次
 *
 * @throws McpToolError      上游業務性錯誤（站名不存在 / 無此線路 / isError=true），呼叫方應如實透傳
 * @throws McpTransportError 連線層失敗（不可達 / 超時），呼叫方應降級模擬
 * @returns 協議格式的查詢結果
 */
async function searchViaMcp(
  mcpUrl: string,
  input: { from: string; to: string; date: string; seatType: string; highSpeedOnly?: boolean },
): Promise<{
  from: string;
  to: string;
  date: string;
  trains: Array<Record<string, unknown>>;
  source: '12306_realtime';
}> {
  const text = await callMcpTool(mcpUrl, 'get-tickets', {
    date: input.date,
    fromStation: input.from, // 12306-mcp 內部自動將中文城市名解析為電報碼
    toStation: input.to,
    trainFilterFlags: input.highSpeedOnly ? 'G' : '',
    limitedNum: 8, // 摘要式返回，避免長列表拖慢小程序端聚合展示
    sortFlag: 'startTime',
    format: 'json',
  });

  let raw: McpTicket[];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not array');
    raw = parsed as McpTicket[];
  } catch {
    // 非 JSON 陣列 = 上游業務性錯誤文本（未查到車次 / 站名不存在等）：
    // 以 McpToolError 類型化標記，供呼叫方與連線層失敗（應降級）區分
    throw new McpToolError(`12306 查詢業務失敗：${text.slice(0, 160)}`);
  }

  const trains = raw
    .filter((t) => typeof t.start_train_code === 'string')
    .map((t) => {
      const seat = pickSeat(t.prices, input.seatType);
      return {
        trainNo: t.start_train_code as string,
        from: t.from_station ?? input.from,
        to: t.to_station ?? input.to,
        departTime: t.start_time ?? '',
        arriveTime: t.arrive_time ?? '',
        durationMin: durationToMin(t.lishi),
        seatType: input.seatType,
        priceCent: seat?.priceCent ?? 0,
        ticketsLeft: seat?.remain ?? 0,
        // 附全席別明細（協議 outputSchema 僅要求 trainNo/priceCent，擴充欄位向後兼容）
        seatClasses: (t.prices ?? []).map((p) => ({
          name: p.seat_name ?? '',
          priceCent: Math.round((p.price ?? 0) * 100),
          remain: parseRemain(p.num),
        })),
      };
    });

  return { from: input.from, to: input.to, date: input.date, trains, source: '12306_realtime' };
}

const handleSearch: RouteHandler = async (body) => {
  const input = (body ?? {}) as SearchTrainInput;
  if (!input.from || !input.to || !input.date) {
    return badRequest('from / to / date 必填');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return badRequest('date 格式必須為 YYYY-MM-DD');
  }

  const seatType = input.seatType ?? 'second_class';

  // 資料源 1：12306-mcp 真實實時數據（MCP_12306_URL 已配置時）
  const mcpUrl = process.env.MCP_12306_URL;
  if (mcpUrl) {
    try {
      const real = await searchViaMcp(mcpUrl, {
        from: input.from as string,
        to: input.to as string,
        date: input.date as string,
        seatType,
        highSpeedOnly: input.highSpeedOnly === true,
      });
      return ok(real);
    } catch (e) {
      if (e instanceof McpToolError) {
        // 上游業務錯誤（站名不存在 / 無此線路 / isError=true）：如實透傳，不降級假數據。
        // 類型化分流取代舊的 message 文案匹配（「業務失敗」關鍵詞曾漏接 isError 規範形態）
        return fail(503, e.message.slice(0, 200));
      }
      // 連線層失敗（McpTransportError 等）：降級確定性模擬（離線演示可用），並記日誌供排查
      console.error('[skill-train] MCP 查詢不可用，降級模擬數據：', e instanceof Error ? e.message : e);
    }
  }

  // 資料源 2：確定性模擬數據（未配置 MCP / 連線層失敗）
  const basePrice = SEAT_PRICE_CENT[seatType] ?? SEAT_PRICE_CENT.second_class;

  const trains = [1, 2, 3, 4, 5].map((i) => {
    const trainNo = `G${100 + i}`;
    // 以日期 + 車次做種子，保證同日同車次餘票穩定、不同日期略有變化
    const seed = stableHash(`${input.date}:${trainNo}`);
    const departHour = 8 + i;
    return {
      trainNo,
      from: input.from as string,
      to: input.to as string,
      departTime: `${String(departHour).padStart(2, '0')}:00`,
      arriveTime: `${String(departHour + 5).padStart(2, '0')}:30`,
      durationMin: 330,
      seatType,
      priceCent: basePrice + (seed % 5) * 100, // ±400 分的確定性浮動
      ticketsLeft: seed % 40,
    };
  });

  return ok({ from: input.from, to: input.to, date: input.date, trains, source: 'mock_deterministic' });
};

interface BookTicketInput {
  trainNo?: string;
  date?: string;
  seatType?: string;
  passengerName?: string;
  passengerIdNo?: string;
  from?: string;
  to?: string;
}

const handleBook: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as BookTicketInput;
  if (!input.trainNo || !input.date || !input.seatType || !input.passengerName || !input.passengerIdNo) {
    return badRequest('trainNo / date / seatType / passengerName / passengerIdNo 必填');
  }
  // 歸屬鑒權：寫操作必須攜帶雲托管注入的調用方身份（規範 § 10 SKILL 越權防護）
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕下單');
  }

  /*
   * 下單金額優先取 12306 真實票價（與查詢展示一致，避免「查價 ¥626 / 下單 ¥553」
   * 的金額不一致）：MCP 可用且 from/to 齊備時，查當日車次並精確匹配請求席別。
   * 查不到（未配置 / 車次已消失 / 連線失敗 / 席別不存在）回退靜態價目表。
   * 精確匹配不回退其他席別：訂單金額必須對應用戶確認的席別，不可「就近取」。
   */
  let amountCent = SEAT_PRICE_CENT[input.seatType] ?? SEAT_PRICE_CENT.second_class;
  const mcpUrl = process.env.MCP_12306_URL;
  if (mcpUrl && input.from && input.to) {
    try {
      const text = await callMcpTool(mcpUrl, 'get-tickets', {
        date: input.date as string,
        fromStation: input.from,
        toStation: input.to,
        limitedNum: 0, // 不限制：確保目標車次落在結果集內
        format: 'json',
      });
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const target = (parsed as McpTicket[]).find((t) => t.start_train_code === input.trainNo);
        const names = SEAT_TYPE_TO_NAMES[input.seatType as string] ?? SEAT_TYPE_TO_NAMES.second_class;
        const hit = (target?.prices ?? []).find((p) => names.includes(p.seat_name ?? ''));
        if (hit && typeof hit.price === 'number' && hit.price > 0) {
          amountCent = Math.round(hit.price * 100);
        }
      }
    } catch (e) {
      console.error('[skill-train] 下單真實票價查詢失敗，回退靜態價目表：', e instanceof Error ? e.message : e);
    }
  }
  const orderId = `ord_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  orders.set(orderId, {
    trainNo: input.trainNo,
    date: input.date,
    amountCent,
    owner: ctx.openid,
    createdAt: Date.now(),
  });

  return ok({
    orderId,
    trainNo: input.trainNo,
    amountCent,
    status: 'pending_payment',
    payDeadline: Date.now() + 15 * 60 * 1000,
  });
};

interface CancelInput {
  orderId?: string;
}

const handleCancel: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CancelInput;
  if (!input.orderId) {
    return badRequest('orderId 必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕取消');
  }
  const order = orders.get(input.orderId);
  if (!order) {
    // 業務失敗（HTTP 200 + 非 0 code），SKILL rollback 會翻譯為異常
    return fail(404, `訂單不存在或已取消：${input.orderId}`);
  }
  // 歸屬鑒權：僅訂單擁有者可取消（防 IDOR——枚舉 orderId 越權取消他人訂單）
  if (order.owner !== ctx.openid) {
    return forbidden('無權取消他人訂單');
  }
  orders.delete(input.orderId);
  return ok({ ok: true, orderId: input.orderId });
};

export const trainRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.train.12306/search_train', handleSearch],
  ['POST /api/skill/skill.train.12306/book_ticket', handleBook],
  ['POST /api/skill/skill.train.12306/book_ticket/cancel', handleCancel],
];
