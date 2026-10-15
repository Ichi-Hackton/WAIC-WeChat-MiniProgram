/**
 * 演出票務 SKILL（skill.ticket.show）
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1；六環節擴展鏈路第 ③ 環
 *
 * 提供能力：
 *   - search_events ：跨渠道搜演出（idempotent, no confirm）
 *   - list_sessions ：查場次與票檔（idempotent, no confirm）
 *   - create_order  ：生成購票需求卡並跳轉大麥小程序（NOT idempotent, requires confirm, reversible）
 *   - list_orders   ：查我的票務訂單（idempotent, no confirm）
 *   - cancel_order  ：取消訂單（NOT idempotent, requires confirm, NOT reversible）
 *
 * 與雲端 skill-ticket.ts 的端點路徑逐字對齊；雲端不可用時（負數碼 =
 * 雲基礎設施錯誤）以演示目錄 mock 降級——目錄、場次與確定性庫存算法
 * 與雲端共用同一份約定（djb2 雜湊 seed = 場次+票檔），保證降級前後
 * 查到的演出 / 票價 / 餘票一致。
 *
 * 2026-10 跳轉模式：大麥 / 秀動無公開 API（渠道網關僅企業 ISV），
 * create_order 產出 pending_external 購票需求卡 + 大麥小程序跳轉包，
 * 真實購票與支付在大麥側完成。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta, JumpPackage } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';
import { error as logError } from '../../../utils/logger';

// ---------------------------------------------------------------------------
// 出入參協議（與雲端 skill-ticket.ts 逐字對齊）
// ---------------------------------------------------------------------------

export interface EventSummary {
  eventId: string;
  name: string;
  type: string;
  artist: string;
  city: string;
  venue: string;
  provider: string;
  minPriceCent: number;
  onSale: boolean;
  sessionCount: number;
  firstSessionDate: string;
}

export interface SearchEventsInput {
  keyword?: string;
  city?: string;
  type?: string;
}

export interface SearchEventsOutput {
  events: EventSummary[];
  firstEventId: string | null;
  eventIdByName: Record<string, string>;
}

export interface TierInfo {
  tierId: string;
  name: string;
  priceCent: number;
  inventory: number;
}

export interface SessionInfo {
  sessionId: string;
  eventId: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  priceTiers: TierInfo[];
}

export interface ListSessionsOutput {
  event: EventSummary;
  sessions: SessionInfo[];
  firstAvailableSessionId: string | null;
  firstAvailableTierId: string | null;
  firstAvailablePriceCent: number | null;
  sessionIdByTime: Record<string, string>;
  tierIdByTime: Record<string, string>;
  priceCentByTime: Record<string, number>;
  priceCentBySession: Record<string, number>;
}

export interface CreateOrderInput {
  eventId: string;
  sessionId: string;
  tierId: string;
  quantity: number;
  viewerName: string;
  viewerIdNo: string;
  /** 由 inputBindings 從 list_sessions 注入的即時票價（分）：僅供 checkpoint 展示 */
  priceCent?: number;
}

export interface TicketOrderInfo {
  orderId: string;
  eventId: string;
  eventName: string;
  sessionId: string;
  sessionDate: string;
  startTime: string;
  tierId: string;
  tierName: string;
  quantity: number;
  amountCent: number;
  status: 'pending_external' | 'completed' | 'cancelled';
  /** 渠道跳轉包（appId 空 = copy-only，EXTERNAL_JUMP 配置後生效） */
  jump?: JumpPackage;
}

// ---------------------------------------------------------------------------
// 演示目錄（與雲端 skill-ticket.ts 的 EVENTS 逐字對齊；名稱不得含「.」
// ——bindings 以點號路徑取值）
// ---------------------------------------------------------------------------

interface TierDef {
  tierNo: string;
  name: string;
  priceCent: number;
}

interface SessionDef {
  sessionNo: string;
  offsetDays: number;
  startTime: string;
  durationMin: number;
  tiers: TierDef[];
}

