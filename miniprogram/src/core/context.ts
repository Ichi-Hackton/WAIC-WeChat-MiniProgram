/**
 * Agent 上下文構造器
 *
 * 規範來源：.qoder/rules/Agent.md § 6.3
 *
 * 構造完整 AgentContext，注入：
 *   - sessionId（自動產生）
 *   - userId（從緩存 / 雲端取得）
 *   - 用戶畫像（含位置，從 wx.getLocation 取得）
 *   - globals（雲端環境 ID 等）
 *   - trace（追蹤資訊）
 */

import { genSessionId } from '../utils/idgen';
import { now as _now } from '../utils/datetime';
import { getCachedOpenid } from '../services/identity';
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

/** 透過微信原生 API 取得位置（包裝） */
function fetchLocation(): Promise<{ lat: number; lng: number; city?: string } | undefined> {
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
        resolve({ lat: r.latitude, lng: r.longitude, city: r.city });
      })
      .catch((e: unknown) => {
        logError('取得位置失敗', e);
        resolve(undefined);
      });
  });
}

/** 構造 AgentContext */
export async function buildContext(opts: BuildContextOptions): Promise<AgentContext> {
  const sessionId = opts.sessionId ?? genSessionId();
  let userId = opts.userId ?? getCachedOpenid() ?? 'anonymous';
  // 若 userId 是匿名但有 cloudEnv 與本地 code，嘗試一次身份獲取（可選）
  if (userId === 'anonymous') {
    logInfo('尚無 userId，使用匿名身份（MVP 階段）');
  }

  const location = opts.withLocation !== false ? await fetchLocation() : undefined;

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