/**
 * 設備通訊 SKILL（skill.device.comm）
 *
 * 規範來源：.qoder/rules/Agent.md § 7.1；2026-10 設備通訊域擴展
 *
 * 提供能力：
 *   - dial_phone：撥打電話（拉起微信撥號面板，本地設備能力，離線可用）
 *   - draft_mail：起草郵件（雲端 LLM 代寫主題 + 正文，輸出 data.subject /
 *                 data.body 供 send_mail 跨任務綁定；純生成無副作用，
 *                 確認卡在 send_mail 環節把關草稿全文，項D）
 *   - send_mail ：發送郵件（雲端 SMTP 代發真發送；雲端不可用 / 未配置
 *                 SMTP / 超頻控時自動降級「複製到剪貼簿引導發送」）
 *
 * 差異維度：
 *   1. 撥號為本地設備 API（經 services/device 封裝，非第三方 API，離線
 *      可用）；發送郵件為雲端代發（經 wx.cloud.callContainer，§ 7.1）
 *   2. idempotent 恒 false：撥號 / 發信均為即時動作（非查詢），結果快取
 *      會讓第二次呼叫直接返回舊結果而跳過真實執行
 *   3. 撥號安全網：wx.makePhoneCall 拉起系統撥號面板後仍需用戶手動點
 *      「呼叫」——天然 human-in-the-loop，無需 requiresHumanConfirm；
 *      發信安全網：send_mail 設 requiresHumanConfirm=true（郵件一經發出
 *      不可撤回 + 內容出站屬隱私場景，規範 § 7.1 第 4 條「不可逆 / 隱私
 *      場景可手動設 true」；當前 checkpoint 彈窗全局禁用，屬性聲明語義，
 *      未來重啟彈窗時自動納入）
 *   4. 發信降級鏈（與 counseling 503 / weather 離線降級同構，鏈路不斷裂）：
 *      雲端 503（SMTP 未配置）/ 502（上游失敗）/ 429（頻控）/ 負數碼
 *      （雲不可達）/ 網路層 reject → 本地複製郵件內容引導手動發送；
 *      400 / 401 等鏈路異常碼如實透傳，不降級掩蓋問題
 *   5. 起草鏈路（2026-10 第二梯隊·項D）：「幫我寫封郵件」拆 draft_mail
 *      → send_mail 兩任務（inputBindings 綁 data.subject / data.body）；
 *      起草失敗時鏈路如實失敗（send_mail 級聯跳過），不降級為空正文
 *      發送——「起草失敗卻發出空郵件」比失敗更糟
 */

import type { AgentContext } from '../../../types/context';
import type { SkillInstance, SkillResult, SkillMeta } from '../../../types/skill';
import { dialPhone, copyText } from '../../../services/device';
import { postContainer, type CloudResponse } from '../../../services/cloud';
import { callLLM } from '../../../services/llm';
import { getMailAccount } from '../../../storage/mail-account';

/** 電話號碼長度上限（截斷防禦，正常號碼遠短於此） */
const MAX_PHONE_LEN = 20;

/** 郵件單欄位長度上限（字元；與雲端 skill-mail.ts 對齊，防超長注入） */
const MAX_MAIL_FIELD_CHARS = 500;

/**
 * 合法電話號碼形態（大陸常用）：
 *   - 手機號：1[3-9] 開頭 11 位
 *   - 座機：區號 3-4 位 + 連字符 + 7-8 位
 *   - 公共熱線短號：5-6 位（10086 / 12306 / 12356 / 95xxx 等）
 *   - 400 熱線：400[-]3-4 位[-]3-4 位
 */
const PHONE_RE =
  /^1[3-9]\d{9}$|^\d{3,4}-\d{7,8}$|^\d{5,6}$|^400-?\d{3,4}-?\d{3,4}$/;

/** 郵箱地址形態（與雲端 skill-mail.ts EMAIL_RE 逐字對齊） */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * 起草 system prompt（jsonMode：雲端切換 JSON 模型，輸出 {subject, body}）
 *
 * 事實約束：僅使用用戶給出的事實——起草是代筆不是代編，編造日期 /
 * 數據會以用戶名義出站（生成內容以用戶身分發送須真實，§ 10 紅線）
 */
const DRAFT_SYSTEM_PROMPT = [
  '你是郵件代筆助手。根據用戶提供的主題要點與正文要點起草一封郵件。',
  '規則：正文 80–200 字、簡潔得體；只使用用戶給出的事實，嚴禁編造日期 / 數據 / 稱謂；未提供的要點以中性表述帶過，不添加佔位符。',
  '只輸出 JSON：{"subject": "主題（15 字內）", "body": "正文"}',
].join('\n');

export interface DialPhoneInput {
  phoneNumber: string;
}

