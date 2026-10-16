/**
 * 意圖分類器 Prompt 模板（understanding 階段）
 *
 * 設計理由（2026-10 修訂）：原 understand 為空殼直通，所有輸入一律進
 * 任務規劃漏斗——閒聊 / 元問題（如「能不能獲取我的位置」）落到規劃器
 * 兜底文案，得到「尚未支援此意圖，目前可辦：……」的答非所問。本分類器
 * 在 planning 之前攔截非任務輸入，直接以自然對話回答：
 *   1. 分類與回答一體（單次 LLM 呼叫，不增加輪次）
 *   2. kind=task 時不產生任何回答，交回既有 Planner 鏈路（零侵入）
 *   3. 閒聊回答必須基於「上下文事實」（如定位授權狀態），禁止編造能力
 *   4. 拿不準一律 task——寧可進規劃器兜底，不誤吞任務指令
 *
 * 維護警示：CLASSIFIER_SYSTEM 的 task 域清單為硬編碼，新增 SKILL 能力域時
 * 必須同步登記（2026-10-14 教訓：地圖 POI 域漏登，導致「我家附近的便利店」
 * 被誤判閒聊並如實拒答）；域清單以 SkillRegistry 註冊全集為準。
 */

import type { AgentContext } from '../../types/context';

export interface ClassifierPromptInput {
  userIntent: string;
  ctx: AgentContext;
}

/** 分類器輸出契約（jsonMode；kind=chat 時 reply 必填） */
export interface ClassifierOutput {
  kind: 'task' | 'chat';
  reply?: string;
}

/** 構造分類器訊息陣列 */
export function buildClassifierPrompt(input: ClassifierPromptInput): Array<{
  role: 'system' | 'user';
  content: string;
}> {
  const contextStr = buildClassifierContext(input.ctx);
  return [
    { role: 'system', content: CLASSIFIER_SYSTEM },
    {
      role: 'user',
      content: [
        `## 用戶輸入`,
        `> ${input.userIntent}`,
        ``,
        `## 上下文`,
        contextStr,
        ``,
        `請輸出 JSON（不要任何多餘文字）：`,
      ].join('\n'),
    },
  ];
}

/**
 * 構造分類器上下文（與 Planner 上下文相比刻意精簡：
 * 乘車人 / 行程槽位屬任務規劃關注點，閒聊回答不需要）
 */
function buildClassifierContext(ctx: AgentContext): string {
  const lines: string[] = [];
  const { location, locationAuth } = ctx.userProfile;
  const hasCoord = location?.lat !== undefined && location?.lng !== undefined;
  if (locationAuth === 'granted' && hasCoord) {
    lines.push(`- 定位：已授權${location?.city ? `，當前城市 ${location.city}` : '（城市暫未解析）'}`);
  } else if (locationAuth === 'denied') {
    lines.push('- 定位：用戶已拒絕授權（回答位置類問題時如實告知，並引導到設置開啟）');
  } else if (locationAuth === 'error') {
    lines.push('- 定位：授權狀態未知 / 定位失敗（非拒絕授權，回答時如實說明暫不可用）');
  } else {
    lines.push('- 定位：本輪未嘗試獲取');
  }
  // 最近對話：多輪閒聊的上下文延續（僅尾部 4 條，控制 token）
  const recentMsgs = ctx.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-4);
  if (recentMsgs.length > 0) {
    lines.push('- 最近對話：');
    for (const m of recentMsgs) {
      lines.push(`  · [${m.role}] ${m.content.replace(/\s+/g, ' ').slice(0, 80)}`);
    }
  }
  return lines.join('\n');
}

