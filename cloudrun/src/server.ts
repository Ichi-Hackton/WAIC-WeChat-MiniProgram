/**
 * MicroMate 雲托管服務入口
 *
 * 職責：
 *   1. 監聽 PORT 環境變數指定的埠（微信雲托管要求，預設 80）
 *   2. JSON body 解析（上限 1MB）
 *   3. 路由分發（路由表由各 handler 模組以 entries 形式註冊）
 *   4. 健康檢查（GET / 與 /healthz，供雲托管探活）
 *
 * 零運行時依賴：僅使用 Node 內建模組（node:http），LLM 呼叫用 Node 18+ 內建 fetch。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import type { CloudResponse, RequestContext, RouteHandler } from './api';
import { llmRoutes } from './llm-chat';
import { trainRoutes } from './skill-train';
import { coffeeRoutes } from './skill-coffee';
import { shoppingRoutes } from './skill-shopping';
import { bookingRoutes } from './skill-booking';

/** 請求 body 大小上限（位元組） */
const MAX_BODY_BYTES = 1024 * 1024;

/** dev-log 落盤檔案大小上限（50MB，超出即跳過寫入，防無界增長耗盡容器磁碟） */
const MAX_DEV_LOG_BYTES = 50 * 1024 * 1024;

/** 路由表：key = `METHOD /path`，各模組以 entries 陣列貢獻路由 */
const routes = new Map<string, RouteHandler>([
  ...llmRoutes,
  ...trainRoutes,
  ...coffeeRoutes,
  ...shoppingRoutes,
  ...bookingRoutes,
]);

/** 雲端日誌（stdout，由雲托管日誌系統收集） */
function log(msg: string): void {
  console.log(`[cloudrun] ${new Date().toISOString()} ${msg}`);
}

/** 讀取並解析 JSON body（空 body 解析為 undefined） */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', (e) => reject(e));
  });
}

/** 統一 JSON 回應 */
function sendJson(res: ServerResponse, status: number, body: CloudResponse): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** 從請求頭取字串值（headers 值可能為陣列，取第一個） */
function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
}

const server = createServer((req, res) => {
  void handle(req, res);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = (req.url ?? '/').split('?')[0];

  // 健康檢查（雲托管探活）
  if (method === 'GET' && (url === '/' || url === '/healthz')) {
    sendJson(res, 200, {
      code: 0,
      message: 'ok',
      data: { service: 'micromate-cloudrun', time: Date.now() },
    });
    return;
  }

  // ---- 開發驗證用：小程序端日誌旁路落盤 ----
  // 小程序端 logger 經 wx.request 逐條上報（僅 develop / trial 環境安裝
  // sink，見 miniprogram/src/app.ts），落盤 logs/dev-log.txt 供自動化
  // 驗證取證——徹底繞開開發者工具 Console 面板「Copy all messages
  // 不可用 / OCR 轉錄漏行」的痛點。
  //
  // 安全門控（生產容器不啟用）：ENABLE_DEV_LOG 未設 '1' 時按 404 處理，
  // 端點在生產暴露面內不存在（否則無鑑權寫入可被高頻灌入耗盡磁碟/IO）；
  // 本地 dev-start.ps1 啟動時自動注入該變數。容量保護：檔案超過 50MB
  // 跳過寫入。同步寫入僅限本地驗證量級（每輪數十條，可接受）；單條
  // msg 截 2000 字元 + 剝離換行（防日誌注入，客戶端已處理一次，雙保險）。
  if (method === 'POST' && url === '/api/dev-log') {
    if (process.env.ENABLE_DEV_LOG !== '1') {
      sendJson(res, 404, { code: 404, message: `無此路由：${method} ${url}` });
      return;
    }
    try {
      const body = (await readBody(req)) as { level?: unknown; msg?: unknown; ts?: unknown } | undefined;
      const ts = typeof body?.ts === 'number' ? body.ts : Date.now();
      const level = String(body?.level ?? 'info').slice(0, 8);
      const msg = String(body?.msg ?? '').replace(/[\r\n]+/g, ' ').slice(0, 2000);
      mkdirSync('logs', { recursive: true });
      let sizeOk = true;
      try {
        sizeOk = statSync('logs/dev-log.txt').size < MAX_DEV_LOG_BYTES;
      } catch {
        sizeOk = true; // 檔案尚不存在，視為可寫
      }
      if (sizeOk) {
        appendFileSync('logs/dev-log.txt', `${new Date(ts).toISOString()} [${level}] ${msg}\n`, 'utf8');
      }
      sendJson(res, 200, { code: 0, message: 'ok' });
    } catch {
      // 取證端點失敗不回 5xx：客戶端 fire-and-forget，靜默即可
      sendJson(res, 200, { code: 0, message: 'dev-log write failed (ignored)' });
    }
    return;
  }

  const handler = routes.get(`${method} ${url}`);
  if (!handler) {
    sendJson(res, 404, { code: 404, message: `無此路由：${method} ${url}` });
    return;
  }

  const ctx: RequestContext = {
    openid: headerStr(req, 'x-wx-openid'),
    sessionId: headerStr(req, 'x-micromate-session'),
  };

  try {
    const body = await readBody(req);
    log(`${method} ${url} session=${ctx.sessionId ?? '-'} openid=${ctx.openid ?? '-'}`);
    const result = await handler(body, ctx);
    sendJson(res, result.httpStatus, result.body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`${method} ${url} 異常：${msg}`);
    if (msg === 'PAYLOAD_TOO_LARGE') {
      sendJson(res, 413, { code: 413, message: '請求體過大（上限 1MB）' });
      return;
    }
    if (msg === 'INVALID_JSON') {
      sendJson(res, 400, { code: 400, message: '請求體必須為合法 JSON' });
      return;
    }
    sendJson(res, 500, { code: 500, message: '內部錯誤' });
  }
}

const PORT = Number(process.env.PORT ?? 80);
server.listen(PORT, () => {
  log(`MicroMate 雲托管服務已啟動，監聽埠 ${PORT}（路由數 ${routes.size}）`);
});
