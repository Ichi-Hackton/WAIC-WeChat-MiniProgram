/**
 * 語音輸入封裝（錄音 → 雲端 STT）
 *
 * 規範來源：.qoder/rules/Agent.md § 4（interaction/voice.ts）、M3 里程碑
 *
 * 技術演進（2026-10）：
 *   - 初版：微信「同聲傳譯」插件（WechatSI）純前端識別——實測個人主體
 *     小程序無法添加任何插件（後台插件市場按主體類型過濾，搜尋恆為空），
 *     該路徑對本項目不可行，棄用
 *   - 現行：RecorderManager 錄製 mp3（16kHz 單聲道，官方建議的低規格
 *     壓縮格式，60s ≈ 幾百 KB）→ base64 → 雲端 /api/stt/recognize
 *     （cloudrun/src/stt.ts 代理 MiniMax asr-1.0）→ 返回文本
 *
 * 會話式 API：startVoiceRecognition 返回 session，頁面再次點按結束
 * 錄音，上傳識別（約 1~3s）後 resolve 最終文本。無實時中間結果
 * （雲端批量識別，非流式），錄音期間由頁面以「正在聆聽」狀態提示。
 *
 * 依賴方向說明：本模組位於互動層，經 services/cloud（wx API 唯一
 * 封裝層）完成雲端呼叫，符合規範 § 12.3。
 */

import { postContainer } from '../services/cloud';
import { info as logInfo, warn as logWarn } from '../utils/logger';

/** 語音輸入選項 */
export interface VoiceOptions {
  /** 雲端環境 ID（callContainer 必填，由頁面傳入） */
  cloudEnv: string;
  /** 會話 ID（透傳雲端做日誌關聯，可選） */
  sessionId?: string;
  /** 最大錄音時長 ms（上限 60000，預設 60000；屆時自動結束並識別） */
  maxDurationMs?: number;
}

/** RecorderManager 最小介面（僅聲明用到的成員；基礎庫 1.6.0+） */
interface RecorderManager {
  start(opts: {
    duration?: number;
    sampleRate?: number;
    numberOfChannels?: number;
    format?: string;
  }): void;
  stop(): void;
  /** 錄音結束（含 duration 屆滿自動結束），tempFilePath 為臨時音頻檔 */
  onStop(cb: (res: { tempFilePath: string }) => void): void;
  onError(cb: (err: { errMsg?: string }) => void): void;
}

/** 全局 wx 最小介面（僅聲明本模組觸達的 API） */
interface WxLike {
  getRecorderManager?: () => unknown;
  getFileSystemManager?: () => {
    readFile(opts: {
      filePath: string;
      encoding: string;
      success: (res: { data: string }) => void;
      fail: (err: { errMsg?: string }) => void;
    }): void;
  };
}

/** 取全局 wx（微信運行時注入；開發者工具 / 單元測試可能缺席） */
function getWx(): WxLike | undefined {
  return (globalThis as { wx?: WxLike }).wx;
}

/** RecorderManager 探測結果緩存（undefined = 尚未探測；null = 不可用） */
let recorderProbe: RecorderManager | null | undefined;

/**
 * 取得錄音 manager（冪等；不可用時快取 null 不再重試）
 *
 * wx.getRecorderManager 為基礎庫內建（無需任何聲明或授權配置，
 * scope.record 權限在首次 start 時由系統彈窗申請）。
 */
function getRecorderManager(): RecorderManager | null {
  if (recorderProbe !== undefined) return recorderProbe;
  try {
    const mgr = getWx()?.getRecorderManager?.() as RecorderManager | undefined;
    recorderProbe = typeof mgr?.start === 'function' ? mgr : null;
  } catch {
    recorderProbe = null;
  }
  if (recorderProbe === null) logWarn('RecorderManager 不可用，語音輸入關閉');
  return recorderProbe;
}

/** 語音輸入是否可用（頁面據此決定是否渲染麥克風按鈕） */
export function isVoiceAvailable(): boolean {
  return getRecorderManager() !== null;
}

/** 讀取臨時音頻檔為 base64 */
function readFileBase64(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fsm = getWx()?.getFileSystemManager?.();
    if (!fsm) {
      reject(new Error('getFileSystemManager 不可用'));
      return;
    }
    fsm.readFile({
      filePath,
      encoding: 'base64',
      success: (res) => resolve(res.data),
      fail: (err) => reject(new Error(err?.errMsg ?? 'readFile 失敗')),
    });
  });
}

