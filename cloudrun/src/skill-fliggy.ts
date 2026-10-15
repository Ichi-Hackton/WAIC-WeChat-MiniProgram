/**
 * 飛豬旅行 SKILL 端點（2026-10 國民級 App MCP 接入）
 *
 * 端點（與小程序端 travel-fliggy SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.travel.fliggy/search_hotels —— 結構化酒店搜索
 *   POST /api/skill/skill.travel.fliggy/ai_search      —— 自然語言全域旅行搜索
 *
 * 資料來源（飛豬官方 FlyAI MCP，https://flyai.open.fliggy.com/mcp，
 * Streamable HTTP + JSON-RPC 2.0 + HMAC-SHA256 請求簽名）：
 *   - search_hotels    ：目的地 / 景點 / 日期 / 星級 / 床型結構化搜索 → itemList
 *   - fliggy_ai_search ：自然語言語義搜索（酒店 / 景點 / 航班 / 火車混合
 *     意圖），回應為上游 LLM 生成的 Markdown 推薦文本（合規：小程序側
 *     卡片需帶 ai_generated 標識，見 Agent.md § 10）
 *   - search_flight / search_domestic_train 與既有 flight / 12306 域
 *     重疊，不接入（規劃器以域互斥路由）
 *
 * 鑑權分層（與 mcd / luckin / didi 的「未配置憑證即降級 mock」不同）：
 *   FlyAI 內置公共 API Key（體驗模式）隨 CLI 公開發行（@fly-ai/flyai-cli
 *   bundle 內置），未配置 FLIGGY_API_KEY 時直接使用——即開箱真實數據，
 *   價格脫敏（如 ¥5xx）、結果條數受限；正式 Key 在 flyai.open.fliggy.com
 *   #playground 登錄自助獲取，以 FLIGGY_API_KEY / FLIGGY_SIGN_SECRET 覆蓋。
 *
 * 簽名契約（逆向 @fly-ai/flyai-cli@1.0.16 還原，2026-10-14 實測驗證）：
 *   Authorization: Bearer <key>
 *   x-flyai-sign-ver: 7 / x-flyai-sign-alg: hmac-sha256
 *   x-flyai-ts / x-flyai-nonce / x-flyai-sign
 *   簽名串 = "POST\n{pathname}\n{ts}\n{nonce}\n{sha256hex(body)}\n{sha256hex(auth)}"
 *   x-flyai-sign = HMAC-SHA256(secret, 簽名串).base64url()
 *   簽名覆蓋最終請求體 → 經 mcp-client.ts 的 McpSigner 回調在序列化後注入
 *
 * 回應包絡（content[0].text 內嵌 JSON）：
 *   {"status":0,"message":"success","data":{itemList:[...]},"systemMessage":"體驗模式提示"}
 *   status≠0 為業務失敗（透傳）；systemMessage 透傳為 notice（體驗模式標註）
 *
 * 只讀查詢域（飛猪 MCP 本期僅開放搜索）：無下單、無訂單落庫、無 rollback。
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { RouteHandler } from './api';
import { ok, fail, badRequest } from './api';
import { callMcpTool, McpToolError, type McpSigner } from './mcp-client';

/** 飛豬 FlyAI MCP 端點（可用 FLIGGY_MCP_URL 覆蓋，如代理位址） */
const FLIGGY_MCP_URL = process.env.FLIGGY_MCP_URL ?? 'https://flyai.open.fliggy.com/mcp';

/**
 * 內置公共 Key（體驗模式）：隨 @fly-ai/flyai-cli 公開發行的開箱憑證，
 * 價格脫敏 / 結果受限；正式 Key 以 FLIGGY_API_KEY 覆蓋解鎖
 *
 * 空白歸一：.env.local 的空值（KEY=）經 dev-start 讀入後為空字串，
 * ?? 不處理空串——按 flyai-cli 同款口徑 trim 後為空即回退內置值，
 * 否則會以空密鑰簽名導致全部請求 401
 */
const FLIGGY_API_KEY =
  process.env.FLIGGY_API_KEY?.trim() || 'sk-faRn8Kp2QzXvLm9YtA4EjHcWbS7oUdG5iF3xNqV6rZ';

/** 簽名密鑰（與 Key 配套發行；正式環境以 FLIGGY_SIGN_SECRET 覆蓋） */
const FLIGGY_SIGN_SECRET =
  process.env.FLIGGY_SIGN_SECRET?.trim() || 'XSbdYnucPARDc9knhD8+X6hxdD1Nh6ZGI6Hadg25kBw=';

/** 單次上游工具調用超時（ai_search 為上游 LLM 生成，長尾可達 10s+） */
const FLIGGY_TIMEOUT_MS = 30_000;

