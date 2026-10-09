/**
 * 演出票務 SKILL 端點（skill.ticket.show）
 *
 * 端點（與小程序端 ticket-show SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.ticket.show/search_events
 *   POST /api/skill/skill.ticket.show/list_sessions
 *   POST /api/skill/skill.ticket.show/create_order
 *   POST /api/skill/skill.ticket.show/create_order/cancel （rollback 專用）
 *   POST /api/skill/skill.ticket.show/list_orders
 *   POST /api/skill/skill.ticket.show/cancel_order
 *
 * 統一票務接口規範（跨平台聚合）：
 *   大麥 / 秀動等第三方票務平台經 TicketProvider 適配層（ticket-provider.ts）
 *   接入，對 SKILL 層暴露統一協議——五個 capability 的入出參不含任何平台
 *   細節，平台僅以 event.provider 欄位作展示標記。渠道接入配置（選配）：
 *     TICKET_DAMAI_API_BASE / TICKET_DAMAI_API_KEY      （大麥渠道網關）
 *     TICKET_SHOWSTART_API_BASE / TICKET_SHOWSTART_API_KEY（秀動渠道網關）
 *   配置後由 createRestTicketProvider 按「票務渠道接入 REST 契約」真實
 *   調用（Bearer 鑒權 / 超時 / 錯誤分流，參考實作見 scripts/ticket-partner-mock.mjs）；
 *   演示目錄 Provider 恆在末位兜底，未配置渠道時演示鏈路仍可用。
 *   下單 / 取消為模擬閉環（同 skill-train 模式：渠道下單 API 開通後僅
 *   替換 Provider 內部實作，端點協議不變）。
 *
 * 庫存模型：確定性偽隨機基礎庫存（djb2 雜湊 seed = 場次+票檔；最低
 * 價檔 t1 保底有票，保證演示鏈路永遠可下單）− 記憶體已售量；同一入
 * 參恆得同一結果，離線演示與自動化驗證均可復現（渠道 Provider 的
 * 庫存以渠道即時回傳為準）。
 *
 * 訂單存於記憶體 Map（重啟丟失、多實例不共享，正式版應落庫），以
 * x-wx-openid 歸屬鑒權（規範 § 10）：寫操作缺身份 401、越權操作
 * 他人訂單 403（防 IDOR）。
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized, forbidden } from './api';
import type { EventSummary, SessionInfo, TierInfo, SessionBundle, TicketProvider } from './ticket-provider';
import { TicketProviderError, createRestTicketProvider } from './ticket-provider';

// ---------------------------------------------------------------------------
// 演示目錄（MVP 確定性數據；正式版由各 Provider 從渠道 API 拉取）
// ---------------------------------------------------------------------------

/** 票檔定義（價目表；庫存由確定性演算法即時計算） */
interface TierDef {
  tierNo: string;
  name: string;
  priceCent: number;
}

/** 場次定義（offsetDays 相對今天，進程內解析為具體日期） */
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

/**
 * 演示演出目錄（名稱不得含「.」—— bindings 以點號路徑取值，
 * 與 train-12306 的 priceCentByTrain 映射鍵約定一致）
 */
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
// 確定性庫存演算法（與小程序端 mock 降級共用同一約定）
// ---------------------------------------------------------------------------

/** djb2 字串雜湊（與 skill-booking / 小程序端 mock 共用同一算法） */
function hashStr(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 已售量（tierId → 數量；下單扣減、取消恢復） */
const soldByTier = new Map<string, number>();

/**
 * 確定性基礎庫存：最低價檔 t1 保底 2~36 張（演示鏈路永遠可下單），
 * 其餘票檔約 1/6 售罄、其餘 2~36 張（模擬熱門檔位秒罄）
 */
function baseInventory(sessionId: string, tierNo: string): number {
  const h = hashStr(`${sessionId}|${tierNo}`);
  if (tierNo === 't1') return 2 + (h % 35);
  return h % 6 === 0 ? 0 : 2 + (h % 35);
}

/** 即時庫存 = 基礎庫存 − 已售 */
function inventoryOf(sessionId: string, tierNo: string): number {
  return Math.max(0, baseInventory(sessionId, tierNo) - (soldByTier.get(`${sessionId}_${tierNo}`) ?? 0));
}

/** 相對今天的日期偏移 → YYYY-MM-DD（本地時區，避免 toISOString 的 UTC 偏移） */
function dateAfterDays(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 「HH:mm」+ 分鐘數 → 結束時刻「HH:mm」 */
function addMinutes(time: string, min: number): string {
  const [h, m] = time.split(':').map((v) => Number(v));
  const total = h * 60 + m + min;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** 目錄定義 → 場次即時資訊（含票檔庫存；按日期+時間排序） */
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
        status: 'on_sale' as const,
        priceTiers: s.tiers.map((t) => ({
          tierId: `${sessionId}_${t.tierNo}`,
          name: t.name,
          priceCent: t.priceCent,
          inventory: inventoryOf(sessionId, t.tierNo),
        })),
      };
    })
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
}

