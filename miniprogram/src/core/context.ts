/**
 * Agent 上下文構造器
 *
 * 規範來源：.qoder/rules/Agent.md § 6.3
 *
 * 構造完整 AgentContext，注入：
 *   - sessionId（自動產生）
 *   - userId（從緩存 / 雲端取得）
 *   - 用戶畫像（座標從 wx.getLocation 取得，城市名經雲端逆地理編碼補全）
 *   - globals（雲端環境 ID 等）
 *   - trace（追蹤資訊）
 */

import { genSessionId } from '../utils/idgen';
import { now as _now } from '../utils/datetime';
import { getCachedOpenid } from '../services/identity';
import { reverseGeocode } from '../services/geo';
import { error as logError, info as logInfo } from '../utils/logger';
import type { AgentContext } from '../types/context';

export interface BuildContextOptions {
  /** 強制使用固定 sessionId（測試用） */
  sessionId?: string;
  /** 強制 userId（測試 / 已登入用） */
  userId?: string;
  /** 雲端環境 ID（必填） */
  cloudEnv: string;
  /** 是否嘗試取得地理位置，預設 true */
  withLocation?: boolean;
  /** 自訂 globals */
  globals?: Record<string, unknown>;
}

/** 透過微信原生 API 取得座標（包裝；基礎庫回應不含 city，見型別註釋） */
function fetchCoord(): Promise<{ lat: number; lng: number; rawCity?: string } | undefined> {
  return new Promise((resolve) => {
    const wxApi = (globalThis as { wx?: {
      getLocation?: (o: unknown) => Promise<unknown>;
    } }).wx;
    if (!wxApi?.getLocation) {
      resolve(undefined);
      return;
    }
    wxApi
      .getLocation({ type: 'gcj02' })
      .then((res: unknown) => {
        const r = res as { latitude?: number; longitude?: number; city?: string } | undefined;
        if (!r || r.latitude === undefined || r.longitude === undefined) {
          resolve(undefined);
          return;
        }
        resolve({ lat: r.latitude, lng: r.longitude, rawCity: r.city });
      })
      .catch((e: unknown) => {
        logError('取得位置失敗', e);
        resolve(undefined);
      });
  });
}

/**
 * 取得用戶位置（城市 + 座標）
 *
 * 城市來源：座標經雲端 /api/geo/reverse（天地圖代理，雙層快取）逆地理
 * 編碼補全；基礎庫原生 city（若未來擴展返回）優先於逆地理。
 *
 * 座標為可選增強（天氣等能力依賴）：定位未授權 / 失敗時無城市上下文，
 * 天氣等座標依賴能力由 Planner 追問定位（見 rule-planner 末尾分支）。
 */
async function fetchLocation(
  cloudEnv: string,
): Promise<{ lat?: number; lng?: number; city?: string } | undefined> {
  const coord = await fetchCoord();
  if (!coord) return undefined;
  if (coord.rawCity) {
    // 基礎庫未來若擴展返回 city，優先使用原生值，省一次雲端調用
    return { lat: coord.lat, lng: coord.lng, city: coord.rawCity };
  }
  const geo = await reverseGeocode(cloudEnv, coord.lat, coord.lng);
  return { lat: coord.lat, lng: coord.lng, city: geo?.city };
}

/** 構造 AgentContext */
export async function buildContext(opts: BuildContextOptions): Promise<AgentContext> {
  const sessionId = opts.sessionId ?? genSessionId();
  let userId = opts.userId ?? getCachedOpenid() ?? 'anonymous';
  // 若 userId 是匿名但有 cloudEnv 與本地 code，嘗試一次身份獲取（可選）
  if (userId === 'anonymous') {
    logInfo('尚無 userId，使用匿名身份（MVP 階段）');
  }

  const location = opts.withLocation !== false ? await fetchLocation(opts.cloudEnv) : undefined;

  const ctx: AgentContext = {
    sessionId,
    userId,
    userProfile: {
      ...(location ? { location } : {}),
      preferences: {},
      history: [],
    },
    globals: {
      cloudEnv: opts.cloudEnv,
      ...(opts.globals ?? {}),
    },
    messages: [],
    trace: {
      llmCalls: 0,
      skillCalls: 0,
      totalTokens: 0,
      startTime: _now(),
    },
  };
  return ctx;
}

/** 把用戶訊息追加到 ctx.messages（不持久化，僅記憶） */
export function pushMessage(
  ctx: AgentContext,
  msg: Parameters<AgentContext['messages']['push']>[0],
): void {
  ctx.messages.push(msg);
  // 防止記憶體爆掉，僅保留最近 20 條
  if (ctx.messages.length > 20) {
    ctx.messages.splice(0, ctx.messages.length - 20);
  }
}