export interface DialPhoneOutput {
  phoneNumber: string;
  /** 撥號面板已拉起（用戶是否真按下呼叫由系統面板承接，小程序不可見） */
  status: 'panel_opened';
}

export interface SendMailInput {
  to: string;
  subject?: string;
  body?: string;
}

export interface DraftMailInput {
  to: string;
  /** 主題要點（如「請假」「進度同步」；可選） */
  topic?: string;
  /** 正文要點 / 背景（原樣摘自用戶要求，起草的唯一事實依據；可選） */
  context?: string;
}

export interface DraftMailOutput {
  to: string;
  /** LLM 起草的主題（send_mail 綁定路徑 data.subject） */
  subject: string;
  /** LLM 起草的正文（send_mail 綁定路徑 data.body；與確認卡所見一致） */
  body: string;
}

export interface SendMailOutput {
  to: string;
  subject: string;
  body: string;
  /** sent = 雲端 SMTP 已發出；copied = 雲端不可用已降級複製引導 */
  mode: 'sent' | 'copied';
  /** copied 模式：已複製到剪貼簿的完整郵件文本（sent 模式省略） */
  copiedText?: string;
  /** 給用戶的結果說明（發送回執 / 降級引導） */
  guidance: string;
}

/** 雲端 send_mail 請求體（to / subject / body + 可選用戶自有 SMTP 憑據） */
interface SendMailRequest {
  to: string;
  subject: string;
  body: string;
  /** 用戶在個人資料頁綁定的自有發件通道（優先級高於運營方預設；未綁定省略） */
  userSmtp?: { host: string; port: number; user: string; pass: string };
}

/** 郵件文本組裝（收件人 / 主題 / 正文；與剪貼簿內容逐字一致） */
function buildMailText(input: { to: string; subject: string; body: string }): string {
  return [`收件人：${input.to}`, `主題：${input.subject}`, '', input.body].join('\n');
}