interface EventDef {
  eventId: string;
  name: string;
  type: string;
  artist: string;
  city: string;
  venue: string;
  provider: 'damai' | 'showstart';
  sessions: SessionDef[];
}

const EVENTS: EventDef[] = [
  {
    eventId: 'ev_001',
    name: '周杰倫「嘉年華」世界巡迴演唱會-上海站',
    type: '演唱會',
    artist: '周杰倫',
    city: '上海',
    venue: '上海體育場',
    provider: 'damai',
    sessions: [
      { sessionNo: 's1', offsetDays: 7, startTime: '19:00', durationMin: 150, tiers: [
        { tierNo: 't1', name: '看台', priceCent: 38000 },
        { tierNo: 't2', name: '內場', priceCent: 128000 },
        { tierNo: 't3', name: 'VIP', priceCent: 228000 },
      ] },
      { sessionNo: 's2', offsetDays: 8, startTime: '19:00', durationMin: 150, tiers: [
        { tierNo: 't1', name: '看台', priceCent: 38000 },
        { tierNo: 't2', name: '內場', priceCent: 128000 },
        { tierNo: 't3', name: 'VIP', priceCent: 228000 },
      ] },
    ],
  },
  {
    eventId: 'ev_002',
    name: '五月天 [回到那一天] 25 巡迴演唱會-北京站',
    type: '演唱會',
    artist: '五月天',
    city: '北京',
    venue: '國家體育場（鳥巢）',
    provider: 'damai',
    sessions: [
      { sessionNo: 's1', offsetDays: 12, startTime: '18:30', durationMin: 165, tiers: [
        { tierNo: 't1', name: '看台', priceCent: 45500 },
        { tierNo: 't2', name: '內場', priceCent: 145500 },
        { tierNo: 't3', name: 'VIP', priceCent: 205500 },
      ] },
      { sessionNo: 's2', offsetDays: 13, startTime: '18:30', durationMin: 165, tiers: [
        { tierNo: 't1', name: '看台', priceCent: 45500 },
        { tierNo: 't2', name: '內場', priceCent: 145500 },
        { tierNo: 't3', name: 'VIP', priceCent: 205500 },
      ] },
    ],
  },
  {
    eventId: 'ev_003',
    name: '2026 草莓音樂節-杭州站',
    type: '音樂節',
    artist: '草莓音樂節',
    city: '杭州',
    venue: '白馬湖國際會展中心',
    provider: 'showstart',
    sessions: [
      { sessionNo: 's1', offsetDays: 15, startTime: '13:00', durationMin: 600, tiers: [
        { tierNo: 't1', name: '單日票', priceCent: 48000 },
        { tierNo: 't2', name: '雙日票', priceCent: 88000 },
        { tierNo: 't3', name: 'VIP', priceCent: 158000 },
      ] },
      { sessionNo: 's2', offsetDays: 16, startTime: '13:00', durationMin: 600, tiers: [
        { tierNo: 't1', name: '單日票', priceCent: 48000 },
        { tierNo: 't2', name: '雙日票', priceCent: 88000 },
        { tierNo: 't3', name: 'VIP', priceCent: 158000 },
      ] },
    ],
  },
  {
    eventId: 'ev_004',
    name: '話劇《暗戀桃花源》經典版',
    type: '話劇',
    artist: '賴聲川',
    city: '上海',
    venue: '上劇場',
    provider: 'showstart',
    sessions: [
      { sessionNo: 's1', offsetDays: 5, startTime: '19:30', durationMin: 150, tiers: [
        { tierNo: 't1', name: '二樓', priceCent: 38000 },
        { tierNo: 't2', name: '一樓', priceCent: 58000 },
        { tierNo: 't3', name: 'VIP', priceCent: 88000 },
      ] },
      { sessionNo: 's2', offsetDays: 6, startTime: '14:00', durationMin: 150, tiers: [
        { tierNo: 't1', name: '二樓', priceCent: 38000 },
        { tierNo: 't2', name: '一樓', priceCent: 58000 },
        { tierNo: 't3', name: 'VIP', priceCent: 88000 },
      ] },
    ],
  },
  {
    eventId: 'ev_005',
    name: '音樂劇《劇院魅影》中文版',
    type: '音樂劇',
    artist: '世界經典音樂劇',
    city: '北京',
    venue: '天橋藝術中心',
    provider: 'damai',
    sessions: [
      { sessionNo: 's1', offsetDays: 10, startTime: '19:30', durationMin: 150, tiers: [
        { tierNo: 't1', name: '山頂座位', priceCent: 28000 },
        { tierNo: 't2', name: '二層', priceCent: 48000 },
        { tierNo: 't3', name: '一層', priceCent: 68000 },
      ] },
      { sessionNo: 's2', offsetDays: 11, startTime: '14:00', durationMin: 150, tiers: [
        { tierNo: 't1', name: '山頂座位', priceCent: 28000 },
        { tierNo: 't2', name: '二層', priceCent: 48000 },
        { tierNo: 't3', name: '一層', priceCent: 68000 },
      ] },
    ],
  },
  {
    eventId: 'ev_006',
    name: 'CBA 常規賽 北京首鋼 vs 上海久事',
    type: '體育賽事',
    artist: '北京首鋼',
    city: '北京',
    venue: '凱迪拉克中心',
    provider: 'damai',
    sessions: [
      { sessionNo: 's1', offsetDays: 9, startTime: '19:35', durationMin: 130, tiers: [
        { tierNo: 't1', name: '上層看台', priceCent: 18000 },
        { tierNo: 't2', name: '下層看台', priceCent: 38000 },
        { tierNo: 't3', name: '場邊 VIP', priceCent: 98000 },
      ] },
    ],
  },
];

