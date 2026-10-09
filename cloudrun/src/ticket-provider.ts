/**
 * 統一票務 Provider 契約與 REST 適配層
 *
 * 職責（skill-ticket.ts 的唯一契約依賴，定位同 api.ts 之於各 handler）：
 *   1. 定義跨平台統一協議結構（EventSummary / SessionInfo / TierInfo）
 *   2. 定義 TicketProvider 契約——大麥 / 秀動等第三方票務平台的接入規範
 *   3. 提供 createRestTicketProvider：按「票務渠道接入 REST 契約」實作的真實
 *      HTTP 適配器（Node 18+ 內建 fetch，零運行時依賴），配置環境變數即生效
 *
 * ── 票務渠道接入 REST 契約（MicroMate 票務接入規範 v1）──
 *
 * 渠道方（大麥 / 秀動的開放平台或聚合網關）須實作以下兩個端點，
 * 資料結構與本模組匯出的統一協議結構逐欄位一致（平台差異在渠道
 * 網關側完成歸一化）：
 *
 *   GET {base}/events?keyword=&city=&type=
 *     → HTTP 200 { "events": EventSummary[] }
 *   GET {base}/events/{eventId}
 *     → HTTP 200 { "event": EventSummary, "sessions": SessionInfo[] }
 *     → HTTP 404 { "code": 404, "message": "..." }   （無此演出）
 *
 * 鑒權：所有請求攜帶 Authorization: Bearer {apiKey}；
 * 回應編碼 UTF-8 JSON；建議單請求回應 < 3s（適配器預設 8s 超時）。
 *
 * 錯誤語義（與 mcp-client.ts 的類型化分流一致，呼叫方據此決定降級）：
 *   - 拋出 TicketProviderError：渠道業務性錯誤（HTTP 非 2xx 且非 404，
 *     如 401 金鑰無效 / 429 限流）——呼叫方應如實透傳，不得降級
 *   - 拋出一般 Error：連線層失敗（不可達 / 超時 / 非 JSON）——呼叫方
 *     應記日誌並降級後續 Provider（演示目錄恆在末位兜底）
 *   - 返回 null（僅 listSessions）：HTTP 404「無此演出」，嘗試下一 Provider
 */

/** 演出摘要（search_events 出參條目；渠道須按此結構歸一化） */
export interface EventSummary {
  eventId: string;
  name: string;
  type: string;
  artist: string;
  city: string;
  venue: string;
  /** 渠道標記：damai（大麥）/ showstart（秀動）—— 僅展示用，協議不含平台細節 */
  provider: string;
  /** 各場次最低票價（分） */
  minPriceCent: number;
  /** 是否任一場次任一票檔有票 */
  onSale: boolean;
  sessionCount: number;
  /** 最近一個場次日期（YYYY-MM-DD） */
  firstSessionDate: string;
}

/** 票檔（價位等級）即時資訊 */
export interface TierInfo {
  tierId: string;
  name: string;
  priceCent: number;
  /** 即時剩餘庫存 */
  inventory: number;
}

/** 場次即時資訊 */
export interface SessionInfo {
  sessionId: string;
  eventId: string;
  date: string;
  startTime: string;
  endTime: string;
  /** MVP 全部 on_sale；pending（未開售）/ closed（已停售）為渠道狀態保留 */
  status: 'on_sale' | 'pending' | 'closed';
  priceTiers: TierInfo[];
}

/** TicketProvider 查詢面回傳：演出摘要 + 場次清單 */
export interface SessionBundle {
  event: EventSummary;
  sessions: SessionInfo[];
}

/**
 * 統一票務 Provider 契約 —— 第三方平台（大麥 / 秀動等）的接入規範
 *
 * 實作方提供「查詢面」兩個方法，平台 API 差異（搜索、場次、庫存介面
 * 形態各異）在 Provider 內部消化，返回資料必須符合統一協議結構。寫
 * 操作（下單 / 取消 / 列單）由 skill-ticket.ts 統一訂單簿管理——渠道
 * 真實下單 API 開通後再行下沉到 Provider。
 */
