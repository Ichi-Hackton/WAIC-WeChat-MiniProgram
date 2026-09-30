/**
 * LLM 代理端點 — POST /api/llm/chat
 *
 * 透過 OpenAI 相容協議（/chat/completions）轉發至 LLM 供應商，
 * DeepSeek / Kimi / 混元 / GPT 系列均有相容端點，切換供應商只需改環境變數。
 * API Key 僅存在於容器環境變數，絕不落入代碼或小程序端（規範 § 8.3）。
 *
 * 環境變數：
 *   LLM_BASE_URL — 供應商 Base URL（如 https://api.deepseek.com/v1），必填
 *   LLM_API_KEY  — 供應商金鑰，必填
 *   LLM_MODEL    — 預設模型名，可選（預設 deepseek-chat）
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
  model?: string;
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

const handleChat: RouteHandler = async (body) => {
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
    model: req.model ?? process.env.LLM_MODEL ?? 'deepseek-chat',
    messages: req.messages.map((m) => ({ role: m.role as string, content: m.content as string })),
    temperature: typeof req.temperature === 'number' ? req.temperature : undefined,
    max_tokens: typeof req.maxTokens === 'number' ? req.maxTokens : undefined,
    ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      // 上游掛起時避免無界等待（Node 18+ 內建 AbortSignal.timeout）
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? `上游逾時（${UPSTREAM_TIMEOUT_MS}ms）` : '';
    return upstreamFail(`LLM 上游連線失敗：${reason || (e instanceof Error ? e.message : String(e))}`);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    return upstreamFail(`LLM 上游返回 ${upstream.status}：${detail.slice(0, 200)}`);
  }

  const data = (await upstream.json().catch(() => null)) as ChatCompletionResponse | null;
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    return upstreamFail('LLM 上游回應格式異常（缺少 choices[0].message.content）');
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
];
