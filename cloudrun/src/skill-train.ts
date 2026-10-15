/**
 * 12306 火車票 SKILL 端點
 *
 * 端點（與小程序端 train-12306 SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.train.12306/search_train
 *   POST /api/skill/skill.train.12306/book_ticket
 *   POST /api/skill/skill.train.12306/book_ticket/cancel
 *   POST /api/skill/skill.train.12306/book_ticket/complete
 *
 * 資料來源（三層降級，端點協議不變；2026-10-14 修訂）:
 *   1. 真實數據（優先）：VARIFLIGHT_API_KEY 已配置時，經飛常準 Tripmatch MCP
 *      （ai.variflight.com，JSON-RPC streamable HTTP，searchTrainTickets）
 *      查 12306 官方實時車次 / 余票 / 票價——免本地子進程，生產容器友好，
 *      與機票域（skill-flight）共用同一 Key；下單金額同源核實
 *   2. 真實數據（輔助）：MCP_12306_URL 已配置時，經 12306-mcp（Joooook/
 *      12306-MCP，本地 .mcp/12306 目錄，埠 3001）查詢——免積分，本地
 *      開發驗證用；Tripmatch 連線層失敗（超時 / 5xx / 解析異常）時回落
 *   3. 確定性模擬：兩者皆不可用（未配置 / 連線層失敗）時降級，同一
 *      入參恆得同一結果，保證離線演示可用
 *   注意：上游工具的業務性錯誤（站名不存在、無此線路）如實透傳為業務
 *   失敗（HTTP 200 + 非 0 code），**不**降級模擬——避免對不存在的線路
 *   展示假數據誤導用戶
 *
 * 2026-10 真實渠道上線：下單改為「跳轉模式」——12306 官方未開放個人購票
 * API，book_ticket 生成 pending_external 跳轉訂單（含真實票價的購票資訊
 * 卡 + 12306 官方小程序跳轉），真實下單與支付在官方側完成。訂單落庫
 * MySQL（db.ts，重啟不丟），rollback/cancel 語義為「放棄購買」。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';
import { checkQuota } from './quota';
import { callMcpTool, McpToolError } from './mcp-client';
import { createOrder, getOrder, cancelOrder, completeOrder } from './db';
import { buildJump } from './external-jump';

/** 座位類型 → 票價（分），與 SKILL meta 的 seatType 枚舉對齊 */
const SEAT_PRICE_CENT: Record<string, number> = {
  business: 174300,
  first_class: 93300,
  second_class: 55300,
  hard_seat: 40100,
};



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

/** 協議席別枚舉 → 中文席別關鍵字（用於在 prices 陣列中定位目標席別）
 *  兩數據源席別名實測一致（商務座 / 一等座 / 優選一等座 / 二等座 / 無座…） */
const SEAT_TYPE_TO_NAMES: Record<string, string[]> = {
  business: ['商務座', '特等座'],
  first_class: ['一等座', '優選一等座'],
  second_class: ['二等座', '二等包座'],
  hard_seat: ['硬座', '軟座', '無座'],
};

/* ==================== 飛常準 Tripmatch 數據源（2026-10-14 新增） ==================== */

/** Tripmatch MCP 服務端點（streamable HTTP，協議 2025-03-26，無狀態 JSON 回應） */
const TRIPMATCH_URL = 'https://ai.variflight.com/servers/tripmatch/mcp';

/** 上游單次工具調用超時上限約 30s（官方文檔），此處對齊 */
const VF_TRAIN_TIMEOUT_MS = 32_000;

/** 業務性錯誤（站名不支援 / Key 餘額問題 / Error executing tool）：呼叫方應如實透傳 */
class VfTrainToolError extends Error {}

/**
 * 經 Tripmatch MCP 呼叫火車票工具並解析為車次陣列
 *
 * 回應為三層包裝（2026-10-14 實測）：
 *   JSON-RPC {result:{content:[{text}]}} → text 為「Train tickets: {...}」
 *   → 內層 12306 官方風格 {code:200, data:{code:0, msg:'ok', data:[車次]}}
 * 防禦點：① text 可能是 Python 風格單引號 dict（非合法 JSON）；② 站名
 * 存在內嵌空格臟數據（如「北 京南」）；③ 工具失敗以「Error executing
 * tool」開頭文本返回而非協議級錯誤（官方文檔明示）
 *
 * @throws VfTrainToolError 上游業務性錯誤（含 4xx 配置類），呼叫方應如實透傳
 * @throws Error           連線層失敗（不可達 / 超時 / 5xx / 結構異常），呼叫方應回落 12306-mcp
 */
