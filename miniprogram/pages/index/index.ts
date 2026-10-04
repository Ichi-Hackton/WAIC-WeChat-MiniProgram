/**
 * MicroMate 首頁 - Agent 辦事介面
 *
 * 規範來源：.qoder/rules/Agent.md
 *
 * 交互模式參考千問 App 的「AI 辦事」UX：結果不是一句話，而是結構化交付卡——
 * 車次卡片即選車界面（每班掛快捷預訂，對話內完成交易閉環）、訂單卡片展示
 * 憑證要素、門市卡片支持瀏覽。過程展示保持輕量（計劃卡 + 狀態徽章）。
 *
 * 此頁提供：
 *   1. 對話氣泡列表（用戶/助理，新訊息自動捲動）
 *   2. 結構化交付卡：車次（含快捷預訂）/ 訂單 / 門市
 *   3. 任務進度卡片（訂閱 runtime 事件即時更新徽章狀態）
 *   4. 文字輸入框 + 範例指令
 *
 * 與 src/core 的關係：
 *   - 透過 getApp().globalData.agent（AgentRuntime）呼叫 Orchestrator
 *   - onLoad 訂閱 runtime 事件、onUnload 退訂，不直接 import core 內部
 */

import { BRAND_NAME, BRAND_SHORT, BRAND_TAGLINE, BRAND_AI_GENERATED_BY } from '../../src/types/brand';
import { info as logInfo, error as logError } from '../../src/utils/logger';
import type { AgentRuntime, LlmStatus } from '../../src/app';
import type { AgentState } from '../../src/types/agent-state';
import type { Plan } from '../../src/types/plan';
import type { Task } from '../../src/types/task';

/* ============ 卡片渲染模型（千問式結構化交付卡） ============ */

/** 所有卡片統一攜帶穩定 key（wxml wx:key 用：plan 卡會被就地更新，key 必須跨更新穩定） */
interface CardKey {
  key: string;
}

/** 車次交付卡：查詢結果即「選車界面」，每班掛快捷預訂 */
interface TrainCard extends CardKey {
  type: 'train';
  /** 出發城市（大字路線頭） */
  routeFrom: string;
  routeTo: string;
  /** 發車日期（YYYY-MM-DD） */
  routeDate: string;
  /** 數據源標籤（12306 即時 / 模擬數據） */
  sourceLabel: string;
  /** 是否 12306 即時數據（決定標籤配色） */
  sourceReal: boolean;
  trains: Array<{
    trainNo: string;
    from: string;
    to: string;
    departTime: string;
    arriveTime: string;
    /** 「5小時56分」 */
    durationLabel: string;
    /** 「¥626」 */
    priceLabel: string;
    /** 「二等座 · 有票」 */
    remainLabel: string;
    /** 餘票為 0 時置灰且不掛預訂 */
    soldOut: boolean;
  }>;
  /** 「共 8 班 · 顯示前 3 班」 */
  moreLabel: string;
  /** 快捷預訂上下文（JSON 字串，wxml dataset 傳遞） */
  bookCtx: string;
}

/** 訂單交付卡：下單成功後的憑證要素（車票 / 咖啡） */
interface OrderCard extends CardKey {
  type: 'order';
  icon: string;
  title: string;
  lines: Array<{ label: string; value: string; highlight?: boolean }>;
}

/** 門市交付卡：星巴克門市瀏覽 */
interface StoreCard extends CardKey {
  type: 'store';
  title: string;
  stores: Array<{ name: string; address: string; distanceLabel: string; openLabel: string }>;
}

/** 商品交付卡：查詢結果即「選購界面」，每件掛快捷加購 */
interface ProductCard extends CardKey {
  type: 'product';
  title: string;
  /** 搜索關鍵詞標籤（無關鍵詞時為「全部商品」） */
  keywordLabel: string;
  products: Array<{
    productId: string;
    name: string;
    category: string;
    priceLabel: string;
    stockLabel: string;
    ratingLabel: string;
    soldOut: boolean;
  }>;
}