export interface TicketProvider {
  /** 平台標識（與演示目錄的 provider 欄位對齊，如 'damai' / 'showstart'） */
  readonly id: string;
  /** 按關鍵詞 / 城市 / 類型查演出 */
  searchEvents(input: { keyword?: string; city?: string; type?: string }): Promise<EventSummary[]>;
  /** 查指定演出的場次與票檔即時庫存；演出不存在返回 null */
  listSessions(eventId: string): Promise<SessionBundle | null>;
}

/** 渠道業務性錯誤（呼叫方應如實透傳為業務失敗，不降級模擬） */
export class TicketProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketProviderError';
  }
}

/** REST 適配器配置（環境變數 → resolveProviders 構造） */
export interface RestProviderConfig {
  /** 平台標識（寫入 event.provider 作展示標記） */
  id: string;
  /** 渠道網關基址（如 https://partner-gateway.example.com） */
  baseUrl: string;
  /** 渠道分配的 API Key（Bearer 鑒權） */
  apiKey: string;
  /** 單請求超時毫秒，預設 8000（覆蓋票務查詢長尾，小於小程序端 15s 上限） */
  timeoutMs?: number;
}

/** 渠道回應外層結構窄化（僅聲明契約欄位；未知欄位容忍） */
function strOrEmpty(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 渠道 events 陣列窄化：容忍缺失 / 非陣列（契約違反按空結果處理） */
function narrowEvents(v: unknown): EventSummary[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is EventSummary => typeof e === 'object' && e !== null && typeof (e as EventSummary).eventId === 'string');
}

/**
 * 單次渠道請求（GET + Bearer + 超時 + 錯誤分流）
 *
 * @returns 解析後的 JSON；HTTP 404 返回 null（「無此資源」語義）
 * @throws TicketProviderError HTTP 非 2xx 且非 404（渠道業務性錯誤）
 * @throws Error               不可達 / 超時 / 非 JSON（連線層失敗）
 */
async function partnerRequest(url: string, cfg: RestProviderConfig): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 8_000);
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`票務渠道端點不可達（${cfg.baseUrl}）：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 404) return null;
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new TicketProviderError(`票務渠道回應 HTTP ${resp.status}：${bodyText.slice(0, 160)}`);
  }

  const text = await resp.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`票務渠道回應非合法 JSON（${cfg.baseUrl}）：${text.slice(0, 120)}`);
  }
}

/**
 * REST 渠道適配器：按「票務渠道接入 REST 契約」實作 TicketProvider
 *
 * 參考實作見 scripts/ticket-partner-mock.mjs（零依賴契約示範服務，
 * 兼本地端到端驗證夾具）。
 */
export function createRestTicketProvider(cfg: RestProviderConfig): TicketProvider {
  return {
    id: cfg.id,
    async searchEvents(input) {
      const qs = new URLSearchParams();
      if (input.keyword) qs.set('keyword', input.keyword);
      if (input.city) qs.set('city', input.city);
      if (input.type) qs.set('type', input.type);
      const data = (await partnerRequest(`${cfg.baseUrl}/events?${qs.toString()}`, cfg)) as
        | { events?: unknown }
        | null;
      if (!data) return []; // 渠道搜索端點 404 按空結果處理（聚合語義）
      return narrowEvents(data.events);
    },
    async listSessions(eventId) {
      const data = (await partnerRequest(`${cfg.baseUrl}/events/${encodeURIComponent(eventId)}`, cfg)) as
        | { event?: unknown; sessions?: unknown }
        | null;
      if (!data) return null; // 404：無此演出，交由下一 Provider 接手
      const event = data.event as EventSummary | undefined;
      const sessions = Array.isArray(data.sessions)
        ? (data.sessions as SessionInfo[]).filter(
            (s) => typeof s === 'object' && s !== null && typeof (s as SessionInfo).sessionId === 'string',
          )
        : [];
      if (!event || typeof event.eventId !== 'string' || sessions.length === 0) {
        // 契約違反（缺 event 結構 / 空場次）：視為渠道數據異常，交由下一 Provider
        throw new Error(`票務渠道回應結構不符契約（${strOrEmpty(cfg.id)} / ${eventId}）`);
      }
      return { event, sessions };
    },
  };
}
