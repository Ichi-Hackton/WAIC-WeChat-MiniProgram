/**
 * 生活預約 SKILL
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1
 *
 * 提供能力：
 *   - search_services    ：查可預約服務與時段（idempotent, no confirm）
 *   - create_reservation ：建立預約（NOT idempotent, requires confirm, reversible）
 *   - list_reservations  ：查我的預約（idempotent, no confirm）
 *   - cancel_reservation ：取消預約（NOT idempotent, requires confirm, NOT reversible）
 *
 * 與雲端 skill-booking.ts 的端點路徑逐字對齊；雲端不可用時（負數碼）
 * 以模擬數據降級——時段生成與雲端共用同一份確定性算法約定（djb2
 * 雜湊 seed = 服務+日期+時段），保證降級前後「查到的可約時段」一致。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';
import { error as logError } from '../../../utils/logger';
import { formatDate } from '../../../utils/datetime';

export interface ServiceSlot {
  startAt: string;
  startTime: string;
  available: boolean;
}

export interface ServiceInfo {
  serviceId: string;
  name: string;
  category: string;
  provider: string;
  address: string;
  durationMin: number;
  priceCent: number;
  date: string;
  slots: ServiceSlot[];
}

export interface SearchServicesInput {
  keyword?: string;
  category?: string;
  date?: string;
}

export interface SearchServicesOutput {
  date: string;
  services: ServiceInfo[];
  priceCentByService: Record<string, number>;
  /** serviceId → 首個可約時段（規劃器未點名時間時以 binding 動態取用） */
  firstAvailableStartTimeByService: Record<string, string>;
}

export interface CreateReservationInput {
  serviceId: string;
  date: string;
  startTime: string;
  contactName?: string;
  contactPhone?: string;
}

export interface ReservationInfo {
  reservationId: string;
  serviceId: string;
  name: string;
  provider: string;
  address: string;
  date: string;
  startTime: string;
  endTime: string;
  contactName: string;
  status: 'confirmed' | 'cancelled';
}

export interface ListReservationsOutput {
  reservations: ReservationInfo[];
}

