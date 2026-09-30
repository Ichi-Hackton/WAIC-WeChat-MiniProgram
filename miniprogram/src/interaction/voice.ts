/**
 * 語音輸入封裝
 *
 * 規範來源：.qoder/rules/Agent.md § 11.4
 *
 * 微信官方推薦用「微信同聲傳譯」插件做語音轉文字；
 * MVP 階段先用 wx.startRecord + 雲端 STT fallback。
 */

import { postContainer } from '../services/cloud';

export interface VoiceOptions {
  /** 最大錄音時長 ms，預設 30000 */
  maxDurationMs?: number;
}

/** 啟動錄音並返回錄音文件路徑（resolve） */
export function startRecord(opts: VoiceOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const wxApi = (globalThis as { wx?: {
      getRecorderManager?: () => unknown;
      startRecord?: (o: unknown) => void;
    } }).wx;
    if (!wxApi?.getRecorderManager) {
      // fallback：使用舊版 startRecord
      if (!wxApi?.startRecord) {
        reject(new Error('錄音 API 不可用'));
        return;
      }
      wxApi.startRecord({});
      // 注意：舊版沒有 callback，這裡僅做兜底
      resolve('');
      return;
    }
    // 推薦：用新版 RecorderManager
    const rm = wxApi.getRecorderManager() as unknown as {
      start: (o?: unknown) => void;
      onStop: (cb: (res: { tempFilePath: string }) => void) => void;
      onError: (cb: (err: unknown) => void) => void;
    };
    rm.start({ duration: opts.maxDurationMs ?? 30000, format: 'mp3' });
    rm.onStop((res) => resolve(res.tempFilePath));
    rm.onError((err) => reject(err));
  });
}

/**
 * 將語音文件傳給雲端做 STT
 *
 * 透過 services/cloud 統一封裝呼叫（重試 / 錯誤結構 / 埋點），
 * 不得繞過 services 直呼 wx.cloud.callContainer（規範 § 12.3）。
 *
 * @param filePath 錄音文件路徑
 * @param cloudEnv 雲端環境 ID
 */
export async function recognizeSpeech(filePath: string, cloudEnv: string): Promise<string> {
  // 微信云函式上傳 + STT
  // 真實實作應先 uploadFile 到雲存儲，再呼叫 /api/stt/recognize
  const res = await postContainer<{ text?: string }>(cloudEnv, '/api/stt/recognize', { filePath });
  if (res.code !== 0 || !res.data) {
    throw new Error(res.message ?? `語音識別失敗 code=${res.code}`);
  }
  return res.data.text ?? '';
}