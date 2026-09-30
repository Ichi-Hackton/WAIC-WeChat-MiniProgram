/**
 * 雲端 API 協議層 — 型別與回應封裝
 *
 * 與小程序端 services/cloud.ts 的 CloudResponse 協議嚴格對齊：
 *   - HTTP 200 + { code: 0, data } → 業務成功
 *   - HTTP 200 + { code: 非0, message } → 業務失敗（SKILL 層翻譯為 SkillError）
 *   - HTTP 5xx → 網路層錯誤（小程序端觸發重試；429/503 視為可重試）
 */

/** 雲端標準回應格式（與小程序端 services/cloud.ts CloudResponse 對齊） */
export interface CloudResponse<T = unknown> {
  /** 業務狀態碼，0 表示成功 */
  code: number;
  /** 人類可讀訊息 */
  message?: string;
  /** 業務資料 */
  data?: T;
}

/** 每次請求的上下文（由 server.ts 從請求頭萃取） */
export interface RequestContext {
  /** 微信雲托管注入的調用方 OpenID（header: x-wx-openid） */
  openid?: string;
  /** 小程序端附加的會話 ID（header: x-micromate-session） */
  sessionId?: string;
}

/** 路由處理器回傳：HTTP 狀態碼 + 業務回應體 */
export interface HandlerResult {
  httpStatus: number;
  body: CloudResponse;
}

/** 路由處理器簽名：入參為已解析的 JSON body（可能為 undefined） */
export type RouteHandler = (
  body: unknown,
  ctx: RequestContext,
) => Promise<HandlerResult>;

/** 業務成功回應（HTTP 200） */
export function ok<T>(data: T): HandlerResult {
  return { httpStatus: 200, body: { code: 0, data } };
}

/** 業務失敗回應（HTTP 200，由 SKILL 層翻譯為 SkillError） */
export function fail(code: number, message: string): HandlerResult {
  return { httpStatus: 200, body: { code, message } };
}

/** 參數 / 請求格式錯誤（HTTP 400） */
export function badRequest(message: string): HandlerResult {
  return { httpStatus: 400, body: { code: 400, message } };
}

/** 未鑒權：缺少調用方身份（HTTP 401，寫操作紅線） */
export function unauthorized(message: string): HandlerResult {
  return { httpStatus: 401, body: { code: 401, message } };
}

/** 無權操作他人資源（HTTP 403，歸屬鑒權） */
export function forbidden(message: string): HandlerResult {
  return { httpStatus: 403, body: { code: 403, message } };
}
