/**
 * 淘寶聯盟（淘寶客）客戶端 — 真實商品查詢 + 淘口令生成
 *
 * 2026-10 真實渠道上線：網購商城 SKILL 的淘寶側數據源。個人開發者在
 * open.taobao.com 建立「淘寶客-導購」類應用並申請權限包後取得憑證
 * （個人准入存在不確定性；若受阻，一期僅京東，本模組保持預留）。
 *
 * 淘寶系無微信小程序：微信生態内無法直接跳轉淘寶，成交路徑為「查真實
 * 商品 → 生成淘口令 → 複製後打開淘寶 App 下單支付」（微信内推廣通行做法）。
 *
 * 環境變數：
 *   TAOBAO_APP_KEY    —— 應用 appKey（open.taobao.com）
 *   TAOBAO_APP_SECRET —— 應用 appSecret
 *   TAOBAO_PID        —— 推廣位 PID（格式 mm_x_y_z，第三段為 adzoneId）
 *
 * 簽名：TOP 網關 HMAC-MD5 規則 —— 業務與公共參數合併後按 key 升序的
 * (k+v) 拼接，取 HMAC-MD5(secret) hex 大寫；以 node:crypto 實現。
 *
 * 錯誤分流（與 union-jd 一致）：
 *   TaobaoUnionError —— 渠道業務錯誤（Key 無效 / 權限缺失 / 響應碼非 0）
 *   一般 Error       —— 連線層失敗（呼叫方跳過渠道降級）
 */

import { createHmac } from 'node:crypto';

/** TOP 網關（GET query 傳參，響應統一 JSON） */
const TB_GATEWAY = 'https://eco.taobao.com/router/rest';

/** 上游單次請求超時 */
const TB_TIMEOUT_MS = 12_000;

/** 渠道業務性錯誤 */
export class TaobaoUnionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaobaoUnionError';
  }
}

/** 淘寶渠道歸一化商品 */
export interface TbProduct {
  productId: string;
  name: string;
  category: string;
  /** 券後價優先（券後 = 折扣價 − 券額），無券取折扣價 */
  priceCent: number;
  stock: number;
  rating: number;
  channel: 'taobao';
  shop: string;
  /** 商品落地頁（淘口令入參） */
  jumpUrl: string;
}

/** 憑證是否齊備（未齊備時 skill-shopping 跳過淘寶渠道） */
export function tbConfigured(): boolean {
  return Boolean(process.env.TAOBAO_APP_KEY && process.env.TAOBAO_APP_SECRET && process.env.TAOBAO_PID);
}

/** 從 PID 解析 adzoneId（mm_x_y_z → z）；解析失敗回 0（API 將報業務錯誤） */
function adzoneIdFromPid(): number {
  const pid = process.env.TAOBAO_PID ?? '';
  const parts = pid.split('_');
  const adzone = parts.length >= 4 ? parseInt(parts[3], 10) : NaN;
  return Number.isFinite(adzone) && adzone > 0 ? adzone : 0;
}

/** TOP HMAC-MD5 簽名（參數按 key 升序 → k+v 拼接 → HMAC-MD5 hex 大寫） */
function tbSign(params: Record<string, string>, secret: string): string {
  const joined = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join('');
  return createHmac('md5', secret).update(joined, 'utf8').digest('hex').toUpperCase();
}

