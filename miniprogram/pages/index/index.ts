/**
 * MicroMate 首頁 - Agent 辦事介面
 *
 * 規範來源：.qoder/rules/Agent.md
 *
 * 交互模式參考千問 App 的「AI 辦事」UX：結果不是一句話，而是結構化交付卡——
 * 車次 / 航班卡片即選擇界面（每班掛快捷預訂，跳轉官方渠道完成真實交易）、
 * 天氣卡展示實況、跳轉卡承載憑證要素。過程展示保持輕量（計劃卡 + 狀態徽章）。
 *
 * 此頁提供：
 *   1. 對話氣泡列表（用戶/助理，新訊息自動捲動）
 *   2. 結構化交付卡：車次 / 航班（含快捷預訂）/ 天氣 / 跳轉下單 / 通用兜底卡片
 *   3. 任務進度卡片（訂閱 runtime 事件即時更新徽章狀態）
 *   4. 文字輸入框 + 快捷入口（常用話語個人化，無記錄時回退出廠範例）
 *   5. 語音輸入（同聲傳譯插件可用時展示麥克風，識別結果即時上屏）
 *
 * 與 src/core 的關係：
 *   - 透過 getApp().globalData.agent（AgentRuntime）呼叫 Orchestrator
 *   - onLoad 訂閱 runtime 事件、onUnload 退訂，不直接 import core 內部
 */

import { BRAND_NAME, BRAND_TAGLINE, BRAND_AI_GENERATED_BY, BRAND_AVATAR_IMG } from '../../src/types/brand';
import { taskLabel } from '../../src/llm/client';
import { info as logInfo, error as logError } from '../../src/utils/logger';
import { isVoiceAvailable, startVoiceRecognition } from '../../src/interaction/voice';
import { renderTaskFallback, toCardLines } from '../../src/interaction/card-render';
import { dueTodayTrips, markReminded } from '../../src/storage/trip';
import { recordQuickPhrase, topQuickPhrases } from '../../src/storage/quick-phrases';
import { getItem, setItem } from '../../src/services/storage';
import { recordEvent } from '../../src/services/metrics';
import { jumpExternal } from '../../src/services/jump';
import { METRIC_NAMES } from '../../src/utils/metrics';
import type { MetricName } from '../../src/utils/metrics';
import { CLOUD_ENV, EMBEDDED_JUMP_APPIDS } from '../../src/app';
import type { VoiceRecognitionSession } from '../../src/interaction/voice';
import type { AgentRuntime } from '../../src/app';
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

/** 航班交付卡：查詢結果即「選航班界面」，每班掛快捷預訂 */
interface FlightCard extends CardKey {
  type: 'flight';
  /** 出發城市（大字路線頭） */
  routeFrom: string;
  routeTo: string;
  /** 起飛日期（YYYY-MM-DD） */
  routeDate: string;
  /** 數據源標籤（飛常準即時 / 模擬數據） */
  sourceLabel: string;
  /** 是否即時數據（決定標籤配色） */
  sourceReal: boolean;
  flights: Array<{
    flightNo: string;
    airline: string;
    /** 出發機場 + 航站樓（「首都機場 T3」） */
    fromAirport: string;
    toAirport: string;
    departTime: string;
    arriveTime: string;
    /** 「2小時20分」 */
    durationLabel: string;
    /** 「¥980」；上游未取到價時為「價格待詢」 */
    priceLabel: string;
  }>;
  /** 「共 8 班 · 顯示前 3 班」 */
  moreLabel: string;
  /** 快捷預訂上下文（JSON 字串，wxml dataset 傳遞） */
  bookCtx: string;
}

/** 跳轉下單交付卡：2026-10 跳轉模式寫操作的憑證（複製資訊 + 前往下單，
 *  真實交易在 12306 / OTA 等官方渠道側完成） */
interface JumpCard extends CardKey {
  type: 'jump';
  title: string;
  lines: Array<{ label: string; value: string; highlight?: boolean }>;
  /** 渠道說明（「真實交易於外部官方渠道完成…」提示行） */
  note: string;
  /** 「複製資訊」按鈕上下文（購票需求摘要） */
  copyText: string;
  /** 主跳轉按鈕（appId 空串時不渲染，僅複製——渠道未接入小程序跳轉） */
  jumpBtn?: { appId: string; path: string; label: string };
}

/** 天氣交付卡：實況大字溫度 + 現象 + 濕度 / 風力明細行 */
interface WeatherCard extends CardKey {
  type: 'weather';
  /** 城市名（定位城市未知時為「當前位置」） */
  city: string;
  /** 天氣現象（晴 / 多雲 / 小雨…） */
  condition: string;
  /** 大字溫度「25°」 */
  tempLabel: string;
  /** 明細行（濕度 / 風況 / 發布時間） */
  lines: Array<{ label: string; value: string }>;
  /** 數據源標籤（中國天氣網 / 模擬數據） */
  sourceLabel: string;
  /** 是否即時數據（決定標籤配色） */
  sourceReal: boolean;
}

