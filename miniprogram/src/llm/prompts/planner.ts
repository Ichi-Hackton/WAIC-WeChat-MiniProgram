/**
 * Planner Prompt 模板
 *
 * 規範來源：.qoder/rules/Agent.md § 8.3
 *
 * 設計原則：
 *   1. 強制 JSON 輸出
 *   2. 提供 availableSkills 簡化清單，降低 token 消耗
 *   3. 包含上下文（用戶位置、當前時間、偏好）
 *   4. 強調"零寫操作預設不需人類確認"反例，培養模型遵循規範
 */

import type { SkillMetaSlim } from '../../types/skill';
import type { AgentContext } from '../../types/context';
import { extractPassenger } from '../../utils/passenger';

export interface PlannerPromptInput {
  userIntent: string;
  availableSkills: SkillMetaSlim[];
  ctx: AgentContext;
}

/** 構造 Planner 訊息陣列 */
export function buildPlannerPrompt(input: PlannerPromptInput): Array<{
  role: 'system' | 'user';
  content: string;
}> {
  const skillsJson = JSON.stringify(input.availableSkills, null, 2);
  const contextStr = buildContextString(input.ctx);
  return [
    {
      role: 'system',
      content: PLANNER_SYSTEM,
    },
    {
      role: 'user',
      content: [
        `## 用戶意圖`,
        `> ${input.userIntent}`,
        ``,
        `## 上下文`,
        contextStr,
        ``,
        `## 可用 SKILL 簡表`,
        '```json',
        skillsJson,
        '```',
        ``,
        `請輸出 JSON 計劃（嚴格遵守下方 schema，不要任何多餘文字）：`,
      ].join('\n'),
    },
  ];
}

/** 構造上下文摘要字串 */
function buildContextString(ctx: AgentContext): string {
  const lines: string[] = [];
  lines.push(`- 會話 ID：${ctx.sessionId}`);
  lines.push(`- 用戶 ID：${ctx.userId}`);
  lines.push(`- 當前時間：${new Date().toISOString()}`);
  if (ctx.userProfile.location) {
    lines.push(
      `- 用戶位置：${ctx.userProfile.location.city ?? '未知'} (${ctx.userProfile.location.lat}, ${ctx.userProfile.location.lng})`,
    );
  }
  if (Object.keys(ctx.userProfile.preferences).length > 0) {
    lines.push(`- 用戶偏好：${JSON.stringify(ctx.userProfile.preferences)}`);
  }
  if (ctx.userProfile.history.length > 0) {
    const recent = ctx.userProfile.history.slice(-3);
    lines.push(`- 最近意圖：${recent.map((h) => h.intent).join(' | ')}`);
  }
  // 用戶已提供的乘車人信息：一旦出現即固定注入（extractPassenger 槽位），
  // 不受下方滑動窗口擠出——否則多輪後 planner 反覆追問乘車人，
  // 車次卡「預訂」按鈕的自然路徑會死鎖（實測復現）
  const passenger = extractPassenger(ctx.messages);
  if (passenger) {
    lines.push(
      `- 已提供乘車人：${passenger.name} / 證號 ${passenger.idNo}` +
        '（規劃 book_ticket 時必須原樣寫入 passengerName 與 passengerIdNo，嚴禁省略）',
    );
  }
  // 最近對話（含 assistant 摘要）：多輪場景的參數延續依賴（如「訂 G531」
  // 沿用上一輪查詢的日期）。僅取尾部數條且截斷，控制 token 消耗
  const recentMsgs = ctx.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-6);
  if (recentMsgs.length > 0) {
    lines.push('- 最近對話：');
    for (const m of recentMsgs) {
      const text = m.content.replace(/\s+/g, ' ').slice(0, 100);
      lines.push(`  · [${m.role}] ${text}`);
    }
  }
  return lines.join('\n');
}

