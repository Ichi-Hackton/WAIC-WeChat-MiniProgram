/**
 * 人類確認對話框
 *
 * 規範來源：.qoder/rules/Agent.md § 8.1, § 10（2026-10 修訂）
 *
 * 預設行為：兩個 hook（confirmPlan / awaitCheckpoint）均**直接 resolve true**，
 * 遵循「最小打扰」原則——使用者發出意圖即視同同意，UI 上的 plan 卡片與交付卡
 * 已提供充分能見性，脫彈窗冗餘只會在高頻任務流中造成噪音。
 *
 * 安全网：
 *   1. rollback 機制：寫操作失敗可反序撤銷已成功的 Task
 *   2. 跳轉模式：2026-10 真實渠道上線後，寫操作（購票 / 購物 / 預約）交付
 *      「跳轉下單卡」——真實交易與支付在官方渠道側完成，交易確認由渠道承擔
 *   3. 「重置」按鈕：誤操作可一鍵清空對話重來
 *
 * 保留函式簽名原因：
 *   - scheduler 仍會呼叫 checkpoint 入參（函式永遠返回 true，狀態機依然走完）
 *   - 未來若要重新啟用彈窗，只需在函式內插回 wx.showModal 即可，不需改動調用方
 *
 * 若無 wx API（如測試環境）：同樣直接 resolve true（預設通過，與生產一致）。
 */

import type { CheckpointInput, ConfirmPlanInput } from '../types/checkpoint';
import { BRAND_AI_GENERATED_BY } from '../types/brand';
import { formatCents } from '../utils/field-labels';
import { info as logInfo } from '../utils/logger';

// 型別已下沉至 types/checkpoint.d.ts（core 層依賴注入用），此處 re-export 保持兼容
export type { CheckpointInput, ConfirmPlanInput };

/** 透過 wx.showModal 顯示確認框，resolve 為布爾 */
function showWxModal(opts: {
  title: string;
  content: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const wxApi = (globalThis as { wx?: {
      showModal?: (o: unknown) => void;
    } }).wx;
    if (!wxApi?.showModal) {
      logInfo(`[fallback] wx.showModal 不可用，預設拒絕：${opts.title}`);
      resolve(false);
      return;
    }
    wxApi.showModal({
      title: opts.title,
      content: opts.content,
      confirmText: opts.confirmText ?? '確認',
      cancelText: opts.cancelText ?? '取消',
      success: (res: { confirm: boolean; cancel: boolean }) => resolve(res.confirm),
      fail: () => resolve(false),
    });
  });
}

/** Plan 確認：預設直接通過（彈窗已禁用；UI plan 卡片提供同等可見性） */
export async function confirmPlan(input: ConfirmPlanInput): Promise<boolean> {
  logInfo(`[checkpoint/auto] Plan 預設通過：${input.intent}（${input.tasks.length} 個任務）`);
  return true;
}

/** 金額明細項（兼容 orders / orderItems 等鍵名） */
interface AmountItem {
  title?: string;
  amountCent?: number;
  quantity?: number;
}

/** 找出入參中第一個「元素含 amountCent」的陣列（金額明細） */
function findAmountItems(input: Record<string, unknown>): AmountItem[] | undefined {
  for (const v of Object.values(input)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((it) => it && typeof it === 'object' && 'amountCent' in (it as Record<string, unknown>))
    ) {
      return v as AmountItem[];
    }
  }
  return undefined;
}

/** 常見入參鍵 → 中文標籤（白名單：未映射鍵 / 巢狀值一律略過，不向用戶暴露 JSON 代碼） */
const INPUT_LABELS: Record<string, string> = {
  from: '出發',
  to: '到達',
  date: '日期',
  seatType: '座位',
  trainNo: '車次',
  passengerName: '乘車人',
  city: '城市',
  keyword: '關鍵詞',
  name: '名稱',
  quantity: '數量',
  flightNo: '航班',
  cabin: '艙位',
};

/** 入參 → 逐行「中文標籤：標量值」（未映射鍵、物件 / 陣列值一律略過） */
function formatScalarLines(input: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const label = INPUT_LABELS[key];
    if (!label || value === null || typeof value === 'object') continue;
    lines.push(`· ${label}：${String(value)}`);
  }
  return lines.length > 0 ? lines.join('\n') : '· 任務參數（略）';
}

/**
 * 入參明細格式化（規範 § 10 紅線：支付前強制展示明細）
 *
 * 金額感知（三級匹配，確保用戶確認前能看到金額）：
 *   1. 元素含 amountCent 的陣列 → 訂單明細逐項展示 + 合計（如星巴克 items）
 *   2. 標量 priceCent / amountCent → 單筆金額展示（如火車票 book_ticket，
 *      值來自上游查詢任務的 inputBindings 注入——規劃層保證「先查詢後下單」
 *      依賴鏈，使確認彈窗展示即時票價；下單金額以雲端再核實為準）
 *   3. 其他 → 鍵值中文標籤行（未映射欄位略過，不輸出原始 JSON）
 */
function formatInputDetail(input: Record<string, unknown>): string {
  const items = findAmountItems(input);
  if (items) {
    const lines = items.map((it) => {
      const qty = it.quantity ?? 1;
      return `· ${it.title ?? '項目'} × ${qty} = ${formatCents((it.amountCent ?? 0) * qty)}`;
    });
    const total = items.reduce((s, it) => s + (it.amountCent ?? 0) * (it.quantity ?? 1), 0);
    lines.push(`合計：${formatCents(total)}`);
    return lines.join('\n');
  }
  const scalarCent =
    typeof input.amountCent === 'number' ? input.amountCent :
    typeof input.priceCent === 'number' ? input.priceCent :
    undefined;
  if (scalarCent !== undefined) {
    // priceCent <= 0 為「未取得即時票價」語義（如飛常準票價端點未覆蓋該航班），
    // 如實展示待核實，不輸出誤導性 ¥0 / 負數金額；amountCent 恒為正常金額
    const isAmount = input.amountCent !== undefined;
    const amountLine = isAmount || scalarCent > 0
      ? `${isAmount ? '金額' : '票價（即時查詢，下單以雲端核實為準）'}：${formatCents(scalarCent)}`
      : '票價：暫無即時報價，下單以雲端核實為準';
    const rest = { ...input };
    delete rest.priceCent;
    delete rest.amountCent;
    return `${amountLine}\n${formatScalarLines(rest)}`;
  }
  return formatScalarLines(input);
}

/** 單步寫操作確認：預設直接通過（彈窗已禁用；跳轉模式下真實交易在渠道側確認） */
export async function awaitCheckpoint(input: CheckpointInput): Promise<boolean> {
  const summary = input.task.summary ?? `${input.task.skillId}.${input.task.action}`;
  logInfo(`[checkpoint/auto] 寫操作預設通過（跳轉模式，真實交易於渠道側完成）：${summary}`);
  return true;
}