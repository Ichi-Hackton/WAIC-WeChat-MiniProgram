/**
 * 12306 火車票 SKILL
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1
 *
 * 提供能力：
 *   - search_train：查詢車次（idempotent, no confirm）
 *   - book_ticket ：下單（NOT idempotent, requires confirm, reversible）
 *
 * 所有遠端呼叫透過 services/cloud 統一封裝，**禁止直接 import 'wx.*'**。
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { postContainer, type CloudResponse } from '../../../services/cloud';
import { error as logError, info as logInfo } from '../../../utils/logger';

/** search_train 入參 */
export interface SearchTrainInput {
  from: string;
  to: string;
  date: string; // YYYY-MM-DD
  seatType?: 'business' | 'first_class' | 'second_class' | 'hard_seat';
  highSpeedOnly?: boolean;
}

/** 單趟車次結果 */
export interface TrainInfo {
  trainNo: string;
  from: string;
  to: string;
  departTime: string; // HH:mm
  arriveTime: string;
  durationMin: number;
  seatType: string;
  priceCent: number;
  ticketsLeft: number;
}

/** search_train 出參 */
export interface SearchTrainOutput {
  from: string;
  to: string;
  date: string;
  trains: TrainInfo[];
}

/** book_ticket 入參 */
export interface BookTicketInput {
  trainNo: string;
  date: string;
  seatType: string;
  passengerName: string;
  passengerIdNo: string;
  /** 從 search_train 注入的 bindings */
  from?: string;
  to?: string;
  /** 從 search_train 注入的即時票價（分）：僅供 checkpoint 彈窗展示，下單金額以雲端再核實為準 */
  priceCent?: number;
}

/** book_ticket 出參 */
export interface BookTicketOutput {
  orderId: string;
  trainNo: string;
  amountCent: number;
  status: 'pending_payment' | 'paid';
  payDeadline: number; // epoch ms
}