/** 通用兜底交付卡：頁面專用卡未覆蓋的 action 走 interaction/card-render 渲染 */
interface GenericCard extends CardKey {
  type: 'generic';
  title: string;
  /** 數據源標籤（skillId.action） */
  subtitle?: string;
  lines: Array<{ label: string; value: string }>;
}

/** 計劃進度卡（過程展示，徽章隨任務事件更新） */
interface PlanCard extends CardKey {
  type: 'plan';
  title: string;
  payload: Record<string, unknown>;
}

type AnyCard = TrainCard | FlightCard | JumpCard | WeatherCard | GenericCard | PlanCard;

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
  /** AI 頭像圖片路徑（啟動畫面與聊天回覆頭像共用） */
  avatarImg: string;
  /** 啟動載入畫面是否展示（淡出動畫結束後置 false 卸載節點） */
  splash: boolean;
  /** 載入畫面淡出中（觸發 splash-fade 過渡） */
  splashFading: boolean;
  /** 載入畫面標語 */
  splashTagline: string;
  messages: ChatMessage[];
  inputText: string;
  loading: boolean;
  state: string;
  /** 語音輸入可用（錄音能力已就緒；不可用時不渲染麥克風按鈕） */
  voiceReady: boolean;
  /** 錄音進行中（麥克風按鈕脈衝態，輸入框唯讀顯示「正在聽」提示） */
  recording: boolean;
  /** 錄音已結束、雲端識別中（上傳 + MiniMax asr 約 1~3s，期間輸入框唯讀） */
  transcribing: boolean;
  /** 狀態中文文案（狀態列與 loading 氣泡共用） */
  stateLabel: string;
  /** scroll-into-view 錨點（自動捲動到最新訊息） */
  scrollIntoView: string;
  /** 快捷入口 chips（常用話語優先；label 為截斷短標籤，text 為點擊發送的完整原話） */
  exampleChips: Array<{ text: string; label: string }>;
  /** 快捷入口標題（常用話語「你常問的：」/ 出廠範例「我可以幫你辦：」） */
  chipsTitle: string;
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
  /** 本輪成功任務 ID 集（收尾「卡片即結論」判定用；同一任務事件多次觸發，Set 去重） */
  succeededTaskIds: Set<string>;
  /** 本輪已渲染交付卡的任務 ID 集 */
  deliveredTaskIds: Set<string>;
  /** runtime 事件退訂函數 */
  unsubscribe?: () => void;
  /** 延後初始化定時器 ID（onLoad 重活延後；onUnload 時取消，防止向已卸載頁面寫入 / 訂閱洩漏） */
  deferredInitTimer?: ReturnType<typeof setTimeout>;
  /** 進行中的語音識別會話（null = 閒置） */
  voiceSession: VoiceRecognitionSession | null;
  nextMsgId: () => string;
  appendMessage: (msg: ChatMessage) => void;
  onAgentStateChange: (state: AgentState) => void;
  onAgentPlanUpdate: (plan: Plan) => void;
  onAgentTaskUpdate: (task: Task) => void;
  appendResultCard: (task: Task) => void;
  dispatch: (intent: string) => Promise<void>;
  onSend: () => Promise<void>;
  onTapVoice: () => Promise<void>;
  onInput: (e: { detail: { value: string } }) => void;
  onTapExample: (e: { currentTarget?: { dataset?: { text?: string } } }) => Promise<void>;
  onTapBookTrain: (e: { currentTarget?: { dataset?: { trainNo?: string; ctx?: string } } }) => Promise<void>;
  onTapBookFlight: (e: { currentTarget?: { dataset?: { flightNo?: string; ctx?: string } } }) => Promise<void>;
  onTapCopyJumpInfo: (e: { currentTarget?: { dataset?: { text?: string } } }) => void;
  onTapJumpMini: (e: { currentTarget?: { dataset?: { appid?: string; path?: string } } }) => void;
  onTapProfile: () => void;
  /** 頂部「行程」入口：前往行程頁瀏覽已規劃行程的時間線 */
  onTapTrips: () => void;
  /** 到點提醒：檢查今日到期行程並以助理氣泡提醒（同日同行程僅一次） */
  remindDueTrips: () => void;
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

/** cabin → 中文（機票快捷預訂指令與卡片摘要共用） */
const CABIN_LABELS: Record<string, string> = {
  economy: '經濟艙',
  business: '商務艙',
  first: '頭等艙',
};

/** 車次卡最多展示班數（其餘以「共 N 班」摘要，避免長列表拖慢瀏覽） */
const TRAIN_CARD_LIMIT = 3;

