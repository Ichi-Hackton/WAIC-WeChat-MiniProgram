/**
 * 生活預約 SKILL 端點（skill.booking.center）
 *
 * 端點（與小程序端 booking-center SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.booking.center/search_services
 *   POST /api/skill/skill.booking.center/create_reservation
 *   POST /api/skill/skill.booking.center/create_reservation/cancel （rollback 專用）
 *   POST /api/skill/skill.booking.center/list_reservations
 *   POST /api/skill/skill.booking.center/cancel_reservation
 *
 * 2026-10 真實渠道上線：預約改為「跳轉模式」——美團等預約平台開放 API
 * 僅面向企業資質 ISV（個人不可得），故：服務目錄保留為演示性輔助
 * （幫意圖理解與需求歸納，真實商家與時段以美團為準，卡片明示）；
 * create_reservation 生成 pending_external 跳轉訂單（預約需求卡 +
 * 美團小程序跳轉 + 需求文本複製），真實預約與支付在美團側完成。
 * 預約單落庫 MySQL（db.ts，重啟不丟），以 x-wx-openid 歸屬鑒權。
 *
 * 時段表改為純確定性演示（不再剔除「已預約」時段——真實時段在美團
 * 側，本地剔除反而誤導；演示目錄僅供選擇參考）。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';
import { createOrder, getOrder, cancelOrder, listOrders } from './db';
import { buildJump } from './external-jump';

/** 演示服務目錄（確定性：離線演示與自動化驗證可復現） */
interface ServiceDef {
  serviceId: string;
  name: string;
  category: string;
  provider: string;
  address: string;
  /** 單次時長（分鐘），用於推算結束時間 */
  durationMin: number;
  priceCent: number;
}

const SERVICES: ServiceDef[] = [
  { serviceId: 'svc_001', name: '羽毛球場地（單場）', category: '運動場館', provider: '城東體育館', address: '城東區體育路 8 號 3F', durationMin: 60, priceCent: 8000 },
  { serviceId: 'svc_002', name: '口腔潔牙護理', category: '醫療健康', provider: '康貝齒科診所', address: '中山路 128 號 2F', durationMin: 45, priceCent: 29900 },
  { serviceId: 'svc_003', name: '健康體檢套餐 A', category: '醫療健康', provider: '慈康體檢中心', address: '健康大道 66 號', durationMin: 120, priceCent: 129900 },
  { serviceId: 'svc_004', name: '恆溫泳池單次票', category: '運動場館', provider: '藍鯨健身中心', address: '濱江路 200 號 B1', durationMin: 90, priceCent: 6800 },
  { serviceId: 'svc_005', name: '首席設計師剪裁', category: '生活服務', provider: '輕語造型沙龍', address: '萬象城 L2-218', durationMin: 45, priceCent: 16800 },
];

/** 每日開放預約的起始時刻模板 */
const SLOT_TIMES = ['10:00', '12:00', '14:00', '16:00', '18:00', '20:00'] as const;

/** djb2 字串雜湊（確定性偽隨機的種子來源） */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 單一時段是否天然開放（確定性；約 3/4 開放，模擬滿約） */
function slotNaturallyOpen(serviceId: string, date: string, time: string): boolean {
  return hashStr(`${serviceId}|${date}|${time}`) % 4 !== 0;
}

/** 生成某服務某日的演示時段（純確定性，真實時段以美團為準；見檔頭） */
function slotsFor(serviceId: string, date: string): Array<{ startAt: string; startTime: string; available: boolean }> {
  const slots = SLOT_TIMES.map((time) => ({
    startAt: `${date}T${time}`,
    startTime: time,
    available: slotNaturallyOpen(serviceId, date, time),
  }));
  // 保底：若確定性雜湊恰好全滿，強制開放最後一檔，保證演示目錄永遠有參考時段
  if (!slots.some((s) => s.available)) {
    slots[slots.length - 1].available = true;
  }
  return slots;
}

/** 「HH:mm」+ 分鐘數 → 結束時刻「HH:mm」 */
function addMinutes(time: string, min: number): string {
  const [h, m] = time.split(':').map((v) => Number(v));
  const total = h * 60 + m + min;
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
}

/** YYYY-MM-DD 簡式校驗（正式版應換完備日期校驗） */
function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

interface SearchServicesInput {
  keyword?: string;
  category?: string;
  date?: string;
}

