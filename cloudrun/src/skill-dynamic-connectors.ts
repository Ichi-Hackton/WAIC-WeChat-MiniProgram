/**
 * 動態技能連接器註冊表 — 服務端預註冊唯讀外部接口（L2 通用執行器的信任邊界）
 *
 * 安全模型（對應計劃紅線）：
 *   - 用戶 / LLM 只能引用 connectorId，永遠不能自帶 URL / 工具名——
 *     外呼目標全部由運維經環境變數預註冊（可審計、可回滾）
 *   - http 連接器：固定 GET、禁重定向、DNS 解析全量公網校驗、
 *     自訂 lookup 綁定連線 IP（防 DNS rebinding TOCTOU）、回應 256KB 上限
 *   - mcp 連接器：調用前做同款位址校驗；allowPrivate=true 僅限
 *     運維顯式標記的內網 MCP（如容器內 12306-mcp）
 *
 * 環境變數 DYNAMIC_SKILL_CONNECTORS（JSON 陣列；解析失敗或單條非法
 * 則跳過該條並記 ERROR，不阻斷啟動）：
 *   [
 *     {"kind":"http","id":"http.lunar","name":"萬年曆","description":"按日期查農曆",
 *      "urlTemplate":"https://api.example.com/lunar?date={date}",
 *      "outFields":[{"key":"data.lunar","label":"農曆"}]},
 *     {"kind":"mcp","id":"mcp.12306","name":"12306 餘票","description":"官方餘票",
 *      "url":"http://127.0.0.1:3001/mcp","tool":"get-tickets",
 *      "outFields":[{"key":"tickets.0.train_no","label":"車次"}],"allowPrivate":true}
 *   ]
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';

/** http 連接器：{param} 佔位模板（GET 固定；佔位值逐個 URL 編碼） */
export interface HttpConnectorConfig {
  kind: 'http';
  id: string;
  name: string;
  description: string;
  urlTemplate: string;
  outFields: Array<{ key: string; label: string }>;
}

/** mcp 連接器：轉發至 MCP 工具（入參即受 schema 校驗後的純量表） */
export interface McpConnectorConfig {
  kind: 'mcp';
  id: string;
  name: string;
  description: string;
  url: string;
  tool: string;
  outFields: Array<{ key: string; label: string }>;
  /** 允許私網 / 回環位址（僅運維標記的內網 MCP；http 連接器一律不允許） */
  allowPrivate?: boolean;
}

export type ConnectorConfig = HttpConnectorConfig | McpConnectorConfig;

/** SSRF 防護 / 上游失敗的統一錯誤（kind 供路由層翻譯業務碼） */
export class HttpFetchError extends Error {
  readonly kind: 'invalid_url' | 'private_address' | 'redirect' | 'bad_status' | 'timeout' | 'upstream';
  readonly status?: number;
  constructor(kind: HttpFetchError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'HttpFetchError';
    this.kind = kind;
    this.status = status;
  }
}

/** 連接器 id 合法性：小寫字母開頭主段，點分隔子段可數字開頭（如 mcp.12306） */
const CONNECTOR_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){0,3}$/;

/** 欄位路徑（點號分段，支援陣列下標） */
const FIELD_KEY_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

/** 已解析連接器表（id → config；解析時過濾非法條目） */
let connectors: Map<string, ConnectorConfig> | null = null;

/** 解析 outFields（1-6 條；key 點號路徑 ≤80 字；label ≤12 字） */
function parseOutFields(raw: unknown, connId: string): Array<{ key: string; label: string }> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 6) return null;
  const out: Array<{ key: string; label: string }> = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') return null;
    const key = (f as Record<string, unknown>).key;
    const label = (f as Record<string, unknown>).label;
    if (typeof key !== 'string' || !FIELD_KEY_RE.test(key) || key.length > 80) return null;
    if (typeof label !== 'string' || label.length === 0 || label.length > 12) return null;
    out.push({ key, label });
  }
  void connId;
  return out;
}