/** 基礎鑑權頭（簽名頭由 McpSigner 補齊） */
function fliggyAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${FLIGGY_API_KEY}`,
    'x-ttid': 'ai2c(micromate)',
    'User-Agent': 'micromate-cloudrun/1.0.0',
  };
}

/** 請求簽名回調：注入 x-flyai-* 五頭（材料含最終 body 與時間戳） */
const fliggySigner: McpSigner = (method, pathname, body, headers) => {
  const auth = headers.Authorization ?? '';
  const ts = Date.now().toString();
  const nonce = randomBytes(16).toString('hex');
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const authHash = createHash('sha256').update(auth, 'utf8').digest('hex');
  const payload = `${method}\n${pathname}\n${ts}\n${nonce}\n${bodyHash}\n${authHash}`;
  const sign = createHmac('sha256', FLIGGY_SIGN_SECRET).update(payload, 'utf8').digest('base64url');
  headers['x-flyai-sign-ver'] = '7';
  headers['x-flyai-sign-alg'] = 'hmac-sha256';
  headers['x-flyai-ts'] = ts;
  headers['x-flyai-nonce'] = nonce;
  headers['x-flyai-sign'] = sign;
};

/** 上游回應包絡（content[0].text 內嵌 JSON；僅聲明用到的欄位） */
interface FliggyEnvelope {
  status?: number;
  message?: string;
  data?: unknown;
  systemMessage?: string;
}

/** 解包 content[0].text 並校驗業務碼（status≠0 視為業務失敗） */
function unwrapFliggy(text: string): { data: unknown; notice: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new McpToolError(`飛豬回應無法解析：${text.slice(0, 160)}`);
  }
  const env = parsed as FliggyEnvelope;
  if (typeof env.status === 'number' && env.status !== 0) {
    throw new McpToolError(`飛豬業務失敗（status ${env.status}）：${String(env.message ?? '').slice(0, 160)}`);
  }
  return { data: env.data, notice: env.systemMessage ?? '' };
}

/* ==================== search_hotels ==================== */

interface SearchHotelsInput {
  destName?: string;
  poiName?: string;
  keyWords?: string;
  checkInDate?: string;
  checkOutDate?: string;
  hotelStars?: string;
  hotelBedTypes?: string;
  hotelTypes?: string;
  maxPrice?: number;
  sort?: string;
  limit?: number;
}

/** itemList 單條酒店（僅聲明用到的欄位） */
interface FliggyHotelItem {
  name?: string;
  address?: string;
  price?: string;
  star?: string;
  shId?: string | number;
  detailUrl?: string;
  interestsPoi?: string;
  rate?: string | number;
}

const handleSearchHotels: RouteHandler = async (body) => {
  const input = (body ?? {}) as SearchHotelsInput;
  if (!input.destName) {
    return badRequest('destName 必填（目的地：國家 / 省 / 市 / 區縣）');
  }

  // 上游參數白名單過濾（僅透傳契約欄位，undefined 自然剔除）
  const args: Record<string, unknown> = { destName: input.destName };
  if (input.poiName) args.poiName = input.poiName;
  if (input.keyWords) args.keyWords = input.keyWords;
  if (input.checkInDate) args.checkInDate = input.checkInDate;
  if (input.checkOutDate) args.checkOutDate = input.checkOutDate;
  if (input.hotelStars) args.hotelStars = input.hotelStars;
  if (input.hotelBedTypes) args.hotelBedTypes = input.hotelBedTypes;
  if (input.hotelTypes) args.hotelTypes = input.hotelTypes;
  if (typeof input.maxPrice === 'number') args.maxPrice = input.maxPrice;
  if (input.sort) args.sort = input.sort;
  if (typeof input.limit === 'number') args.limit = Math.min(Math.max(input.limit, 1), 20);

  try {
    const text = await callMcpTool(
      FLIGGY_MCP_URL,
      'search_hotels',
      args,
      FLIGGY_TIMEOUT_MS,
      fliggyAuthHeaders(),
      fliggySigner,
    );
    const { data, notice } = unwrapFliggy(text);
    const items = ((data as { itemList?: unknown[] })?.itemList ?? []) as FliggyHotelItem[];
    return ok({
      hotels: items.map((h) => ({
        name: h.name ?? '',
        address: h.address ?? '',
        priceText: h.price ?? '',
        star: h.star ?? '',
        shId: h.shId != null ? String(h.shId) : '',
        detailUrl: h.detailUrl ?? '',
        interestsPoi: h.interestsPoi ?? '',
        rate: h.rate != null ? String(h.rate) : '',
      })),
      query: args,
      notice,
      source: 'fliggy_mcp_realtime',
    });
  } catch (e) {
    if (e instanceof McpToolError) return fail(503, e.message.slice(0, 200));
    console.error('[skill-fliggy] 飛豬酒店搜索不可用：', e instanceof Error ? e.message : e);
    return fail(502, '飛豬服務暫不可用，請稍後再試');
  }
};

/* ==================== ai_search ==================== */

interface AiSearchInput {
  query?: string;
}

const handleAiSearch: RouteHandler = async (body) => {
  const input = (body ?? {}) as AiSearchInput;
  if (!input.query) {
    return badRequest('query 必填（自然語言旅行意圖，如「西湖附近性價比高的酒店」）');
  }

  try {
    const text = await callMcpTool(
      FLIGGY_MCP_URL,
      'fliggy_ai_search',
      { query: input.query },
      FLIGGY_TIMEOUT_MS,
      fliggyAuthHeaders(),
      fliggySigner,
    );
    const { data, notice } = unwrapFliggy(text);
    const answer = typeof data === 'string' ? data : '';
    if (!answer) {
      return fail(502, '飛豬 AI 搜索回應缺少推薦文本（結構異常）');
    }
    return ok({
      answer,
      // 合規紅線（Agent.md § 10）：上游 LLM 生成內容，卡片側必須帶 ai_generated 標識
      aiGenerated: true,
      notice,
      source: 'fliggy_mcp_realtime',
    });
  } catch (e) {
    if (e instanceof McpToolError) return fail(503, e.message.slice(0, 200));
    console.error('[skill-fliggy] 飛豬 AI 搜索不可用：', e instanceof Error ? e.message : e);
    return fail(502, '飛豬服務暫不可用，請稍後再試');
  }
};

export const fliggyRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.travel.fliggy/search_hotels', handleSearchHotels],
  ['POST /api/skill/skill.travel.fliggy/ai_search', handleAiSearch],
];