export const meta = {
  id: 'skill.booking.center',
  name: '生活預約',
  description:
    '【能做】查詢可預約服務與時段（search_services：羽毛球場、口腔潔牙、健康體檢、游泳、理髮）、建立預約（create_reservation）、查我的預約（list_reservations）、取消預約（cancel_reservation）。' +
    '【不能做】不能改期（須取消後重新預約）、不能線上支付到店服務。' +
    '【觸發時機】用戶提到「預約/預訂 + 場館/潔牙/體檢/游泳/理髮」或「我的預約」時。',
  version: '1.0.0',
  owner: 'wx-booking-mock',
  tags: ['生活', '預約'],
  capabilities: [
    {
      action: 'search_services',
      description: '按關鍵詞查可預約服務及當日時段',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '關鍵詞（匹配服務名 / 類目 / 商家）' },
          category: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD，缺省今天' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['services'],
        properties: {
          services: {
            type: 'array',
            items: {
              type: 'object',
              required: ['serviceId', 'name'],
              properties: {
                serviceId: { type: 'string' },
                name: { type: 'string' },
                provider: { type: 'string' },
                address: { type: 'string' },
                durationMin: { type: 'integer' },
                priceCent: { type: 'integer' },
                date: { type: 'string' },
                slots: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['startTime', 'available'],
                    properties: {
                      startTime: { type: 'string' },
                      available: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
          priceCentByService: { type: 'object', description: 'serviceId → 即時價（供 inputBindings 取價）' },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1000,
    },
    {
      action: 'create_reservation',
      description: '在指定服務的可用時段建立預約',
      inputSchema: {
        type: 'object',
        required: ['serviceId', 'date', 'startTime'],
        properties: {
          serviceId: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          startTime: { type: 'string', description: 'HH:mm，須為該服務當日可用時段' },
          contactName: { type: 'string', description: '聯繫人（可選，缺省現場登記）' },
          contactPhone: { type: 'string', description: '聯繫電話（可選）' },
          priceCent: {
            type: 'integer',
            description: '服務費（分），由 inputBindings 從 search_services 注入，僅供確認彈窗展示',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['reservationId'],
        properties: {
          reservationId: { type: 'string' },
          startTime: { type: 'string' },
          endTime: { type: 'string' },
          status: { type: 'string' },
        },
      },
      idempotent: false,
      reversible: true,
      requiresHumanConfirm: true,
      estimatedLatencyMs: 1200,
    },
    {
      action: 'list_reservations',
      description: '查詢我的全部預約',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      outputSchema: {
        type: 'object',
        required: ['reservations'],
        properties: {
          reservations: { type: 'array', items: { type: 'object' } },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 800,
    },
    {
      action: 'cancel_reservation',
      description: '取消指定預約（不可逆，改期須重新預約）',
      inputSchema: {
        type: 'object',
        required: ['reservationId'],
        properties: {
          reservationId: { type: 'string' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
        },
      },
      idempotent: false,
      reversible: false,
      requiresHumanConfirm: true,
      estimatedLatencyMs: 800,
    },
  ],
} as unknown as SkillMeta;

/**
 * 模擬服務目錄（與雲端 skill-booking.ts 的演示數據逐字對齊）
 */
const MOCK_SERVICES: Array<Omit<ServiceInfo, 'date' | 'slots'>> = [
  { serviceId: 'svc_001', name: '羽毛球場地（單場）', category: '運動場館', provider: '城東體育館', address: '城東區體育路 8 號 3F', durationMin: 60, priceCent: 8000 },
  { serviceId: 'svc_002', name: '口腔潔牙護理', category: '醫療健康', provider: '康貝齒科診所', address: '中山路 128 號 2F', durationMin: 45, priceCent: 29900 },
  { serviceId: 'svc_003', name: '健康體檢套餐 A', category: '醫療健康', provider: '慈康體檢中心', address: '健康大道 66 號', durationMin: 120, priceCent: 129900 },
  { serviceId: 'svc_004', name: '恆溫泳池單次票', category: '運動場館', provider: '藍鯨健身中心', address: '濱江路 200 號 B1', durationMin: 90, priceCent: 6800 },
  { serviceId: 'svc_005', name: '首席設計師剪裁', category: '生活服務', provider: '輕語造型沙龍', address: '萬象城 L2-218', durationMin: 45, priceCent: 16800 },
];

const SLOT_TIMES = ['10:00', '12:00', '14:00', '16:00', '18:00', '20:00'] as const;

/** djb2 雜湊（與雲端共用同一算法約定，保證 mock 降級時段可復現） */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 模擬預約單表（模組級單例：mock 降級路徑的會話內狀態） */
const mockReservations = new Map<string, ReservationInfo>();

/** 生成某服務某日的可約時段（天然開放 ∖ 已被預約；全滿時保底開放最後一檔） */
function mockSlots(serviceId: string, date: string): ServiceSlot[] {
  const taken = new Set<string>();
  for (const r of mockReservations.values()) {
    if (r.serviceId === serviceId && r.date === date) taken.add(r.startTime);
  }
  const slots = SLOT_TIMES.map((time) => ({
    startAt: `${date}T${time}`,
    startTime: time,
    available: hashStr(`${serviceId}|${date}|${time}`) % 4 !== 0 && !taken.has(time),
  }));
  if (!slots.some((s) => s.available)) slots[slots.length - 1].available = true;
  return slots;
}

/** 「HH:mm」+ 分鐘數 → 結束時刻（與雲端同構） */
function addMinutes(time: string, min: number): string {
  const [h, m] = time.split(':').map((v) => Number(v));
  const total = h * 60 + m + min;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    const env = ctx.globals.cloudEnv as string;
    if (action === 'search_services') {
      return invokeSearch(env, input as SearchServicesInput, ctx.sessionId);
    }
    if (action === 'create_reservation') {
      return invokeCreate(env, input as CreateReservationInput, ctx.sessionId);
    }
    if (action === 'list_reservations') {
      return invokeList(env, ctx.sessionId);
    }
    if (action === 'cancel_reservation') {
      return invokeCancel(env, input as { reservationId: string }, ctx.sessionId);
    }
    return {
      success: false,
      error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
    };
  },
  async rollback(action, _input, result, ctx) {
    if (action !== 'create_reservation') return;
    const env = ctx.globals.cloudEnv as string;
    const res = await postContainer<{ ok: boolean }>(
      env,
      '/api/skill/skill.booking.center/create_reservation/cancel',
      { reservationId: (result.data as ReservationInfo).reservationId },
      { sessionId: ctx.sessionId, retry: false },
    );
    if (res.code !== 0) {
      logError('booking rollback 失敗', res);
      throw new Error('預約取消失敗');
    }
  },
};

async function invokeSearch(env: string, input: SearchServicesInput, sessionId: string): Promise<SkillResult<SearchServicesOutput>> {
  const res: CloudResponse<SearchServicesOutput> = await postContainer<SearchServicesOutput>(
    env,
    '/api/skill/skill.booking.center/search_services',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲端不可用時返回 mock：負數碼 = 雲基礎設施錯誤（見 coffee SKILL 說明）
  if (res.code < 0) return { success: true, data: mockSearch(input) };
  return {
    success: false,
    error: { code: 'SERVICE_SEARCH_FAILED', message: res.message ?? '服務查詢失敗', retryable: true },
  };
}

async function invokeCreate(env: string, input: CreateReservationInput, sessionId: string): Promise<SkillResult<ReservationInfo>> {
  const res: CloudResponse<ReservationInfo> = await postContainer<ReservationInfo>(
    env,
    '/api/skill/skill.booking.center/create_reservation',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) {
    // mock 降級：與雲端同構的校驗（服務存在 / 時段可用 / 防重複預約）
    const def = MOCK_SERVICES.find((s) => s.serviceId === input.serviceId);
    if (!def) {
      return { success: false, error: { code: 'SERVICE_NOT_FOUND', message: `服務不存在：${input.serviceId}`, retryable: false } };
    }
    const slot = mockSlots(input.serviceId, input.date).find((s) => s.startTime === input.startTime);
    if (!slot || !slot.available) {
      return {
        success: false,
        error: { code: 'SLOT_UNAVAILABLE', message: `該時段不可約：${input.date} ${input.startTime}`, retryable: false },
      };
    }
    const dup = Array.from(mockReservations.values()).find(
      (r) => r.serviceId === input.serviceId && r.date === input.date && r.startTime === input.startTime,
    );
    if (dup) {
      return {
        success: false,
        error: { code: 'DUPLICATED_RESERVATION', message: `你已預約過此時段（預約號 ${dup.reservationId}）`, retryable: false },
      };
    }
    const info: ReservationInfo = {
      reservationId: `mock_rsv_${Date.now()}`,
      serviceId: def.serviceId,
      name: def.name,
      provider: def.provider,
      address: def.address,
      date: input.date,
      startTime: input.startTime,
      endTime: addMinutes(input.startTime, def.durationMin),
      contactName: input.contactName?.trim() || '現場登記',
      status: 'confirmed',
    };
    mockReservations.set(info.reservationId, info);
    return { success: true, data: info };
  }
  return {
    success: false,
    error: { code: 'RESERVATION_FAILED', message: res.message ?? '預約失敗', retryable: false },
  };
}

async function invokeList(env: string, sessionId: string): Promise<SkillResult<ListReservationsOutput>> {
  const res: CloudResponse<ListReservationsOutput> = await postContainer<ListReservationsOutput>(
    env,
    '/api/skill/skill.booking.center/list_reservations',
    {},
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) {
    const reservations = Array.from(mockReservations.values()).sort((a, b) =>
      (a.date + a.startTime).localeCompare(b.date + b.startTime),
    );
    return { success: true, data: { reservations } };
  }
  return {
    success: false,
    error: { code: 'LIST_FAILED', message: res.message ?? '預約查詢失敗', retryable: true },
  };
}

async function invokeCancel(env: string, input: { reservationId: string }, sessionId: string): Promise<SkillResult<{ ok: boolean }>> {
  const res: CloudResponse<{ ok: boolean }> = await postContainer<{ ok: boolean }>(
    env,
    '/api/skill/skill.booking.center/cancel_reservation',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) {
    if (!mockReservations.has(input.reservationId)) {
      return { success: false, error: { code: 'NOT_FOUND', message: `預約單不存在：${input.reservationId}`, retryable: false } };
    }
    mockReservations.delete(input.reservationId);
    return { success: true, data: { ok: true } };
  }
  return {
    success: false,
    error: { code: 'CANCEL_FAILED', message: res.message ?? '取消失敗', retryable: false },
  };
}

function mockSearch(input: SearchServicesInput): SearchServicesOutput {
  const kw = input.keyword?.trim() ?? '';
  const cat = input.category?.trim() ?? '';
  const date = input.date?.trim() || formatDate(new Date());
  let list = MOCK_SERVICES;
  if (kw) list = list.filter((s) => s.name.includes(kw) || s.category.includes(kw) || s.provider.includes(kw));
  if (cat) list = list.filter((s) => s.category.includes(cat));
  const services: ServiceInfo[] = list.map((s) => ({ ...s, date, slots: mockSlots(s.serviceId, date) }));
  const priceCentByService: Record<string, number> = {};
  const firstAvailableStartTimeByService: Record<string, string> = {};
  for (const s of services) {
    priceCentByService[s.serviceId] = s.priceCent;
    const first = s.slots.find((slot) => slot.available);
    if (first) firstAvailableStartTimeByService[s.serviceId] = first.startTime;
  }
  return { date, services, priceCentByService, firstAvailableStartTimeByService };
}