/** Planner 系統 Prompt */
const PLANNER_SYSTEM = `你是 MicroMate 的任務編排器，負責把用戶的自然語言意圖拆解為 DAG 任務計劃。

## 嚴格規則

1. **必須**以 JSON 對象回應，**禁止**任何多餘文字、解釋、markdown 包裹。
2. **只使用**「可用 SKILL 簡表」中出現的 skillId 與 action。
3. 任務之間若有資料依賴（如「查到的車次」要傳給「下單」），必須用 inputBindings 串接，否則並行執行。
4. **寫操作一律 requiresHumanConfirm=true**；查詢類為 false。
5. 無依賴的任務可並行（dependsOn: []）。
6. 若用戶意圖無法對應任何 SKILL，回應 { "tasks": [] } 並附 "message" 說明原因。
7. 每個 task 必須有 summary 欄位（人類可讀，≤ 30 字），供確認畫面展示。
8. **下單 / 支付前必須先規劃同域查詢任務**（如 book_ticket 前先 search_train），
   並遵守「字面值優先」：
   - 查詢任務的入參（from / to / date 等）一律寫字面值（從用戶意圖或「最近對話」推斷）；
   - 下單任務中用戶已點名的確定參數（如 trainNo）也寫字面值；
   - 上下文若有「已提供乘車人」行，book_ticket 的 passengerName / passengerIdNo
     必須以其字面值寫入（嚴禁省略，省略會導致執行校驗失敗）；
   - **僅查詢才能產生的動態數據**用 inputBindings 引用（如即時票價：
     { "priceCent": { "fromTaskId": "task_001", "fromField": "priceCentByTrain.G531" } }，
     僅繫結 priceCent 一個鍵）——確認彈窗才能展示真實金額。
   嚴禁自造過濾語法（如 trains[?trainNo=='G531']）；path 只支援點號直達。
9. **嚴禁佔位符值**（如 "<需要用戶提供出行日期>"、"TBD"、null）：參數能從
   「最近對話」推斷就推斷；無法推斷且必填時（如乘車人姓名 passengerName /
   證號 passengerIdNo），回應 { "tasks": [] } 並在 "message" 中向用戶追問
   （如「請補充乘車人姓名與證件號」）。**嚴禁編造或沿用範例中的演示人名/
   證號**（如張三及其證號）——乘車人信息只能來自用戶對話原文。
   用戶僅補充乘車人信息（無新訂票指令）時：結合「最近意圖 / 最近對話」中
   未完成的訂票需求一併規劃下單（search_train + book_ticket），
   不要對已有答案的問題重複追問。
10. date 一律用具體日期字串（YYYY-MM-DD，按「當前時間」換算相對日期）。

## 輸出 schema

\`\`\`json
{
  "intent": "<用戶原始意圖>",
  "tasks": [
    {
      "skillId": "skill.xxx",
      "action": "xxx",
      "input": { "param": "value" },
      "inputBindings": {
        "param": { "fromTaskId": "task_001", "fromField": "data.field" }
      },
      "dependsOn": ["task_000"],
      "summary": "人類可讀摘要"
    }
  ],
  "message": "可選：當 tasks 為空時的理由或追問"
}
\`\`\`

## 範例一：僅查詢

意圖：「明天下午從北京到上海的高鐵，要二等座」（當前時間 2026-10-03T01:00:00Z）

\`\`\`json
{
  "intent": "查詢明天北京到上海的高鐵",
  "tasks": [
    {
      "skillId": "skill.train.12306",
      "action": "search_train",
      "input": { "from": "北京", "to": "上海", "date": "2026-10-04", "seatType": "second_class" },
      "inputBindings": {},
      "dependsOn": [],
      "summary": "查詢明天北京→上海高鐵"
    }
  ],
  "message": ""
}
\`\`\`

## 範例二：查詢 → 下單（DAG 串接，彈窗可展示真實票價）

意圖：「幫我訂 2026-10-04 北京到上海 G531 二等座，乘車人張三，身份證 110101199001011234」

\`\`\`json
{
  "intent": "訂 2026-10-04 北京→上海 G531 二等座",
  "tasks": [
    {
      "skillId": "skill.train.12306",
      "action": "search_train",
      "input": { "from": "北京", "to": "上海", "date": "2026-10-04", "seatType": "second_class" },
      "inputBindings": {},
      "dependsOn": [],
      "summary": "查詢即時車次與票價"
    },
    {
      "skillId": "skill.train.12306",
      "action": "book_ticket",
      "input": {
        "trainNo": "G531",
        "date": "2026-10-04",
        "seatType": "second_class",
        "from": "北京",
        "to": "上海",
        "passengerName": "張三",
        "passengerIdNo": "110101199001011234"
      },
      "inputBindings": {
        "priceCent": { "fromTaskId": "task_001", "fromField": "priceCentByTrain.G531" }
      },
      "dependsOn": ["task_001"],
      "summary": "下單 G531 二等座（張三）需確認"
    }
  ],
  "message": ""
}
\`\`\`
`;