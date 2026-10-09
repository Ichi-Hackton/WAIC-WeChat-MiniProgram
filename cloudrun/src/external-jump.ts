/**
 * 外部渠道跳轉目標集中配置
 *
 * 2026-10 真實渠道上線改造：火車票 / 機票 / 京東購物 / 美團預約改為
 * 「生成資訊卡 → 跳轉官方小程序 → 官方側完成真實交易」模式。跳轉目標
 * appId 集中於 EXTERNAL_JUMP 環境變數（JSON），真機驗證後一處修正即全局生效。
 *
 * 環境變數格式（未配置的 target 回退 copy-only：僅複製資訊不跳轉）：
 *   EXTERNAL_JUMP={"train_12306":{"appId":"wx…","path":"pages/index/index"},
 *                  "ota_flight":{"appId":"wx…"},
 *                  "jd":{"appId":"wx91d27bd997970158"},
 *                  "meituan":{"appId":"wx…","path":"…"}}
 *
 * 微信平台約束：每個小程序可跳轉的外部小程序上限 10 個（當前 4 個，安全）；
 * 跳轉前微信強制彈窗徵求用戶確認（屬預期交互，不可繞過）。
 */

/** 跳轉目標宣告（appId 為空 = 該渠道暫未接入，前端僅提供複製） */
export interface JumpTarget {
  appId: string;
  /** 目標小程序頁面路徑（可帶 query；缺省開首頁） */
  path?: string;
}

/** 協議支援的跳轉渠道識別字（taobao 無微信小程序，恆為 copy-only） */
export type JumpTargetKey = 'train_12306' | 'ota_flight' | 'jd' | 'meituan' | 'taobao' | 'none';

/**
 * 預設目標表（EXTERNAL_JUMP 未配置 / 部分配置時的兜底）
 *
 * 僅京東購物小程序 appId 為公開確定值；12306 / OTA / 美團的 appId 與
 * 可用 path 需真機驗證後經 EXTERNAL_JUMP 覆蓋（空字串 = copy-only 降級）。
 */
const DEFAULT_TARGETS: Record<JumpTargetKey, JumpTarget> = {
  train_12306: { appId: '' },
  ota_flight: { appId: '' },
  jd: { appId: 'wx91d27bd997970158' },
  meituan: { appId: '' },
  // 淘寶系無微信小程序：微信生態内無法直接跳轉，固定走淘口令複製
  taobao: { appId: '' },
  // 演示商品 / 無渠道兜底：僅複製清單，不跳轉
  none: { appId: '' },
};

/** 已解析的目標表（首次訪問時解析環境變數並與預設表合併） */
let resolved: Record<JumpTargetKey, JumpTarget> | null = null;

function resolveTargets(): Record<JumpTargetKey, JumpTarget> {
  if (resolved) return resolved;
  const merged: Record<JumpTargetKey, JumpTarget> = { ...DEFAULT_TARGETS };
  const raw = process.env.EXTERNAL_JUMP;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<Record<JumpTargetKey, Partial<JumpTarget>>>;
      for (const key of Object.keys(merged) as JumpTargetKey[]) {
        const override = parsed[key];
        if (!override || typeof override !== 'object') continue;
        if (typeof override.appId === 'string') merged[key] = { ...merged[key], appId: override.appId.trim() };
        if (typeof override.path === 'string' && override.path) merged[key] = { ...merged[key], path: override.path };
      }
    } catch (e) {
      console.error('[external-jump] EXTERNAL_JUMP 解析失敗（JSON 形態非法），使用預設表：', e instanceof Error ? e.message : e);
    }
  }
  resolved = merged;
  return merged;
}

/** 取跳轉目標；appId 為空時回傳 null（呼叫方走 copy-only 降級） */
export function getJumpTarget(key: JumpTargetKey): JumpTarget | null {
  const target = resolveTargets()[key];
  return target.appId ? target : null;
}

/**
 * 構造跳轉包（各 skill book/checkout 端點的 jump 欄位統一結構）
 *
 * appId 為空時仍攜帶空串與 note 說明，前端據 appId 空值隱藏跳轉按鈕、僅留複製。
 */
export function buildJump(
  key: JumpTargetKey,
  copyText: string,
  extras?: { jCommand?: string; path?: string },
): {
  target: JumpTargetKey;
  appId: string;
  path?: string;
  jCommand?: string;
  copyText: string;
  note: string;
} {
  const target = getJumpTarget(key);
  return {
    target: key,
    appId: target?.appId ?? '',
    ...(extras?.path || target?.path ? { path: extras?.path ?? target?.path } : {}),
    ...(extras?.jCommand ? { jCommand: extras.jCommand } : {}),
    copyText,
    note: '真實交易於外部官方渠道完成，支付與售後以渠道為準',
  };
}