/** 預約服務交付卡：時段瀏覽即「選時段界面」，每項掛快捷預約 */
interface BookingCard extends CardKey {
  type: 'booking';
  title: string;
  /** 查詢日期（YYYY-MM-DD） */
  date: string;
  services: Array<{
    serviceId: string;
    name: string;
    provider: string;
    durationLabel: string;
    priceLabel: string;
    slots: Array<{ startTime: string; available: boolean }>;
    /** 首個可約時段（快捷預約按鈕預設值，保證可約） */
    firstSlot: string;
    anyAvailable: boolean;
  }>;
}

/** 計劃進度卡（過程展示，徽章隨任務事件更新） */
interface PlanCard extends CardKey {
  type: 'plan';
  title: string;
  payload: Record<string, unknown>;
}

type AnyCard = TrainCard | OrderCard | StoreCard | ProductCard | BookingCard | PlanCard;

/* ============ 基礎模型 ============ */

/** 對話訊息 */
interface ChatMessage {
  /** 訊息唯一 ID（wx:key 用，避免 timestamp 同毫秒碰撞） */
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** 附帶的渲染卡片（可選） */
  cards?: AnyCard[];
}

/** 頁面資料結構 */
interface HomePageData {
  brandName: string;
  /** AI 頭像字標（品牌短代號） */
  brandAvatar: string;
  /** 啟動載入畫面是否展示（淡出動畫結束後置 false 卸載節點） */
  splash: boolean;
  /** 載入畫面淡出中（觸發 splash-fade 過渡） */
  splashFading: boolean;
  /** 載入畫面標語 */
  splashTagline: string;
  /** LLM 接入狀態列文案（如「LLM：MiniMax · MiniMax-M3」） */
  llmLabel: string;
  messages: ChatMessage[];
  inputText: string;
  loading: boolean;
  state: string;
  /** 狀態中文文案（狀態列與 loading 氣泡共用） */
  stateLabel: string;
  /** scroll-into-view 錨點（自動捲動到最新訊息） */
  scrollIntoView: string;
  [key: string]: unknown;
}

/** Page 內部 this 實例 */
interface HomePageThis {
  data: HomePageData;
  setData: (patch: Partial<HomePageData>) => void;
  /** 訊息序號（生成遞增 ID 用） */
  msgSeq: number;
  /** 當前活躍 Plan ID（task_NNN 僅在單一 Plan 內唯一，跨輪次需以 planId 隔離卡片更新） */
  activePlanId: string;
  /** runtime 事件退訂函數 */
  unsubscribe?: () => void;
  nextMsgId: () => string;
  appendMessage: (msg: ChatMessage) => void;
  onAgentStateChange: (state: AgentState) => void;
  onAgentPlanUpdate: (plan: Plan) => void;
  onAgentTaskUpdate: (task: Task) => void;
  appendResultCard: (task: Task) => void;
  dispatch: (intent: string) => Promise<void>;
  onSend: () => Promise<void>;
  onInput: (e: { detail: { value: string } }) => void;
  onTapExample: (e: { currentTarget?: { dataset?: { text?: string } } }) => Promise<void>;
  onTapBookTrain: (e: { currentTarget?: { dataset?: { trainNo?: string; ctx?: string } } }) => Promise<void>;
  onTapAddProduct: (e: { currentTarget?: { dataset?: { name?: string } } }) => Promise<void>;
  onTapBookService: (e: { currentTarget?: { dataset?: { serviceName?: string; date?: string; firstSlot?: string } } }) => Promise<void>;
  onTapReset: () => void;
}

/** Agent 回應形狀 */
interface AgentRespShape {
  message: string;
  state: string;
  cards?: Array<{ type: string; title: string; payload: Record<string, unknown> }>;
  errorCode?: string;
}

/** AgentState → 中文階段文案（敘事式，狀態列與 loading 氣泡共用） */
const STATE_LABELS: Record<string, string> = {
  idle: '待命中',
  understanding: '正在理解你的需求…',
  planning: '正在拆解任務…',
  confirming_plan: '請確認計劃',
  executing: '正在為你辦事…',
  awaiting_human: '需要你確認',
  aggregating: '正在彙總結果…',
  completed: '已為你辦妥',
  failed: '這次沒辦成',
  rolling_back: '正在撤銷已辦步驟…',
};

/** TaskStatus → 進度卡片徽章文案 */
const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '排隊中',
  running: '執行中',
  waiting_human: '待確認',
  succeeded: '成功',
  failed: '失敗',
  rolled_back: '已回滾',
  skipped: '已跳過',
};