/** 欄位清洗：去首尾空白 + 截斷（未知形態防禦窄化） */
function sanitize(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export const meta = {
  id: 'skill.device.comm',
  name: '設備通訊（撥打電話 / 發郵件）',
  description:
    '【能做】撥打電話（dial_phone：拉起撥號面板撥打手機號 / 座機 / 10086 等公共熱線）；起草郵件（draft_mail：根據你給的要點代寫主題與正文）；發送郵件（send_mail：經雲端 SMTP 真實發出到指定郵箱——用戶在個人資料頁綁定自有郵箱時以其名義發出，雲端不可用時自動降級為複製內容引導手動發送）。\n' +
    '【不能做】不能代替用戶按下「呼叫」（撥號面板由用戶最終確認）；不能保證郵件必達（以收件方郵箱收信為準）；不能撥打境外號碼；起草不會編造你未提供的事實。\n' +
    '【觸發時機】用戶說「打電話給 10086 / 撥打 138xxxx / 呼出熱線」「發郵件到 xx@xx.com」「幫我寫封郵件到 xx@xx.com 說⋯⋯」時。號碼與郵箱地址必須來自用戶原文，嚴禁推測。「幫我寫 / 代我寫」且正文未給全 → draft_mail + send_mail 兩任務鏈（send_mail 綁定 data.subject / data.body，確認卡所見即所發）；主題正文均已給全 → 單任務 send_mail 直達。',
  version: '2.1.0',
  owner: 'wx-micromate',
  tags: ['通訊', '設備'],
  capabilities: [
    {
      action: 'dial_phone',
      description: '撥打電話（拉起系統撥號面板；本地設備能力，無需雲端）',
      inputSchema: {
        type: 'object',
        required: ['phoneNumber'],
        properties: {
          phoneNumber: {
            type: 'string',
            description: '電話號碼：11 位手機號 / 座機（區號-號碼）/ 5-6 位熱線（如 10086、12306）',
            minLength: 5,
            maxLength: 20,
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['phoneNumber', 'status'],
        properties: {
          phoneNumber: { type: 'string' },
          status: { type: 'string' },
        },
      },
      idempotent: false,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 600,
    },
    {
      action: 'draft_mail',
      description:
        '起草郵件（雲端 LLM 代寫主題 + 正文；輸出 data.subject / data.body 供 send_mail 跨任務綁定，確認卡所見即所發）',
      inputSchema: {
        type: 'object',
        required: ['to'],
        properties: {
          to: {
            type: 'string',
            description: '收件人郵箱地址（原樣取自用戶原文，如 name@example.com）',
            maxLength: 100,
          },
          topic: { type: 'string', description: '主題要點（如「請假」「進度同步」；可選）' },
          context: { type: 'string', description: '正文要點 / 背景（原樣摘自用戶要求，起草的唯一事實依據；可選）' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['to', 'subject', 'body'],
        properties: {
          to: { type: 'string' },
          subject: { type: 'string', description: 'LLM 起草的主題（綁定路徑 data.subject）' },
          body: { type: 'string', description: 'LLM 起草的正文（綁定路徑 data.body）' },
        },
      },
      idempotent: false,
      reversible: false,
      requiresHumanConfirm: false,
      estimatedLatencyMs: 8000,
    },
    {
      action: 'send_mail',
      description:
        '發送郵件（雲端 SMTP 代發真實發送；雲端不可用時降級複製到剪貼簿引導發送，交付卡如實標註發送 / 複製模式）',
      inputSchema: {
        type: 'object',
        required: ['to'],
        properties: {
          to: {
            type: 'string',
            description: '收件人郵箱地址（如 name@example.com）',
            maxLength: 100,
          },
          subject: { type: 'string', description: '郵件主題（可選，缺省「（無主題）」）' },
          body: { type: 'string', description: '郵件正文（可選）' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['to', 'subject', 'body', 'mode', 'guidance'],
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          mode: { type: 'string', description: 'sent（已發出）/ copied（已複製引導）' },
          copiedText: { type: 'string' },
          guidance: { type: 'string' },
        },
      },
      idempotent: false,
      reversible: false,
      requiresHumanConfirm: true,
      estimatedLatencyMs: 3000,
    },
  ],
} as unknown as SkillMeta;

/**
 * 降級原因文案（含行動引導）：
 * 503 且用戶未綁定郵箱 → 提示綁定自有郵箱後即可直接發送（引導閉環）
 */
function degradeReason(res: CloudResponse<unknown>, hasAccount: boolean): string {
  if (res.code === 503 && !hasAccount) {
    return '尚未綁定發件郵箱；可在「我的 → 郵箱帳戶」綁定後直接發送';
  }
  return res.message ?? '通道不可用';
}

/**
 * 發信降級：複製郵件內容到剪貼簿，引導用戶到郵件 App 貼上發送
 * （小程序離線 / 雲端 SMTP 未配置 / 上游失敗 / 超頻控時的保底，鏈路不斷裂）
 */
async function degradeToCopy(
  fields: { to: string; subject: string; body: string },
  reason: string,
): Promise<SkillResult> {
  const copiedText = buildMailText(fields);
  try {
    await copyText(copiedText);
    return {
      success: true,
      data: {
        ...fields,
        mode: 'copied',
        copiedText,
        guidance: `雲端郵件通道暫不可用（${reason}）：內容已複製到剪貼簿，請到郵件 App 貼上發送。`,
      } satisfies SendMailOutput,
    };
  } catch {
    return {
      success: false,
      error: { code: 'CLIPBOARD_FAILED', message: '複製到剪貼簿失敗，請稍後再試', retryable: true },
    };
  }
}

export const instance: SkillInstance = {
  meta,
  async invoke(action, input, ctx: AgentContext): Promise<SkillResult> {
    if (action === 'dial_phone') {
      const req = input as Partial<DialPhoneInput>;
      const phoneNumber = sanitize(req?.phoneNumber, MAX_PHONE_LEN);
      if (!phoneNumber) {
        return {
          success: false,
          error: { code: 'INVALID_PHONE', message: '請提供要撥打的電話號碼', retryable: false },
        };
      }
      if (!PHONE_RE.test(phoneNumber)) {
        return {
          success: false,
          error: {
            code: 'INVALID_PHONE',
            message: '電話號碼格式不正確（支援手機號 / 座機 / 10086 類熱線短號）',
            retryable: false,
          },
        };
      }
      try {
        await dialPhone(phoneNumber);
        return {
          success: true,
          data: { phoneNumber, status: 'panel_opened' } satisfies DialPhoneOutput,
        };
      } catch {
        // 用戶取消面板 / 環境不支援：如實失敗（不假裝已撥出）
        return {
          success: false,
          error: {
            code: 'DIAL_CANCELLED',
            message: '已取消撥號，需要時可再說一次',
            retryable: false,
          },
        };
      }
    }

    if (action === 'draft_mail') {
      const req = input as Partial<DraftMailInput>;
      const to = sanitize(req?.to, 100);
      if (!to || !EMAIL_RE.test(to)) {
        return {
          success: false,
          error: {
            code: 'INVALID_EMAIL',
            message: !to ? '請提供收件人郵箱地址' : '郵箱地址格式不正確（如 name@example.com）',
            retryable: false,
          },
        };
      }
      const topic = sanitize(req?.topic, 200);
      const context = sanitize(req?.context, 1000);
      try {
        const env = ctx.globals.cloudEnv as string;
        const res = await callLLM(env, {
          messages: [
            { role: 'system', content: DRAFT_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                `收件人：${to}`,
                `主題要點：${topic || '（未提供，請自行概括）'}`,
                `正文要點：${context || '（未提供，起草一封簡短通用的詢問郵件）'}`,
              ].join('\n'),
            },
          ],
          temperature: 0.7,
          maxTokens: 500,
          jsonMode: true,
          sessionId: ctx.sessionId,
        });
        // 起草輸出抽 JSON + 窄化（LLM 輸出必須以正則抽取 JSON，規範 § 8.3 同款防禦）
        const m = res.text.match(/\{[\s\S]*\}/);
        let draft: { subject?: unknown; body?: unknown } | null = null;
        try {
          draft = m ? (JSON.parse(m[0]) as { subject?: unknown; body?: unknown }) : null;
        } catch {
          draft = null;
        }
        // 與 send_mail 側截斷口徑對齊（MAX_MAIL_FIELD_CHARS）：確認卡所見 = 實際發送
        const subject = sanitize(draft?.subject, MAX_MAIL_FIELD_CHARS);
        const body = sanitize(draft?.body, MAX_MAIL_FIELD_CHARS);
        if (!subject || !body) {
          return {
            success: false,
            error: { code: 'DRAFT_PARSE_FAILED', message: '起草結果不完整，請重試或改為口述全文', retryable: true },
          };
        }
        return {
          success: true,
          data: { to, subject, body } satisfies DraftMailOutput,
        };
      } catch {
        // LLM 不可用：起草如實失敗（下游 send_mail 級聯跳過，不降級為空正文發送）
        return {
          success: false,
          error: { code: 'DRAFT_LLM_FAILED', message: '郵件起草服務暫時不可用，請稍後再試', retryable: true },
        };
      }
    }

    if (action === 'send_mail') {
      const req = input as Partial<SendMailInput>;
      const to = sanitize(req?.to, 100);
      if (!to || !EMAIL_RE.test(to)) {
        return {
          success: false,
          error: {
            code: 'INVALID_EMAIL',
            message: !to ? '請提供收件人郵箱地址' : '郵箱地址格式不正確（如 name@example.com）',
            retryable: false,
          },
        };
      }
      const subject = sanitize(req?.subject, MAX_MAIL_FIELD_CHARS) || '（無主題）';
      const body = sanitize(req?.body, MAX_MAIL_FIELD_CHARS);

      // 用戶綁定的自有發件通道（本地加密存儲，僅發送瞬態透傳雲端，不落庫不留痕）
      const account = getMailAccount();
      const payload: SendMailRequest = { to, subject, body };
      if (account) {
        payload.userSmtp = {
          host: account.smtpHost,
          port: account.smtpPort,
          user: account.email,
          pass: account.authCode,
        };
      }

      // 路徑 1：雲端 SMTP 代發（優先用戶自有憑據，其次運營方預設）
      try {
        const env = ctx.globals.cloudEnv as string;
        const res: CloudResponse<{ to: string; subject: string; mode: string }> = await postContainer<
          { to: string; subject: string; mode: string }
        >(env, '/api/skill/skill.device.comm/send_mail', payload, {
          sessionId: ctx.sessionId,
          retry: false,
        });
        if (res.code === 0 && res.data) {
          return {
            success: true,
            data: {
              to,
              subject: res.data.subject || subject,
              body,
              mode: 'sent',
              guidance: account
                ? `郵件已由你的郵箱（${account.email}）發送到 ${to}，對方是否收到以其郵箱收信為準。`
                : `郵件已發送到 ${to}，對方是否收到以其郵箱收信為準。`,
            } satisfies SendMailOutput,
          };
        }
        // 降級碼：503 未配置 / 502 上游失敗 / 429 頻控 / 負數雲不可達 → 複製引導
        if (res.code === 503 || res.code === 502 || res.code === 429 || res.code < 0) {
          return degradeToCopy({ to, subject, body }, degradeReason(res, !!account));
        }
        // 400 / 401 等鏈路異常碼：如實透傳，不降級掩蓋問題
        return {
          success: false,
          error: { code: 'SEND_MAIL_FAILED', message: res.message ?? '郵件發送失敗', retryable: false },
        };
      } catch {
        // 網路層失敗（release 閃斷）：離線保底複製
        return degradeToCopy({ to, subject, body }, '網路暫時不可達');
      }
    }

    return {
      success: false,
      error: { code: 'CAPABILITY_NOT_FOUND', message: `${action} 不支援`, retryable: false },
    };
  },
  // 無 rollback：撥號面板由用戶最終確認；郵件經 requiresHumanConfirm 聲明
  // 後由確認環節把關（發出後不可撤回屬協議屬性，非可回滾副作用）
};