export const meta = {
  id: 'skill.train.12306',
  name: '12306 火車票',
  description:
    '【能做】查詢中國大陸境內高鐵 / 普速車次（search_train），並下單購票（book_ticket）。' +
    '【不能做】不能改簽、不能退票（須走 12306 官方）、不能查詢國際列車。' +
    '【觸發時機】用戶提到「高鐵/動車/火車/車次/12306」並表達查詢或購票意圖時。',
  version: '1.0.0',
  owner: 'wx-12306-mock',
  tags: ['出行', '交通', '火車'],
  capabilities: [
    {
      action: 'search_train',
      description: '查詢指定日期、起訖站的車次清單',
      inputSchema: {
        type: 'object',
        required: ['from', 'to', 'date'],
        properties: {
          from: { type: 'string', description: '出發站城市名（如「北京」）', minLength: 1 },
          to: { type: 'string', description: '到達站城市名（如「上海」）', minLength: 1 },
          date: { type: 'string', description: '出行日期 YYYY-MM-DD', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          seatType: {
            type: 'string',
            enum: ['business', 'first_class', 'second_class', 'hard_seat'],
            description: '座位類型',
          },
          highSpeedOnly: { type: 'boolean', description: '是否只查高鐵' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['from', 'to', 'date', 'trains'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          date: { type: 'string' },
          trains: {
            type: 'array',
            items: {
              type: 'object',
              required: ['trainNo', 'priceCent'],
              properties: {
                trainNo: { type: 'string' },
                departTime: { type: 'string' },
                arriveTime: { type: 'string' },
                priceCent: { type: 'integer' },
                ticketsLeft: { type: 'integer' },
              },
            },
          },
        },
      },
      idempotent: true,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 1500,
    },
    {
      action: 'book_ticket',
      description: '下單購買指定車次（會凍結座位）',
      inputSchema: {
        type: 'object',
        required: ['trainNo', 'date', 'seatType', 'passengerName', 'passengerIdNo'],
        properties: {
          trainNo: { type: 'string' },
          date: { type: 'string' },
          seatType: { type: 'string' },
          passengerName: { type: 'string', minLength: 1 },
          passengerIdNo: { type: 'string', description: '身份證字號' },
          from: { type: 'string' },
          to: { type: 'string' },
          priceCent: {
            type: 'integer',
            description: '查詢時即時票價（分），由 inputBindings 從 search_train 注入，僅供確認彈窗展示',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['orderId', 'amountCent'],
        properties: {
          orderId: { type: 'string' },
          amountCent: { type: 'integer' },
          status: { type: 'string', enum: ['pending_payment', 'paid'] },
        },
      },
      idempotent: false,
      reversible: true,
      requiresHumanConfirm: true, // 紅線：寫操作
      estimatedLatencyMs: 2000,
    },
  ],
} as unknown as SkillMeta;

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx): Promise<SkillResult> {
    const env = ctx.globals.cloudEnv as string;
    if (action === 'search_train') {
      return invokeSearch(env, input as SearchTrainInput, ctx.sessionId);
    }
    if (action === 'book_ticket') {
      return invokeBook(env, input as BookTicketInput, ctx.sessionId);
    }
    return {
      success: false,
      error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
    };
  },
  async rollback(action, input, _result, ctx) {
    if (action !== 'book_ticket') return;
    // 透過雲端 cancel 訂單
    const env = ctx.globals.cloudEnv as string;
    const res = await postContainer<{ ok: boolean }>(
      env,
      '/api/skill/skill.train.12306/book_ticket/cancel',
      { orderId: (_result.data as BookTicketOutput).orderId, input },
      { sessionId: ctx.sessionId, retry: false },
    );
    if (res.code !== 0) {
      logError('12306 rollback 失敗', res);
      throw new Error('12306 訂單取消失敗');
    }
    logInfo('12306 訂單已取消');
  },
};

/** search_train 實作：呼叫雲端，雲端不可用時返回 mock 數據（便於本地開發） */
async function invokeSearch(
  env: string,
  input: SearchTrainInput,
  sessionId: string,
): Promise<SkillResult<SearchTrainOutput>> {
  const res: CloudResponse<SearchTrainOutput> = await postContainer<SearchTrainOutput>(
    env,
    '/api/skill/skill.train.12306/search_train',
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
    error: { code: 'SEARCH_FAILED', message: res.message ?? '車次查詢失敗', retryable: res.code === 503 },
  };
}

/**
 * 構造供下游 book_ticket 引用的輸出綁定（協議 § 6.1 bindings 語義）
 *
 * applyBindings 取值時 bindings 優先於 data，輸出兩類引用形態：
 *   1. 首趟車關鍵欄位（trainNo / departTime / priceCent）——泛「買票」意圖
 *      （未點名車次）直接引用，如 fromField: 'trainNo'
 *   2. priceCentByTrain 映射（車次號→即時票價）——「訂指定車次」意圖（如
 *      「訂 G531」）以點號路徑精確取價，如 fromField: 'priceCentByTrain.G531'；
 *      指定車次若不在查詢結果中，取值失敗會阻斷下單（查無此車不應下單）。
 *      相比讓 LLM 自造陣列過濾語法（實測產出過 trains[?trainNo=='G531']
 *      等不支援路徑），映射鍵直達路徑對 LLM 最穩。
 */
function buildSearchBindings(
  input: SearchTrainInput,
  data: SearchTrainOutput,
): Record<string, unknown> {
  const first = data.trains[0];
  const priceCentByTrain: Record<string, number> = {};
  for (const t of data.trains) {
    if (!(t.trainNo in priceCentByTrain)) priceCentByTrain[t.trainNo] = t.priceCent;
  }
  return {
    from: input.from,
    to: input.to,
    date: input.date,
    ...(first
      ? { trainNo: first.trainNo, departTime: first.departTime, priceCent: first.priceCent }
      : {}),
    ...(Object.keys(priceCentByTrain).length > 0 ? { priceCentByTrain } : {}),
  };
}

/** book_ticket 實作 */
async function invokeBook(
  env: string,
  input: BookTicketInput,
  sessionId: string,
): Promise<SkillResult<BookTicketOutput>> {
  const res: CloudResponse<BookTicketOutput> = await postContainer<BookTicketOutput>(
    env,
    '/api/skill/skill.train.12306/book_ticket',
    input,
    { sessionId },
  );
  if (res.code === 0 && res.data) {
    return { success: true, data: res.data };
  }
  // 雲端不可用時返回 mock：負數碼 = 雲基礎設施錯誤（見 invokeSearch 說明）
  if (res.code < 0) {
    return {
      success: true,
      data: {
        orderId: `mock_order_${Date.now()}`,
        trainNo: input.trainNo,
        amountCent: 55300, // 假設 553 元
        status: 'pending_payment',
        payDeadline: Date.now() + 15 * 60 * 1000,
      },
    };
  }
  return {
    success: false,
    error: {
      code: res.code === 1001 ? 'NO_TICKETS' : 'BOOK_FAILED',
      message: res.message ?? '下單失敗',
      retryable: false,
    },
  };
}

/** mock 數據（本地開發用） */
function mockSearch(input: SearchTrainInput): SearchTrainOutput {
  const baseHour = 8;
  const trains: TrainInfo[] = [1, 2, 3, 4, 5].map((i) => ({
    trainNo: `G${100 + i}`,
    from: input.from,
    to: input.to,
    departTime: `${String(baseHour + i).padStart(2, '0')}:00`,
    arriveTime: `${String(baseHour + i + 5).padStart(2, '0')}:30`,
    durationMin: 330,
    seatType: input.seatType ?? 'second_class',
    priceCent: 55300,
    ticketsLeft: 50 - i * 7,
  }));
  return { from: input.from, to: input.to, date: input.date, trains };
}