/** seatType → 中文（快捷預訂指令與卡片摘要共用） */
const SEAT_LABELS: Record<string, string> = {
  business: '商務座',
  first_class: '一等座',
  second_class: '二等座',
  hard_seat: '硬座',
};

/** 車次卡最多展示班數（其餘以「共 N 班」摘要，避免長列表拖慢瀏覽） */
const TRAIN_CARD_LIMIT = 3;

/** 分 → 元顯示（整數金額省略小數） */
function formatPrice(cent: number): string {
  const yuan = cent / 100;
  return `¥${cent % 100 === 0 ? String(yuan) : yuan.toFixed(2)}`;
}

/** 分鐘 → 「5小時56分」 */
function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}小時${m}分` : `${m}分`;
}

/** 米 → 「1.2km」/「350m」 */
function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`;
}

/** 取得 Agent Runtime（onLaunch 先於頁面 onLoad，防禦性判空） */
function getAgent(): AgentRuntime | null {
  const app = getApp() as unknown as { globalData?: { agent?: AgentRuntime } };
  return app?.globalData?.agent ?? null;
}

/* ============ 交付卡構造（unknown 防禦性窄化，§ 12.2 禁 any） ============ */

/** search_train 成功 → 車次交付卡（卡片即選車界面） */
function buildTrainCard(data: unknown): TrainCard | null {
  const d = data as { from?: unknown; to?: unknown; date?: unknown; trains?: unknown; source?: unknown } | undefined;
  if (!d || !Array.isArray(d.trains) || d.trains.length === 0) return null;
  const seatLabel = SEAT_LABELS[(d.trains[0] as { seatType?: unknown }).seatType as string] ?? '二等座';
  const shown = d.trains.slice(0, TRAIN_CARD_LIMIT);
  const trains = shown.map((raw) => {
    const t = raw as Record<string, unknown>;
    const left = typeof t.ticketsLeft === 'number' ? t.ticketsLeft : 0;
    return {
      trainNo: String(t.trainNo ?? ''),
      from: String(t.from ?? ''),
      to: String(t.to ?? ''),
      departTime: String(t.departTime ?? ''),
      arriveTime: String(t.arriveTime ?? ''),
      durationLabel: formatDuration(typeof t.durationMin === 'number' ? t.durationMin : 0),
      priceLabel: formatPrice(typeof t.priceCent === 'number' ? t.priceCent : 0),
      remainLabel: left >= 9999 ? '有票' : left > 0 ? `剩 ${left} 張` : '無票',
      soldOut: left <= 0,
    };
  });
  return {
    type: 'train',
    key: `train-${String(d.from ?? '')}-${String(d.to ?? '')}-${String(d.date ?? '')}`,
    routeFrom: String(d.from ?? ''),
    routeTo: String(d.to ?? ''),
    routeDate: String(d.date ?? ''),
    sourceLabel: d.source === '12306_realtime' ? '12306 即時' : '模擬數據',
    sourceReal: d.source === '12306_realtime',
    trains,
    moreLabel: d.trains.length > shown.length ? `共 ${d.trains.length} 班 · 顯示前 ${shown.length} 班` : `共 ${d.trains.length} 班`,
    // 快捷預訂上下文：發送「預訂 2026-10-04 北京到上海的G531次高鐵二等座」
    bookCtx: JSON.stringify({
      from: String(d.from ?? ''),
      to: String(d.to ?? ''),
      date: String(d.date ?? ''),
      seatLabel,
    }),
  };
}

/** book_ticket 成功 → 車票訂單卡 */
function buildTrainOrderCard(data: unknown): OrderCard | null {
  const d = data as { orderId?: unknown; trainNo?: unknown; amountCent?: unknown; status?: unknown; payDeadline?: unknown } | undefined;
  if (!d || typeof d.orderId !== 'string') return null;
  const deadline =
    typeof d.payDeadline === 'number'
      ? `${String(new Date(d.payDeadline).getHours()).padStart(2, '0')}:${String(new Date(d.payDeadline).getMinutes()).padStart(2, '0')}`
      : '';
  return {
    type: 'order',
    key: `order-${d.orderId}`,
    icon: '',
    title: '高鐵票訂單已建立',
    lines: [
      { label: '車次', value: String(d.trainNo ?? '') },
      { label: '金額', value: formatPrice(typeof d.amountCent === 'number' ? d.amountCent : 0), highlight: true },
      { label: '狀態', value: d.status === 'paid' ? '已支付' : '待支付' },
      ...(deadline ? [{ label: '支付時限', value: `${deadline} 前` }] : []),
      { label: '訂單號', value: d.orderId },
    ],
  };
}

