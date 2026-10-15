/**
 * 滴滴出行打車 SKILL（skill.ride.didi）
 *
 * 規範來源：.qoder/rules/Agent.md § 7
 *
 * 提供能力：
 *   - estimate_ride ：起終點車型與價格預估（idempotent）
 *   - place_ride    ：建立打車訂單（真實訂單！需確認後執行，reversible）
 *   - query_ride    ：訂單狀態輪詢（司機 / 距離 / ETA，idempotent）
 *   - place_ride/cancel 為 rollback 通道（非獨立 capability）
 *
 * 2026-10-14 國民級 App MCP 接入：滴滴官方 MCP（mcp.didichuxing.com，
 * Key 走 URL query）提供 taxi_* 真實叫車工具鏈——estimate 拿 traceId，
 * create_order 憑 traceId 建真實訂單，query 輪詢司機狀態。
 *
 * requiresHumanConfirm 判定（Agent.md § 7.1 第 4 條例外條款）：
 * place_ride 設 true——上游文檔明令「下單前必須取得用戶確認，禁止
 * 自動下單」，且行程中取消可能產生取消費、司機端已真實接單，屬典型
 * 不可逆場景，由 checkpoint 彈窗承擔確認職責（車型 + 價格 + 起終點）。
 *
 * 官方約束的落地（見雲端 skill-didi.ts 檔頭）：
 *   - 經緯度一律字符串傳遞（數字觸發 -32010）
 *   - 坐標格式 lng,lat（經度在前），必須來自工具實時獲取
 *   - traceId 有時效性（過期 -32021 → 重新預估）
 *
 * 降級策略：未配置 Key / 雲端不可用時，estimate 與 query 本地確定性
 * mock 兜底（離線演示可用）；place_ride 雲端已降級模擬訂單（可完整
 * 演示 query / cancel 閉環），雲基礎設施不可用時本地同構兜底。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';
import { error as logError } from '../../../utils/logger';

export interface EstimateRideInput {
  fromName: string;
  toName: string;
  fromCity?: string;
  toCity?: string;
  /** 已有定位坐標時直接使用（GCJ-02），跳過地點檢索 */
  fromLng?: number;
  fromLat?: number;
  toLng?: number;
  toLat?: number;
}

export interface RideOption {
  productCategory: string;
  productName: string;
  priceText: string;
}

export interface EstimateRideOutput {
  from: { name: string; lng: number; lat: number };
  to: { name: string; lng: number; lat: number };
  traceId: string;
  options: RideOption[];
  source: string;
}

export interface PlaceRideInput {
  /** 來自 estimate_ride 的 bindings */
  estimateTraceId: string;
  productCategory: string;
  productName?: string;
  fromName?: string;
  toName?: string;
  /** 叫車人手機號（缺省用 Key 綁定賬號手機號） */
  callerCarPhone?: string;
}

export interface PlaceRideOutput {
  orderId: string;
  upstreamOrderId: string;
  status: 'pending_external';
  fromName: string;
  toName: string;
  productName: string;
  phoneSuffix?: string;
  source: string;
}

export interface QueryRideInput {
  orderId: string;
}

export interface QueryRideOutput {
  orderId: string;
  upstreamOrderId: string;
  statusCode: number;
  statusText: string;
  driver: { name: string; phone: string; carModel: string; carPlate: string } | null;
  driverDistanceKm: string;
  etaMin: string;
  source: string;
}