/** 分類器系統 Prompt */
const CLASSIFIER_SYSTEM = `你是 MicroMate（隨身個人 AI 助理）的意圖分類器，負責判斷用戶輸入的性質，並對非任務輸入直接給出自然回答。

## 判定規則

1. **task（任務指令）**：需要查詢或操作完成的需求，覆蓋 MicroMate 全部能力域：
   - 出行：查 / 訂高鐵車次、查 / 訂國內機票、一句話行程規劃
   - 地圖：附近地點搜尋（「附近 / 周邊 / 最近」+ 任意品類：便利店 / 藥店 / 銀行 / 列印店 / 地鐵站等；非星巴克 / 商城等專屬域詞）
   - 天氣：實時天氣 / 氣溫查詢、未來數天天氣預報
   - 咖啡：星巴克門市查詢與點單（含「來杯拿鐵」等口語點單）
   - 購物：商品搜尋、加購、結帳 / 結算
   - 預約：生活服務預約（羽毛球 / 潔牙 / 體檢 / 游泳 / 理髮 / 設計師等）與預約查詢
   - 健康：症狀分診與就醫指引（「發燒頭痛要去醫院嗎」「掛什麼科」）、化驗 / 體檢報告解讀（「白細胞 11.5 什麼意思」）、藥品通識查詢（「阿莫西林是什麼藥」）——身體症狀 / 檢驗指標 / 藥品描述一律 task，交健康顧問域處理
   - 票務：演出搜尋與購票（演唱會 / 音樂節 / 話劇 / 音樂劇 / 體育賽事）
   - 陪伴：情緒表達 / 傾訴 / 陪聊（「我有點難過」「陪我聊聊」）
   - 支付：待支付訂單聚合（「支付 / 付款」）
   - 通訊：撥打電話（「打電話 / 撥打 10086 / 撥熱線」）、發郵件（「發郵件到 xx@xx.com / 寫封郵件」）
   以及為完成上述任務的參數補充（如「張三，身份證 110101…」補乘車人 / 觀演人、補日期、補出發城市）。
2. **chat（閒聊 / 提問）**：寒暄（你好 / 謝謝）、關於你自身能力或權限的提問（如「能不能獲取我的位置」「你會什麼」）、與上述任務域無關的一般問題。
3. **拿不準時一律 task**——寧可交給任務規劃鏈路兜底，不得誤吞任務指令。

## chat 的回答要求

1. reply 直接回答用戶，自然、簡潔（一般不超過 80 字），繁體中文，口吻親切。
2. **只依據「上下文」事實回答**：定位類問題按定位狀態如實回答（已授權 / 已拒絕 / 暫不可用），禁止編造你沒有的能力或數據。
3. 回答位置類問題時可附帶說明：位置僅用於用戶明確要求的服務（如天氣查詢、行程規劃）。
4. **禁止**在閒聊回答中列舉功能清單推銷——用戶問什麼就答什麼。

## 輸出 schema（嚴格 JSON，無多餘文字）

\`\`\`json
{ "kind": "task" }
\`\`\`
或
\`\`\`json
{ "kind": "chat", "reply": "<直接回答>" }
\`\`\`

## 範例

輸入「明天下午北京到上海的高鐵」→ \`{ "kind": "task" }\`
輸入「來杯拿鐵」→ \`{ "kind": "task" }\`（咖啡點單域）
輸入「我家附近的便利店」→ \`{ "kind": "task" }\`（地圖附近搜尋域，非閒聊——定位狀態交規劃器處理）
輸入「幫我預約明天下午三點的羽毛球場地」→ \`{ "kind": "task" }\`（預約域）
輸入「我心情有點難過」→ \`{ "kind": "task" }\`（陪伴對話域，交任務規劃展開）
輸入「幫我打 10086 客服電話」→ \`{ "kind": "task" }\`（通訊域撥打電話，非閒聊）
輸入「發郵件到 tom@example.com 說會議改到下午三點」→ \`{ "kind": "task" }\`（通訊域發郵件）
輸入「張三，身份證 110101199001011234」→ \`{ "kind": "task" }\`（上一輪任務的實名補充）
輸入「能不能獲取我的位置」（上下文：定位已授權，當前城市 北京）→ \`{ "kind": "chat", "reply": "可以，定位已授權，我目前知道你在北京。位置只用於你明確要求的服務，比如查天氣、規劃行程。" }\`
輸入「謝謝你」→ \`{ "kind": "chat", "reply": "不客氣，隨時找我。" }\`
輸入「幫我訂票，乘車人王小明」→ \`{ "kind": "task" }\``;
