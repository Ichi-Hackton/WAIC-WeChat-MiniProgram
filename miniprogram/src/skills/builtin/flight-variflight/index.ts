/**
 * 國內機票 SKILL（數據源：飛常準 AI 開放平台）
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1
 *
 * 提供能力：
 *   - search_flights：查詢航班時刻與艙位票價（idempotent, no confirm）
 *   - book_flight ：下單（NOT idempotent, requires confirm, reversible）
 *
 * 所有遠端呼叫透過 services/cloud 統一封裝，**禁止直接 import 'wx.*'**。
 * 結構與 train-12306 SKILL 同構（雙層數據源：雲端真實 → 本地確定性模擬）。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta, JumpPackage } from '../../../types/skill';
import { postContainer } from '../../../services/cloud';
import type { CloudResponse } from '../../../services/cloud';
import { error as logError, info as logInfo } from '../../../utils/logger';

/** search_flights 入參 */
export interface SearchFlightsInput {
  from: string;
  to: string;
  date: string; // YYYY-MM-DD
  cabin?: 'economy' | 'business' | 'first';
}

/** 單趟航班結果 */
export interface FlightInfo {
  flightNo: string; // 如 CA1501
  airline: string; // 如 中國國航
  from: string;
  to: string;
  /** 「首都機場 T3」 */
  fromAirport: string;
  toAirport: string;
  departTime: string; // HH:mm
  arriveTime: string;
  durationMin: number;
  cabin: string;
  /** 艙位即時票價（分）；-1 = 上游未取到（展示層特判「價格待詢」） */
  priceCent: number;
}

/** search_flights 出參 */
export interface SearchFlightsOutput {
  from: string;
  to: string;
  date: string;
  cabin: string;
  flights: FlightInfo[];
}

/** book_flight 入參 */
export interface BookFlightInput {
  flightNo: string;
  date: string;
  cabin: string;
  passengerName: string;
  passengerIdNo: string;
  /** 從 search_flights 注入的 bindings */
  from?: string;
  to?: string;
  /** 從 search_flights 注入的即時票價（分）：僅供 checkpoint 彈窗展示，下單金額以雲端再核實為準 */
  priceCent?: number;
}

/** book_flight 出參（2026-10 跳轉模式：真實購票與支付在 OTA 小程序側完成） */
export interface BookFlightOutput {
  orderId: string;
  flightNo: string;
  amountCent: number;
  status: 'pending_external' | 'completed' | 'cancelled';
  /** 跳轉包（appId 為空串 = copy-only，僅複製購票資訊） */
  jump?: JumpPackage;
}

/** 艙位枚舉 → 中文名（copyText 展示用，與雲端 skill-flight.ts CABIN_LABEL 對齊） */
const CABIN_LABEL: Record<string, string> = {
  economy: '經濟艙',
  business: '商務艙',
  first: '頭等艙',
};

