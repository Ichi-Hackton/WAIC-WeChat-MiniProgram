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
}

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
 * @returns 回應 result；通知類請求（無 id）回傳 null
 */
async function rpc(
  endpoint: string,
  method: string,
  params: Record<string, unknown> | null,
  sessionId: string | undefined,
  timeoutMs: number,
): Promise<unknown | null> {
  const isNotification = params === null;
  const id = nextId++;
  const payload: Record<string, unknown> = { jsonrpc: '2.0', method };
  // JSON-RPC 通知（如 notifications/initialized）不得攜帶 id；帶 id 的請求才期待回應

  if (!isNotification) payload.params = params as Record<string, unknown>;
  if (!isNotification) payload.id = id;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(payload),
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
 */
async function ensureSession(endpoint: string, timeoutMs: number): Promise<void> {
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
  );
  const sessionId = sessionCache.get(endpoint);
  await rpc(endpoint, 'notifications/initialized', null, sessionId, timeoutMs).catch(() => undefined);
}

/**
 * 呼叫 MCP 工具並返回首個 text 內容
 *
 * @param endpoint  MCP Streamable HTTP 端點
 * @param toolName  工具名（如 "get-tickets"）
 * @param args      工具參數（原樣作為 arguments 傳遞）
 * @param timeoutMs 整體超時（預設 25 秒，覆蓋 12306 官方介面的長尾回應）
 * @returns 工具輸出的 text 內容
 * @throws McpToolError      工具標記 isError=true（業務性錯誤，呼叫方應透傳）
 * @throws McpTransportError 連線層失敗（呼叫方應降級模擬）
 */
export async function callMcpTool(
  endpoint: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 25_000,
): Promise<string> {
  try {
    await ensureSession(endpoint, timeoutMs);
    const result = (await rpc(endpoint, 'tools/call', { name: toolName, arguments: args }, sessionCache.get(endpoint), timeoutMs)) as
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
      return callMcpTool(endpoint, toolName, args, timeoutMs);
    }
    throw e;
  }
}
