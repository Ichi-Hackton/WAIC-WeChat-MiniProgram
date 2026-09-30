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
  "message": "可選：當 tasks 為空時的理由"
}
\`\`\`

## 範例

意圖：「明天下午從北京到上海的高鐵，要二等座」

\`\`\`json
{
  "intent": "查詢明天北京到上海的高鐵",
  "tasks": [
    {
      "skillId": "skill.train.12306",
      "action": "search_train",
      "input": { "from": "北京", "to": "上海", "date": "<明天>", "seatType": "second_class" },
      "inputBindings": {},
      "dependsOn": [],
      "summary": "查詢明天北京→上海高鐵"
    }
  ],
  "message": ""
}
\`\`\`
`;