/** TOP 時間戳格式 yyyy-MM-dd HH:mm:ss（東八區） */
function tbTimestamp(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 網關呼叫：公共參數 + 業務參數平铺合併 → 簽名 → GET → 解包
 *
 * 響應包裝鍵 = method 的點號換下劃線 + '_response'；錯誤統一落在
 * error_response（code / msg / sub_msg）。
 *
 * @throws TaobaoUnionError 業務錯誤
 * @throws Error            連線層失敗
 */
async function tbGateway(method: string, bizParams: Record<string, string | number>): Promise<Record<string, unknown>> {
  const appKey = process.env.TAOBAO_APP_KEY ?? '';
  const appSecret = process.env.TAOBAO_APP_SECRET ?? '';
  const params: Record<string, string> = {
    method,
    app_key: appKey,
    timestamp: tbTimestamp(),
    format: 'json',
    v: '2.0',
    sign_method: 'hmac',
  };
  for (const [k, v] of Object.entries(bizParams)) params[k] = String(v);
  params.sign = tbSign(params, appSecret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TB_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${TB_GATEWAY}?${new URLSearchParams(params)}`, { signal: controller.signal });
  } catch (e) {
    throw new Error(`淘寶網關不可達：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new Error(`淘寶網關回應非 JSON（HTTP ${resp.status}）`);
  }

  const b = body as Record<string, unknown>;
  const errResp = b.error_response as Record<string, unknown> | undefined;
  if (errResp) {
    const detail = [errResp.msg, errResp.sub_msg].filter(Boolean).join('：');
    throw new TaobaoUnionError(`淘寶聯盟業務失敗 ${String(errResp.code ?? '')}：${detail.slice(0, 160)}`);
  }

  const wrapKey = `${method.replace(/\./g, '_')}_response`;
  const wrap = b[wrapKey] as Record<string, unknown> | undefined;
  if (!wrap || typeof wrap !== 'object') {
    throw new TaobaoUnionError(`淘寶聯盟回應缺少 ${wrapKey} 包裝`);
  }
  return wrap;
}

/** 元（字串或數字）→ 分；畸形回 0 */
function yuanToCent(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

/** 標題清理：剔除 API 高亮標籤 <em>…</em> 與多餘空白 */
function cleanTitle(title: unknown): string {
  return String(title ?? '')
    .replace(/<\/?em>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 關鍵詞搜尋淘寶真實商品（taobao.tbk.dg.material.optional）
 *
 * @throws TaobaoUnionError 業務錯誤（權限缺失 / adzone 非法）
 * @throws Error            連線層失敗（呼叫方跳過淘寶渠道）
 */
export async function searchTbGoods(keyword: string, limit: number): Promise<TbProduct[]> {
  const adzoneId = adzoneIdFromPid();
  if (!adzoneId) {
    throw new TaobaoUnionError('TAOBAO_PID 格式非法（應為 mm_x_y_z，z 為 adzoneId）');
  }
  const wrap = await tbGateway('taobao.tbk.dg.material.optional', {
    q: keyword,
    adzone_id: adzoneId,
    page_no: 1,
    page_size: Math.min(Math.max(limit, 1), 20),
  });
  const resultList = (wrap.result_list ?? {}) as Record<string, unknown>;
  const mapData = resultList.map_data;
  if (!Array.isArray(mapData)) return [];

  return mapData
    .map((raw): TbProduct | null => {
      const g = raw as Record<string, unknown>;
      const numIid = g.num_iid ?? g.item_id;
      if (typeof numIid !== 'number' && typeof numIid !== 'string') return null;
      const name = cleanTitle(g.title);
      if (!name) return null;

      // 券後價優先：折扣價 − 券額（券信息缺失時直接取折扣價）
      const zkCent = yuanToCent(g.zk_final_price ?? g.reserve_price);
      const couponCent = yuanToCent(g.coupon_amount);
      const priceCent = zkCent > 0 && couponCent > 0 ? Math.max(zkCent - couponCent, 0) : zkCent;

      return {
        productId: `tb_${numIid}`,
        name,
        category: '淘寶',
        priceCent,
        stock: 9999,
        rating: 0, // material.optional 不含好評率欄位
        channel: 'taobao',
        shop: String(g.shop_title ?? g.nick ?? '淘寶店鋪'),
        jumpUrl: `https://item.taobao.com/item.htm?id=${numIid}`,
      };
    })
    .filter((p): p is TbProduct => p !== null);
}

/**
 * 生成淘口令（taobao.tbk.tpwd.create）
 *
 * 淘口令是淘寶系在微信生態内的通行導入載體：複製後打開淘寶 App 即自動
 * 彈出對應商品。text 超長會被 API 拒絕，此處截 12 字元。
 *
 * @throws TaobaoUnionError 業務錯誤（URL 非法 / 權限缺失）
 * @throws Error            連線層失敗
 */
export async function tbkTpwd(url: string, text: string): Promise<string> {
  const wrap = await tbGateway('taobao.tbk.tpwd.create', {
    url,
    text: text.slice(0, 12),
  });
  const data = (wrap.data ?? {}) as Record<string, unknown>;
  const model = data.model;
  if (typeof model !== 'string' || !model) {
    throw new TaobaoUnionError('淘口令生成回應缺失 model');
  }
  return model;
}
