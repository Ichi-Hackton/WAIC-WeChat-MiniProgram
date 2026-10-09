/**
 * 京東聯盟開放平台客戶端 — 真實商品查詢 + 推廣轉鏈
 *
 * 2026-10 真實渠道上線：網購商城 SKILL 的京東側數據源。個人開發者在
 * union.jd.com 備案推廣位 + jos.jd.com 建立應用即可取得憑證（無需企業
 * 資質），查詢真實商品 / 價格，轉鏈後跳京東購物小程序完成真實下單支付。
 *
 * 環境變數：
 *   JD_UNION_APP_KEY      —— 應用 appKey（jos.jd.com）
 *   JD_UNION_APP_SECRET   —— 應用 appSecret
 *   JD_UNION_POSITION_ID  —— 推廣位 ID（union.jd.com 備案，數字）
 *
 * 簽名：宙斯網關 MD5 規則 —— appSecret + 按 key 升序的 (k+v) 拼接 +
 * appSecret，取 MD5 轉大寫；以 node:crypto 實現（不引三方簽名庫）。
 *
 * 錯誤分流（仿 ticket-provider 模式）：
 *   JdUnionError —— 渠道業務錯誤（Key 無效 / 參數非法 / 響應碼非 0）
 *   一般 Error   —— 連線層失敗（不可達 / 超時 / 非 JSON），呼叫方跳過
 *                   當前渠道降級另一渠道（見 skill-shopping.ts）
 */

import { createHash } from 'node:crypto';

/** 宙斯網關（GET query 傳參，響應統一 JSON） */
const JD_GATEWAY = 'https://api.jd.com/routerjson';

/** 上游單次請求超時（超出視為連線層失敗，跳過渠道降級） */
const JD_TIMEOUT_MS = 12_000;

/** 渠道業務性錯誤（呼叫方決定語義：查詢時跳過渠道 / 轉鏈時降級複製） */
export class JdUnionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JdUnionError';
  }
}

/** 聯盟渠道歸一化商品（skill-shopping 聚合消費；與演示 Product 同構擴展） */
export interface JdProduct {
  productId: string;
  name: string;
  category: string;
  priceCent: number;
  /** 聯盟無實時庫存：以 9999 表「可購」，真實庫存以京東頁面為準 */
  stock: number;
  /** 好評率 0-5（goodCommentsShare 0~1 映射） */
  rating: number;
  channel: 'jd';
  shop: string;
  /** 商品落地頁（轉鏈 materialId 入參） */
  jumpUrl: string;
}

/** 憑證是否齊備（未齊備時 skill-shopping 跳過京東渠道） */
export function jdConfigured(): boolean {
  return Boolean(process.env.JD_UNION_APP_KEY && process.env.JD_UNION_APP_SECRET);
}

/** 宙斯 MD5 簽名（參數按 key 升序 → k+v 拼接 → 前後包 appSecret → MD5 大寫） */
function jdSign(params: Record<string, string>, secret: string): string {
  const joined = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join('');
  return createHash('md5').update(secret + joined + secret, 'utf8').digest('hex').toUpperCase();
}

/** 京東要求的時間戳格式 yyyy-MM-dd HH:mm:ss（東八區） */
function jdTimestamp(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 網關呼叫：組裝公共參數 + 簽名 → GET 請求 → 解包 method 業務響應
 *
 * 響應包裝鍵 = method 的點號換下劃線 + '_responce'（京東官方歷史拼寫），
 * 業務數據內嵌為 JSON 字串（如 queryResult / getResult），需二次解析。
 *
 * @throws JdUnionError 業務錯誤（error_response / 業務碼非 0 / 解包缺失）
 * @throws Error        連線層失敗
 */
async function jdGateway(method: string, bizParam: Record<string, unknown>): Promise<Record<string, unknown>> {
  const appKey = process.env.JD_UNION_APP_KEY ?? '';
  const appSecret = process.env.JD_UNION_APP_SECRET ?? '';
  const params: Record<string, string> = {
    method,
    app_key: appKey,
    timestamp: jdTimestamp(),
    format: 'json',
    v: '1.0',
    sign_method: 'md5',
    param_json: JSON.stringify(bizParam),
  };
  params.sign = jdSign(params, appSecret);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JD_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${JD_GATEWAY}?${new URLSearchParams(params)}`, { signal: controller.signal });
  } catch (e) {
    throw new Error(`京東網關不可達：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new Error(`京東網關回應非 JSON（HTTP ${resp.status}）`);
  }

  const b = body as Record<string, unknown>;
  const errResp = b.error_response as Record<string, unknown> | undefined;
  if (errResp) {
    throw new JdUnionError(`京東聯盟業務失敗：${String(errResp.zh_desc ?? errResp.code ?? 'unknown').slice(0, 160)}`);
  }

  const wrapKey = `${method.replace(/\./g, '_')}_responce`;
  const wrap = b[wrapKey] as Record<string, unknown> | undefined;
  if (!wrap || typeof wrap !== 'object') {
    throw new JdUnionError(`京東聯盟回應缺少 ${wrapKey} 包裝`);
  }
  return wrap;
}