/** place_order 成功 → 咖啡訂單卡 */
function buildCoffeeOrderCard(data: unknown): OrderCard | null {
  const d = data as { orderId?: unknown; items?: unknown; amountCent?: unknown; status?: unknown } | undefined;
  if (!d || typeof d.orderId !== 'string') return null;
  const items = Array.isArray(d.items)
    ? (d.items as Array<Record<string, unknown>>)
        .map((i) => `${String(i.name ?? i.sku ?? '')} ×${typeof i.quantity === 'number' ? i.quantity : 1}`)
        .join('、')
    : '';
  return {
    type: 'order',
    key: `order-${d.orderId}`,
    icon: '',
    title: '咖啡訂單已建立',
    lines: [
      ...(items ? [{ label: '品項', value: items }] : []),
      { label: '金額', value: formatPrice(typeof d.amountCent === 'number' ? d.amountCent : 0), highlight: true },
      { label: '狀態', value: d.status === 'paid' ? '已支付' : '待支付' },
      { label: '訂單號', value: d.orderId },
    ],
  };
}

/** search_store 成功 → 門市瀏覽卡 */
function buildStoreCard(data: unknown): StoreCard | null {
  const d = data as { stores?: unknown } | undefined;
  if (!d || !Array.isArray(d.stores) || d.stores.length === 0) return null;
  const stores = d.stores.slice(0, 3).map((raw) => {
    const s = raw as Record<string, unknown>;
    return {
      name: String(s.name ?? ''),
      address: String(s.address ?? ''),
      distanceLabel: typeof s.distanceM === 'number' ? formatDistance(s.distanceM) : '',
      openLabel: s.openNow === true ? '營業中' : '休息中',
    };
  });
  return {
    type: 'store',
    key: 'store-list',
    title: `星巴克門市（${d.stores.length} 家）`,
    stores,
  };
}

/** search_products 成功 → 商品選購卡（卡片即選購界面） */
function buildProductCard(data: unknown, keyword?: string): ProductCard | null {
  const d = data as { products?: unknown } | undefined;
  if (!d || !Array.isArray(d.products) || d.products.length === 0) return null;
  const shown = (d.products as Array<Record<string, unknown>>).slice(0, TRAIN_CARD_LIMIT);
  const products = shown.map((raw) => {
    const p = raw as Record<string, unknown>;
    const stock = typeof p.stock === 'number' ? p.stock : 0;
    return {
      productId: String(p.productId ?? ''),
      name: String(p.name ?? ''),
      category: String(p.category ?? ''),
      priceLabel: formatPrice(typeof p.priceCent === 'number' ? p.priceCent : 0),
      stockLabel: stock > 0 ? `庫存 ${stock}` : '已售罄',
      ratingLabel: typeof p.rating === 'number' ? `${p.rating} 分` : '',
      soldOut: stock <= 0,
    };
  });
  return {
    type: 'product',
    key: `product-${keyword ?? 'all'}`,
    title: `商品搜索（${d.products.length} 件）`,
    keywordLabel: keyword ? `關鍵詞：${keyword}` : '全部商品',
    products,
  };
}

/** add_to_cart 成功 → 購物車加購卡（OrderCard 票券式） */
function buildCartCard(data: unknown): OrderCard | null {
  const d = data as { cartItemId?: unknown; name?: unknown; quantity?: unknown; priceCent?: unknown; cartCount?: unknown; cartAmountCent?: unknown } | undefined;
  if (!d || typeof d.cartItemId !== 'string') return null;
  return {
    type: 'order',
    key: `cart-${d.cartItemId}`,
    icon: '',
    title: '已加入購物車',
    lines: [
      { label: '商品', value: `${String(d.name ?? '')} ×${typeof d.quantity === 'number' ? d.quantity : 1}` },
      { label: '單價', value: formatPrice(typeof d.priceCent === 'number' ? d.priceCent : 0), highlight: true },
      { label: '購物車', value: `共 ${typeof d.cartCount === 'number' ? d.cartCount : '?'} 件 · 合計 ${formatPrice(typeof d.cartAmountCent === 'number' ? d.cartAmountCent : 0)}` },
    ],
  };
}