async function vfTrainCall(
  key: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<VfTrainTicket[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VF_TRAIN_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(TRIPMATCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-API-Key': key,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`Tripmatch 端點不可達：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    // 401/403（Key 無效 / 餘額不足）為配置性業務錯誤：透傳；5xx 視為連線層失敗回落
    if (resp.status >= 500) throw new Error(`Tripmatch HTTP ${resp.status}`);
    throw new VfTrainToolError(`Tripmatch HTTP ${resp.status}：${bodyText.slice(0, 120)}`);
  }
  const rpc = (await resp.json().catch(() => {
    throw new Error('Tripmatch 回應非合法 JSON-RPC');
  })) as { result?: { content?: Array<{ type?: string; text?: string }> } };
  const text = rpc.result?.content?.[0]?.text ?? '';
  if (!text) throw new Error('Tripmatch 回應缺少 content 文本');
  if (text.startsWith('Error executing tool')) {
    throw new VfTrainToolError(`Tripmatch 業務失敗：${text.slice(0, 160)}`);
  }
  // 剝離前綴標籤（「Train tickets: 」等），先試原文 parse（容忍將來上游
  // 改為合法 JSON），失敗再以單引號→雙引號轉換重試（中文站名場景安全）
  const payloadText = text.slice(Math.max(0, text.indexOf('{')));
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    try {
      payload = JSON.parse(payloadText.replace(/'/g, '"'));
    } catch {
      throw new VfTrainToolError(`Tripmatch 回應無法解析：${text.slice(0, 120)}`);
    }
  }
  const p = payload as {
    code?: unknown; message?: unknown;
    data?: { code?: unknown; msg?: unknown; data?: unknown };
  };
  if (p.code !== 200 || !p.data || p.data.code !== 0) {
    throw new VfTrainToolError(`Tripmatch 業務失敗：${String(p.data?.msg ?? p.message ?? '未知錯誤').slice(0, 160)}`);
  }
  if (!Array.isArray(p.data.data)) throw new Error('Tripmatch 車次回應缺少 data.data 陣列');
  return p.data.data as VfTrainTicket[];
}

/** Tripmatch searchTrainTickets 單條車次記錄（僅聲明用到的欄位） */
interface VfTrainTicket {
  trainNumber?: string;
  fromStation?: string;
  toStation?: string;
  fromTime?: string;
  toTime?: string;
  useTime?: number; // 歷時分鐘數（區別於 12306-mcp 的 lishi hh:mm）
  seatLists?: Array<{ seatName?: string; seatPrice?: number; ticketLeft?: number }>;
}

/** Tripmatch 席別選取（余票為直接數字，區別於 12306-mcp 的「有/無」文案） */
function pickSeatVf(
  seatLists: VfTrainTicket['seatLists'],
  seatType: string,
): { name: string; priceCent: number; remain: number } | null {
  if (!Array.isArray(seatLists) || seatLists.length === 0) return null;
  const wanted = SEAT_TYPE_TO_NAMES[seatType] ?? SEAT_TYPE_TO_NAMES.second_class;
  const fallbackNames = SEAT_TYPE_TO_NAMES.second_class;
  const hit =
    seatLists.find((s) => wanted.includes(s.seatName ?? '')) ??
    seatLists.find((s) => fallbackNames.includes(s.seatName ?? '')) ??
    seatLists[0];
  return {
    name: hit.seatName ?? '未知席別',
    priceCent: Math.round((hit.seatPrice ?? 0) * 100),
    remain: typeof hit.ticketLeft === 'number' ? hit.ticketLeft : 0,
  };
}

/** 站名臟數據清洗（實測存在「北 京南」內嵌空格形態） */
function cleanStationName(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, '');
}

/**
 * 經 Tripmatch 查詢真實車次（協議輸出與 searchViaMcp 同構）
 *
 * @throws VfTrainToolError 上游業務性錯誤，呼叫方應如實透傳
 * @throws Error           連線層失敗，呼叫方應回落 12306-mcp
 */
async function searchViaTripmatch(
  key: string,
  input: { from: string; to: string; date: string; seatType: string; highSpeedOnly?: boolean },
): Promise<{
  from: string;
  to: string;
  date: string;
  trains: Array<Record<string, unknown>>;
  source: 'tripmatch_realtime';
}> {
  // 官方契約：from_city / to_city 為中文城市名（Tripmatch 內部解析為電報碼）
  const raw = await vfTrainCall(key, 'searchTrainTickets', {
    from_city: input.from,
    to_city: input.to,
    date: input.date,
  });

  const trains = raw
    .filter((t) => typeof t.trainNumber === 'string' && t.trainNumber)
    // 高鐵過濾：上游無 trainFilterFlags 參數，本地按車次號前綴過濾
    .filter((t) => (input.highSpeedOnly ? (t.trainNumber as string).startsWith('G') : true))
    .slice(0, 8) // 摘要式返回，與 searchViaMcp 的 limitedNum 語義對齊
    .map((t) => {
      const seat = pickSeatVf(t.seatLists, input.seatType);
      return {
        trainNo: t.trainNumber as string,
        from: cleanStationName(t.fromStation) || input.from,
        to: cleanStationName(t.toStation) || input.to,
        departTime: t.fromTime ?? '',
        arriveTime: t.toTime ?? '',
        durationMin: typeof t.useTime === 'number' ? t.useTime : 0,
        seatType: input.seatType,
        priceCent: seat?.priceCent ?? 0,
        ticketsLeft: seat?.remain ?? 0,
        // 附全席別明細（協議 outputSchema 僅要求 trainNo/priceCent，擴充欄位向後兼容）
        seatClasses: (t.seatLists ?? []).map((s) => ({
          name: s.seatName ?? '',
          priceCent: Math.round((s.seatPrice ?? 0) * 100),
          remain: typeof s.ticketLeft === 'number' ? s.ticketLeft : 0,
        })),
      };
    });

  return { from: input.from, to: input.to, date: input.date, trains, source: 'tripmatch_realtime' };
}


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

export const handleSearch: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as SearchTrainInput;
  if (!input.from || !input.to || !input.date) {
    return badRequest('from / to / date 必填');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return badRequest('date 格式必須為 YYYY-MM-DD');
  }

  // 查詢配額（2026-10 審計 P2 遺留項）：Tripmatch 為付費配額（VARIFLIGHT_API_KEY），
  // 此前無身份無頻次限制，公網直連可無限刷。與 llm/stt 同款雙層桶；train 與
  // flight 共用 'vf-search' 域——同一把付費鑰匙的總量封頂。monitors tick 以
  // owner 身份傳入（每用戶 ≤5 條監控 + 10 分鐘節流，遠低於個人桶上限）
  const identity = ctx.openid ?? `ip:${ctx.clientIp ?? 'unknown'}`;
  if (
    !checkQuota('vf-search', identity, 12, 60_000) ||
    !checkQuota('vf-search', '__global__', 240, 60_000)
  ) {
    return fail(429, '查詢過於頻繁，請稍後再試');
  }

  const seatType = input.seatType ?? 'second_class';

  // 資料源 1：飛常準 Tripmatch 真實實時數據（VARIFLIGHT_API_KEY 已配置時；2026-10-14）
  const vfKey = process.env.VARIFLIGHT_API_KEY;
  if (vfKey) {
    try {
      const real = await searchViaTripmatch(vfKey, {
        from: input.from as string,
        to: input.to as string,
        date: input.date as string,
        seatType,
        highSpeedOnly: input.highSpeedOnly === true,
      });
      return ok(real);
    } catch (e) {
      if (e instanceof VfTrainToolError) {
        // 上游業務錯誤（站名不支援 / Key 餘額問題）：如實透傳，不降級假數據
        return fail(503, e.message.slice(0, 200));
      }
      // 連線層失敗（超時 / 5xx / 結構異常）：回落 12306-mcp，記日誌供排查
      console.error('[skill-train] Tripmatch 查詢不可用，回落 12306-mcp：', e instanceof Error ? e.message : e);
    }
  }

  // 資料源 2：12306-mcp 真實實時數據（MCP_12306_URL 已配置且進程在跑時）
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

  // 資料源 3：確定性模擬數據（兩者皆未配置 / 連線層失敗）
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

/** 協議席別枚舉 → 中文名（copyText 展示用，與 SEAT_TYPE_TO_NAMES 對齊） */
const SEAT_TYPE_LABEL: Record<string, string> = {
  business: '商務座',
  first_class: '一等座',
  second_class: '二等座',
  hard_seat: '硬座',
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
   * 下單金額優先取真實票價（與查詢展示一致，避免「查價 ¥626 / 下單 ¥553」
   * 的金額不一致）：Tripmatch（優先）或 12306-mcp 可用且 from/to 齊備時，
   * 查當日車次並精確匹配請求席別。查不到（未配置 / 車次已消失 / 連線失敗 /
   * 席別不存在）回退靜態價目表。精確匹配不回退其他席別：訂單金額必須
   * 對應用戶確認的席別，不可「就近取」。
   */
  let amountCent = SEAT_PRICE_CENT[input.seatType] ?? SEAT_PRICE_CENT.second_class;
  const vfBookKey = process.env.VARIFLIGHT_API_KEY;
  const mcpUrl = process.env.MCP_12306_URL;
  if (vfBookKey && input.from && input.to) {
    try {
      const raw = await vfTrainCall(vfBookKey, 'searchTrainTickets', {
        from_city: input.from,
        to_city: input.to,
        date: input.date as string,
      });
      const target = raw.find((t) => t.trainNumber === input.trainNo);
      const names = SEAT_TYPE_TO_NAMES[input.seatType as string] ?? SEAT_TYPE_TO_NAMES.second_class;
      const hit = (target?.seatLists ?? []).find((s) => names.includes(s.seatName ?? ''));
      if (hit && typeof hit.seatPrice === 'number' && hit.seatPrice > 0) {
        amountCent = Math.round(hit.seatPrice * 100);
      }
    } catch (e) {
      console.error('[skill-train] 下單真實票價查詢（Tripmatch）失敗，回落 12306-mcp / 靜態價目表：', e instanceof Error ? e.message : e);
    }
  }
  if (amountCent === (SEAT_PRICE_CENT[input.seatType] ?? SEAT_PRICE_CENT.second_class)
    && mcpUrl && input.from && input.to) {
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
  /*
   * 跳轉模式：生成購票資訊卡訂單（pending_external）。真實下單與支付在
   * 12306 官方小程序側完成（官方未開放個人購票 API），本系統留存跳轉
   * 記錄供行程頁重跳轉與歷史回溯。金額取上方核實的真實票價，僅作資訊
   * 展示，實際以 12306 下單頁為準。
   */
  const orderId = `trn_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const seatLabel = SEAT_TYPE_LABEL[input.seatType] ?? input.seatType;
  const copyText = [
    `車次 ${input.trainNo}（${input.date}）`,
    `${input.from ?? ''} → ${input.to ?? ''}`,
    `${seatLabel} ¥${(amountCent / 100).toFixed(2)}`,
    `乘車人 ${input.passengerName}`,
  ].join('\n');
  await createOrder({
    orderId,
    owner: ctx.openid,
    domain: 'train',
    status: 'pending_external',
    payload: {
      trainNo: input.trainNo,
      date: input.date,
      seatType: input.seatType,
      from: input.from,
      to: input.to,
      passengerName: input.passengerName,
      amountCent,
    },
    createdAt: Date.now(),
  });

  return ok({
    orderId,
    trainNo: input.trainNo,
    // 乘車人姓名透出供購票資訊卡主卡面展示（實名攔截鏈保證必為真實值；
// 證件號仍不透出，隱私口徑不變）
    passengerName: input.passengerName,
    amountCent,
    status: 'pending_external',
    jump: buildJump('train_12306', copyText),
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
  const order = await getOrder(input.orderId);
  if (!order || order.domain !== 'train') {
    // 業務失敗（HTTP 200 + 非 0 code），SKILL rollback 會翻譯為異常
    return fail(404, `訂單不存在或已取消：${input.orderId}`);
  }
  // 歸屬鑒權 + 取消（防 IDOR——枚舉 orderId 越權取消他人訂單）
  const result = await cancelOrder(input.orderId, ctx.openid);
  if (result === 'forbidden') {
    return forbidden('無權取消他人訂單');
  }
  return ok({ ok: true, orderId: input.orderId });
};

/*
 * 成交確認（2026-10 半屏跳轉 + 支付閉環）：用戶在 12306 官方側完成真實支付後，
 * 回到行程頁點「標記已支付」將訂單歸檔為 completed。真實支付發生在渠道
 * 收銀台（對方主體資質），本端點僅記錄用戶自證成交——漏斗最深可觀測點，
 * 與埋點事件 order_confirmed 同步發生。已取消訂單不可再標記成交。
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
  if (!order || order.domain !== 'train') {
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

export const trainRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.train.12306/search_train', handleSearch],
  ['POST /api/skill/skill.train.12306/book_ticket', handleBook],
  ['POST /api/skill/skill.train.12306/book_ticket/cancel', handleCancel],
  ['POST /api/skill/skill.train.12306/book_ticket/complete', handleComplete],
];