/** 解析環境變數為連接器表（單條非法跳過；全部非法則空表） */
function parseConnectors(): Map<string, ConnectorConfig> {
  const map = new Map<string, ConnectorConfig>();
  const raw = process.env.DYNAMIC_SKILL_CONNECTORS;
  if (!raw) return map;
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    console.error(`[skill-dynamic] DYNAMIC_SKILL_CONNECTORS JSON 解析失敗（全部連接器不可用）：${e instanceof Error ? e.message : String(e)}`);
    return map;
  }
  if (!Array.isArray(arr)) {
    console.error('[skill-dynamic] DYNAMIC_SKILL_CONNECTORS 必須為 JSON 陣列（全部連接器不可用）');
    return map;
  }
  for (const item of arr) {
    const parsed = parseOneConnector(item);
    if (parsed) {
      if (map.has(parsed.id)) {
        console.error(`[skill-dynamic] 連接器 id 重複，跳過：${parsed.id}`);
        continue;
      }
      map.set(parsed.id, parsed);
    }
  }
  return map;
}

/** 單條連接器解析與校驗（非法回 null 並記日誌） */
function parseOneConnector(item: unknown): ConnectorConfig | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const id = o.id;
  const name = o.name;
  const description = o.description;
  if (typeof id !== 'string' || !CONNECTOR_ID_RE.test(id)) {
    console.error(`[skill-dynamic] 連接器 id 不合法，跳過：${String(id)}`);
    return null;
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > 24) return skip(id, 'name');
  if (typeof description !== 'string' || description.length === 0 || description.length > 120) return skip(id, 'description');
  const outFields = parseOutFields(o.outFields, id);
  if (!outFields) return skip(id, 'outFields');
  if (o.kind === 'http') {
    const urlTemplate = o.urlTemplate;
    if (typeof urlTemplate !== 'string' || !/^https?:\/\//.test(urlTemplate) || urlTemplate.length > 500) {
      return skip(id, 'urlTemplate');
    }
    return { kind: 'http', id, name, description, urlTemplate, outFields };
  }
  if (o.kind === 'mcp') {
    const url = o.url;
    const tool = o.tool;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || url.length > 500) return skip(id, 'url');
    if (typeof tool !== 'string' || tool.length === 0 || tool.length > 64) return skip(id, 'tool');
    const allowPrivate = o.allowPrivate === true ? true : undefined;
    return { kind: 'mcp', id, name, description, url, tool, outFields, ...(allowPrivate ? { allowPrivate } : {}) };
  }
  return skip(id, 'kind');
}

function skip(id: string, field: string): null {
  console.error(`[skill-dynamic] 連接器「${id}」欄位 ${field} 不合法，跳過`);
  return null;
}

/** 確保已解析（惰性一次；環境變數變化需 resetConnectorCache） */
function ensureParsed(): Map<string, ConnectorConfig> {
  if (!connectors) connectors = parseConnectors();
  return connectors;
}

/** 按 id 取連接器（不存在回 null） */
export function getConnector(id: string): ConnectorConfig | null {
  return ensureParsed().get(id) ?? null;
}

/** center 展示用公開清單（不含 url / tool 等內部細節） */
export function listConnectorsPublic(): Array<{ id: string; name: string; kind: 'http' | 'mcp'; description: string }> {
  return Array.from(ensureParsed().values()).map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    description: c.description,
  }));
}

/** 重置解析快取（測試 / 運維腳本變更環境變數後用） */
export function resetConnectorCache(): void {
  connectors = null;
}

// ---- 位址合法性（SSRF 核心） ----

