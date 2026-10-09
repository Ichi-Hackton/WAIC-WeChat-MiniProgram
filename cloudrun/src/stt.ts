/**
 * 語音識別代理端點 — POST /api/stt/recognize
 *
 * 背景（2026-10）：微信「同聲傳譯」插件（WechatSI）對個人主體小程序
 * 不可添加（後台插件市場按主體類型過濾，搜尋任何插件均無結果），
 * 語音識別改走雲端 STT：MiniMax /v1/speech_to_text（asr-1.0），
 * 與 LLM 代理共用同一 MiniMax 帳戶金鑰（環境變數回退見下）。
 *
 * 傳輸形態：音頻以 base64 內嵌 JSON（audioBase64）——不走 multipart。
 * 原因：wx.cloud.callContainer 僅支援 JSON body，且可完整復用小程序端
 * callContainer 既有的超時 / 重試 / 開發直連（127.0.0.1:8787）基礎設施。
 * 體積評估：60s mp3@16kHz 單聲道實測 ≤500KB，base64 後 ≤670KB，
 * 在 server.ts 的 1MB body 上限內。
 *
 * 環境變數（均可選，未設定時自 LLM 配置回退——LLM 供應商為 MiniMax
 * 時零額外配置即用；非 MiniMax 供應商必須顯式設定 STT_*）：
 *   STT_BASE_URL — 如 https://api.minimax.cn/v1（需含 /v1，與 LLM_BASE_URL 同形）
 *   STT_API_KEY  — MiniMax 金鑰
 *
 * 錯誤語義（與 llm-chat.ts 對齊）：
 *   - 未配置 / 上游連線失敗 / 5xx / 402 餘額不足 → HTTP 503（小程序端可重試）
 *   - 音頻非法（空 / 超限 / 格式壞，上游 400）/ 敏感內容（上游 422）
 *     → HTTP 200 + 業務失敗碼（不可重試，提示用戶重說）
 */

import type { RouteHandler } from './api';
import { ok, badRequest, fail } from './api';

/** 上游 STT 呼叫逾時上限（毫秒）——短音頻識別通常 1~3s，留足餘量 */
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * 音頻二進位大小上限（位元組）。與 server.ts 的 MAX_BODY_BYTES（1MB）協調：
 * 音頻以 base64 內嵌 JSON body（膨脹 4/3 倍），1MB body 實際僅容納約 750KB
 * 音頻，故上限設 700KB 以保證此友好錯誤先於通用 413 觸發
 * （正常 60s mp3@16kHz 單聲道實測 ≤500KB，遠低於此上限）
 */
const MAX_AUDIO_BYTES = 700 * 1024;

/** MiniMax asr 回應（僅聲明用到的欄位） */
interface AsrResponse {
  text?: string;
  duration?: number;
}

/** 小程序端請求體（與 miniprogram/src/interaction/voice.ts 對齊） */
interface SttRequestBody {
  audioBase64?: unknown;
}

/** 上游失敗翻譯為 503（可重試語義，與 llm-chat.ts upstreamFail 同構） */
function upstreamFail(message: string): { httpStatus: number; body: { code: number; message: string } } {
  return { httpStatus: 503, body: { code: 503, message } };
}

/** 解析 STT 上游配置：優先 STT_*，缺省回退 LLM_*（僅當 LLM 供應商為 MiniMax） */
function resolveUpstream(): { url: string; apiKey: string } | { error: string } {
  const sttBase = process.env.STT_BASE_URL;
  const sttKey = process.env.STT_API_KEY;
  if (sttBase && sttKey) {
    return { url: `${sttBase.replace(/\/$/, '')}/speech_to_text`, apiKey: sttKey };
  }
  // 回退：LLM 供應商為 MiniMax 時，同一金鑰可直接呼叫 asr-1.0
  const llmBase = process.env.LLM_BASE_URL ?? '';
  const llmKey = process.env.LLM_API_KEY ?? '';
  if (llmBase.includes('minimax') && llmKey) {
    return { url: `${llmBase.replace(/\/$/, '')}/speech_to_text`, apiKey: llmKey };
  }
  return { error: 'STT 未配置：請設定 STT_BASE_URL 與 STT_API_KEY（或將 LLM 供應商配置為 MiniMax）' };
}

const handleRecognize: RouteHandler = async (body) => {
  const upstream = resolveUpstream();
  if ('error' in upstream) {
    return upstreamFail(upstream.error);
  }

  const req = (body ?? {}) as SttRequestBody;
  if (typeof req.audioBase64 !== 'string' || req.audioBase64.length === 0) {
    return badRequest('audioBase64 必填（錄音檔案內容的 base64 字串）');
  }
  const audio = Buffer.from(req.audioBase64, 'base64');
  if (audio.length === 0) {
    return badRequest('audioBase64 不是合法的 base64 內容');
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    return badRequest(`音頻過大（${audio.length} 位元組，上限 ${MAX_AUDIO_BYTES}）`);
  }

  // MiniMax 要求 multipart/form-data：以 Node 18+ 內建 FormData / Blob 構造
  const form = new FormData();
  form.append('model', 'asr-1.0');
  form.append('response_format', 'json');
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'audio.mp3');

  let resp: Response;
  try {
    resp = await fetch(upstream.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${upstream.apiKey}`,
        // 語言提示（可選）：用戶輸入以中文為主，明確提示可提升識別品質
        language: 'zh',
      },
      body: form,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? `上游逾時（${UPSTREAM_TIMEOUT_MS}ms）` : '';
    return upstreamFail(`STT 上游連線失敗：${reason || (e instanceof Error ? e.message : String(e))}`);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    // 400（音頻格式 / 時長非法）與 422（敏感內容）為確定性失敗，
    // 重試無意義 → 業務失敗碼讓小程序端直接提示用戶
    if (resp.status === 400 || resp.status === 422) {
      return fail(resp.status, `語音識別失敗（${resp.status}）：${detail.slice(0, 200)}`);
    }
    // 401（金鑰錯）/ 402（餘額不足）/ 429（限流）/ 5xx → 503 可重試語義
    return upstreamFail(`STT 上游返回 ${resp.status}：${detail.slice(0, 200)}`);
  }

  const data = (await resp.json().catch(() => null)) as AsrResponse | null;
  if (typeof data?.text !== 'string') {
    return upstreamFail('STT 上游回應格式異常（缺少 text 欄位）');
  }

  return ok({
    text: data.text,
    /** 音頻時長（秒），MiniMax 計費依據，原樣透傳供端側展示 / 埋點 */
    durationSec: typeof data.duration === 'number' ? data.duration : 0,
  });
};

export const sttRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/stt/recognize', handleRecognize],
];