/** 出廠範例（無常用話語記錄時的快捷入口；label 短標籤 + text 完整指令） */
const DEFAULT_EXAMPLES: Array<{ text: string; label: string }> = [
  { text: '明天北京到上海的高鐵，二等座', label: '查高鐵車次' },
  { text: '明天北京飛上海的機票', label: '查機票航班' },
  { text: '現在天氣怎麼樣', label: '查天氣' },
  { text: '周六去上海看球賽', label: '規劃行程' },
];

/** 快捷入口最多展示數（與出廠範例數對齊，避免擠佔輸入區） */
const CHIPS_LIMIT = 4;

/** chip 短標籤截斷長度（超過顯示省略號；點擊仍發送完整原話） */
const CHIP_LABEL_MAX = 12;

/**
 * 依常用話語記錄構造快捷入口（返回值可直接展開進 setData）
 *
 * 頻次降序、同頻次最近使用優先；無任何記錄時回退出廠範例——
 * 新用戶首輪體驗不空窗，老用戶快捷入口隨使用習慣演化。
 */
function buildExampleChips(): Pick<HomePageData, 'exampleChips' | 'chipsTitle'> {
  const top = topQuickPhrases(CHIPS_LIMIT);
  if (top.length === 0) {
    return { exampleChips: DEFAULT_EXAMPLES, chipsTitle: '我可以幫你辦：' };
  }
  return {
    exampleChips: top.map((p) => ({
      text: p.text,
      label: p.text.length > CHIP_LABEL_MAX ? `${p.text.slice(0, CHIP_LABEL_MAX)}…` : p.text,
    })),
    chipsTitle: '你常問的：',
  };
}

/**
 * 任務錯誤 → 用戶可讀文案（按錯誤碼白名單映射）
 *
 * EndUser 不應看到原始錯誤（可能含 wx API、內部欄位、堆疊等代碼級細節）；
 * 未映射的錯誤碼一律回退通用文案，原始訊息由 logger 落盤供開發者排查。
 */
const TASK_ERROR_LABELS: Record<string, string> = {
  NO_TICKETS: '車票已售完，請選擇其他班次',
};

/** 任務錯誤碼 → 用戶文案；未知碼回退通用文案（不透傳原始 message） */
function friendlyTaskError(code: string | undefined): string {
  return TASK_ERROR_LABELS[code ?? ''] ?? '該步驟未能完成，請稍後重試';
}

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

/**
 * 跳轉外部官方小程序（12306 / OTA 渠道下單，真實交易與支付在渠道側完成）
 *
 * 經 services/jump 統一入口：半屏白名單（src/app.ts EMBEDDED_JUMP_APPIDS，
 * 後台「半屏小程序管理」申請通過後生效）命中時半屏打開——渠道支付環節
 * 自行轉全屏，關閉即回對話流；不可用時逐級降級（半屏 fail → 普通跳轉
 * → 複製提示），任何環境下下單路徑不斷裂。開發者工具不支援跳轉（僅真機）。
 */
function jumpToMiniProgram(appId: string, path: string): void {
  jumpExternal({ env: CLOUD_ENV, appId, path, embeddedAppIds: EMBEDDED_JUMP_APPIDS });
}

/** 取得 Agent Runtime（onLaunch 先於頁面 onLoad，防禦性判空） */
function getAgent(): AgentRuntime | null {
  const app = getApp() as unknown as { globalData?: { agent?: AgentRuntime } };
  return app?.globalData?.agent ?? null;
}

/** 交付卡動作 → 漏斗事件（2026-10 評審 #5：查票 → 購票卡 → 跳轉漏斗前兩級） */
const METRIC_BY_ACTION: Partial<Record<string, MetricName>> = {
  search_train: METRIC_NAMES.trainResultsView,
  book_ticket: METRIC_NAMES.trainBookCard,
  search_flights: METRIC_NAMES.flightResultsView,
  book_flight: METRIC_NAMES.flightBookCard,
};

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