/** IPv4 字面量判定 */
function isIPv4Literal(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/** IPv4 是否公網（拒絕私網 / 回環 / 鏈路本地 / 保留 / 組播段） */
function isPublicIPv4(ip: string): boolean {
  const a = ip.split('.').map(Number) as [number, number, number, number];
  const [b1, b2] = a;
  if (b1 === 0 || b1 === 10 || b1 === 127) return false; // 本網 / 私網 / 回環
  if (b1 === 169 && b2 === 254) return false; // 鏈路本地（含雲 metadata 169.254.169.254）
  if (b1 === 172 && b2 >= 16 && b2 <= 31) return false; // 私網
  if (b1 === 192 && b2 === 168) return false; // 私網
  if (b1 === 100 && b2 >= 64 && b2 <= 127) return false; // CGNAT
  if (b1 === 192 && (b2 === 0 || b2 === 88)) return false; // 192.0.0/24 / 192.88.99
  if (b1 === 198 && (b2 === 18 || b2 === 19 || b2 === 51)) return false; // 基準 / 保留
  if (b1 === 203 && b2 === 0) return false; // 203.0.113 TEST-NET-3
  if (b1 >= 224) return false; // 組播 / 保留 / 廣播
  return true;
}

/** IPv6 是否公網（拒絕回環 / 未指定 / ULA / 鏈路本地 / v4 映射私網 / 文檔段） */
function isPublicIPv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return false; // 回環 / 未指定
  const v4mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isPublicIPv4(v4mapped[1]); // v4 映射位址按 v4 規則
  if (s.startsWith('fc') || s.startsWith('fd')) return false; // fc00::/7 ULA
  if (/^fe[89ab]/.test(s)) return false; // fe80::/10 鏈路本地
  if (s.startsWith('2001:db8')) return false; // 文檔專用段
  return true;
}

/** IP 字面量（v4 / v6）是否公網 */
export function isPublicIpLiteral(host: string): boolean {
  if (isIPv4Literal(host)) return isPublicIPv4(host);
  if (host.includes(':')) return isPublicIPv6(host); // 含冒號即視為 v6 字面量
  return false; // 非字面量（域名）由呼叫方走 DNS 校驗
}

/**
 * DNS 位址校驗：解析全部 A / AAAA 記錄，任一私網即拒絕（防混合記錄繞過）
 * 回傳首個可用位址供綁定連線（防 rebinding：校驻與連線使用同一解析結果）
 */
async function resolvePublicAddress(hostname: string, allowPrivate: boolean): Promise<LookupAddress> {
  if (allowPrivate) {
    const all = await new Promise<LookupAddress[]>((resolve, reject) => {
      dnsLookup(hostname, { all: true }, (err, addresses) => {
        if (err) reject(err);
        else resolve(addresses as LookupAddress[]);
      });
    });
    if (all.length === 0) throw new HttpFetchError('upstream', 'DNS 無解析結果');
    return all[0];
  }
  const all = await new Promise<LookupAddress[]>((resolve, reject) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses as LookupAddress[]);
    });
  });
  for (const addr of all) {
    if (!isPublicIpLiteral(addr.address)) {
      throw new HttpFetchError('private_address', `目標域名解析到內網位址，已阻斷（SSRF 防護）`);
    }
  }
  if (all.length === 0) throw new HttpFetchError('upstream', 'DNS 無解析結果');
  return all[0];
}

/** mcp 連接器調用前的位址校驗（拒絕私網除非 allowPrivate；TOCTOU 窗口由運維信任面覆蓋） */
export async function assertMcpEndpointAllowed(conn: McpConnectorConfig): Promise<void> {
  const u = new URL(conn.url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIPv4Literal(host) || host.includes(':')) {
    if (!conn.allowPrivate && !isPublicIpLiteral(host)) {
      throw new HttpFetchError('private_address', `MCP 端點為內網位址且未標記 allowPrivate，已阻斷`);
    }
    return;
  }
  await resolvePublicAddress(host, conn.allowPrivate === true);
}

// ---- SSRF 安全 HTTP GET（http 連接器專用） ----

/** 回應位元組上限（256KB） */
const MAX_RESPONSE_BYTES = 256 * 1024;

/** 連線 / 整體超時（毫秒） */
const HTTP_TIMEOUT_MS = 8_000;

/**
 * 受防護的 HTTP GET：
 *   1. {param} 佔位替換（值逐個 URL 編碼；未知佔位即拒絕）
 *   2. URL 靜態校驗（http/https、無 userinfo、無 fragment）
 *   3. IP 字面量即刻校驗；域名經自訂 lookup 校驗並綁定該次解析的位址
 *      （連線層不再二次解析，關閉 DNS rebinding 競態窗口）
 *   4. 3xx 一律拒絕（不跟隨重定向）；≥400 回 bad_status
 */
