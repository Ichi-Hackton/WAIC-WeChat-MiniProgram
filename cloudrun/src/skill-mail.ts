/**
 * 設備通訊 SKILL 端點 — 郵件發送（skill.device.comm / send_mail）
 *
 * 端點（與小程序端 device-comm SKILL 呼叫路徑逐字對齊）：
 *   POST /api/skill/skill.device.comm/send_mail   body: { to, subject?, body? }
 *
 * 發送通道（優先級）：
 *   1. 用戶自帶憑據（body.userSmtp：個人資料頁綁定的自有郵箱，
 *      host 經 SSRF 私網阻斷校驗；憑據僅發送瞬態使用，不落庫不打日誌）
 *   2. 運營方預設（環境變數，與 AMAP_KEY / VARIFLIGHT_API_KEY 同構）：
 *      MAIL_SMTP_HOST / MAIL_SMTP_PORT / MAIL_SMTP_USER / MAIL_SMTP_PASS
 *      （郵箱授權碼，非登入密碼）/ MAIL_FROM（可選，缺省 = MAIL_SMTP_USER）
 * 兩者皆無 → 業務碼 503，小程序端自動降級為「複製到剪貼簿引導發送」
 * （與 counseling 503 / weather 離線降級同構，鏈路不斷裂）。
 *
 * 合規與防護（規範 § 10）：
 *   1. 寫操作鑑權：x-wx-openid 缺失 401
 *   2. 頻控：每 openid 滾動 24h 最多 10 封（記憶體計數——個人郵箱 SMTP
 *      日限約幾十封，被刷爆會連累發件帳號被郵商限流；重啟清零可接受）
 *   3. 隱私：郵件內容僅即時轉發 SMTP，不落庫；日誌收件人脫敏
 *      （local 部分摺疊為 ***，與乘車人日誌不落明文同規）
 *   4. 防注入：僅透傳純文本 text（不透傳 HTML / 附件欄位），
 *      主題 / 正文長度截斷（與小程序端入參上限對齊）
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized } from './api';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { isPublicIpLiteral } from './skill-dynamic-connectors';

/** nodemailer 僅類型層引用（編譯後消失），運行時於已配置環境動態加載 */
import type { Transporter } from 'nodemailer';

interface SendMailInput {
  to?: string;
  subject?: string;
  body?: string;
  /** 用戶自帶 SMTP 憑據（個人資料頁綁定；可選，優先於運營方預設） */
  userSmtp?: unknown;
}

/** 用戶自帶 SMTP 憑據（內部形態） */
interface UserSmtp {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** 郵箱形態（與小程序端 device-comm EMAIL_RE 逐字對齊） */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** 欄位長度上限（與小程序端 MAX_MAIL_FIELD_CHARS 對齊，防超長注入） */
const MAX_FIELD_CHARS = 500;

/** 頻控：滾動 24h 窗口，每用戶最多 10 封 */
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT = 10;

/** 記憶體頻控計數（openid → 窗口起點與計數；容器重啟清零） */
const sendCounters = new Map<string, { windowStart: number; count: number }>();

/** 字串清洗：去首尾空白 + 截斷（未知形態防禦窄化） */
function sanitizeStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 收件人脫敏（local 部分摺疊，域名保留供排查定向） */
function maskEmail(addr: string): string {
  const at = addr.indexOf('@');
  return at > 0 ? `***${addr.slice(at)}` : '***';
}

/** 頻控檢查與計數（超限返回 false） */
function acquireQuota(openid: string): boolean {
  const now = Date.now();
  const rec = sendCounters.get(openid);
  if (!rec || now - rec.windowStart >= RATE_WINDOW_MS) {
    sendCounters.set(openid, { windowStart: now, count: 1 });
    return true;
  }
  if (rec.count >= RATE_LIMIT) return false;
  rec.count += 1;
  return true;
}

/** SMTP 環境配置萃取（缺任一必要項返回 null → 503 降級語義） */
function smtpConfig(): { host: string; port: number; user: string; pass: string; from: string } | null {
  const host = process.env.MAIL_SMTP_HOST;
  const user = process.env.MAIL_SMTP_USER;
  const pass = process.env.MAIL_SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = Number(process.env.MAIL_SMTP_PORT ?? 465);
  return { host, port, user, pass, from: process.env.MAIL_FROM || user };
}

/**
 * 用戶自帶 SMTP 憑據萃取（欄位齊備且形態合法才透出；否則視為未攜帶）
 *
 * pass 不做內容校驗（各家授權碼 / 自建密碼形態各異，長度截斷防禦即可）
 */
function userSmtpConfig(raw: unknown): UserSmtp | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const host = typeof r.host === 'string' ? r.host.trim() : '';
  const user = typeof r.user === 'string' ? r.user.trim() : '';
  const pass = typeof r.pass === 'string' ? r.pass.slice(0, 128) : '';
  if (!host || !user || !pass) return null;
  if (host.length > 100 || !/^[A-Za-z0-9.-]+$/.test(host)) return null;
  const port = typeof r.port === 'number' && Number.isInteger(r.port) ? r.port : 465;
  if (port < 25 || port > 65535) return null;
  return { host, port, user, pass };
}

