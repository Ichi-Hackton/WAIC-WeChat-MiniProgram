/**
 * LLM 代理端點 — POST /api/llm/chat
 *
 * 透過 OpenAI 相容協議（/chat/completions）轉發至 LLM 供應商，
 * DeepSeek / Kimi / 混元 / GPT 系列均有相容端點，切換供應商只需改環境變數。
 * API Key 僅存在於容器環境變數，絕不落入代碼或小程序端（規範 § 8.3）。
 *
 * 環境變數：
 *   LLM_BASE_URL — 供應商 Base URL（如 https://api.minimax.cn/v1），必填
 *   LLM_API_KEY  — 供應商金鑰，必填
 *   LLM_MODEL    — 模型名，可選（預設 MiniMax-M3；模型由雲端固定，請求不可覆蓋）
 *
 * 錯誤語義（與小程序端 services/llm.ts 對齊）：
 *   - 未配置 / 上游失敗 → HTTP 503（小程序端視為可重試；開發/體驗環境
 *     重試耗盡後降級為本地規則式規劃器，release 保持失敗語義）
 *   - 入參不合法 → HTTP 400
 */

import type { RouteHandler } from './api';
import { ok, badRequest } from './api';

/** OpenAI 相容 chat 請求體（僅聲明本代理用到的欄位） */
interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
}

/** OpenAI 相容 chat 回應（僅聲明用到的欄位） */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

/** 小程序端 LLMRequest（與 miniprogram/src/services/llm.ts 對齊，僅聲明用到的欄位） */
interface LLMRequestBody {
  messages?: Array<{ role?: string; content?: string }>;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

/** 上游回應翻譯為 503 處理結果（可重試語義） */
function upstreamFail(message: string): { httpStatus: number; body: { code: number; message: string } } {
  return { httpStatus: 503, body: { code: 503, message } };
}

/** 上游 LLM 呼叫逾時上限（毫秒） */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** 固定預設模型（LLM_MODEL 未設定時兜底；模型由雲端唯一決定，請求不可覆蓋） */
const DEFAULT_LLM_MODEL = 'MiniMax-M3';

/**
 * GET /api/config — LLM 配置狀態查詢（脫敏）
 *
 * 運維排查入口（LLM 型號不對用戶展示，小程序端已無調用方）：
 * 回報當前接入狀態（供應商 / 模型 / 是否已配 Key），
 * 絕不返回 API Key 本身；baseUrl 僅回 host（如 api.minimax.cn）。
 */
const handleConfig: RouteHandler = async () => {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL;
  let host = '';
  try {
    host = baseUrl ? new URL(baseUrl).host : '';
  } catch {
    host = '';
  }
  // 供應商識別（僅供展示；未知 host 一律「自定義」）
  const provider = !host
    ? '未配置'
    : host.includes('minimax')
      ? 'MiniMax'
      : host.includes('deepseek')
        ? 'DeepSeek'
        : host.includes('bigmodel')
          ? '智譜 GLM'
          : '自定義';
  return ok({
    llm: {
      configured: Boolean(baseUrl && apiKey),
      provider,
      model,
      baseUrl: host,
    },
  });
};

/**
 * LLM 對話代理處理器
 *
 * 匯出供同服務 SKILL 端點復用（如 skill-counseling 以自有 System Prompt
 * 構造 messages 後直呼，避免多一跳 HTTP 自轉發）；亦直接註冊於 llmRoutes。
 */
export const handleChat: RouteHandler = async (body) => {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  if (!baseUrl || !apiKey) {
    // 配置缺失視為服務暫不可用（503 可重試；開發環境降級鏈會兜底為 rule-planner）
    return upstreamFail('LLM 代理未配置：請在雲托管環境變數設定 LLM_BASE_URL 與 LLM_API_KEY');
  }

  const req = (body ?? {}) as LLMRequestBody;
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return badRequest('messages 必填且不可為空');
  }
  for (const m of req.messages) {
    if (typeof m.role !== 'string' || typeof m.content !== 'string') {
      return badRequest('messages[].role / content 必須為字串');
    }
  }

  const payload: ChatCompletionRequest = {
    model: process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
    messages: req.messages.map((m) => ({ role: m.role as string, content: m.content as string })),
    temperature: typeof req.temperature === 'number' ? req.temperature : undefined,
    max_tokens: typeof req.maxTokens === 'number' ? req.maxTokens : undefined,
    ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  };

  // 供應商特有參數合併（LLM_EXTRA_BODY，JSON 字串）：如 MiniMax M3 的
  // {"thinking":{"type":"disabled"}} 跳過思考降低延遲；解析失敗靜默忽略，
  // 避免錯誤配置阻斷主鏈路
  if (process.env.LLM_EXTRA_BODY) {
    try {
      Object.assign(payload, JSON.parse(process.env.LLM_EXTRA_BODY) as object);
    } catch {
      // 忽略非法 JSON 配置
    }
  }

  let upstream: Response;
  /** 執行上游呼叫（供 400 自適應重試複用） */
  const doFetch = async (p: ChatCompletionRequest): Promise<Response> =>
    fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(p),
      // 上游掛起時避免無界等待（Node 18+ 內建 AbortSignal.timeout）
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  try {
    upstream = await doFetch(payload);
    // 供應商相容自適應：部分供應商（如 MiniMax）不支援 OpenAI 的
    // response_format 參數，收到 400 時去掉該參數重試一次——planner
    // 輸出本就由 prompt 約束 + 小程序端 parser 正則抽取雙重保底，
    // 不依賴服務端 JSON 模式
    if (upstream.status === 400 && payload.response_format) {
      const { response_format: _drop, ...rest } = payload;
      void _drop;
      upstream = await doFetch(rest);
    }
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? `上游逾時（${UPSTREAM_TIMEOUT_MS}ms）` : '';
    return upstreamFail(`LLM 上游連線失敗：${reason || (e instanceof Error ? e.message : String(e))}`);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return upstreamFail(`LLM 上游返回 ${upstream.status}：${detail.slice(0, 200)}`);
  }

  const data = (await upstream.json().catch(() => null)) as ChatCompletionResponse | null;
  let text = data?.choices?.[0]?.message?.content;
  // 剔除內嵌思考標籤：部分供應商（如 MiniMax M3 實測行為）將思考過程
  // 以 <think>…</think> 直接內嵌 content（而非 reasoning_content 欄位），
  // 且思考 token 計入 max_tokens——下游 planner 只需純正文，思考內容
  // 流入解析會污染 JSON 抽取
  if (typeof text === 'string') {
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  if (typeof text !== 'string' || text === '') {
    return upstreamFail('LLM 上游回應格式異常（缺少 choices[0].message.content 或內容全為思考過程）');
  }

  return ok({
    text,
    usage: {
      promptTokens: data?.usage?.prompt_tokens ?? 0,
      completionTokens: data?.usage?.completion_tokens ?? 0,
      totalTokens: data?.usage?.total_tokens ?? 0,
    },
    model: data?.model ?? payload.model,
  });
};

export const llmRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/llm/chat', handleChat],
  ['GET /api/config', handleConfig],
];
