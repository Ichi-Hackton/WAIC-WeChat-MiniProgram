/**
 * 極簡 MCP（Model Context Protocol）Streamable HTTP 用戶端
 *
 * 設計約束：
 *   - 零依賴：僅用 Node 18+ 全域 fetch，與 server.ts 的零依賴方針一致
 *   - 僅實作「tools/call」所需最小協議面：惰性 initialize → 快取工作階段
 *     → tools/call；工作階段失效（HTTP 404）時重置並重試一次
 *   - 響應相容兩種傳輸編碼：application/json（單體 JSON-RPC）與
 *     text/event-stream（SSE `data:` 行承載 JSON-RPC），逐行拼接還原
 *
 * 2026-10 國民級 App MCP 接入：新增可選自訂 Header（extraHeaders）——
 *   麥當勞（mcp.mcd.cn）/ 瑞幸（gwmcp.lkcoffee.com）要求每個請求攜帶
 *   Authorization: Bearer <token>，滴滴的 Key 走 URL query 不受影響。
 *   向後兼容：第 5 參數可選，既有呼叫點（12306-mcp / 動態技能）零改動
 *
 * 2026-10 飛豬接入：新增可選請求簽名回調（McpSigner）——飛豬 FlyAI
 *   要求每個請求攜帶 HMAC-SHA256 簽名五頭，且簽名覆蓋最終請求體
 *   （sha256(body)）與時間戳，靜態 extraHeaders 無法表達 body 綁定，
 *   故在序列化後、發送前回調注入。向後兼容：第 6 參數可選
 *
 * 錯誤語義（呼叫方據此決定降級策略，類型化分流取代 message 文案匹配）：
 *   - 拋出 McpToolError：上游工具的業務性錯誤（工具結果標記 isError，
 *     如「站名不存在 / 無此線路」）——呼叫方應如實透傳，不得降級模擬
 *   - 拋出 McpTransportError：連線層失敗（不可達 / 超時 / HTTP 非 2xx /
 *     JSON-RPC 協議錯 / 回應缺少 content）——呼叫方應降級模擬數據
 *   - 正常返回 text：由呼叫方按約定格式解析
 */

/** 連線層錯誤（呼叫方應降級模擬） */
export class McpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpTransportError';
  }
}

/** 上游工具業務性錯誤（呼叫方應如實透傳，不得降級模擬） */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

/** JSON-RPC 回應的外層結構（僅聲明用到的欄位） */
interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** tools/call 的 result 結構 */
interface ToolCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  /** 結構化輸出（滴滴 taxi_* 等雙通道工具攜帶：traceId / orderId 等
   *  程序化欄位僅在此處，content[0].text 為面向 LLM 的自然語言） */
  structuredContent?: unknown;
}

/**
 * 請求簽名回調：在請求體序列化後、發送前調用，直接改寫 headers 注入簽名頭
 *
 * @param method   HTTP 方法（恒為 POST，保留參數以明確簽名材料）
 * @param pathname 端點 URL 的 path（如 /mcp）
 * @param body     最終請求體字串（簽名材料：sha256(body)）
 * @param headers  待發送的請求頭表（回調內追加 / 改寫）
 */
export type McpSigner = (
  method: string,
  pathname: string,
  body: string,
  headers: Record<string, string>,
) => void;

/** 各 MCP 端點的工作階段 ID 快取（url → sessionId） */
const sessionCache = new Map<string, string>();

/** 自增請求 id（JSON-RPC 關聯用；服務端實測不校驗連續性） */
let nextId = 1;

/**
 * 發送單次 JSON-RPC 請求並解析回應（相容 JSON 與 SSE 兩種編碼）
 *
 * @param endpoint MCP Streamable HTTP 端點（如 http://127.0.0.1:3001/mcp）
 * @param method   JSON-RPC 方法名
 * @param params   參數物件（通知類方法傳 null 時不帶 params 欄位）
 * @param sessionId 已建立的工作階段 ID（可空）
 * @param timeoutMs 超時毫秒數
 * @param extraHeaders 額外請求頭（如遠程託管 MCP 的 Authorization: Bearer）
 * @param signer    請求簽名回調（飛豬等 body 綁定簽名型端點專用，可空）
 * @returns 回應 result；通知類請求（無 id）回傳 null
 */