/**
 * 用戶自帶 SMTP host 的 SSRF 校驗（與動態技能 http 連接器同規）：
 * IP 字面量即刻校驗（拒私網 / 回環 / 鏈路本地——含雲 metadata
 * 169.254.169.254）；域名解析全部記錄均須公網（防混合記錄繞過）。
 * 校驗後由 nodemailer 自行解析連線，TOCTOU 窗口與
 * assertMcpEndpointAllowed 同權衡（信任面：域名郵商不可控場景極罕見）。
 */
async function assertSmtpHostAllowed(host: string): Promise<void> {
  if (isPublicIpLiteral(host)) return;
  // 非「公網 IP 字面量」但形似 IP 字面量（私網 v4 / v6）→ 拒
  if (host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    throw new Error('private_address');
  }
  const all = await new Promise<LookupAddress[]>((resolve, reject) => {
    dnsLookup(host, { all: true }, (err, addresses) => {
      if (err) reject(new Error('dns_failed'));
      else resolve(addresses as LookupAddress[]);
    });
  });
  for (const addr of all) {
    if (!isPublicIpLiteral(addr.address)) throw new Error('private_address');
  }
}

const handleSendMail: RouteHandler = async (body, ctx) => {
  const input = (body ?? {}) as SendMailInput;
  const to = sanitizeStr(input.to, 100);
  const subject = sanitizeStr(input.subject, MAX_FIELD_CHARS);
  const text = sanitizeStr(input.body, MAX_FIELD_CHARS);
  if (!to || !EMAIL_RE.test(to)) {
    return badRequest('to 必須為合法郵箱地址（如 name@example.com）');
  }
  // 寫操作鑑權（規範 § 10 SKILL 越權防護）
  if (!ctx.openid) {
    return unauthorized('缺少調用方身份（x-wx-openid），拒絕發送');
  }

  // 用戶自帶憑據：SSRF 私網阻斷（用戶可控的 host 字段是內網探測面）
  const userCfg = userSmtpConfig(input.userSmtp);
  if (userCfg) {
    try {
      await assertSmtpHostAllowed(userCfg.host);
    } catch (e) {
      if (e instanceof Error && e.message === 'dns_failed') {
        return badRequest('SMTP 服務器域名無法解析，請核對後重試');
      }
      return badRequest('SMTP 服務器地址不合法（內網 / 保留位址已阻斷）');
    }
  }

  // 發送通道選擇：用戶自帶 > 運營方預設；兩者皆無 → 503 降級複製引導
  const cfg = userCfg
    ? { ...userCfg, from: userCfg.user }
    : smtpConfig();
  if (!cfg) {
    return fail(503, '尚未配置發件郵箱（可在小程序「我的 → 郵箱帳戶」綁定自己的郵箱後直接發送）');
  }

  // 頻控：超限拒發（複製降級仍可用——複製不經雲端，天然不受頻控影響）
  if (!acquireQuota(ctx.openid)) {
    return fail(429, `今日發送額度已用完（上限 ${RATE_LIMIT} 封），明天再試或複製內容手動發送`);
  }

  /*
   * 動態加載 nodemailer：未配置環境跳過加載（雖依賴已隨鏡像安裝，
   * 動態加載保證 503 路徑不因模組異常而 5xx）；模組缺失 / 加載失敗
   * 同樣走 502 讓小程序端降級複製，鏈路不斷裂
   */
  let transporter: Transporter;
  try {
    const nodemailer = await import('nodemailer');
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      // 465 為隱式 TLS；587 / 25 由 nodemailer 自動協商 STARTTLS
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  } catch (e) {
    console.error('[skill-mail] nodemailer 加載失敗（降級複製引導）：', e instanceof Error ? e.message : e);
    return fail(502, '郵件模組不可用');
  }

  try {
    const info = await transporter.sendMail({
      from: { name: 'MicroMate', address: cfg.from },
      to,
      subject: subject || '（無主題）',
      // 僅純文本：不透傳 HTML / 附件，收斂注入面
      text: text || `此郵件由 MicroMate（隨身個人 AI 助理）代 ${maskEmail(cfg.from)} 發送。`,
    });
    // 用戶自帶憑據路徑：通道來源標記（pass 絕不入日誌；user 經 maskEmail 脫敏）
    const via = userCfg ? ` user=${maskEmail(userCfg.user)}` : '';
    console.log(`[skill-mail] 已發送 to=${maskEmail(to)}${via} msgId=${String(info.messageId)}`);
    return ok({ to, subject: subject || '（無主題）', mode: 'sent' });
  } catch (e) {
    // 郵商拒信 / 網路超時 / 鑑權失敗：502 → 小程序端降級複製引導
    console.error(
      `[skill-mail] SMTP 發送失敗 to=${maskEmail(to)}：`,
      e instanceof Error ? e.message : e,
    );
    return fail(502, '郵件發送失敗（SMTP 上游錯誤），已可降級為複製引導');
  }
};

export const mailRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/skill/skill.device.comm/send_mail', handleSendMail],
];
