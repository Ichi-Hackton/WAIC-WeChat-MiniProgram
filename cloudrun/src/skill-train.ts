/**
 * 12306 火車票 SKILL 端點
 *
 * 端點（與小程序端 train-12306 SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.train.12306/search_train
 *   POST /api/skill/skill.train.12306/book_ticket
 *   POST /api/skill/skill.train.12306/book_ticket/cancel
 *
 * MVP 資料來源說明：12306 無對外開放 API，本端點返回**結構完整的確定性
 * 模擬數據**（同一入參恆得同一結果），訂單存於記憶體 Map：
 *   - 容器重啟後訂單丟失（MVP 可接受，正式版應落庫）
 *   - 多實例擴縮容時訂單不共享（正式版應落庫）
 * 對接真實購票渠道屬後續里程碑，屆時僅替換本模組內部實作，端點協議不變。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';

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

  return ok({ from: input.from, to: input.to, date: input.date, trains });
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

  const amountCent = SEAT_PRICE_CENT[input.seatType] ?? SEAT_PRICE_CENT.second_class;
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