const handleSearchServices: RouteHandler = async (body) => {
  const input = (body ?? {}) as SearchServicesInput;
  const kw = input.keyword?.trim() ?? '';
  const cat = input.category?.trim() ?? '';
  const date = input.date?.trim() || new Date().toISOString().slice(0, 10);
  if (!isValidDate(date)) {
    return badRequest('date 必須為 YYYY-MM-DD');
  }

  let list = SERVICES;
  if (kw) {
    list = list.filter((s) => s.name.includes(kw) || s.category.includes(kw) || s.provider.includes(kw));
  }
  if (cat) {
    list = list.filter((s) => s.category.includes(cat));
  }

  const services = list.map((s) => ({
    serviceId: s.serviceId,
    name: s.name,
    category: s.category,
    provider: s.provider,
    address: s.address,
    durationMin: s.durationMin,
    priceCent: s.priceCent,
    date,
    slots: slotsFor(s.serviceId, date),
  }));

  // 與 search_train 的 priceCentByTrain 同構：後續任務以 inputBindings 取即時價。
  // firstAvailableStartTimeByService 另提供「首個可約時段」——規劃器在用戶
  // 未點名時間時以 binding 動態取用，規避字面時間撞滿約的業務失敗
  const priceCentByService: Record<string, number> = {};
  const firstAvailableStartTimeByService: Record<string, string> = {};
  for (const s of services) {
    priceCentByService[s.serviceId] = s.priceCent;
    const first = s.slots.find((slot) => slot.available);
    if (first) firstAvailableStartTimeByService[s.serviceId] = first.startTime;
  }

  // source 明示演示目錄（真實渠道模式下目錄僅為輔助參考，真實商家以美團為準）
  return ok({ date, services, priceCentByService, firstAvailableStartTimeByService, source: 'demo' });
};

interface CreateReservationInput {
  serviceId?: string;
  date?: string;
  startTime?: string;
  contactName?: string;
  contactPhone?: string;
}

const handleCreateReservation: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CreateReservationInput;
  if (!input.serviceId || !input.date || !input.startTime) {
    return badRequest('serviceId / date / startTime 必填');
  }
  if (!isValidDate(input.date)) {
    return badRequest('date 必須為 YYYY-MM-DD');
  }
  // 歸屬鑒權：寫操作必須攜帶雲托管注入的調用方身份（規範 § 10）
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕預約');
  }
  const def = SERVICES.find((s) => s.serviceId === input.serviceId);
  if (!def) {
    return fail(404, `服務不存在：${input.serviceId}`);
  }

  /*
   * 跳轉模式：時段目錄為演示性參考（真實時段在美團側），不再做本地
   * 時段開放 / 重複預約校驗；生成預約需求卡訂單（pending_external），
   * 真實預約與支付在美團小程序側完成。
   */
  const reservationId = `rsv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const contactName = input.contactName?.trim() || '現場登記';
  const contactPhone = input.contactPhone?.trim() || '-';
  const endTime = addMinutes(input.startTime, def.durationMin);
  const copyText = [
    `預約 ${def.name}（${def.provider}）`,
    `${input.date} ${input.startTime}-${endTime}`,
    `地址 ${def.address}`,
    `聯繫人 ${contactName}，電話 ${contactPhone}`,
  ].join('\n');
  await createOrder({
    orderId: reservationId,
    owner: ctx.openid,
    domain: 'booking',
    status: 'pending_external',
    payload: {
      serviceId: def.serviceId,
      name: def.name,
      provider: def.provider,
      address: def.address,
      date: input.date,
      startTime: input.startTime,
      endTime,
      contactName,
      contactPhone,
    },
    createdAt: Date.now(),
  });

  return ok({
    reservationId,
    serviceId: def.serviceId,
    name: def.name,
    provider: def.provider,
    address: def.address,
    date: input.date,
    startTime: input.startTime,
    endTime,
    contactName,
    status: 'pending_external',
    jump: buildJump('meituan', copyText),
  });
};

interface CancelInput {
  reservationId?: string;
}

/** rollback 與用戶主動取消共用：刪除預約單（歸屬鑒權防 IDOR） */
const handleCancel: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CancelInput;
  if (!input.reservationId) {
    return badRequest('reservationId 必填');
  }
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕取消');
  }
  const r = await getOrder(input.reservationId);
  if (!r || r.domain !== 'booking') {
    return fail(404, `預約單不存在或已取消：${input.reservationId}`);
  }
  const result = await cancelOrder(input.reservationId, ctx.openid);
  if (result === 'forbidden') {
    return forbidden('無權取消他人預約');
  }
  return ok({ ok: true, reservationId: input.reservationId });
};

const handleListReservations: RouteHandler = async (_body, ctx) => {
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕查詢');
  }
  const orders = await listOrders(ctx.openid, 'booking');
  const list = orders
    .map((o) => {
      const p = o.payload as {
        serviceId?: string; name?: string; provider?: string; address?: string;
        date?: string; startTime?: string; endTime?: string; contactName?: string;
      };
      return {
        reservationId: o.orderId,
        serviceId: p.serviceId ?? '',
        name: p.name ?? '',
        provider: p.provider ?? '',
        address: p.address ?? '',
        date: p.date ?? '',
        startTime: p.startTime ?? '',
        endTime: p.endTime ?? '',
        contactName: p.contactName ?? '-',
        status: o.status,
      };
    })
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  return ok({ reservations: list });
};

export const bookingRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.booking.center/search_services', handleSearchServices],
  ['POST /api/skill/skill.booking.center/create_reservation', handleCreateReservation],
  ['POST /api/skill/skill.booking.center/create_reservation/cancel', handleCancel],
  ['POST /api/skill/skill.booking.center/list_reservations', handleListReservations],
  ['POST /api/skill/skill.booking.center/cancel_reservation', handleCancel],
];