/**
 * 上傳音頻並取得識別文本（雲端 /api/stt/recognize → MiniMax asr-1.0）
 *
 * 超時 30s（上傳 + 識別），不額外重試——postContainer 內建重試已覆蓋
 * 網路閃斷，識別失敗由用戶重說一次即可（語音輸入天然可重放）。
 */
async function recognizeAudio(
  filePath: string,
  cloudEnv: string,
  sessionId?: string,
): Promise<string> {
  const audioBase64 = await readFileBase64(filePath);
  const resp = await postContainer<{ text?: string; durationSec?: number }>(
    cloudEnv,
    '/api/stt/recognize',
    { audioBase64 },
    { sessionId, timeoutMs: 30_000 },
  );
  if (resp.code !== 0 || typeof resp.data?.text !== 'string') {
    throw new Error(resp.message ?? `語音識別失敗（code=${resp.code}）`);
  }
  return resp.data.text;
}

/** 進行中的語音會話（重入保護：同一時刻僅一個識別會話） */
let activeSession: VoiceRecognitionSession | null = null;

/** 語音識別會話：stop 結束錄音、上傳識別並取得最終文本 */
export interface VoiceRecognitionSession {
  /** 結束錄音並識別，resolve 最終文本（已 trim；識別失敗 reject） */
  stop(): Promise<string>;
  /** 放棄本次識別（靜默丟棄結果；頁面 onUnload 等場景） */
  abort(): void;
}

/**
 * 開始語音錄音
 *
 * @param opts 語音選項（cloudEnv 必填；時長上限 60s）
 * @returns 語音會話；錄音能力不可用 / 已有進行中會話時拋錯
 */
export function startVoiceRecognition(opts: VoiceOptions): VoiceRecognitionSession {
  const recorder = getRecorderManager();
  if (!recorder) {
    throw new Error('語音輸入不可用（錄音能力未就緒）');
  }
  if (activeSession) {
    throw new Error('已有進行中的語音識別');
  }

  const duration = Math.min(Math.max(opts.maxDurationMs ?? 60_000, 1000), 60_000);

  // settle 模型：onStop → 上傳識別完成 / onError 任一先到即定案；
  // stop() 可在定案前後呼叫（60s 超時自動結束時 stop() 尚未被呼叫，
  // 識別結果先落地，後續 stop 直接取值）；abort() 定案後到達的
  // onStop 直接丟棄——已放棄的音頻不上傳雲端（隱私 + 免計費）
  let settled = false;
  let finalText = '';
  let waiters: Array<{ resolve: (t: string) => void; reject: (e: Error) => void }> = [];

  const settle = (text: string | null, errMsg?: string): void => {
    if (settled) return;
    settled = true;
    activeSession = null;
    if (text !== null) finalText = text;
    for (const w of waiters) {
      if (errMsg) w.reject(new Error(errMsg));
      else w.resolve(finalText);
    }
    waiters = [];
  };

  // recorder 回調為覆蓋式註冊（manager 為全局單例），每次會話重掛
  recorder.onStop(async (res) => {
    // 已定案（abort 取消後 stop() 觸發 / onError 已分流）：不上傳已放棄的音頻
    if (settled) return;
    try {
      const text = await recognizeAudio(res.tempFilePath, opts.cloudEnv, opts.sessionId);
      settle(text.trim());
      logInfo(`語音識別完成：${finalText.slice(0, 40)}`);
    } catch (e) {
      settle(null, `語音識別失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  });
  recorder.onError((err) => {
    // 常見：用戶拒絕錄音授權（scope.record）、錄音被系統中斷
    settle(null, `錄音失敗：${err?.errMsg ?? '未知錯誤'}`);
  });

  // 16kHz 單聲道 mp3：官方與 MiniMax asr 共同建議的低規格壓縮組合
  //（識別品質不受影響，體積僅為高規格錄音的零頭，base64 後遠低於
  // 雲端 1MB body 上限）
  recorder.start({
    duration,
    sampleRate: 16_000,
    numberOfChannels: 1,
    format: 'mp3',
  });

  const session: VoiceRecognitionSession = {
    stop(): Promise<string> {
      if (settled) return Promise.resolve(finalText);
      const p = new Promise<string>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
      recorder.stop();
      return p;
    },
    abort(): void {
      settle('', '語音識別已取消');
      recorder.stop();
    },
  };
  activeSession = session;
  return session;
}