/** book_ticket 成功 → 購票資訊卡（跳轉 12306 官方小程序下單） */
function buildTrainOrderCard(data: unknown): JumpCard | null {
  const d = data as {
    orderId?: unknown;
    trainNo?: unknown;
    amountCent?: unknown;
    status?: unknown;
    jump?: { target?: unknown; appId?: unknown; path?: unknown; jCommand?: unknown; copyText?: unknown; note?: unknown } | undefined;
  } | undefined;
  if (!d || typeof d.orderId !== 'string') return null;
  const amountCent = typeof d.amountCent === 'number' ? d.amountCent : 0;
  const jump = d.jump;
  const appId = typeof jump?.appId === 'string' ? jump.appId : '';
  const copyText = typeof jump?.copyText === 'string' && jump.copyText ? jump.copyText : `${String(d.trainNo ?? '')} 車票 ¥${(amountCent / 100).toFixed(2)}`;
  return {
    type: 'jump',
    key: `jump-${d.orderId}`,
    title: '購票資訊卡已生成',
    lines: [
      { label: '車次', value: String(d.trainNo ?? '') },
      { label: '票價', value: formatPrice(amountCent), highlight: true },
      { label: '狀態', value: d.status === 'completed' ? '已完成' : d.status === 'cancelled' ? '已取消' : '待跳轉下單' },
      { label: '訂單號', value: d.orderId },
    ],
    note: typeof jump?.note === 'string' && jump.note ? jump.note : '真實交易於外部官方渠道完成，支付與售後以渠道為準',
    copyText,
    // appId 非空才掛跳轉鈕（EXTERNAL_JUMP 未配置的渠道 copy-only）
    ...(appId
      ? { jumpBtn: { appId, path: typeof jump?.jCommand === 'string' && jump.jCommand ? jump.jCommand : typeof jump?.path === 'string' ? jump.path : '', label: '前往 12306 下單' } }
      : {}),
  };
}

/** search_flights 成功 → 航班交付卡（卡片即選航班界面，每班掛快捷預訂） */
function buildFlightCard(data: unknown): FlightCard | null {
  const d = data as { from?: unknown; to?: unknown; date?: unknown; flights?: unknown; source?: unknown } | undefined;
  if (!d || !Array.isArray(d.flights) || d.flights.length === 0) return null;
  const cabinLabel = CABIN_LABELS[String((d.flights[0] as Record<string, unknown>).cabin ?? '')] ?? '經濟艙';
  const shown = d.flights.slice(0, TRAIN_CARD_LIMIT);
  const flights = shown.map((raw) => {
    const f = raw as Record<string, unknown>;
    const priceCent = typeof f.priceCent === 'number' ? f.priceCent : -1;
    return {
      flightNo: String(f.flightNo ?? ''),
      airline: String(f.airline ?? ''),
      fromAirport: String(f.fromAirport ?? ''),
      toAirport: String(f.toAirport ?? ''),
      departTime: String(f.departTime ?? ''),
      arriveTime: String(f.arriveTime ?? ''),
      durationLabel: formatDuration(typeof f.durationMin === 'number' ? f.durationMin : 0),
      // 上游未取到價（priceCent < 0）特判「價格待詢」，不展示誤導性 ¥0
      priceLabel: priceCent > 0 ? formatPrice(priceCent) : '價格待詢',
    };
  });
  return {
    type: 'flight',
    key: `flight-${String(d.from ?? '')}-${String(d.to ?? '')}-${String(d.date ?? '')}`,
    routeFrom: String(d.from ?? ''),
    routeTo: String(d.to ?? ''),
    routeDate: String(d.date ?? ''),
    sourceLabel: d.source === 'variflight_realtime' ? '飛常準即時' : '模擬數據',
    sourceReal: d.source === 'variflight_realtime',
    flights,
    moreLabel: d.flights.length > shown.length ? `共 ${d.flights.length} 班 · 顯示前 ${shown.length} 班` : `共 ${d.flights.length} 班`,
    // 快捷預訂上下文：發送「預訂 2026-10-12 北京飛上海的CA1501航班經濟艙」
    bookCtx: JSON.stringify({
      from: String(d.from ?? ''),
      to: String(d.to ?? ''),
      date: String(d.date ?? ''),
      cabinLabel,
    }),
  };
}

/** book_flight 成功 → 機票購票資訊卡（跳轉 OTA 小程序下單） */
function buildFlightOrderCard(data: unknown): JumpCard | null {
  const d = data as {
    orderId?: unknown;
    flightNo?: unknown;
    amountCent?: unknown;
    status?: unknown;
    jump?: { target?: unknown; appId?: unknown; path?: unknown; jCommand?: unknown; copyText?: unknown; note?: unknown } | undefined;
  } | undefined;
  if (!d || typeof d.orderId !== 'string') return null;
  const amountCent = typeof d.amountCent === 'number' ? d.amountCent : 0;
  const jump = d.jump;
  const appId = typeof jump?.appId === 'string' ? jump.appId : '';
  const copyText = typeof jump?.copyText === 'string' && jump.copyText ? jump.copyText : `${String(d.flightNo ?? '')} 機票 ¥${(amountCent / 100).toFixed(2)}`;
  return {
    type: 'jump',
    key: `jump-${d.orderId}`,
    title: '機票購票資訊卡已生成',
    lines: [
      { label: '航班', value: String(d.flightNo ?? '') },
      { label: '票價', value: formatPrice(amountCent), highlight: true },
      { label: '狀態', value: d.status === 'completed' ? '已完成' : d.status === 'cancelled' ? '已取消' : '待跳轉下單' },
      { label: '訂單號', value: d.orderId },
    ],
    note: typeof jump?.note === 'string' && jump.note ? jump.note : '真實交易於外部官方渠道完成，支付與售後以渠道為準',
    copyText,
    ...(appId
      ? { jumpBtn: { appId, path: typeof jump?.path === 'string' ? jump.path : '', label: '前往 OTA 下單' } }
      : {}),
  };
}

