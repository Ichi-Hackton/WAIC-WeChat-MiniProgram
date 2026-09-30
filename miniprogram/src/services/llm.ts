/**
 * LLM 雲端呼叫封裝
 *
 * 規範來源：.qoder/rules/Agent.md § 8.3
 *
 * 透過微信雲函式 `llm-proxy` 統一轉發到多家 LLM（DeepSeek / 混元 / Kimi 等）。
 * 不在小程序端暴露 API Key。
 */

import { postContainer, type CloudResponse } from './cloud';
import { retry } from '../utils/retry';
import { error as logError } from '../utils/logger';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  /** 模型（後端決定實際呼叫哪一家） */
  model?: string;
  /** 對話歷史 */
  messages: LLMMessage[];
  /** 溫度 0~1，建議任務型用 0.3，生成型用 0.7 */
  temperature?: number;
  /** 最大輸出 token */
  maxTokens?: number;
  /** 是否要求 JSON 模式（後端會切換到對應模型） */
  jsonMode?: boolean;
  /** Session ID（埋點用） */
  sessionId?: string;
}

export interface LLMResponse {
  /** LLM 輸出文字 */
  text: string;
  /** 用量統計 */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** 使用的實際模型 */
  model: string;
}

export class LLMError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'LLMError';
    this.retryable = retryable;
  }
}

/** 呼叫雲端 LLM 代理 */
export async function callLLM(
  env: string,
  req: LLMRequest,
): Promise<LLMResponse> {
  const invoke = async (): Promise<LLMResponse> => {
    const res: CloudResponse<LLMResponse> = await postContainer<LLMResponse>(
      env,
      '/api/llm/chat',
      req,
      // postContainer 內建 3 次重試已關閉：重試統一收斂到本函數外層的
      // 單層 retry，避免巢狀放大（3 × 3 = 9 次）拖慢開發環境降級路徑
      { sessionId: req.sessionId, retry: false },
    );
    if (res.code !== 0 || !res.data) {
      const retryable = res.code === 429 || res.code === 503;
      throw new LLMError(res.message ?? `LLM 呼叫失敗 code=${res.code}`, retryable);
    }
    return res.data;
  };

  return retry(invoke, {
    maxAttempts: 3,
    baseDelayMs: 800,
    shouldRetry: (e) => (e instanceof LLMError ? e.retryable : true),
    onRetry: (attempt, err) => logError(`LLM 重試 #${attempt}`, err),
  });
}