export const meta = {
  id: 'skill.flight.variflight',
  name: '國內機票',
  description:
    '【能做】查詢中國大陸境內城市間航班時刻與艙位票價（search_flights，飛常準真實數據），並生成購票資訊卡跳轉 OTA 小程序（攜程等）下單（book_flight，支付在官方側完成）。' +
    '【不能做】不能代付（真實交易在 OTA 小程序完成）、不能查國際航班、不能值機選座、不能退改簽（須走航司官方渠道）。' +
    '【觸發時機】用戶提到「機票/航班/飛機/飛往」並表達查詢或購票意圖時。',
  version: '1.1.0',
  owner: 'wx-variflight-mock',
  tags: ['出行', '交通', '機票'],
  capabilities: [
    {
      action: 'search_flights',
      description: '查詢指定日期、起訖城市的航班清單（時刻 + 艙位票價）',
      inputSchema: {
        type: 'object',
        required: ['from', 'to', 'date'],
        properties: {
          from: { type: 'string', description: '出發城市名（如「北京」）', minLength: 1 },
          to: { type: 'string', description: '到達城市名（如「上海」）', minLength: 1 },
          date: { type: 'string', description: '出行日期 YYYY-MM-DD', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          cabin: {
            type: 'string',
            enum: ['economy', 'business', 'first'],
            description: '艙位類型（經濟艙 / 商務艙 / 頭等艙）',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['from', 'to', 'date', 'flights'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          date: { type: 'string' },
          flights: {
            type: 'array',
            items: {
              type: 'object',
              required: ['flightNo', 'priceCent'],
              properties: {
                flightNo: { type: 'string' },
                departTime: { type: 'string' },
                arriveTime: { type: 'string' },
                priceCent: { type: 'integer' },
              },
            },
          },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 3000, // 雲端併發拉時刻 + 票價，長於單一 12306 查詢
    },
    {
      action: 'book_flight',
      description: '生成購票資訊卡並跳轉 OTA 小程序下單（真實支付在官方側完成）',
      inputSchema: {
        type: 'object',
        required: ['flightNo', 'date', 'cabin', 'passengerName', 'passengerIdNo'],
        properties: {
          flightNo: { type: 'string', description: '航班號（如 CA1501）' },
          date: { type: 'string' },
          cabin: { type: 'string', enum: ['economy', 'business', 'first'] },
          passengerName: { type: 'string', minLength: 1 },
          passengerIdNo: { type: 'string', description: '身份證字號' },
          from: { type: 'string' },
          to: { type: 'string' },
          priceCent: {
            type: 'integer',
            description: '查詢時即時票價（分），由 inputBindings 從 search_flights 注入，僅供確認彈窗展示',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['orderId', 'amountCent'],
        properties: {
          orderId: { type: 'string' },
          amountCent: { type: 'integer' },
          status: { type: 'string', enum: ['pending_external', 'completed', 'cancelled'] },
          jump: { type: 'object', description: '跳轉包（appId 空串 = 僅複製購票資訊）' },
        },
      },
      idempotent: false,
      reversible: true,
      requiresHumanConfirm: true, // 紅線：寫操作（與 book_ticket 同構）
      estimatedLatencyMs: 2500,
    },
  ],
} as unknown as SkillMeta;

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    const env = ctx.globals.cloudEnv as string;
    if (action === 'search_flights') {
      return invokeSearch(env, input as SearchFlightsInput, ctx.sessionId);
    }
    if (action === 'book_flight') {
      return invokeBook(env, input as BookFlightInput, ctx.sessionId);
    }
    return {
      success: false,
      error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
    };
  },
  async rollback(action, input, _result, ctx) {
    if (action !== 'book_flight') return;
    // 透過雲端 cancel 訂單
    const env = ctx.globals.cloudEnv as string;
    const res = await postContainer<{ ok: boolean }>(
      env,
      '/api/skill/skill.flight.variflight/book_flight/cancel',
      { orderId: (_result.data as BookFlightOutput).orderId, input },
      { sessionId: ctx.sessionId, retry: false },
    );
    if (res.code !== 0) {
      logError('flight rollback 失敗', res);
      throw new Error('機票訂單取消失敗');
    }
    logInfo('機票訂單已取消');
  },
};

/** search_flights 實作：呼叫雲端，雲端不可用時返回 mock 數據（便於本地開發） */
async function invokeSearch(
  env: string,
  input: SearchFlightsInput,
  sessionId: string,
): Promise<SkillResult<SearchFlightsOutput>> {
  const res: CloudResponse<SearchFlightsOutput> = await postContainer<SearchFlightsOutput>(
    env,
    '/api/skill/skill.flight.variflight/search_flights',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) {
    return { success: true, data: res.data, bindings: buildSearchBindings(input, res.data) };
  }
  // 雲端不可用時返回 mock（MVP 階段允許）：負數碼 = 雲基礎設施錯誤
  // （-1 開發佔位 / -501000 INVALID_ENV 等），業務錯誤碼為正數不受影響
  if (res.code < 0) {
    const data = mockSearch(input);
    return { success: true, data, bindings: buildSearchBindings(input, data) };
  }
  return {
    success: false,
    error: { code: 'SEARCH_FAILED', message: res.message ?? '航班查詢失敗', retryable: res.code === 503 },
  };
}

/**
 * 構造供下游 book_flight 引用的輸出綁定（與 train-12306 的
 * priceCentByTrain 同構）：
 *   1. 首班航班關鍵欄位（flightNo / departTime / priceCent）——泛「買機票」
 *      意圖（未點名航班）直接引用
 *   2. priceCentByFlight 映射（航班號→即時票價）——「訂指定航班」意圖以
 *      點號路徑精確取價；指定航班不在查詢結果中時取值失敗阻斷下單
 */
function buildSearchBindings(
  input: SearchFlightsInput,
  data: SearchFlightsOutput,
): Record<string, unknown> {
  const first = data.flights[0];
  const priceCentByFlight: Record<string, number> = {};
  for (const f of data.flights) {
    if (!(f.flightNo in priceCentByFlight)) priceCentByFlight[f.flightNo] = f.priceCent;
  }
  return {
    from: input.from,
    to: input.to,
    date: input.date,
    ...(first
      ? { flightNo: first.flightNo, departTime: first.departTime, priceCent: first.priceCent }
      : {}),
    ...(Object.keys(priceCentByFlight).length > 0 ? { priceCentByFlight } : {}),
  };
}

/** book_flight 實作 */
async function invokeBook(
  env: string,
  input: BookFlightInput,
  sessionId: string,
): Promise<SkillResult<BookFlightOutput>> {
  const res: CloudResponse<BookFlightOutput> = await postContainer<BookFlightOutput>(
    env,
    '/api/skill/skill.flight.variflight/book_flight',
    input,
    // 寫操作禁用自動重試：逾時重試會重複下單（雲端尚無 clientToken 冪等鍵）
    { sessionId, retry: false },
  );
  if (res.code === 0 && res.data) {
    return { success: true, data: res.data };
  }
  // 雲端不可用時返回 mock：負數碼 = 雲基礎設施錯誤（見 invokeSearch 說明）。
  // mock 與雲端跳轉模式同構：pending_external + 購票資訊卡（copy-only，
  // 開發者工具離線演示時 UI 形態與真實鏈路一致）
  if (res.code < 0) {
    const amountCent = 98000; // 假設 980 元（與雲端靜態價目表經濟艙基準價對齊）
    const cabinLabel = CABIN_LABEL[input.cabin] ?? input.cabin;
    const copyText = [
      `航班 ${input.flightNo}（${input.date}）`,
      `${input.from ?? ''} → ${input.to ?? ''}`,
      `${cabinLabel} ¥${(amountCent / 100).toFixed(2)}`,
      `乘機人 ${input.passengerName}`,
    ].join('\n');
    return {
      success: true,
      data: {
        orderId: `mock_flg_${Date.now()}`,
        flightNo: input.flightNo,
        amountCent,
        status: 'pending_external',
        jump: {
          target: 'ota_flight',
          appId: '',
          copyText,
          note: '真實交易於外部官方渠道完成，支付與售後以渠道為準',
        },
      },
    };
  }
  return {
    success: false,
    error: { code: 'BOOK_FAILED', message: res.message ?? '機票下單失敗', retryable: false },
  };
}

/** mock 數據（本地開發用，與雲端確定性模擬同款航班表） */
function mockSearch(input: SearchFlightsInput): SearchFlightsOutput {
  const MOCK: Array<[string, string, string, string, number]> = [
    ['CA1501', '中國國航', '07:30', '09:50', 98000],
    ['MU5101', '中國東航', '09:00', '11:15', 105000],
    ['CZ3907', '中國南航', '11:30', '13:45', 89000],
    ['HU7603', '海南航空', '14:00', '16:10', 112000],
  ];
  const toMin = (s: string): number => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3), 10);
  const flights: FlightInfo[] = MOCK.map(([flightNo, airline, dep, arr, price]) => ({
    flightNo,
    airline,
    from: input.from,
    to: input.to,
    fromAirport: `${input.from}出發機場 T2`,
    toAirport: `${input.to}到達機場 T1`,
    departTime: dep,
    arriveTime: arr,
    durationMin: toMin(arr) - toMin(dep),
    cabin: input.cabin ?? 'economy',
    priceCent: price,
  }));
  return { from: input.from, to: input.to, date: input.date, cabin: input.cabin ?? 'economy', flights };
}