export const meta = {
  id: 'skill.ride.didi',
  name: '滴滴出行',
  description:
    '【能做】起終點車型與價格預估（estimate_ride，如「從國貿到三里屯打車多少錢」）、' +
    '確認後建立真實打車訂單（place_ride，滴滴側真實派單）、輪詢訂單狀態（query_ride，' +
    '司機姓名 / 車牌 / 距離 / ETA）、取消訂單（rollback 通道）。' +
    '【不能做】不能代用戶支付車費（行程結束後由乘客在滴滴側支付）、行程中取消可能產生取消费。' +
    '【觸發時機】用戶提到「打車/滴滴/叫車/快車/專車」並表達出行意圖時。' +
    '【注意】叫車為真實派單，必須先經用戶確認車型與價格。',
  version: '1.0.0',
  owner: 'wx-didi-open',
  tags: ['出行', '打車'],
  capabilities: [
    {
      action: 'estimate_ride',
      description: '起終點車型與價格預估（返回可選車型列表與 traceId）',
      inputSchema: {
        type: 'object',
        required: ['fromName', 'toName', 'fromCity'],
        properties: {
          fromName: { type: 'string', description: '出發地名稱（如「國貿」）' },
          toName: { type: 'string', description: '到達地名稱（如「三里屯」）' },
          fromCity: { type: 'string', description: '出發城市（完整市名如「北京市」，滴滴地圖檢索必填；終點同城缺省繼承）' },
          toCity: { type: 'string', description: '到達城市（跨城時顯式傳入，缺省繼承 fromCity）' },
          fromLng: { type: 'number', description: '出發點經度（已有定位時直傳）' },
          fromLat: { type: 'number' },
          toLng: { type: 'number' },
          toLat: { type: 'number' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['traceId', 'options'],
        properties: {
          traceId: { type: 'string', description: '預估憑證（下單必傳，有時效）' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              required: ['productCategory', 'productName', 'priceText'],
              properties: {
                productCategory: { type: 'string', description: '車型代碼（下單必傳）' },
                productName: { type: 'string' },
                priceText: { type: 'string' },
              },
            },
          },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 8000,
    },
    {
      action: 'place_ride',
      description: '憑預估 traceId 與車型建立真實打車訂單（需確認；行程中取消可能有取消费）',
      inputSchema: {
        type: 'object',
        required: ['estimateTraceId', 'productCategory'],
        properties: {
          estimateTraceId: { type: 'string', description: 'estimate_ride 結果的 traceId' },
          productCategory: { type: 'string', description: 'estimate_ride 結果的車型代碼' },
          productName: { type: 'string' },
          fromName: { type: 'string' },
          toName: { type: 'string' },
          callerCarPhone: { type: 'string', description: '叫車人手機號（缺省用賬號綁定手機號）' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['orderId', 'status'],
        properties: {
          orderId: { type: 'string' },
          upstreamOrderId: { type: 'string' },
          status: { type: 'string' },
          productName: { type: 'string' },
        },
      },
      idempotent: false,
      reversible: true,
      requiresHumanConfirm: true,
      estimatedLatencyMs: 5000,
    },
    {
      action: 'query_ride',
      description: '輪詢打車訂單狀態（司機信息 / 距離 / ETA）',
      inputSchema: {
        type: 'object',
        required: ['orderId'],
        properties: { orderId: { type: 'string' } },
      },
      outputSchema: {
        type: 'object',
        required: ['orderId', 'statusText'],
        properties: {
          orderId: { type: 'string' },
          statusText: { type: 'string', description: '如「匹配中」「司機已接單」' },
          driver: { type: 'object' },
          etaMin: { type: 'string' },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 3000,
    },
  ],
} as unknown as SkillMeta;

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    const env = ctx.globals.cloudEnv as string;
    const i = input as Record<string, unknown>;
    switch (action) {
      case 'estimate_ride':
        return invokeEstimate(env, i as unknown as EstimateRideInput, ctx.sessionId);
      case 'place_ride':
        return invokePlace(env, i as unknown as PlaceRideInput, ctx.sessionId);
      case 'query_ride':
        return invokeQuery(env, i as unknown as QueryRideInput, ctx.sessionId);
      default:
        return {
          success: false,
          error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
        };
    }
  },
  async rollback(action, _input, result, ctx) {
    if (action !== 'place_ride') return;
    // 真實回滾：上游 taxi_cancel_order（未接單前可免費取消）+ 本地歸檔
    const env = ctx.globals.cloudEnv as string;
    const out = result.data as PlaceRideOutput;
    const res = await postContainer<{ ok: boolean }>(
      env,
      '/api/skill/skill.ride.didi/place_ride/cancel',
      { orderId: out.orderId, reason: '用戶取消' },
      { sessionId: ctx.sessionId, retry: false },
    );
    if (res.code !== 0) {
      logError('didi rollback 失敗', res);
      throw new Error('滴滴訂單取消失敗（請及時在滴滴 App 內處理）');
    }
  },
};

async function invokeEstimate(
  env: string,
  input: EstimateRideInput,
  sessionId: string,
): Promise<SkillResult<EstimateRideOutput>> {
  const res: CloudResponse<EstimateRideOutput> = await postContainer<EstimateRideOutput>(
    env,
    '/api/skill/skill.ride.didi/estimate_ride',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  // 雲端不可用（負數碼）：本地確定性 mock 兜底（雲端同款口徑）
  if (res.code < 0) return { success: true, data: mockEstimate(input) };
  return {
    success: false,
    error: { code: 'ESTIMATE_FAILED', message: res.message ?? '預估失敗', retryable: true },
  };
}

async function invokePlace(
  env: string,
  input: PlaceRideInput,
  sessionId: string,
): Promise<SkillResult<PlaceRideOutput>> {
  const res: CloudResponse<PlaceRideOutput> = await postContainer<PlaceRideOutput>(
    env,
    '/api/skill/skill.ride.didi/place_ride',
    input,
    // 寫操作禁用自動重試：逾時重試會重複叫車（雲端尚無 clientToken 冪等鍵）——
    // 滴滴真實派單，重複訂單即重複接單司機（取消費爭議源）
    { sessionId, retry: false },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  if (res.code < 0) {
    // 雲基礎設施不可用：本地模擬訂單兜底（與雲端降級同構，可演示查詢 / 取消閉環）
    const seed = input.estimateTraceId.length * 7 + input.productCategory.length;
    return {
      success: true,
      data: {
        orderId: `mock_ride_${Date.now()}`,
        upstreamOrderId: `mock_didi_${seed}`,
        status: 'pending_external',
        fromName: input.fromName ?? '',
        toName: input.toName ?? '',
        productName: input.productName ?? '快車',
        source: 'mock_local',
      },
    };
  }
  return {
    success: false,
    error: {
      code: 'PLACE_RIDE_FAILED',
      message: res.message ?? '叫車失敗（預估可能已過期，請重新預估）',
      retryable: true,
    },
  };
}

async function invokeQuery(
  env: string,
  input: QueryRideInput,
  sessionId: string,
): Promise<SkillResult<QueryRideOutput>> {
  const res: CloudResponse<QueryRideOutput> = await postContainer<QueryRideOutput>(
    env,
    '/api/skill/skill.ride.didi/query_ride',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) return { success: true, data: res.data };
  return {
    success: false,
    error: { code: 'QUERY_RIDE_FAILED', message: res.message ?? '訂單查詢失敗', retryable: true },
  };
}

function mockEstimate(input: EstimateRideInput): EstimateRideOutput {
  let h = 5381;
  const seedSrc = `${input.fromName}|${input.toName}`;
  for (let i = 0; i < seedSrc.length; i++) h = ((h << 5) + h + seedSrc.charCodeAt(i)) >>> 0;
  const baseYuan = 30 + (h % 40);
  return {
    from: { name: input.fromName, lng: input.fromLng ?? 0, lat: input.fromLat ?? 0 },
    to: { name: input.toName, lng: input.toLng ?? 0, lat: input.toLat ?? 0 },
    traceId: `mock_trace_${h}`,
    options: [
      { productCategory: '1', productName: '特惠快車', priceText: `約 ${baseYuan} 元` },
      { productCategory: '1', productName: '快車', priceText: `約 ${baseYuan + 5} 元` },
      { productCategory: '2', productName: '專車', priceText: `約 ${Math.round(baseYuan * 1.8)} 元` },
    ],
    source: 'mock_local',
  };
}