/** 目錄定義 → 演出摘要（minPriceCent 取全部場次票價最小值） */
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

// ---------------------------------------------------------------------------
// 演示 Provider（mock 目錄實作；正式渠道 Provider 接入位見 resolveProviders）
// ---------------------------------------------------------------------------

const catalogProvider: TicketProvider = {
  id: 'mock-catalog',
  async searchEvents(input) {
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
    return list.map(buildSummary);
  },
  async listSessions(eventId) {
    const def = EVENTS.find((e) => e.eventId === eventId);
    if (!def) return null;
    return { event: buildSummary(def), sessions: buildSessions(def) };
  },
};

/**
 * 組裝已配置的 Provider 清單（統一票務接口的接入位）
 *
 * 環境變數配置渠道網關後即以 REST 適配器真實調用（見 ticket-provider.ts
 * 檔頭的渠道接入 REST 契約）；BASE 與 KEY 需同時配置才啟用，否則視為
 * 未接入。演示目錄 Provider 恆在末位兜底。
 */
function resolveProviders(): TicketProvider[] {
  const providers: TicketProvider[] = [];
  const damaiBase = process.env.TICKET_DAMAI_API_BASE;
  if (damaiBase && process.env.TICKET_DAMAI_API_KEY) {
    providers.push(
      createRestTicketProvider({
        id: 'damai',
        baseUrl: damaiBase,
        apiKey: process.env.TICKET_DAMAI_API_KEY,
      }),
    );
  }
  const showstartBase = process.env.TICKET_SHOWSTART_API_BASE;
  if (showstartBase && process.env.TICKET_SHOWSTART_API_KEY) {
    providers.push(
      createRestTicketProvider({
        id: 'showstart',
        baseUrl: showstartBase,
        apiKey: process.env.TICKET_SHOWSTART_API_KEY,
      }),
    );
  }
  providers.push(catalogProvider);
  return providers;
}

// ---------------------------------------------------------------------------
// 訂單簿（記憶體 Map：重啟丟失、多實例不共享，見檔頭說明）
// ---------------------------------------------------------------------------

interface TicketOrder {
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
  status: 'pending_payment' | 'paid';
  owner: string;
  createdAt: number;
}

const orders = new Map<string, TicketOrder>();

/** 跨 Provider 定位場次與票檔（eventId → session → tier 三級查找）
 *
 * 錯誤分流與 handleListSessions 一致：渠道業務性錯誤（TicketProviderError）
 * 上拋由呼叫方透傳；連線層失敗降級下一渠道（下單前即時核實不可用假數據）
 */
async function locateTier(
  eventId: string,
  sessionId: string,
  tierId: string,
): Promise<{ bundle: SessionBundle; session: SessionInfo; tier: TierInfo } | null> {
  for (const p of resolveProviders()) {
    let bundle: SessionBundle | null;
    try {
      bundle = await p.listSessions(eventId);
    } catch (e) {
      if (e instanceof TicketProviderError) throw e;
      console.error(`[skill-ticket] 渠道 ${p.id} 下單核實不可用，降級下一渠道：`, e instanceof Error ? e.message : e);
      continue;
    }
    if (!bundle) continue;
    const session = bundle.sessions.find((s) => s.sessionId === sessionId);
    if (!session) continue;
    const tier = session.priceTiers.find((t) => t.tierId === tierId);
    if (tier) return { bundle, session, tier };
  }
  return null;
}