/** get_weather 成功 → 實況天氣交付卡（大字溫度 + 明細行，數據源標籤區分即時 / 模擬） */
function buildWeatherCard(data: unknown): WeatherCard | null {
  const d = data as {
    city?: unknown;
    weather?: unknown;
    temperature?: unknown;
    humidity?: unknown;
    windDirection?: unknown;
    windPower?: unknown;
    reportTime?: unknown;
    source?: unknown;
  } | undefined;
  if (!d || typeof d.weather !== 'string' || typeof d.temperature !== 'string') return null;
  // 風向與風力合併為一行（「東北 · ≤3」）
  const wind = [d.windDirection, d.windPower]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' · ');
  return {
    type: 'weather',
    key: `weather-${String(d.reportTime ?? '')}-${d.temperature}`,
    city: typeof d.city === 'string' && d.city ? d.city : '當前位置',
    condition: d.weather,
    tempLabel: `${d.temperature}°`,
    lines: [
      ...(typeof d.humidity === 'string' && d.humidity ? [{ label: '濕度', value: `${d.humidity}%` }] : []),
      ...(wind ? [{ label: '風況', value: wind }] : []),
      ...(typeof d.reportTime === 'string' && d.reportTime ? [{ label: '發布時間', value: d.reportTime }] : []),
    ],
    sourceLabel: d.source === 'weathercn_realtime' ? '中國天氣網' : '模擬數據',
    sourceReal: d.source === 'weathercn_realtime',
  };
}