export function httpGetSafe(
  conn: HttpConnectorConfig,
  params: Record<string, string | number | boolean>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    // 1. 佔位替換：{name} 必須在已宣告參數中
    let urlStr: string;
    try {
      urlStr = conn.urlTemplate.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
        const v = params[name];
        if (v === undefined) throw new HttpFetchError('invalid_url', `URL 模板佔位「${name}」缺少參數值`);
        return encodeURIComponent(String(v));
      });
    } catch (e) {
      reject(e instanceof Error ? e : new HttpFetchError('invalid_url', 'URL 模板替換失敗'));
      return;
    }
    // 2. 靜態校驗
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch {
      reject(new HttpFetchError('invalid_url', 'URL 格式非法'));
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new HttpFetchError('invalid_url', '僅允許 http / https 協議'));
      return;
    }
    if (u.username || u.password || u.hash) {
      reject(new HttpFetchError('invalid_url', 'URL 不允許攜帶憑證或片段'));
      return;
    }
    const host = u.hostname.replace(/^\[|\]$/g, '');

    // 3a. IP 字面量：即刻校驗（http 連接器永不允许私網，與 allowPrivate 無關）
    if (isIPv4Literal(host) || host.includes(':')) {
      if (!isPublicIpLiteral(host)) {
        reject(new HttpFetchError('private_address', '目標為內網 / 回環位址，已阻斷（SSRF 防護）'));
        return;
      }
      void doFetch();
      return;
    }
    // 3b. 域名：先校驗解析結果，再把「校驗過的位址」經自訂 lookup 鎖定給連線層
    resolvePublicAddress(host, false)
      .then((addr) => {
        // 鎖定 IP：lookup 回呼直接回傳已校驗位址，連線層不再自行解析
        const lockedLookup = (
          _hostname: string,
          _options: unknown,
          callback: (err: Error | null, address: string, family: number) => void,
        ) => {
          callback(null, addr.address, addr.family);
        };
        doFetch(lockedLookup);
      })
      .catch((e) => {
        reject(e instanceof HttpFetchError ? e : new HttpFetchError('upstream', `DNS 解析失敗：${e instanceof Error ? e.message : String(e)}`));
      });

    function doFetch(lockedLookup?: (_h: string, _o: unknown, cb: (err: Error | null, address: string, family: number) => void) => void): void {
      const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = lib(
        u,
        {
          method: 'GET',
          timeout: HTTP_TIMEOUT_MS,
          headers: { 'user-agent': 'MicroMate-DynamicSkill/1.0', accept: 'application/json, text/plain;q=0.8, */*;q=0.5' },
          ...(lockedLookup ? { lookup: lockedLookup } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume(); // 釋放 socket
            reject(new HttpFetchError('redirect', `上游返回重定向（${status}），已拒絕跟隨`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy();
              reject(new HttpFetchError('upstream', `回應超過 ${MAX_RESPONSE_BYTES} 上限`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (status >= 400) {
              reject(new HttpFetchError('bad_status', `上游返回 ${status}`, status));
              return;
            }
            const text = Buffer.concat(chunks).toString('utf8');
            try {
              resolve({ status, json: JSON.parse(text) as unknown });
            } catch {
              resolve({ status, json: { text: text.slice(0, 2000) } }); // 非 JSON：包一層純文字
            }
          });
          res.on('error', (e) => reject(new HttpFetchError('upstream', `回應讀取失敗：${e.message}`)));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new HttpFetchError('timeout', `連線超時（${HTTP_TIMEOUT_MS}ms）`));
      });
      req.on('error', (e) => {
        reject(e instanceof HttpFetchError ? e : new HttpFetchError('upstream', `連線失敗：${e.message}`));
      });
      req.end();
    }
  });
}

/**
 * 依點號路徑取值（outFields key 用；支援陣列下標，如 "tickets.0.train_no"）
 * 取不到回 undefined；純量原 樣、物件 / 陣列 JSON 化（截 120 字）
 */
export function resolveFieldPath(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === null || cur === undefined) return undefined;
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  try {
    return JSON.stringify(cur).slice(0, 120);
  } catch {
    return undefined;
  }
}
