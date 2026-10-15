// 麥當勞 MCP（mcp.mcd.cn）就緒探針（裸 HTTP JSON-RPC，零第三方依賴）
//
// 背景：麥當勞中國遠程託管 MCP Server（Streamable HTTP + Bearer Token 鑑權，
//       限流 600 次/分）。接入前需摸清：① 是否要求 initialize 握手與會話頭；
//       ② tools/list 各工具 inputSchema（下單鏈路參數契約）；③ 回應編碼
//       （JSON 單體還是 SSE 流）。
//
// 用法：
//   node cloudrun/scripts/mcd-probe.mjs <token>                # 握手 + tools/list
//   node cloudrun/scripts/mcd-probe.mjs <token> <tool> [JSON]  # 再試調一個工具
// 就緒退出碼 0，否則 1。
const token = process.argv[2];
if (!token) {
  console.error('用法：node mcd-probe.mjs <token> [tool] [argsJson]');
  process.exit(1);
}
const base = 'https://mcp.mcd.cn';
const PROTOCOL_VERSION = '2025-03-26';

const authHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: `Bearer ${token}`,
};

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
  // 1. initialize 握手（帶 Bearer），取 session id
  const initRes = await withTimeout(fetch(base, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'micromate-probe', version: '0.0.1' } },
    }),
  }), 15_000, 'initialize');
  if (!initRes.ok) throw new Error(`initialize HTTP ${initRes.status}: ${(await initRes.text()).slice(0, 200)}`);
  const initMsg = parseRpcMessage(initRes.headers.get('content-type') ?? '', await initRes.text());
  if (initMsg.error) throw new Error(`initialize 被拒: ${JSON.stringify(initMsg.error)}`);
  const sessionId = initRes.headers.get('mcp-session-id');
  const serverInfo = initMsg.result?.serverInfo ?? {};
  console.log(`[probe] initialize OK：server=${serverInfo.name ?? '?'} v${serverInfo.version ?? '?'}；content-type=${initRes.headers.get('content-type') ?? '?'}；session=${sessionId ? '有' : '無'}`);

  const callHeaders = { ...authHeaders, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) };

  // 2. initialized 通知
  await withTimeout(fetch(base, {
    method: 'POST', headers: callHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }), 15_000, 'initialized').catch(() => undefined);

  // 3. tools/list：輸出全部工具名 + inputSchema
  const listRes = await withTimeout(fetch(base, {
    method: 'POST', headers: callHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  }), 15_000, 'tools/list');
  if (!listRes.ok) throw new Error(`tools/list HTTP ${listRes.status}: ${(await listRes.text()).slice(0, 200)}`);
  const listMsg = parseRpcMessage(listRes.headers.get('content-type') ?? '', await listRes.text());
  if (listMsg.error) throw new Error(`tools/list 被拒: ${JSON.stringify(listMsg.error)}`);
  const tools = listMsg.result?.tools ?? [];
  console.log(`[probe] tools/list OK：共 ${tools.length} 個工具`);
  for (const t of tools) {
    console.log(`\n=== ${t.name} ===`);
    console.log((t.description ?? '').slice(0, 200));
    console.log('inputSchema:', JSON.stringify(t.inputSchema ?? {}));
  }

  // 4. 可選：試調指定工具
  const tool = process.argv[3];
  if (tool) {
    const args = process.argv[4] ? JSON.parse(process.argv[4]) : {};
    const callRes = await withTimeout(fetch(base, {
      method: 'POST', headers: callHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: args } }),
    }), 30_000, `tools/call ${tool}`);
    console.log(`\n[probe] tools/call ${tool} HTTP ${callRes.status}`);
    const raw = await callRes.text();
    const ct = callRes.headers.get('content-type') ?? '';
    let msg;
    try {
      msg = parseRpcMessage(ct, raw);
    } catch {
      console.log('（非 JSON-RPC 回應）', raw.slice(0, 500));
      process.exit(callRes.ok ? 0 : 1);
    }
    const text = (msg.result?.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('');
    console.log(`isError=${msg.result?.isError ?? false}`);
    console.log(text.slice(0, 3000));
    if (msg.error) console.log('JSON-RPC error:', JSON.stringify(msg.error));
    process.exit(msg.result?.isError || msg.error ? 1 : 0);
  }
  process.exit(0);
} catch (e) {
  console.error(`[probe] 失敗：${e && e.message}`);
  process.exit(1);
}
