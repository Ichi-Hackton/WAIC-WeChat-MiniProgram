/**
 * 人類確認（聊天流結構化確認卡，2026-10 第二梯隊·項C）
 *
 * 規範來源：.qoder/rules/Agent.md § 8.1, § 10；借鑑 Muse 審批卡形態
 *
 * 形態演進：
 *   1. wx.showModal 彈窗（歷史）——並行 ready 的多個寫操作同時彈窗會互相
 *      頂掉導致確認丟失（scheduler 的 Promise 鏈串行化只是權宜補丁）
 *   2. 直接 resolve true（2026-10 最小打找修訂）——彈窗全局禁用
 *   3. 聊天流確認卡（現行）——requiresHumanConfirm 的寫操作在對話流內出
 *      結構化確認卡（標題 + 脱敏明細 + 雙按鈕），點按後回傳。卡片天然
 *      可並存（每張卡獨立應答閉包），不依賴串行化也不會互頂；留在聊天
 *      流中還提供了彈窗沒有的審計能見度（用户可回看當時確認了什麼）
 *
 * 觀察者反轉（依賴方向）：interaction 層不反向依賴頁面——模組級 sink 由
 * app.ts 組裝時注入（轉發給 AgentRuntimeEvents 訂閱者，即首頁），依賴
 * 方向保持 app → interaction → core 單向（規範 § 12.3）。
 *
 * fail-closed 語義：sink 未註冊（無 UI 可確認，如測試環境 / 頁面已卸載）
 * 時直接拒絕——需確認的寫操作不得在無人看見時默默放行。
 *
 * Plan 確認（confirmPlan）維持直接通過：UI plan 卡已提供能見度，整輪
 * 彈窗屬高頻任務流噪音（§ 8.1 最小打找修訂不變）；單步確認卡只攔截
 * capability 聲明 requiresHumanConfirm 或用戶域級覆蓋為 confirm 的任務。
 */

import type {
  CheckpointInput,
  ConfirmPlanInput,
  CheckpointCardPayload,
  CheckpointRespond,
  CheckpointSink,
} from '../types/checkpoint';
import { taskLabel } from '../llm/client';
import { formatCents } from '../utils/field-labels';
import { info as logInfo, warn as logWarn } from '../utils/logger';

// 型別已下沉至 types/checkpoint.d.ts（core 層依賴注入用），此處 re-export 保持兼容
export type { CheckpointInput, ConfirmPlanInput, CheckpointCardPayload, CheckpointRespond };

/** 確認請求 sink（模組級；app.ts 組裝時注入，頁面卸載 / runtime 重建時可置空） */
let checkpointSink: CheckpointSink | null = null;

/** 注入 / 撤除確認卡轉發通道（app.ts 組裝層專用） */
export function setCheckpointSink(sink: CheckpointSink | null): void {
  checkpointSink = sink;
}

/** 確認卡等待上限：超時視為拒絕（防止页面異常時 Promise 永久掛起卡死調度鏈） */
const CHECKPOINT_TIMEOUT_MS = 120_000;

/** 動作級確認按鈕文案（未命中用「確認執行」兌底） */
const CONFIRM_TEXTS: Record<string, string> = {
  send_mail: '確認發送',
  book_ticket: '確認生成購票卡',
  book_flight: '確認生成機票卡',
  dial_phone: '確認撥號',
};

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
  viewerName: '觀演人',
  city: '城市',
  keyword: '關鍵詞',
  name: '名稱',
  productName: '品名',
  quantity: '數量',
  flightNo: '航班',
  cabin: '艙位',
  subject: '主題',
  body: '正文',
  pickupType: '取餐方式',
};

/** 品名明細項（咖啡 items 等點單品項：無金額，有品名 / 數量 / 規格） */
interface NamedItem {
  name?: string;
  quantity?: number;
  size?: string;
}

/** 找出入參中第一個「元素含 name 欄位」的陣列（點單品項；金額明細優先於此） */
function findNamedItems(input: Record<string, unknown>): NamedItem[] | undefined {
  for (const v of Object.values(input)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((it) => it && typeof it === 'object' && 'name' in (it as Record<string, unknown>))
    ) {
      return v as NamedItem[];
    }
  }
  return undefined;
}

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
 * 金額感知（四級匹配，確保用戶確認前能看到金額 / 品項）：
 *   1. 元素含 amountCent 的陣列 → 訂單明細逐項展示 + 合計（如星巴克 items
 *      帶金額形態）
 *   2. 元素含 name 的陣列 → 品名 × 數量逐項展示（如咖啡點單 items，
 *      2026-10-16 黑盒測試 D7 修訂新增——此前三級全落空時咖啡確認卡
 *      明細退化為「任務參數（略）」，用戶確認前看不到買了什麼）
 *   3. 標量 priceCent / amountCent → 單筆金額展示（如火車票 book_ticket，
 *      值來自上游查詢任務的 inputBindings 注入——規劃層保證「先查詢後下單」
 *      依賴鏈，使確認彈窗展示即時票價；下單金額以雲端再核實為準）
 *   4. 其他 → 鍵值中文標籤行（未映射欄位略過，不輸出原始 JSON）
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
  const named = findNamedItems(input);
  if (named) {
    const lines = named.map((it) => {
      const size = typeof it.size === 'string' && it.size ? `（${it.size}）` : '';
      const qty = typeof it.quantity === 'number' ? it.quantity : 1;
      return `· ${String(it.name ?? '品項')}${size} × ${qty}`;
    });
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

/**
 * 單步寫操作確認：向聊天流發結構化確認卡，等用戶點按應答
 *
 * 超時 / sink 缺失均 fail-closed（拒絕）；重複應答冪等（settled 標記 +
 * clearTimeout，晚到的第二次點按無副作用）。
 */
export function awaitCheckpoint(input: CheckpointInput): Promise<boolean> {
  const { task, resolvedInput } = input;
  const label = taskLabel(task);
  const payload: CheckpointCardPayload = {
    taskId: task.id,
    skillName: label,
    title: `請確認：${label}`,
    detailLines: formatInputDetail(resolvedInput)
      .split('\n')
      .filter((line) => line.length > 0),
    confirmText: CONFIRM_TEXTS[task.action] ?? '確認執行',
  };
  const sink = checkpointSink;
  if (!sink) {
    logWarn(`[checkpoint] 無 UI 確認通道（sink 未註冊），安全起見拒絕：${payload.title}`);
    return Promise.resolve(false);
  }
  logInfo(`[checkpoint] 確認卡已發出：${payload.title}`);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      if (settled) return;
      settled = true;
      logWarn(`[checkpoint] 確認卡超時未應答，視為拒絕：${payload.title}`);
      resolve(false);
    }, CHECKPOINT_TIMEOUT_MS);
    const respond: CheckpointRespond = (approved: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logInfo(`[checkpoint] 應答：${approved ? '同意' : '拒絕'}（${payload.title}）`);
      resolve(approved);
    };
    sink(payload, respond);
  });
}