Page({
  data: {
    brandName: BRAND_NAME,
    avatarImg: BRAND_AVATAR_IMG,
    splash: true,
    splashFading: false,
    splashTagline: BRAND_TAGLINE,
    messages: [] as ChatMessage[],
    inputText: '',
    loading: false,
    state: 'idle',
    voiceReady: false,
    recording: false,
    transcribing: false,
    stateLabel: STATE_LABELS.idle,
    scrollIntoView: '',
    exampleChips: DEFAULT_EXAMPLES,
    chipsTitle: '我可以幫你辦：',
  } as HomePageData,

  onLoad(): void {
    const self = this as unknown as HomePageThis;
    self.msgSeq = 0;
    self.activePlanId = '';
    self.succeededTaskIds = new Set();
    self.deliveredTaskIds = new Set();
    self.voiceSession = null;
    logInfo(`${BRAND_NAME} 首頁載入`);

    // 快捷入口個人化：常用話語 Top N 優先，無記錄時回退出廠範例
    // （onLoad 先於首幀渲染，同步 storage 讀取無閃爍）
    self.setData(buildExampleChips());

    // 啟動載入畫面（2026-10 產品評審修訂）：僅設備首次冷啟動顯示 800ms
    // 品牌首秀，回訪啟動直接跳過——工作型工具不為內容型開場反覆支付
    // 啟動延遲稅（首訪總時長 800ms 展示 + 820ms 淡出；回訪 0ms）。
    // 淡出時長與 wxss opacity 過渡對齊；歡迎訊息延至淡出時入場，
    // 與範例 chips 錯落動畫銜接（chips 的 wx:if 綁定 !splash）。
    const firstLaunch = !getItem<boolean>('splash:seen', false);
    const welcome = `你好，我是${BRAND_NAME}，說一句「明天北京到上海的高鐵」，我來辦。\n剩下的，交給下面的示例。`;
    if (firstLaunch) {
      setItem('splash:seen', true);
      setTimeout(() => {
        self.setData({ splashFading: true });
        logInfo(`助手回覆（歡迎語）：${welcome}`);
        self.appendMessage({
          id: self.nextMsgId(),
          role: 'assistant',
          content: welcome,
          timestamp: Date.now(),
        });
        setTimeout(() => self.setData({ splash: false }), 820);
      }, 800);
    } else {
      self.setData({ splash: false });
      logInfo(`助手回覆（歡迎語）：${welcome}`);
      self.appendMessage({
        id: self.nextMsgId(),
        role: 'assistant',
        content: welcome,
        timestamp: Date.now(),
      });
    }

    // 重活延後：Agent Runtime 建構（globalData.agent getter 首次存取觸發，
    // 含 wx.cloud.init 與 3 個 SKILL 註冊）+ RecorderManager 探測移出
    // onLoad 同步段——基礎庫對耗時 >100ms 的頁面生命週期拋 [Perf] 警告。
    // 首訪路徑 800ms 品牌展示窗口內延後零感知；回訪路徑 splash 即時
    // 卸載，setTimeout(0) 仍將建構排至首幀渲染之後；dispatch 內
    // getAgent() 為幂等 getter 兜底，建構競態安全。
    self.deferredInitTimer = setTimeout(() => {
      // 語音輸入可用性判定（插件未接入時靜默降級，不渲染麥克風按鈕）
      self.setData({ voiceReady: isVoiceAvailable() });

      // 訂閱 Agent runtime 事件（狀態 / 計劃 / 任務進度 → UI 即時更新）
      const agent = getAgent();
      if (agent) {
        self.unsubscribe = agent.subscribe({
          onStateChange: (s) => self.onAgentStateChange(s),
          onPlanUpdate: (p) => self.onAgentPlanUpdate(p),
          onTaskUpdate: (t) => self.onAgentTaskUpdate(t),
        });
      } else {
        logError('Agent runtime 未就緒（globalData.agent 缺失），對話功能不可用');
      }
    }, 0);
  },

  /**
   * 到點提醒（每次頁面顯示檢查一次）：行程日當天以助理氣泡提醒用戶按計劃出行。
   *
   * 提醒與行程任務成敗無關——「今天有行程」本身就是提醒語義；
   * 同日同行程僅提醒一次（remindedAt 標記去重，storage/trip 統一判定）。
   * 冷啟動首輪 onShow 早於歡迎語入場，提醒會排在歡迎語之前（優先級更高，可接受）。
   */
  onShow(): void {
    (this as unknown as HomePageThis).remindDueTrips();
  },

  /**
   * 右上角菜單轉發（2026-10 評審 #4：補齊全項目缺失的分享入口）
   *
   * 行程卡一對一分享在行程頁（open-type=share 按鈕攜 ?shared=shareId）；
   * 此處為小程序級分享（傳播側入口）。
   */
  onShareAppMessage(): { title: string; path: string } {
    return { title: `${BRAND_NAME} — 一句話規劃出行`, path: '/pages/index/index' };
  },

  onUnload(): void {
    const self = this as unknown as HomePageThis;
    // 取消未觸發的延後初始化（避免向已卸載頁面 setData / runtime 監聽器洩漏）
    if (self.deferredInitTimer !== undefined) {
      clearTimeout(self.deferredInitTimer);
      self.deferredInitTimer = undefined;
    }
    self.unsubscribe?.();
    self.unsubscribe = undefined;
    // 進行中的錄音會話丟棄（辨識結果不再消費）
    self.voiceSession?.abort();
    self.voiceSession = null;
  },

  /** 即時更新輸入框（受控元件；loading 期間允許繼續輸入下一條） */
  onInput(this: HomePageThis, e: { detail: { value: string } }): void {
    this.setData({ inputText: e.detail.value });
  },

  /** 發送按鈕（錄音中自動結束錄音，識別取文本後發送） */
  async onSend(this: HomePageThis): Promise<void> {
    if (this.data.loading || this.data.transcribing) return;
    let text = (this.data.inputText ?? '').trim();
    if (this.data.recording && this.voiceSession) {
      const session = this.voiceSession;
      this.voiceSession = null;
      this.setData({ recording: false, transcribing: true });
      try {
        text = ((await session.stop()).trim()) || text;
      } catch (err) {
        logError('語音識別失敗', err);
        this.setData({ transcribing: false });
        wx.showToast({ title: '語音識別失敗，請重試', icon: 'none' });
        return;
      }
      this.setData({ inputText: text, transcribing: false });
    }
    if (!text) return;
    this.setData({ inputText: '' });
    await this.dispatch(text);
  },

  /**
   * 麥克風按鈕：切換錄音開關
   *
   * 開始 → 輸入框唯讀顯示「正在聽」提示；再次點按 → 結束錄音並
   * 上傳雲端識別（transcribing 態，約 1~3s），最終文本留在輸入框
   * 供用戶校對後發送（語音識別有誤時可手工修正，避免誤發下單類指令）
   */
  async onTapVoice(this: HomePageThis): Promise<void> {
    if (this.data.loading || this.data.transcribing) return;
    // 結束錄音：上傳識別後文本入輸入框，交由用戶校對發送
    if (this.voiceSession) {
      const session = this.voiceSession;
      this.voiceSession = null;
      this.setData({ recording: false, transcribing: true });
      try {
        const text = (await session.stop()).trim();
        if (text) this.setData({ inputText: text });
      } catch (err) {
        logError('語音識別失敗', err);
        wx.showToast({ title: '語音識別失敗，請重試', icon: 'none' });
      }
      this.setData({ transcribing: false });
      return;
    }
    // 開始錄音：清空輸入框，錄音期間唯讀（雲端批量識別，無實時中間結果）
    try {
      this.voiceSession = startVoiceRecognition({ cloudEnv: CLOUD_ENV });
      this.setData({ recording: true, inputText: '' });
    } catch (err) {
      logError('語音識別啟動失敗', err);
      wx.showToast({ title: '語音輸入不可用，請使用文字輸入', icon: 'none' });
    }
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

  /**
   * 航班卡快捷預訂：以「預訂 + 完整要素」的自然語言指令重新進入規劃鏈路
   * （與車次卡同構：規劃器支援字面航班號，確認彈窗展示即時票價）
   */
  async onTapBookFlight(this: HomePageThis, e: { currentTarget?: { dataset?: { flightNo?: string; ctx?: string } } }): Promise<void> {
    const flightNo = e.currentTarget?.dataset?.flightNo;
    const ctxRaw = e.currentTarget?.dataset?.ctx;
    if (!flightNo || !ctxRaw || this.data.loading) return;
    try {
      const ctx = JSON.parse(ctxRaw) as { from?: string; to?: string; date?: string; cabinLabel?: string };
      const cabin = ctx.cabinLabel ?? '經濟艙';
      const intent = `預訂 ${ctx.date ?? ''} ${ctx.from ?? ''}飛${ctx.to ?? ''}的${flightNo}航班${cabin}`;
      await this.dispatch(intent);
    } catch (err) {
      logError('快捷預訂參數解析失敗', err);
    }
  },

  /** 跳轉卡「複製資訊」：憑證要素寫入剪貼板，渠道側下單時粘貼使用 */
  onTapCopyJumpInfo(this: HomePageThis, e: { currentTarget?: { dataset?: { text?: string } } }): void {
    const text = e.currentTarget?.dataset?.text;
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已複製', icon: 'success' }),
    });
  },

  /** 跳轉卡「前往下單」：跳轉官方渠道小程序（12306 / OTA），真實交易與支付在渠道側完成 */
  onTapJumpMini(this: HomePageThis, e: { currentTarget?: { dataset?: { appid?: string; path?: string } } }): void {
    const appId = e.currentTarget?.dataset?.appid ?? '';
    const path = e.currentTarget?.dataset?.path ?? '';
    jumpToMiniProgram(appId, path);
  },

  /** 頂部入口：前往個人資料頁（乘車人簿管理，供火車 / 機票下單自動帶入） */
  onTapProfile(this: HomePageThis): void {
    wx.navigateTo({ url: '/pages/profile/index' });
  },

  /** 頂部入口：前往行程頁（瀏覽已規劃行程的時間線，行程確認後自動建檔） */
  onTapTrips(this: HomePageThis): void {
    wx.navigateTo({ url: '/pages/trips/index' });
  },

  /** 清空對話並重置 Agent */
  onTapReset(this: HomePageThis): void {
    getAgent()?.resetAgent();
    this.msgSeq = 0;
    this.activePlanId = '';
    this.succeededTaskIds.clear();
    this.deliveredTaskIds.clear();
    this.voiceSession?.abort();
    this.voiceSession = null;
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
      recording: false,
      inputText: '',
      // 對話清空後快捷入口區隨之重現，刷新為最新常用話語
      ...buildExampleChips(),
    });
  },

  /** 內部：生成遞增訊息 ID */
  nextMsgId(this: HomePageThis): string {
    this.msgSeq += 1;
    return `msg_${this.msgSeq}`;
  },

  /** 內部：發送訊息給 Agent */
  async dispatch(this: HomePageThis, intent: string): Promise<void> {
    if (this.data.loading || this.data.recording || this.data.transcribing) return;

    // 本輪收尾判定集歸零（task_NNN 跨輪同名，須以輪次隔離，同 activePlanId 理由）
    this.succeededTaskIds.clear();
    this.deliveredTaskIds.clear();

    // 1. 追加用戶訊息（content 全量落日誌：Console + dev-log 旁路，不截斷，
    //    補齊 orchestrator.handle 僅取前 60 字的取證盲區）
    logInfo(`用戶訊息：${intent}`);
    this.appendMessage({
      id: this.nextMsgId(),
      role: 'user',
      content: intent,
      timestamp: Date.now(),
    });

    // 常用話語記錄（快捷入口個人化數據源；預訂類指令由儲存層過濾）
    recordQuickPhrase(intent);

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
      const finalState = res.state ?? 'idle';

      // 2. 收尾文字按需追加（卡片即結論）：本輪成功任務已全部以交付卡呈現時，
      //    聚合結論「已完成 N 項任務 ✓…」與計劃卡成功徽章、交付卡、狀態列
      //    「已為你辦妥」三重重複——按「最小打擾」原則靜默收尾。仍需文字的場景：
      //    a. 非 completed 態（失敗 / 追問 / BUSY——文字是主要反饋通道，
      //       如失敗時的回滾摘要僅此處展示）
      //    b. 存在成功但無卡承載的任務（如無專用卡的 action、
      //       兜底卡白名單亦無可展示欄位——聚合文字是其唯一結果反饋）
      const hasUncardedSuccess = this.succeededTaskIds.size > this.deliveredTaskIds.size;
      if (finalState !== 'completed' || hasUncardedSuccess) {
        const reply = res.message ?? `${BRAND_AI_GENERATED_BY} 已完成`;
        logInfo(`助手回覆：${reply}`);
        this.appendMessage({
          id: this.nextMsgId(),
          role: 'assistant',
          content: reply,
          timestamp: Date.now(),
        });
      }

      if (res.errorCode === 'BUSY') {
        wx.showToast({ title: '請等待當前任務完成', icon: 'none' });
      }

      this.setData({
        loading: false,
        state: finalState,
        stateLabel: STATE_LABELS[finalState] ?? finalState,
      });
    } catch (e) {
      logError('dispatch 失敗', e);
      const fallback = `${BRAND_AI_GENERATED_BY}：系統異常，請稍後再試。`;
      logInfo(`助手回覆：${fallback}`);
      this.appendMessage({
        id: this.nextMsgId(),
        role: 'assistant',
        content: fallback,
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
      // 任務中文展示名（技術形態 summary 由 action 中文名兜底，不暴露 skillId 代碼）
      title: taskLabel(t),
      payload: {
        planId: plan.id,
        taskId: t.id,
        /** 步驟序號（01 / 02…，渲染在序號方塊內） */
        seq: String(i + 1).padStart(2, '0'),
        status: t.status,
        statusLabel: TASK_STATUS_LABELS[t.status] ?? t.status,
        dependsOn: t.dependsOn,
        // 時間線標籤（行程 DAG 任務攜帶，如「10/11 下周六」；普通任務無此欄位）
        ...(t.timeLabel ? { timeLabel: t.timeLabel } : {}),
      },
    }));
    // 行程 Plan 文案突出三要素（口語日期 + 城市 + 活動），與普通計劃文案區分
    const lead = plan.trip
      ? `已生成 ${plan.trip.dateLabel} ${plan.trip.city}行程計劃（${plan.tasks.length} 個任務，${plan.trip.activity}），開始為你執行：`
      : `已生成執行計劃（${plan.tasks.length} 個任務），開始為你執行：`;
    logInfo(`助手回覆（計劃摘要）：${lead}`);
    this.appendMessage({
      id: this.nextMsgId(),
      role: 'assistant',
      content: lead,
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
          // 錯誤文案白名單映射：不透傳原始 message（可能含 wx API / 內部欄位等代碼級細節），
          // 原始錯誤已由 scheduler / skill 層記入日誌供排查
          ...(task.result?.error ? { error: friendlyTaskError(task.result.error.code) } : {}),
        },
      } as PlanCard;
      return { ...msg, cards };
    });
    this.setData({ messages });

    // 本輪成功任務登記（收尾「卡片即結論」判定用；同任務多次事件冪等）
    if (task.status === 'succeeded') this.succeededTaskIds.add(task.id);

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
    else if (task.action === 'search_flights') card = buildFlightCard(data);
    else if (task.action === 'book_flight') card = buildFlightOrderCard(data);
    else if (task.action === 'get_weather') card = buildWeatherCard(data);
    if (!card) {
      // 未知 action → interaction/card-render 通用兜底卡（成功結果不靜默丟棄）
      const rc = renderTaskFallback(task);
      const lines = toCardLines(rc.body);
      if (lines.length === 0) return;
      card = {
        type: 'generic',
        key: `generic-${this.activePlanId}-${task.id}`,
        title: rc.title,
        lines,
      };
    }
    // 交付落實登記（收尾判定「該任務已有卡片承載」用）
    this.deliveredTaskIds.add(task.id);
    // 漏斗埋點：交付卡渲染即記（fire-and-forget，永不阻斷交付）
    const metric = METRIC_BY_ACTION[task.action];
    if (metric) recordEvent(CLOUD_ENV, metric);
    // content 為空字串（成果由卡片承載），日誌記 action 與卡片型別供取證
    logInfo(`助手回覆（交付卡）：${task.action} → ${card.type}`);
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

  /** 內部：今日到期行程提醒（onShow 觸發；同日同行程僅提醒一次） */
  remindDueTrips(this: HomePageThis): void {
    for (const trip of dueTodayTrips()) {
      const text = `${BRAND_AI_GENERATED_BY}\n今天你有${trip.city}行程——${trip.activity}，記得按計劃出行。可在「行程」頁查看時間線。`;
      logInfo(`助手回覆（行程提醒）：${text}`);
      this.appendMessage({
        id: this.nextMsgId(),
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
      });
      markReminded(trip.id);
    }
  },
} as unknown as Parameters<typeof Page>[0]);
