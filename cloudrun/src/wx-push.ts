/**
 * 微信開放接口推送 + 定時觸發器鑒權（monitors / trip-remind 共享基建）
 *
 * 2026-10 第二梯隊·項B（出發提醒推模式）從 monitors.ts 抽出：餘票監控與
 * 出發提醒都需要「access_token 換取 + subscribe/send」與「CRON_TOKEN 恆定
 * 時間校驗」，模板 ID / 落地頁 / 欄位由調用方構造。
 *
 * 設計要點：
 * 1. 配置驅動（不演）：WX_APPID / WX_APPSECRET 缺失時 sendSubscribeMessage
 *    直接返回 'error'，調用方按拉模式語義降級（僅落標記，不虛報已推送）
 * 2. access_token 記憶體快取（過期前 5 分鐘重用；單實例夠用）
 * 3. 43101（用戶未訂閱 / 額度耗盡）獨立分流 'not_subscribed'——一次性
 *    訂閱消息的額度語義由調用方決策（重試無意義時直接收斂）
 */

import { timingSafeEqual } from 'node:crypto';
import { unauthorized } from './api';

/**
 * CRON_TOKEN 恆定時間校驗（定時觸發器端點共享鑒權）
 *
 * 恆定時間比較（2026-10 審計 P3）：普通 !== 的逐字元短路會泄漏前綴匹配
 * 長度，攻擊者可據此逐字節爆破 token；長度先比（長度非秘密，不構成可
 * 利用的時序信道），等長再 timingSafeEqual。CRON_TOKEN 未配置時
 * fail-closed（掃描通道整體關閉）。
 *
 * @returns null 表示校驗通過；非 null 為應直接返回的 401 回應
 */
export function verifyCronToken(body: unknown): ReturnType<typeof unauthorized> | null {
  const expected = process.env.CRON_TOKEN;
  if (!expected) return unauthorized('CRON_TOKEN 未配置，掃描通道關閉（fail-closed）');
  const got = typeof (body as { token?: unknown } | undefined)?.token === 'string'
    ? String((body as { token?: unknown }).token)
    : '';
  const gotBuf = Buffer.from(got, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (gotBuf.length !== expBuf.length || !timingSafeEqual(gotBuf, expBuf)) {
    return unauthorized('CRON_TOKEN 不符');
  }
  return null;
}

/** access_token 快取條目（過期前 5 分鐘視為失效，提前刷新） */
let cachedToken: { token: string; expireAt: number } | null = null;

/** 微信開放接口單次請求超時（token 換取與訂閱消息發送對稱防護：串行 tick
 * 中單個掛起連接會拖住整輪掃描直至觸發器超時） */
const WX_API_TIMEOUT_MS = 8_000;

/**
 * 換取 access_token（快取重用）
 *
 * @returns token；WX_APPID / WX_APPSECRET 缺失或換取失敗時返回 null
 */
async function getAccessToken(): Promise<string | null> {
  const appid = process.env.WX_APPID;
  const secret = process.env.WX_APPSECRET;
  if (!appid || !secret) return null;
  if (cachedToken && Date.now() < cachedToken.expireAt) return cachedToken.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WX_API_TIMEOUT_MS);
  try {
    const resp = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`,
      { signal: controller.signal },
    );
    const json = (await resp.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
      | null;
    if (!json?.access_token) {
      console.error('[wx-push] access_token 獲取失敗：', json?.errcode, json?.errmsg);
      return null;
    }
    // 官方 expires_in 約 7200s；提前 5 分鐘過期防臨界失效
    cachedToken = {
      token: json.access_token,
      expireAt: Date.now() + (Number(json.expires_in) || 7200) * 1000 - 5 * 60 * 1000,
    };
    return json.access_token;
  } catch (e) {
    console.error('[wx-push] access_token 換取異常：', e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 訂閱消息發送結果分流（額度語義由調用方決策） */
export type SendResult = 'ok' | 'not_subscribed' | 'error';

/**
 * 發送訂閱消息（模板 / 落地頁 / data 欄位由調用方構造）
 *
 * 注意：data 欄位名（thing1 / thing2 ...）須與實際申請的模板欄位一致，
 * 部署側申請模板後同步調整調用方構造處。
 *
 * @returns 'ok' 發送成功；'not_subscribed' 用戶未訂閱（43101，正常業態，
 *   一次性額度耗盡 / 未授權）；'error' 配置缺失或發送失敗
 */
export async function sendSubscribeMessage(
  openid: string,
  tmplId: string,
  page: string,
  data: Record<string, { value: string }>,
): Promise<SendResult> {
  const token = await getAccessToken();
  if (!token) return 'error';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WX_API_TIMEOUT_MS);
  try {
    const resp = await fetch(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ touser: openid, template_id: tmplId, page, data }),
        signal: controller.signal,
      },
    );
    const json = (await resp.json().catch(() => null)) as { errcode?: number; errmsg?: string } | null;
    if (json?.errcode === 0) return 'ok';
    if (json?.errcode === 43101) {
      // 用戶未訂閱：正常業態（拉模式用戶），記 info 不報錯
      console.log('[wx-push] 用戶未訂閱模板，僅落標記（拉模式）');
      return 'not_subscribed';
    }
    console.error('[wx-push] 訂閱消息發送失敗：', json?.errcode, json?.errmsg);
    return 'error';
  } catch (e) {
    console.error('[wx-push] 訂閱消息推送異常：', e instanceof Error ? e.message : e);
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}