async function rpc(
  endpoint: string,
  method: string,
  params: Record<string, unknown> | null,
  sessionId: string | undefined,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
  signer?: McpSigner,
): Promise<unknown | null> {
  const isNotification = params === null;
  const id = nextId++;
  const payload: Record<string, unknown> = { jsonrpc: '2.0', method };
  // JSON-RPC 通知（如 notifications/initialized）不得攜帶 id；帶 id 的請求才期待回應

  if (!isNotification) payload.params = params as Record<string, unknown>;
  if (!isNotification) payload.id = id;

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    ...(extraHeaders ?? {}),
  };
  if (signer) {
    // 簽名覆蓋最終請求體與時間戳：必須在序列化完成後調用（順序不可前移）
    let pathname = '/';
    try {
      pathname = new URL(endpoint).pathname || '/';
    } catch {
      /* 端點非標準 URL 時按契約以 / 參與簽名 */
    }
    signer('POST', pathname, body, headers);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new McpTransportError(`MCP 端點不可達（${endpoint}）：${e instanceof Error ? e.message : String(e)}`);
  }
  clearTimeout(timer);

  if (resp.status === 404 && sessionId) {
    // 工作階段已失效（服務端重啟等）：上拋由呼叫方重置重試
    throw new McpTransportError('MCP 工作階段失效（404）');
  }
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => '');
    throw new McpTransportError(`MCP 端點回應 HTTP ${resp.status}：${bodyText.slice(0, 120)}`);
  }

  const rawSession = resp.headers.get('mcp-session-id');
  if (rawSession) sessionCache.set(endpoint, rawSession);

  const contentType = resp.headers.get('content-type') ?? '';
  let bodyText = await resp.text();
  if (contentType.includes('text/event-stream')) {
    // SSE 編碼：抽取全部 data: 行逐行拼接為完整 JSON 文件
    bodyText = bodyText
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('');
  }
  if (bodyText === '' || isNotification) return null; // 通知類請求的合法空回應（202 Accepted）

  let envelope: JsonRpcEnvelope;
  try {
    envelope = JSON.parse(bodyText) as JsonRpcEnvelope;
  } catch {
    throw new McpTransportError(`MCP 回應非合法 JSON：${bodyText.slice(0, 120)}`);
  }
  if (envelope.error) {
    throw new McpTransportError(`MCP JSON-RPC 錯誤 ${envelope.error.code}：${envelope.error.message}`);
  }
  return envelope.result ?? null;
}

/**
 * 確保與目標端點完成 initialize 握手並快取工作階段
 *
 * 實測（12306-mcp @ mcp-http-server）對無工作階段請求會自動接納，
 * 此處仍按協議規範先握手——避免對其他嚴格實現的服務端產生兼容性問題。
 * 無狀態服務（如麥當勞 mcp.mcd.cn）不返回 Mc-Session-Id：以空串標記
 * 「已握手完成」，避免每次呼叫重複 initialize（遠程端點有頻控）。
 */
async function ensureSession(
  endpoint: string,
  timeoutMs: number,
  extraHeaders?: Record<string, string>,
  signer?: McpSigner,
): Promise<void> {
  if (sessionCache.has(endpoint)) return;
  await rpc(
    endpoint,
    'initialize',
    {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'micromate-cloudrun', version: '1.0.0' },
    },
    undefined,
    timeoutMs,
    extraHeaders,
    signer,
  );
  const sessionId = sessionCache.get(endpoint) ?? '';
  sessionCache.set(endpoint, sessionId);
  await rpc(endpoint, 'notifications/initialized', null, sessionId || undefined, timeoutMs, extraHeaders, signer).catch(() => undefined);
}