/** 內嵌業務 JSON 解析（queryResult / getResult 可能為字串或已解析物件） */
function parseInner(raw: unknown, field: string): Record<string, unknown> {
  const value = (raw as Record<string, unknown> | undefined)?.[field];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* 落到下方統一業務錯誤 */
    }
  } else if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  throw new JdUnionError('京東聯盟業務回應缺失或非法');
}

/** 元 → 分（priceCent；畸形輸入回 0） */
function yuanToCent(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

/**
 * 關鍵詞搜尋京東真實商品（jd.union.open.goods.query）
 *
 * @throws JdUnionError 業務錯誤（Key 無效 / 參數非法）
 * @throws Error        連線層失敗（呼叫方跳過京東渠道）
 */
export async function searchJdGoods(keyword: string, limit: number): Promise<JdProduct[]> {
  const wrap = await jdGateway('jd.union.open.goods.query', {
    goodsReqDTO: {
      keyword,
      pageIndex: 1,
      pageSize: Math.min(Math.max(limit, 1), 20),
    },
  });
  const inner = parseInner(wrap, 'queryResult');
  const code = Number(inner.code);
  if (code !== 0) {
    throw new JdUnionError(`京東商品查詢業務碼 ${code}：${String(inner.message ?? '').slice(0, 120)}`);
  }
  const list = inner.data;
  if (!Array.isArray(list)) return [];

  return list
    .map((raw): JdProduct | null => {
      const g = raw as Record<string, unknown>;
      const goodsId = g.goodsId;
      if (typeof goodsId !== 'number' && typeof goodsId !== 'string') return null;
      const priceInfo = (g.priceInfo ?? {}) as Record<string, unknown>;
      const shopInfo = (g.shopInfo ?? {}) as Record<string, unknown>;
      const categoryInfo = (g.categoryInfo ?? {}) as Record<string, unknown>;
      const goodCommentsShare = typeof g.goodCommentsShare === 'number' ? g.goodCommentsShare : 0;
      return {
        productId: `jd_${goodsId}`,
        name: String(g.skuName ?? `京東商品 ${goodsId}`),
        category: String(categoryInfo.cname3 ?? '京東'),
        priceCent: yuanToCent(priceInfo.lowestPrice ?? g.unitPrice),
        stock: 9999,
        rating: Math.round(goodCommentsShare * 500) / 100,
        channel: 'jd',
        shop: String(shopInfo.shopName ?? '京東自營'),
        jumpUrl: typeof g.materialUrl === 'string' && g.materialUrl ? g.materialUrl : `https://item.m.jd.com/product/${goodsId}.html`,
      };
    })
    .filter((p): p is JdProduct => p !== null);
}

/** 轉鏈結果：jCommand = 微信小程序跳轉指令；clickUrl = H5 推廣連結（降級用） */
export interface JdPromotion {
  jCommand?: string;
  clickUrl?: string;
}

/**
 * 推廣轉鏈（jd.union.open.promotion.common.get，chainType=3 取小程序指令）
 *
 * @throws JdUnionError 業務錯誤（推廣位未審核通過 / materialId 非法）
 * @throws Error        連線層失敗
 */
export async function jdPromotion(materialUrl: string): Promise<JdPromotion> {
  const positionId = Number(process.env.JD_UNION_POSITION_ID ?? '');
  const wrap = await jdGateway('jd.union.open.promotion.common.get', {
    promotionCodeReq: {
      materialId: materialUrl,
      ...(Number.isFinite(positionId) && positionId > 0 ? { positionId } : {}),
      chainType: 3, // 3 = 微信小程序跳轉指令（jCommand）
    },
  });
  const inner = parseInner(wrap, 'getResult');
  const code = Number(inner.code);
  if (code !== 0) {
    throw new JdUnionError(`京東轉鏈業務碼 ${code}：${String(inner.message ?? '').slice(0, 120)}`);
  }
  const data = inner.data;
  const first = Array.isArray(data) && data.length > 0 ? (data[0] as Record<string, unknown>) : undefined;
  if (!first) {
    throw new JdUnionError('京東轉鏈回應缺少 data');
  }
  const result: JdPromotion = {};
  if (typeof first.jCommand === 'string' && first.jCommand) result.jCommand = first.jCommand;
  if (typeof first.clickURL === 'string' && first.clickURL) result.clickUrl = first.clickURL;
  if (!result.jCommand && !result.clickUrl) {
    throw new JdUnionError('京東轉鏈回應無 jCommand / clickURL');
  }
  return result;
}
