/**
 * 票務渠道接入 REST 契約 —— 參考實作 / 本地驗證夾具
 *
 * 用途：
 *   1. 渠道方（大麥 / 秀動開放平台或聚合網關）對接「票務渠道接入
 *      REST 契約」（見 ../src/ticket-provider.ts 檔頭文檔）時的行為參考
 *   2. 本地端到端驗證：模擬一家已簽約票務平台網關，供
 *      smoke-ticket-partner.ps1 驗證 cloudrun 經 REST Provider 真實
 *      HTTP 調用第三方渠道的完整鏈路
 *
 * 實作端點（與契約逐字對齊）：
 *   GET /healthz                                  （探活，免鑒權）
 *   GET /events?keyword=&city=&type=              （Bearer 鑒權）
 *   GET /events/{eventId}                         （Bearer 鑒權；404 = 無此演出）
 *
 * 環境變數：
 *   PARTNER_PORT    監聽埠（預設 8790）
 *   PARTNER_API_KEY 要求的 Bearer 金鑰（預設 partner-test-key）
 *
 * 啟動：node scripts/ticket-partner-mock.mjs（零依賴，Node 18+）
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PARTNER_PORT ?? 8790);
const API_KEY = process.env.PARTNER_API_KEY ?? 'partner-test-key';

/** 相對今天的日期偏移 → YYYY-MM-DD（與 skill-ticket.ts 的演示目錄同構） */
function dateAfterDays(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 模擬渠道持有的演出目錄（與 cloudrun 演示目錄區隔，驗證聚合與來源標記） */
const EVENTS = [
  {
    eventId: 'ev_d101',
    name: '林俊傑 JJ20 世界巡迴演唱會-深圳站',
    type: '演唱會',
    artist: '林俊傑',
    city: '深圳',
    venue: '深圳灣體育中心「春繭」體育場',
    provider: 'damai',
    sessions: [
      {
        sessionNo: 's1',
        offsetDays: 20,
        startTime: '19:30',
        endTime: '22:30',
        tiers: [
          { tierNo: 't1', name: '看台', priceCent: 68000, inventory: 30 },
          { tierNo: 't2', name: '內場', priceCent: 168000, inventory: 20 },
          { tierNo: 't3', name: 'VIP', priceCent: 268000, inventory: 10 },
        ],
      },
      {
        sessionNo: 's2',
        offsetDays: 21,
        startTime: '19:30',
        endTime: '22:30',
        tiers: [
          { tierNo: 't1', name: '看台', priceCent: 68000, inventory: 25 },
          { tierNo: 't2', name: '內場', priceCent: 168000, inventory: 15 },
          { tierNo: 't3', name: 'VIP', priceCent: 268000, inventory: 8 },
        ],
      },
    ],
  },
];

/** 目錄定義 → 契約結構（EventSummary + SessionInfo[]，逐欄位對齊契約） */
function toSummary(def) {
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

function buildSessions(def) {
  return def.sessions
    .map((s) => ({
      sessionId: `${def.eventId}_${s.sessionNo}`,
      eventId: def.eventId,
      date: dateAfterDays(s.offsetDays),
      startTime: s.startTime,
      endTime: s.endTime,
      status: 'on_sale',
      priceTiers: s.tiers.map((t) => ({
        tierId: `${def.eventId}_${s.sessionNo}_${t.tierNo}`,
        name: t.name,
        priceCent: t.priceCent,
        inventory: t.inventory,
      })),
    }))
    .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { code: 0, message: 'ok', data: { service: 'ticket-partner-mock', time: Date.now() } });
    return;
  }

  // 契約鑒權：Authorization: Bearer {API_KEY}
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${API_KEY}`) {
    sendJson(res, 401, { code: 401, message: 'Invalid or missing Authorization Bearer key' });
    return;
  }

  if (req.method === 'GET' && path === '/events') {
    const keyword = url.searchParams.get('keyword') ?? '';
    const city = url.searchParams.get('city') ?? '';
    const type = url.searchParams.get('type') ?? '';
    let list = EVENTS;
    if (keyword) {
      list = list.filter(
        (e) => e.name.includes(keyword) || e.artist.includes(keyword) || e.venue.includes(keyword) || e.city.includes(keyword) || e.type.includes(keyword),
      );
    }
    if (city) list = list.filter((e) => e.city.includes(city));
    if (type) list = list.filter((e) => e.type.includes(type));
    sendJson(res, 200, { events: list.map(toSummary) });
    return;
  }

  const detail = path.match(/^\/events\/([^/]+)$/);
  if (req.method === 'GET' && detail) {
    const eventId = decodeURIComponent(detail[1]);
    const def = EVENTS.find((e) => e.eventId === eventId);
    if (!def) {
      // 契約 404 語義：無此演出（Provider 適配器映射為 null，交由下一渠道）
      sendJson(res, 404, { code: 404, message: `event not found: ${eventId}` });
      return;
    }
    sendJson(res, 200, { event: toSummary(def), sessions: buildSessions(def) });
    return;
  }

  sendJson(res, 404, { code: 404, message: `no route: ${req.method} ${path}` });
});

server.listen(PORT, () => {
  console.log(`[ticket-partner-mock] 契約參考服務已啟動，監聽埠 ${PORT}（金鑰 ${API_KEY}）`);
});