/** checkout 成功 → 購物訂單卡 */
function buildShopOrderCard(data: unknown): OrderCard | null {
  const d = data as { orderId?: unknown; items?: unknown; amountCent?: unknown; status?: unknown } | undefined;
  if (!d || typeof d.orderId !== 'string') return null;
  const items = Array.isArray(d.items)
    ? (d.items as Array<Record<string, unknown>>)
        .map((i) => `${String(i.name ?? i.sku ?? '')} ×${typeof i.quantity === 'number' ? i.quantity : 1}`)
        .join('、')
    : '';
  return {
    type: 'order',
    key: `order-${d.orderId}`,
    icon: '',
    title: '購物訂單已建立',
    lines: [
      ...(items ? [{ label: '品項', value: items }] : []),
      { label: '金額', value: formatPrice(typeof d.amountCent === 'number' ? d.amountCent : 0), highlight: true },
      { label: '狀態', value: d.status === 'paid' ? '已支付' : '待支付' },
      { label: '訂單號', value: d.orderId },
    ],
  };
}

/** search_services 成功 → 預約服務時段卡（卡片即選時段界面） */
function buildBookingCard(data: unknown): BookingCard | null {
  const d = data as { date?: unknown; services?: unknown } | undefined;
  if (!d || !Array.isArray(d.services) || d.services.length === 0) return null;
  const shown = (d.services as Array<Record<string, unknown>>).slice(0, TRAIN_CARD_LIMIT);
  const services = shown.map((raw) => {
    const s = raw as Record<string, unknown>;
    const slots = Array.isArray(s.slots)
      ? (s.slots as Array<Record<string, unknown>>).map((slot) => ({
          startTime: String(slot.startTime ?? ''),
          available: slot.available === true,
        }))
      : [];
    const first = slots.find((slot) => slot.available);
    return {
      serviceId: String(s.serviceId ?? ''),
      name: String(s.name ?? ''),
      provider: String(s.provider ?? ''),
      durationLabel: formatDuration(typeof s.durationMin === 'number' ? s.durationMin : 0),
      priceLabel: formatPrice(typeof s.priceCent === 'number' ? s.priceCent : 0),
      slots,
      firstSlot: first?.startTime ?? '',
      anyAvailable: Boolean(first),
    };
  });
  return {
    type: 'booking',
    key: `booking-${String(d.date ?? '')}-${services.map((s) => s.serviceId).join('-')}`,
    title: `可預約服務（${d.services.length} 項）`,
    date: String(d.date ?? ''),
    services,
  };
}

/** create_reservation 成功 → 預約悪證卡 */
function buildReservationCard(data: unknown): OrderCard | null {
  const d = data as { reservationId?: unknown; name?: unknown; provider?: unknown; address?: unknown; date?: unknown; startTime?: unknown; endTime?: unknown; contactName?: unknown; status?: unknown } | undefined;
  if (!d || typeof d.reservationId !== 'string') return null;
  const timeLabel =
    typeof d.startTime === 'string' && typeof d.endTime === 'string' ? `${d.startTime}-${d.endTime}` : String(d.startTime ?? '');
  return {
    type: 'order',
    key: `rsv-${d.reservationId}`,
    icon: '',
    title: '預約成功',
    lines: [
      { label: '服務', value: String(d.name ?? '') },
      { label: '門店', value: `${String(d.provider ?? '')} · ${String(d.address ?? '')}` },
      { label: '時間', value: `${String(d.date ?? '')} ${timeLabel}`, highlight: true },
      { label: '聯繫人', value: String(d.contactName ?? '現場登記') },
      { label: '狀態', value: d.status === 'cancelled' ? '已取消' : '已確認' },
      { label: '預約號', value: d.reservationId },
    ],
  };
}

