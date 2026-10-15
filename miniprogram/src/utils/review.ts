/**
 * 寫操作前置一致性複核（純函數）
 *
 * 設計定位（2026-10 第一梯隊·項1，借鑑 Grok Bot「獨立審查」模式）：
 * LLM 規劃的寫操作任務（下單 / 預約 / 點單 / 呼叫）入參若與用戶意圖
 * 點名的確定參數不一致，即為規劃幻覺或綁定錯配——在 checkpoint 與
 * 執行前以規則字面比對攔截，作為幻覺下單的最後一道閘（規範 § 10 紅線：
 * 「LLM 幻覺導致錯誤下單」的本地防線，與 rollback / 渠道側確認互補）。
 *
 * 強證據才攔截原則：僅當意圖中出現可確定比對的字面線索（YYYY-MM-DD /
 * M月D日 日期、車次號、航班號、到達城市詞）且任務對應欄位與之不符時
 * 攔截；意圖無該類線索（如相對日期「明天」、未點名車次）一律放行——
 * 寧可漏攔交由執行層與渠道側兜底，不可誤攔正常任務。
 *
 * 比對口徑：
 *   - 日期僅比月-日維度（M月D日 線索無年份資訊）；任務日期命中意圖
 *     任一線索即通過（「10月20日到10月22日」往返兩程各自成立）
 *   - 車次統一大寫逐字比對（[GDCZK]＋1-4 位數字）
 *   - 到達城市以 ≥2 字公共子串判斷一致（容忍「杭州西湖」對「杭州」
 *     的尾綴截斷形態）；僅針對 to 欄位（火車 / 機票到達站——訂錯方向
 *     危害最大；city 欄位常來自定位而非意圖點名，誤傷率高，不比對）
 *
 * 本模組為純函數（規範 § 4：utils/ 不得 import wx），便於單元測試。
 */

/** 複核結論：ok=false 時 message 為面向用戶的中文說明（脱敏規範：不含代碼級數據） */
export interface ReviewVerdict {
  ok: boolean;
  message?: string;
}

/**
 * 寫操作判定（冪等查詢類不複核）
 *
 * 覆蓋現網全部寫操作 action 命名形態：book_ / place_ / create_ / add_to_ /
 * cancel_ / pay_ / dial_ / send_ 前綴與整詞 checkout；chat_companion
 * （陪伴對話）與 search_ / list_ / query_ / estimate_ 查詢類不在此列。
 */
const WRITE_ACTION_RE = /^(?:book_|place_|create_|add_to_|cancel_|pay_|dial_|send_|checkout$)/;

/** 判定 action 是否寫操作 */
export function isWriteAction(action: string): boolean {
  return WRITE_ACTION_RE.test(action);
}

/* ============ 規則一：日期字面比對 ============ */

/** 提取意圖日期線索並歸一為「月-日」（YYYY-MM-DD 與 M月D日 兩形態） */
function dateClues(intent: string): string[] {
  const out: string[] = [];
  for (const d of intent.match(/\d{4}-\d{1,2}-\d{1,2}/g) ?? []) {
    out.push(`${Number(d.slice(5, 7))}-${Number(d.slice(8, 10))}`);
  }
  const re = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(intent)) !== null) {
    out.push(`${Number(m[1])}-${Number(m[2])}`);
  }
  return out;
}

/** 日期比對：任務 date 命中意圖任一日期線索即通過（往返多日期場景） */
function reviewDate(intent: string, input: Record<string, unknown>): string | null {
  const dateVal = typeof input.date === 'string' ? input.date.trim() : '';
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(dateVal)) return null;
  const clues = dateClues(intent);
  if (clues.length === 0) return null;
  const taskMd = `${Number(dateVal.slice(5, 7))}-${Number(dateVal.slice(8, 10))}`;
  if (!clues.includes(taskMd)) {
    return `您點名的日期與任務將執行的 ${dateVal} 不一致`;
  }
  return null;
}

/* ============ 規則二：車次字面比對 ============ */