// ---------------------------------------------------------------------------
// 確定性庫存算法（與雲端同構：djb2 雜湊 seed = 場次+票檔；t1 保底有票）
// ---------------------------------------------------------------------------

function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

function baseInventory(sessionId: string, tierNo: string): number {
  const h = hashStr(`${sessionId}|${tierNo}`);
  if (tierNo === 't1') return 2 + (h % 35);
  return h % 6 === 0 ? 0 : 2 + (h % 35);
}

function dateAfterDays(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addMinutes(time: string, min: number): string {
  const [h, m] = time.split(':').map((v) => Number(v));
  const total = h * 60 + m + min;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function buildSessions(def: EventDef): SessionInfo[] {
  return def.sessions
    .map((s) => {
      const sessionId = `${def.eventId}_${s.sessionNo}`;
      return {
        sessionId,
        eventId: def.eventId,
        date: dateAfterDays(s.offsetDays),
        startTime: s.startTime,
        endTime: addMinutes(s.startTime, s.durationMin),
        status: 'on_sale',
        priceTiers: s.tiers.map((t) => ({
          tierId: `${sessionId}_${t.tierNo}`,
          name: t.name,
          priceCent: t.priceCent,
          inventory: baseInventory(sessionId, t.tierNo),
        })),
      };
    })
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
}

function buildSummary(def: EventDef): EventSummary {
  const sessions = buildSessions(def);
  const allTiers = sessions.flatMap((s) => s.priceTiers);
  return {
    eventId: def.eventId,
    name: def.name,
    type: def.type,
    artist: def.artist,
    city: def.city,
    venue: def.venue,
    provider: def.provider,
    minPriceCent: allTiers.length > 0 ? Math.min(...allTiers.map((t) => t.priceCent)) : 0,
    onSale: allTiers.some((t) => t.inventory > 0),
    sessionCount: sessions.length,
    firstSessionDate: sessions[0]?.date ?? '',
  };
}

/** mock 訂單表（降級路徑的會話內狀態） */
const mockOrders = new Map<string, TicketOrderInfo>();

// ---------------------------------------------------------------------------
// SKILL 協議宣告與實作
// ---------------------------------------------------------------------------

export const meta = {
  id: 'skill.ticket.show',
  name: '演出票務',
  description:
    '【能做】跨渠道搜演出（search_events：演唱會/話劇/音樂劇/音樂節/體育賽事）、查場次票檔（list_sessions）、生成購票需求卡並跳轉大麥小程序完成真實購票（create_order，真實交易在大麥側）、查我的票務訂單（list_orders）、取消訂單（cancel_order）。' +
    '【不能做】不能選座（以渠道下單頁為準）、不能改期（須取消後重下單）。' +
    '【觸發時機】用戶提到「演唱會/話劇/音樂劇/音樂節/看比賽/CBA/演出票」或點名演出（周杰倫/五月天/草莓音樂節/暗戀桃花源/劇院魅影）時。',
  version: '1.0.0',
  owner: 'wx-ticket-mock',
  tags: ['票務', '演出'],
  capabilities: [
    {
      action: 'search_events',
      description: '按關鍵詞/城市/類型搜尋演出',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '關鍵詞（匹配演出名/藝人/場館）' },
          city: { type: 'string' },
          type: { type: 'string', description: '演出類型（演唱會/話劇…）' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['events'],
        properties: {
          events: { type: 'array', items: { type: 'object' } },
          firstEventId: { type: ['string', 'null'] },
          eventIdByName: { type: 'object', description: '演出名 → eventId（點名演出直達）' },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1200,
    },
    {
      action: 'list_sessions',
      description: '查詢演出的場次與票檔（含即時庫存與 bindings 映射）',
      inputSchema: {
        type: 'object',
        required: ['eventId'],
        properties: {
          eventId: { type: 'string' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['sessions'],
        properties: {
          sessions: { type: 'array', items: { type: 'object' } },
          firstAvailableSessionId: { type: ['string', 'null'] },
          firstAvailableTierId: { type: ['string', 'null'] },
          firstAvailablePriceCent: { type: ['integer', 'null'] },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1200,
    },
    {
      action: 'create_order',
      description: '生成購票需求卡並跳轉大麥小程序（真實購票與支付在渠道側）',
      inputSchema: {
        type: 'object',
        required: ['eventId', 'sessionId', 'tierId', 'viewerName', 'viewerIdNo'],
        properties: {
          eventId: { type: 'string' },
          sessionId: { type: 'string' },
          tierId: { type: 'string' },
          quantity: { type: 'integer', minimum: 1, maximum: 4 },
          viewerName: { type: 'string', description: '實名觀演人姓名' },
          viewerIdNo: { type: 'string', description: '實名觀演人證件號' },
          priceCent: { type: 'integer', description: '即時票價（分），由 inputBindings 注入，僅供確認彈窗展示' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['orderId', 'amountCent'],
        properties: {
          orderId: { type: 'string' },
          amountCent: { type: 'integer' },
          status: { type: 'string' },
        },
      },
      idempotent: false,
      reversible: true,
      requiresHumanConfirm: true,
      estimatedLatencyMs: 1500,
    },
    {
      action: 'list_orders',
      description: '查詢我的全部票務訂單',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      outputSchema: {
        type: 'object',
        required: ['orders'],
        properties: {
          orders: { type: 'array', items: { type: 'object' } },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 800,
    },
    {
      action: 'cancel_order',
      description: '取消票務訂單（放棄購票）',
      inputSchema: {
        type: 'object',
        required: ['orderId'],
        properties: {
          orderId: { type: 'string' },
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

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    const env = ctx.globals.cloudEnv as string;
    if (action === 'search_events') {
      return invokeSearchEvents(env, input as SearchEventsInput, ctx.sessionId);
    }
    if (action === 'list_sessions') {
      return invokeListSessions(env, input as { eventId: string }, ctx.sessionId);
    }
    if (action === 'create_order') {
      return invokeCreateOrder(env, input as CreateOrderInput, ctx.sessionId);
    }
    if (action === 'list_orders') {
      return invokeListOrders(env, ctx.sessionId);
    }
    if (action === 'cancel_order') {
      return invokeCancel(env, input as { orderId: string }, ctx.sessionId);
    }
    return {
      success: false,
      error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
    };
  },
  async rollback(action, _input, result, ctx) {
    if (action !== 'create_order') return;
    const env = ctx.globals.cloudEnv as string;
    const res = await postContainer<{ ok: boolean }>(
      env,
      '/api/skill/skill.ticket.show/create_order/cancel',
      { orderId: (result.data as TicketOrderInfo).orderId },
      { sessionId: ctx.sessionId, retry: false },
    );
    if (res.code !== 0) {
      logError('ticket rollback 失敗', res);
      throw new Error('票務訂單取消失敗');
    }
  },
};

async function invokeSearchEvents(env: string, input: SearchEventsInput, sessionId: string): Promise<SkillResult<SearchEventsOutput>> {
  const res: CloudResponse<SearchEventsOutput> = await postContainer<SearchEventsOutput>(
    env,
    '/api/skill/skill.ticket.show/search_events',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲端不可用時返回 mock：負數碼 = 雲基礎設施錯誤（見 coffee SKILL 說明）
  if (res.code < 0) return { success: true, data: mockSearchEvents(input) };
  return {
    success: false,
    error: { code: 'EVENT_SEARCH_FAILED', message: res.message ?? '演出查詢失敗', retryable: true },
  };
}

async function invokeListSessions(env: string, input: { eventId: string }, sessionId: string): Promise<SkillResult<ListSessionsOutput>> {
  const res: CloudResponse<ListSessionsOutput> = await postContainer<ListSessionsOutput>(
    env,
    '/api/skill/skill.ticket.show/list_sessions',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) {
    const mocked = mockListSessions(input.eventId);
    if (!mocked) {
      return { success: false, error: { code: 'EVENT_NOT_FOUND', message: `演出不存在：${input.eventId}`, retryable: false } };
    }
    return { success: true, data: mocked };
  }
  return {
    success: false,
    error: { code: 'SESSION_QUERY_FAILED', message: res.message ?? '場次查詢失敗', retryable: true },
  };
}

async function invokeCreateOrder(env: string, input: CreateOrderInput, sessionId: string): Promise<SkillResult<TicketOrderInfo>> {
  const res: CloudResponse<TicketOrderInfo> = await postContainer<TicketOrderInfo>(
    env,
    '/api/skill/skill.ticket.show/create_order',
    input,
    // 寫操作禁用自動重試：逾時重試會重複建單（同 train invokeBook 防線；
    // 跳轉域重複單僅為重複需求卡，但口徑與各域寫操作保持一致）
    { sessionId, retry: false },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) {
    // mock 降級：與雲端同構的定位核實（演出/場次/票檔存在 + 庫存足夠）
    const def = EVENTS.find((e) => e.eventId === input.eventId);
    const session = def ? buildSessions(def).find((s) => s.sessionId === input.sessionId) : undefined;
    const tier = session?.priceTiers.find((t) => t.tierId === input.tierId);
    if (!def || !session || !tier) {
      return { success: false, error: { code: 'TIER_NOT_FOUND', message: `場次或票檔不存在：${input.sessionId} / ${input.tierId}`, retryable: false } };
    }
    if (tier.inventory < input.quantity) {
      return { success: false, error: { code: 'SOLD_OUT', message: `該票檔餘票不足（剩餘 ${tier.inventory} 張，需求 ${input.quantity} 張）`, retryable: false } };
    }
    const amountCent = tier.priceCent * input.quantity;
    const copyText = [
      `演出 ${def.name}`,
      `${session.date} ${session.startTime} 場`,
      `${tier.name} ×${input.quantity}（參考價 ¥${(amountCent / 100).toFixed(2)}）`,
      `場館 ${def.venue}`,
      '以下單頁實際價格與票檔為準',
    ].join('\n');
    const info: TicketOrderInfo = {
      orderId: `mock_tkt_${Date.now()}`,
      eventId: def.eventId,
      eventName: def.name,
      sessionId: session.sessionId,
      sessionDate: session.date,
      startTime: session.startTime,
      tierId: tier.tierId,
      tierName: tier.name,
      quantity: input.quantity,
      amountCent,
      status: 'pending_external',
      jump: { target: 'damai', appId: '', copyText, note: '真實交易於外部官方渠道完成，支付與售後以渠道為準' },
    };
    mockOrders.set(info.orderId, info);
    return { success: true, data: info };
  }
  return {
    success: false,
    error: { code: 'CREATE_ORDER_FAILED', message: res.message ?? '購票卡生成失敗', retryable: false },
  };
}

async function invokeListOrders(env: string, sessionId: string): Promise<SkillResult<{ orders: TicketOrderInfo[] }>> {
  const res: CloudResponse<{ orders: TicketOrderInfo[] }> = await postContainer<{ orders: TicketOrderInfo[] }>(
    env,
    '/api/skill/skill.ticket.show/list_orders',
    {},
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) {
    const orders = Array.from(mockOrders.values());
    return { success: true, data: { orders } };
  }
  return {
    success: false,
    error: { code: 'LIST_FAILED', message: res.message ?? '訂單查詢失敗', retryable: true },
  };
}

async function invokeCancel(env: string, input: { orderId: string }, sessionId: string): Promise<SkillResult<{ ok: boolean }>> {
  const res: CloudResponse<{ ok: boolean }> = await postContainer<{ ok: boolean }>(
    env,
    '/api/skill/skill.ticket.show/cancel_order',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) {
    if (!mockOrders.has(input.orderId)) {
      return { success: false, error: { code: 'NOT_FOUND', message: `訂單不存在：${input.orderId}`, retryable: false } };
    }
    mockOrders.delete(input.orderId);
    return { success: true, data: { ok: true } };
  }
  return {
    success: false,
    error: { code: 'CANCEL_FAILED', message: res.message ?? '取消失敗', retryable: false },
  };
}

function mockSearchEvents(input: SearchEventsInput): SearchEventsOutput {
  const kw = input.keyword?.trim() ?? '';
  const city = input.city?.trim() ?? '';
  const type = input.type?.trim() ?? '';
  let list = EVENTS;
  if (kw) {
    list = list.filter(
      (e) => e.name.includes(kw) || e.artist.includes(kw) || e.venue.includes(kw) || e.city.includes(kw) || e.type.includes(kw),
    );
  }
  if (city) list = list.filter((e) => e.city.includes(city));
  if (type) list = list.filter((e) => e.type.includes(type));
  const events = list.map(buildSummary);
  const eventIdByName: Record<string, string> = {};
  for (const e of events) eventIdByName[e.name] = e.eventId;
  return { events, firstEventId: events[0]?.eventId ?? null, eventIdByName };
}

function mockListSessions(eventId: string): ListSessionsOutput | null {
  const def = EVENTS.find((e) => e.eventId === eventId);
  if (!def) return null;
  const sessions = buildSessions(def);

  // bindings 映射（與雲端同構）：首個有票組合 + 按開演時間直達映射
  const sessionIdByTime: Record<string, string> = {};
  const tierIdByTime: Record<string, string> = {};
  const priceCentByTime: Record<string, number> = {};
  const priceCentBySession: Record<string, number> = {};
  let firstAvailableSessionId: string | null = null;
  let firstAvailableTierId: string | null = null;
  let firstAvailablePriceCent: number | null = null;
  for (const s of sessions) {
    const firstTier = s.priceTiers.find((t) => t.inventory > 0);
    if (firstTier) {
      sessionIdByTime[s.startTime] = s.sessionId;
      tierIdByTime[s.startTime] = firstTier.tierId;
      priceCentByTime[s.startTime] = firstTier.priceCent;
      priceCentBySession[s.sessionId] = firstTier.priceCent;
      if (firstAvailableSessionId === null) {
        firstAvailableSessionId = s.sessionId;
        firstAvailableTierId = firstTier.tierId;
        firstAvailablePriceCent = firstTier.priceCent;
      }
    }
  }
  return {
    event: buildSummary(def),
    sessions,
    firstAvailableSessionId,
    firstAvailableTierId,
    firstAvailablePriceCent,
    sessionIdByTime,
    tierIdByTime,
    priceCentByTime,
    priceCentBySession,
  };
}