Page({
  data: {
    brandName: BRAND_NAME,
    brandAvatar: BRAND_SHORT,
    splash: true,
    splashFading: false,
    splashTagline: BRAND_TAGLINE,
    llmLabel: 'LLM：連線中…',
    messages: [] as ChatMessage[],
    inputText: '',
    loading: false,
    state: 'idle',
    stateLabel: STATE_LABELS.idle,
    scrollIntoView: '',
  } as HomePageData,

  onLoad(): void {
    const self = this as unknown as HomePageThis;
    self.msgSeq = 0;
    self.activePlanId = '';
    logInfo(`${BRAND_NAME} 首頁載入`);

    // 啟動載入畫面：品牌字標與水平細線缓慢展開 2.4s 後淡出卸載。展示期間後台並行
    // 拉取 LLM 狀態（不白等）；歡迎訊息延至淡出時入場，與範例 chips
    // 錯落動畫銜接（chips 的 wx:if 綁定 !splash，卸載後才掛載入場）
    setTimeout(() => {
      self.setData({ splashFading: true });
      self.appendMessage({
        id: self.nextMsgId(),
        role: 'assistant',
        content: `你好，我是${BRAND_NAME}，你的隨身辦事助理。\n\n說出需求，我來跨小程序幫你辦妥。你可以說：\n• 「明天北京到上海的高鐵」\n• 「幫我點一杯拿鐵」\n• 「幫我買一副無線降噪耳機」\n• 「預約明天下午的羽毛球場」\n\n查到的車次、商品、時段會以卡片展示，點按鈕即可一鍵下單。`,
        timestamp: Date.now(),
      });
      setTimeout(() => self.setData({ splash: false }), 820);
    }, 2400);

    // 訂閱 Agent runtime 事件（狀態 / 計劃 / 任務進度 → UI 即時更新）
    const agent = getAgent();
    if (agent) {
      self.unsubscribe = agent.subscribe({
        onStateChange: (s) => self.onAgentStateChange(s),
        onPlanUpdate: (p) => self.onAgentPlanUpdate(p),
        onTaskUpdate: (t) => self.onAgentTaskUpdate(t),
      });
      // 查詢 LLM 接入狀態（GET /api/config）：已配 Key 顯示供應商與模型，
      // 未配 Key / 雲端不可達顯示對應降級提示
      agent
        .getLlmStatus()
        .then((s: LlmStatus) => {
          const label = s.configured
            ? `LLM：${s.provider} · ${s.model}`
            : `LLM：${s.provider}（未配 Key，規劃降級中）`;
          self.setData({ llmLabel: label });
        })
        .catch(() => {
          self.setData({ llmLabel: 'LLM：離線（本地降級模式）' });
        });
    } else {
      logError('Agent runtime 未就緒（globalData.agent 缺失），對話功能不可用');
    }
  },

  onUnload(): void {
    const self = this as unknown as HomePageThis;
    self.unsubscribe?.();
    self.unsubscribe = undefined;
  },

  /** 下拉刷新入口（onPullDownRefresh）：重查 LLM 狀態 */
  async onPullDownRefresh(this: HomePageThis): Promise<void> {
    try {
      const s = await getAgent()?.getLlmStatus();
      if (s) {
        this.setData({ llmLabel: s.configured ? `LLM：${s.provider} · ${s.model}` : `LLM：${s.provider}（未配 Key，規劃降級中）` });
      }
    } catch {
      this.setData({ llmLabel: 'LLM：離線（本地降級模式）' });
    }
    wx.stopPullDownRefresh?.();
  },

  /** 即時更新輸入框（受控元件；loading 期間允許繼續輸入下一條） */
  onInput(this: HomePageThis, e: { detail: { value: string } }): void {
    this.setData({ inputText: e.detail.value });
  },

  /** 發送按鈕 */
  async onSend(this: HomePageThis): Promise<void> {
    const text = (this.data.inputText ?? '').trim();
    if (!text || this.data.loading) return;
    this.setData({ inputText: '' });
    await this.dispatch(text);
  },

  /** 範例點選 */
  async onTapExample(this: HomePageThis, e: { currentTarget?: { dataset?: { text?: string } } }): Promise<void> {
    const text = e.currentTarget?.dataset?.text;
    if (!text) return;
    await this.dispatch(text);
  },

  /**
   * 車次卡快捷預訂：以「預訂 + 完整要素」的自然語言指令重新進入規劃鏈路
   * （規劃器支援字面車次：查價任務 + 指定車次下單任務，確認彈窗展示真實票價）
   */
  async onTapBookTrain(this: HomePageThis, e: { currentTarget?: { dataset?: { trainNo?: string; ctx?: string } } }): Promise<void> {
    const trainNo = e.currentTarget?.dataset?.trainNo;
    const ctxRaw = e.currentTarget?.dataset?.ctx;
    if (!trainNo || !ctxRaw || this.data.loading) return;
    try {
      const ctx = JSON.parse(ctxRaw) as { from?: string; to?: string; date?: string; seatLabel?: string };
      const seat = ctx.seatLabel ?? '二等座';
      const intent = `預訂 ${ctx.date ?? ''} ${ctx.from ?? ''}到${ctx.to ?? ''}的${trainNo}次高鐵${seat}`;
      await this.dispatch(intent);
    } catch (err) {
      logError('快捷預訂參數解析失敗', err);
    }
  },

  /** 商品卡快捷加購：以「幫我買 + 商品全名」重新進入規劃鏈路（字面 productId 加購，確認彈窗展示即時價） */
  async onTapAddProduct(this: HomePageThis, e: { currentTarget?: { dataset?: { name?: string } } }): Promise<void> {
    const name = e.currentTarget?.dataset?.name;
    if (!name || this.data.loading) return;
    await this.dispatch(`幫我買${name}，加入購物車`);
  },

  /** 服務時段卡快捷預約：以「預約 + 日期 + 首個可約時段 + 服務全名」重新進入規劃鏈路（字面時間必可約） */
  async onTapBookService(this: HomePageThis, e: { currentTarget?: { dataset?: { serviceName?: string; date?: string; firstSlot?: string } } }): Promise<void> {
    const serviceName = e.currentTarget?.dataset?.serviceName;
    const date = e.currentTarget?.dataset?.date;
    const firstSlot = e.currentTarget?.dataset?.firstSlot;
    if (!serviceName || !date || !firstSlot || this.data.loading) return;
    await this.dispatch(`預約 ${date} ${firstSlot} 的${serviceName}`);
  },

  /** 清空對話並重置 Agent */
  onTapReset(this: HomePageThis): void {
    getAgent()?.resetAgent();
    this.msgSeq = 0;
    this.activePlanId = '';
    this.setData({
      messages: [{
        id: 'msg_0',
        role: 'assistant',
        content: '對話已重置。',
        timestamp: Date.now(),
      }],
      state: 'idle',
      stateLabel: STATE_LABELS.idle,
      scrollIntoView: 'msg_0',
      loading: false,
    });
  },

  /** 內部：生成遞增訊息 ID */
  nextMsgId(this: HomePageThis): string {
    this.msgSeq += 1;
    return `msg_${this.msgSeq}`;
  },

  /** 內部：發送訊息給 Agent */
  async dispatch(this: HomePageThis, intent: string): Promise<void> {
    if (this.data.loading) return;

    // 1. 追加用戶訊息
    this.appendMessage({
      id: this.nextMsgId(),
      role: 'user',
      content: intent,
      timestamp: Date.now(),
    });

    this.setData({
      loading: true,
      state: 'understanding',
      stateLabel: STATE_LABELS.understanding,
    });

    try {
      const agent = getAgent();
      if (!agent) {
        throw new Error('Agent runtime 未就緒');
      }
      const res = (await agent.handleIntent(intent)) as AgentRespShape;

      // 2. 追加 Agent 回覆（交付卡已由任務事件即時展示，此處僅放聚合結論）
      this.appendMessage({
        id: this.nextMsgId(),
        role: 'assistant',
        content: res.message ?? `${BRAND_AI_GENERATED_BY} 已完成`,
        timestamp: Date.now(),
      });

      if (res.errorCode === 'BUSY') {
        wx.showToast({ title: '請等待當前任務完成', icon: 'none' });
      }

      const finalState = res.state ?? 'idle';
      this.setData({
        loading: false,
        state: finalState,
        stateLabel: STATE_LABELS[finalState] ?? finalState,
      });
    } catch (e) {
      logError('dispatch 失敗', e);
      this.appendMessage({
        id: this.nextMsgId(),
        role: 'assistant',
        content: `${BRAND_AI_GENERATED_BY}：系統異常，請稍後再試。`,
        timestamp: Date.now(),
      });
      this.setData({
        loading: false,
        state: 'failed',
        stateLabel: STATE_LABELS.failed,
      });
    }
  },

  /** runtime 事件：狀態機轉移 → 更新狀態列與 loading 氣泡文案 */
  onAgentStateChange(this: HomePageThis, state: AgentState): void {
    this.setData({ state, stateLabel: STATE_LABELS[state] ?? state });
  },

  /** runtime 事件：Plan 生成 → 追加計劃進度卡（徽章隨任務進度更新） */
  onAgentPlanUpdate(this: HomePageThis, plan: Plan): void {
    if (plan.tasks.length === 0) return;
    // 記錄活躍 Plan：後續任務事件僅更新本輪卡片。Task ID（task_NNN）只在
    // 單一 Plan 內唯一，跨輪次對話中兩輪都有 task_001——若不隔離，後一輪
    // 的失敗事件會污染前一輪同名卡片的徽章（實測復現過）
    this.activePlanId = plan.id;
    const cards: PlanCard[] = plan.tasks.map((t, i) => ({
      type: 'plan',
      key: `plan-${plan.id}-${t.id}`,
      title: t.summary ?? `${t.skillId}.${t.action}`,
      payload: {
        planId: plan.id,
        taskId: t.id,
        /** 步驟序號（01 / 02…，渲染在序號方塊內） */
        seq: String(i + 1).padStart(2, '0'),
        skill: `${t.skillId}.${t.action}`,
        status: t.status,
        statusLabel: TASK_STATUS_LABELS[t.status] ?? t.status,
        dependsOn: t.dependsOn,
      },
    }));
    this.appendMessage({
      id: this.nextMsgId(),
      role: 'assistant',
      content: `已生成執行計劃（${plan.tasks.length} 個任務），請在彈窗中確認：`,
      timestamp: Date.now(),
      cards,
    });
  },

  /** runtime 事件：任務狀態更新 → 更新進度徽章 + 成功時追加交付卡 */
  onAgentTaskUpdate(this: HomePageThis, task: Task): void {
    // 1. 就地更新計劃卡徽章（僅當前活躍 Plan）
    const messages = this.data.messages.map((msg) => {
      if (!msg.cards?.length) return msg;
      const idx = msg.cards.findIndex((c) => {
        if (c.type !== 'plan') return false;
        const p = c.payload as { taskId?: string; planId?: string };
        return p.taskId === task.id && p.planId === this.activePlanId;
      });
      if (idx < 0) return msg;
      const cards = msg.cards.slice();
      cards[idx] = {
        ...cards[idx],
        payload: {
          ...(cards[idx] as PlanCard).payload,
          status: task.status,
          statusLabel: TASK_STATUS_LABELS[task.status] ?? task.status,
          ...(task.result?.error?.message ? { error: task.result.error.message } : {}),
        },
      } as PlanCard;
      return { ...msg, cards };
    });
    this.setData({ messages });

    // 2. 任務成功且有可渲染數據 → 追加結構化交付卡（過程與成果分離展示）
    this.appendResultCard(task);
  },

  /** 任務成功 → 按 action 構造交付卡並追加為新訊息 */
  appendResultCard(this: HomePageThis, task: Task): void {
    if (task.status !== 'succeeded' || !task.result?.data) return;
    const data: unknown = task.result.data;
    let card: AnyCard | null = null;
    if (task.action === 'search_train') card = buildTrainCard(data);
    else if (task.action === 'book_ticket') card = buildTrainOrderCard(data);
    else if (task.action === 'place_order') card = buildCoffeeOrderCard(data);
    else if (task.action === 'search_store') card = buildStoreCard(data);
    else if (task.action === 'search_products') card = buildProductCard(data, typeof task.input.keyword === 'string' ? task.input.keyword : undefined);
    else if (task.action === 'add_to_cart') card = buildCartCard(data);
    else if (task.action === 'checkout') card = buildShopOrderCard(data);
    else if (task.action === 'search_services') card = buildBookingCard(data);
    else if (task.action === 'create_reservation') card = buildReservationCard(data);
    if (!card) return;
    this.appendMessage({
      id: this.nextMsgId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      cards: [card],
    });
  },

  /** 追加訊息到列表並自動捲動到底部 */
  appendMessage(this: HomePageThis, msg: ChatMessage): void {
    const messages = [...this.data.messages, msg];
    this.setData({ messages, scrollIntoView: msg.id });
  },
} as unknown as Parameters<typeof Page>[0]);