/**
 * 呼叫 MCP 工具並返回首個 text 內容
 *
 * @param endpoint  MCP Streamable HTTP 端點
 * @param toolName  工具名（如 "get-tickets"）
 * @param args      工具參數（原樣作為 arguments 傳遞）
 * @param timeoutMs 整體超時（預設 25 秒，覆蓋 12306 官方介面的長尾回應）
 * @param extraHeaders 額外請求頭（遠程託管 MCP 的鑑權頭，每輪攜帶——
 *   無狀態服務不綁工作階段，鑑權必須隨每次請求重複提供）
 * @param signer    請求簽名回調（飛豬等 body 綁定簽名型端點專用，可空）
 * @returns 工具輸出的 text 內容
 * @throws McpToolError      工具標記 isError=true（業務性錯誤，呼叫方應透傳）
 * @throws McpTransportError 連線層失敗（呼叫方應降級模擬）
 */
export async function callMcpTool(
  endpoint: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 25_000,
  extraHeaders?: Record<string, string>,
  signer?: McpSigner,
): Promise<string> {
  try {
    await ensureSession(endpoint, timeoutMs, extraHeaders, signer);
    const cached = sessionCache.get(endpoint);
    const result = (await rpc(endpoint, 'tools/call', { name: toolName, arguments: args }, cached || undefined, timeoutMs, extraHeaders, signer)) as
      | ToolCallResult
      | null;
    if (!result || !Array.isArray(result.content) || result.content.length === 0) {
      throw new McpTransportError(`MCP 工具 ${toolName} 回應缺少 content`);
    }
    const text = result.content.find((c) => c.type === 'text')?.text;
    if (typeof text !== 'string') {
      throw new McpTransportError(`MCP 工具 ${toolName} 回應缺少 text 內容`);
    }
    if (result.isError) {
      // 規範形態的業務性錯誤（站名不存在等）：類型化上拋供呼叫方透傳，
      // 不可混入 McpTransportError（會被呼叫方誤判為連線失敗而降級假數據）
      throw new McpToolError(`MCP 工具 ${toolName} 執行錯誤：${text.slice(0, 160)}`);
    }
    return text;
  } catch (e) {
    if (e instanceof McpTransportError && e.message.includes('工作階段失效')) {
      // 工作階段失效：清快取重握手重試一次（僅一次，避免循環）
      sessionCache.delete(endpoint);
      return callMcpTool(endpoint, toolName, args, timeoutMs, extraHeaders, signer);
    }
    throw e;
  }
}

/** 雙通道工具呼叫的完整回應（text + structuredContent） */
export interface McpToolFullResult {
  text: string;
  structured: unknown;
}

/**
 * 呼叫 MCP 工具並返回 text + structuredContent 雙通道完整結果
 *
 * 滴滴（taxi_estimate / taxi_create_order 等）在 structuredContent 攜帶
 * traceId / orderId / 車型列表等程序化欄位，content[0].text 僅為自然語言
 * 描述——需要程序化提取時用本函數取代 callMcpTool。協議行為（握手 /
 * 會話重試 / 錯誤語義）與 callMcpTool 完全一致。
 */
export async function callMcpToolStructured(
  endpoint: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 25_000,
  extraHeaders?: Record<string, string>,
  signer?: McpSigner,
): Promise<McpToolFullResult> {
  try {
    await ensureSession(endpoint, timeoutMs, extraHeaders, signer);
    const cached = sessionCache.get(endpoint);
    const result = (await rpc(endpoint, 'tools/call', { name: toolName, arguments: args }, cached || undefined, timeoutMs, extraHeaders, signer)) as
      | ToolCallResult
      | null;
    if (!result || !Array.isArray(result.content) || result.content.length === 0) {
      throw new McpTransportError(`MCP 工具 ${toolName} 回應缺少 content`);
    }
    const text = result.content.find((c) => c.type === 'text')?.text;
    if (typeof text !== 'string') {
      throw new McpTransportError(`MCP 工具 ${toolName} 回應缺少 text 內容`);
    }
    if (result.isError) {
      throw new McpToolError(`MCP 工具 ${toolName} 執行錯誤：${text.slice(0, 160)}`);
    }
    return { text, structured: result.structuredContent ?? null };
  } catch (e) {
    if (e instanceof McpTransportError && e.message.includes('工作階段失效')) {
      sessionCache.delete(endpoint);
      return callMcpToolStructured(endpoint, toolName, args, timeoutMs, extraHeaders, signer);
    }
    throw e;
  }
}
