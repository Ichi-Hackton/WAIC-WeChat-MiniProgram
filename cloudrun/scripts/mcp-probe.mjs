// 12306-mcp 就緒探針（裸 HTTP JSON-RPC，零第三方依賴）
//
// 背景：MCP 進程「埠在監聽」≠「站名表已載入」——官網風控下站名表可能為空，
//       服務存活但所有查詢報 Station not found。必須真實調用一次站名工具驗證。
//       不用 @modelcontextprotocol/sdk 客戶端：其內建協議版本可能比服務端
//       （mcp-http-server）支援的更新，握手即被拒；此處顯式指定相容版本。
//
// 判定：initialize 握手 → 調用 get-stations-code-in-city（city=北京），
//       結果包含北京站電報碼 BJP 且不含 "Error" 即視為就緒。
//
// 用法：node cloudrun/scripts/mcp-probe.mjs [port]    （默認 3001；就緒退出碼 0，否則 1）
const port = process.argv[2] ?? '3001';
const base = `http://127.0.0.1:${port}/mcp`;
// 服務端已明確列出的支援版本（2025-06-18 為其最新）
const PROTOCOL_VERSION = '2025-06-18';

const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超時 ' + label)), ms))]);

/** Streamable HTTP 回應體可能是 JSON 也可能是 SSE 流，統一抽取第一個 JSON-RPC 訊息 */
function parseRpcMessage(contentType, text) {
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data) return JSON.parse(data);
      }
    }
    throw new Error('SSE 回應中無 data 訊息');
  }
  return JSON.parse(text);
}

try {
  // 1. initialize 握手，取 session id
  const initRes = await withTimeout(fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'micromate-probe', version: '0.0.1' } },
    }),
  }), 8000, 'initialize');
  if (!initRes.ok) throw new Error(`initialize HTTP ${initRes.status}: ${(await initRes.text()).slice(0, 200)}`);
  const initMsg = parseRpcMessage(initRes.headers.get('content-type') ?? '', await initRes.text());
  if (initMsg.error) throw new Error(`initialize 被拒: ${JSON.stringify(initMsg.error)}`);
  const sessionId = initRes.headers.get('mcp-session-id');
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };

  // 2. initialized 通知（Streamable HTTP 常規要求）
  await withTimeout(fetch(base, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }), 8000, 'initialized');

  // 3. 真實調用站名工具驗證站名表
  const callRes = await withTimeout(fetch(base, {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get-stations-code-in-city', arguments: { city: '北京' } },
    }),
  }), 15000, 'tools/call');
  if (!callRes.ok) throw new Error(`tools/call HTTP ${callRes.status}: ${(await callRes.text()).slice(0, 200)}`);
  const callMsg = parseRpcMessage(callRes.headers.get('content-type') ?? '', await callRes.text());
  if (callMsg.error) throw new Error(`tools/call 被拒: ${JSON.stringify(callMsg.error)}`);
  const text = (callMsg.result?.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');

  if (text.includes('Error') || !text.includes('BJP')) {
    throw new Error(`站名表未就緒：${text.slice(0, 200)}`);
  }
  const count = text.split('station_code').length - 1;
  console.log(`[probe] 就緒：北京站解析正常（BJP），返回 ${count} 個車站`);
} catch (e) {
  console.error(`[probe] 失敗：${e && e.message}`);
  process.exitCode = 1;
}