/** 車次比對：意圖點名車次（統一大寫）與任務 trainNo 集合比對 */
function reviewTrainNo(intent: string, input: Record<string, unknown>): string | null {
  const trainNo = typeof input.trainNo === 'string' ? input.trainNo.trim().toUpperCase() : '';
  if (!trainNo) return null;
  const clues: string[] = intent.toUpperCase().match(/[GDCZK]\d{1,4}/g) ?? [];
  if (clues.length > 0 && !clues.includes(trainNo)) {
    return `您點名的車次（${clues.join('、')}）與任務將執行的 ${trainNo} 不一致`;
  }
  return null;
}

/* ============ 規則三：航班號字面比對 ============ */

/** 航班號比對：意圖點名航班（統一大寫，兩字航司碼＋3-4 位數字）與任務 flightNo 集合比對 */
function reviewFlightNo(intent: string, input: Record<string, unknown>): string | null {
  const flightNo = typeof input.flightNo === 'string' ? input.flightNo.trim().toUpperCase() : '';
  if (!flightNo) return null;
  const clues: string[] = intent.toUpperCase().match(/[A-Z]{2}\d{3,4}/g) ?? [];
  if (clues.length > 0 && !clues.includes(flightNo)) {
    return `您點名的航班與任務將執行的 ${flightNo} 不一致`;
  }
  return null;
}

/* ============ 規則四：到達城市比對（僅 to 欄位） ============ */

/**
 * 城市候選頭部停用字：提取詞以常見非地名開頭的丟棄（「到站時間」類
 * 誤提取）。不做完整地名詞表（維護成本高且覆蓋有限），以寬鬆過濾 +
 * 公共子串容錯兜底
 */
const CITY_HEAD_STOP = /^[机票機票车車场場站酒之後后时時候办辦買买订訂取拿说說问問找吃喝玩看逛的]/;

/** 提取到達城市候選：「到 / 飛往 / 飞 / 去 / 回」後的連續漢字段（截 2-6 字） */
function cityClues(intent: string): string[] {
  const out: string[] = [];
  const re = /(?:到|飞往|飛往|飞|去|回)\s*([一-龥]{2,6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(intent)) !== null) {
    if (!CITY_HEAD_STOP.test(m[1])) out.push(m[1]);
  }
  return out;
}

/** 雙字公共子串判斷（容忍「杭州西湖」對「杭州」的截斷 / 尾綴形態） */
function sharesTwoChar(a: string, b: string): boolean {
  for (let i = 0; i + 1 < a.length; i++) {
    if (b.includes(a.slice(i, i + 2))) return true;
  }
  return false;
}

/** 到達城市比對：任務 to 與意圖任一城市候選有 ≥2 字公共子串即通過 */
function reviewCity(intent: string, input: Record<string, unknown>): string | null {
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  if (to.length < 2) return null;
  const clues = cityClues(intent);
  if (clues.length === 0) return null;
  if (!clues.some((c) => sharesTwoChar(c, to))) {
    return `您點名的到達地（${clues[0]}）與任務將執行的 ${to} 不一致`;
  }
  return null;
}

/** 由不一致原因構造攔截結論（統一中文文案口徑） */
function verdictOf(reason: string): ReviewVerdict {
  return {
    ok: false,
    message: `安全複核未通過：${reason}，已自動攔截。請核對需求後重新下達。`,
  };
}

/**
 * 寫操作一致性複核主入口
 *
 * @param intent 用戶本輪原始意圖（plan.intent）
 * @param input 任務綁定解析後的最終入參（Scheduler 已寫回 task.input）
 * @returns ok=true 放行；ok=false 攔截（message 供 failTask 透出給用戶）
 */
export function reviewWriteTask(intent: string, input: Record<string, unknown>): ReviewVerdict {
  const dateErr = reviewDate(intent, input);
  if (dateErr) return verdictOf(dateErr);
  const trainErr = reviewTrainNo(intent, input);
  if (trainErr) return verdictOf(trainErr);
  const flightErr = reviewFlightNo(intent, input);
  if (flightErr) return verdictOf(flightErr);
  const cityErr = reviewCity(intent, input);
  if (cityErr) return verdictOf(cityErr);
  return { ok: true };
}