/** tierId（`{eventId}_s{n}_t{m}`）拆出 sessionId 與 tierNo（已售量記帳鍵） */
function tierKeys(tierId: string): { sessionId: string; tierNo: string } {
  const idx = tierId.lastIndexOf('_t');
  return { sessionId: tierId.slice(0, idx), tierNo: tierId.slice(idx + 1) };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

interface SearchEventsInput {
  keyword?: string;
  city?: string;
  type?: string;
}

const handleSearchEvents: RouteHandler = async (body) => {
  const input = (body ?? {}) as SearchEventsInput;
  const kw = input.keyword?.trim() ?? '';
  const city = input.city?.trim() ?? '';
  const type = input.type?.trim() ?? '';
  if (!kw && !city && !type) {
    return badRequest('keyword / city / type 至少提供一項');
  }

  const events: EventSummary[] = [];
  for (const p of resolveProviders()) {
    // 搜尋為 best-effort 聚合：單一渠道異常（不可達 / 限流）不阻斷整體，
    // 記日誌後繼續——演示目錄恆在末位，至少有一份結果
    try {
      const list = await p.searchEvents({ keyword: kw || undefined, city: city || undefined, type: type || undefined });
      events.push(...list);
    } catch (e) {
      console.error(`[skill-ticket] 渠道 ${p.id} 搜尋失敗，跳過：`, e instanceof Error ? e.message : e);
    }
  }

  // bindings 友好映射（與 priceCentByTrain 同構）：點名演出以名稱直達 eventId
  const eventIdByName: Record<string, string> = {};
  for (const e of events) eventIdByName[e.name] = e.eventId;

  return ok({ events, firstEventId: events[0]?.eventId ?? null, eventIdByName });
};

interface ListSessionsInput {
  eventId?: string;
}

const handleListSessions: RouteHandler = async (body) => {
  const input = (body ?? {}) as ListSessionsInput;
  if (!input.eventId) {
    return badRequest('eventId 必填');
  }

  let bundle: SessionBundle | null = null;
  for (const p of resolveProviders()) {
    try {
      bundle = await p.listSessions(input.eventId);
    } catch (e) {
      if (e instanceof TicketProviderError) {
        // 渠道業務性錯誤（金鑰無效 / 限流等）：如實透傳，不降級假數據
        return fail(503, e.message.slice(0, 200));
      }
      // 連線層失敗（不可達 / 超時）：降級下一渠道（演示目錄兜底），記日誌供排查
      console.error(`[skill-ticket] 渠道 ${p.id} 場次查詢不可用，降級下一渠道：`, e instanceof Error ? e.message : e);
      continue;
    }
    if (bundle) break;
  }
  if (!bundle) {
    return fail(404, `演出不存在：${input.eventId}`);
  }

  /*
   * bindings 友好映射（映射鍵直達路徑對 LLM 最穩，禁自造過濾語法）：
   *   - firstAvailable* 三鍵：未點名場次 / 票檔時直接引用（首個有票組合）
   *   - *ByTime 三映射：點名開演時間（HH:mm）精確取場次 / 票檔 / 即時價
   *   - priceCentBySession：點名場次（sessionId）取該場首個有票票檔價
   */
  const sessionIdByTime: Record<string, string> = {};
  const tierIdByTime: Record<string, string> = {};
  const priceCentByTime: Record<string, number> = {};
  const priceCentBySession: Record<string, number> = {};
  let firstAvailableSessionId: string | null = null;
  let firstAvailableTierId: string | null = null;
  let firstAvailablePriceCent: number | null = null;

  for (const s of bundle.sessions) {
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

  return ok({
    event: bundle.event,
    sessions: bundle.sessions,
    firstAvailableSessionId,
    firstAvailableTierId,
    firstAvailablePriceCent,
    sessionIdByTime,
    tierIdByTime,
    priceCentByTime,
    priceCentBySession,
  });
};

interface CreateOrderInput {
  eventId?: string;
  sessionId?: string;
  tierId?: string;
  quantity?: number;
  viewerName?: string;
  viewerIdNo?: string;
  /** 由 inputBindings 從 list_sessions 注入的即時票價（分）：僅供 checkpoint 展示，下單金額以雲端再核實為準 */
  priceCent?: number;
}

const handleCreateOrder: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as CreateOrderInput;
  const quantity = Number(input.quantity ?? 1);
  if (!input.eventId || !input.sessionId || !input.tierId || !input.viewerName || !input.viewerIdNo) {
    return badRequest('eventId / sessionId / tierId / viewerName / viewerIdNo 必填');
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 4) {
    return badRequest('quantity 必須為 1~4 的整數（票務平台實名限購）');
  }
  // 歸屬鑒權：寫操作必須攜帶雲托管注入的調用方身份（規範 § 10 SKILL 越權防護）
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕下單');
  }

  // 三級定位 + 雲端再核實（場次狀態 / 票檔存在性 / 即時庫存 / 金額）
  let located: { bundle: SessionBundle; session: SessionInfo; tier: TierInfo } | null;
  try {
    located = await locateTier(input.eventId, input.sessionId, input.tierId);
  } catch (e) {
    // 渠道業務性錯誤（金鑰無效 / 限流）：如實透傳為業務失敗，不得以下單
    if (e instanceof TicketProviderError) {
      return fail(503, `渠道核實失敗：${e.message.slice(0, 160)}`);
    }
    throw e;
  }
  if (!located) {
    return fail(404, `場次或票檔不存在：${input.sessionId} / ${input.tierId}`);
  }
  if (located.session.status !== 'on_sale') {
    return fail(1001, `該場次不可售（${located.session.status}）：${located.session.date} ${located.session.startTime}`);
  }
  if (located.tier.inventory < quantity) {
    return fail(1002, `該票檔餘票不足（剩餘 ${located.tier.inventory} 張，需求 ${quantity} 張）`);
  }

  // 金額以雲端價目表再核實為準（價 × 量），杜絕以客戶端注入價下單
  const amountCent = located.tier.priceCent * quantity;
  const orderId = `tkt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const keys = tierKeys(located.tier.tierId);
  soldByTier.set(`${keys.sessionId}_${keys.tierNo}`, (soldByTier.get(`${keys.sessionId}_${keys.tierNo}`) ?? 0) + quantity);
  orders.set(orderId, {
    orderId,
    eventId: located.bundle.event.eventId,
    eventName: located.bundle.event.name,
    sessionId: located.session.sessionId,
    sessionDate: located.session.date,
    startTime: located.session.startTime,
    tierId: located.tier.tierId,
    tierName: located.tier.name,
    quantity,
    amountCent,
    status: 'pending_payment',
    owner: ctx.openid,
    createdAt: Date.now(),
  });

  return ok({
    orderId,
    eventId: located.bundle.event.eventId,
    eventName: located.bundle.event.name,
    sessionId: located.session.sessionId,
    sessionDate: located.session.date,
    startTime: located.session.startTime,
    tierId: located.tier.tierId,
    tierName: located.tier.name,
    quantity,
    amountCent,
    status: 'pending_payment',
    payDeadline: Date.now() + 15 * 60 * 1000,
  });
};

interface CancelInput {
  orderId?: string;
}

/** rollback 與用戶主動取消共用：取消訂單並恢復庫存（歸屬鑒權防 IDOR） */
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

  // 恢復庫存並移除訂單（MVP 模擬閉環：已支付訂單亦直接取消；正式版
  // 應按 status 區分——paid 須走退款流程而非直接刪單）
  const keys = tierKeys(order.tierId);
  const soldKey = `${keys.sessionId}_${keys.tierNo}`;
  soldByTier.set(soldKey, Math.max(0, (soldByTier.get(soldKey) ?? 0) - order.quantity));
  orders.delete(input.orderId);
  return ok({ ok: true, orderId: input.orderId });
};

const handleListOrders: RouteHandler = async (_body, ctx) => {
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕查詢');
  }
  const list = Array.from(orders.values())
    .filter((o) => o.owner === ctx.openid)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((o) => ({
      orderId: o.orderId,
      eventId: o.eventId,
      eventName: o.eventName,
      sessionId: o.sessionId,
      sessionDate: o.sessionDate,
      startTime: o.startTime,
      tierId: o.tierId,
      tierName: o.tierName,
      quantity: o.quantity,
      amountCent: o.amountCent,
      status: o.status,
      payDeadline: o.createdAt + 15 * 60 * 1000,
    }));
  return ok({ orders: list });
};

export const ticketRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.ticket.show/search_events', handleSearchEvents],
  ['POST /api/skill/skill.ticket.show/list_sessions', handleListSessions],
  ['POST /api/skill/skill.ticket.show/create_order', handleCreateOrder],
  ['POST /api/skill/skill.ticket.show/create_order/cancel', handleCancel],
  ['POST /api/skill/skill.ticket.show/list_orders', handleListOrders],
  ['POST /api/skill/skill.ticket.show/cancel_order', handleCancel],
];
