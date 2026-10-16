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
import { warn as logWarn } from '../../utils/logger';
import { extractPassenger } from '../../utils/passenger';
import { extractTripSlots } from '../../utils/trip';
import { PREFERENCE_DOMAINS } from '../../storage/preferences';

/**
 * 重規劃失敗上下文（業務錯誤回傳 LLM 調整 Plan，規範 § 9）
 *
 * 2026-10 第一梯隊·項6（借鑑千問 Go 動態路徑切換）：售罄 / 無票類
 * 業務失敗回傳規劃器，引導 LLM 規劃替代路徑（而非直接以失敗收斂）
 */
export interface ReplanFailedContext {
  /** 上一輪方案中的業務性失敗任務（中文摘要 + 業務錯誤文案） */
  failures: Array<{
    action: string;
    summary?: string;
    errorCode: string;
    errorMessage: string;
  }>;
}

export interface PlannerPromptInput {
  userIntent: string;
  availableSkills: SkillMetaSlim[];
  ctx: AgentContext;
  /** 重規劃上下文（可選）：附帶時 LLM 應規劃避開同路徑的替代方案 */
  failedContext?: ReplanFailedContext;
}

/** 構造 Planner 訊息陣列 */
export function buildPlannerPrompt(input: PlannerPromptInput): Array<{
  role: 'system' | 'user';
  content: string;
}> {
  // 預算上限：雲端 llm-chat.ts 單條消息 MAX_MESSAGE_CHARS=24000（2026-10-16
  // 上調，原 16000），超限即確定性 400（不可重試）→ LLM 規劃永久降級規則
  // 規劃器（2026-10-16 缺陷）。預留 ~2000 字元給訊息包裝、模板增長與後續
  // 技能擴容（16 技能 slim 表實測 15471 字元，曾令原 15200 預算被技能表
  // 自身擊穿——常規會話必降載，deviceComm 被截尾踢出、最近對話全滅）。
  // 超過即逐級降載（見下方階梯）。
  const BUDGET_CHARS = 22_000;

  // 重規劃段落（僅附帶失敗上下文時注入）：置於用戶意圖之後——LLM 先讀
  // 原意圖再讀失敗背景，調整方向不脫離原目標。不參與降載（失敗背景是
  // 重規劃的關鍵依據，裁剪會令替代路徑規劃失焦）
  const replanSection = input.failedContext
    ? [
        `## 上一輪方案執行失敗（本輪為重規劃，請調整路徑）`,
        ...input.failedContext.failures.map(
          (f) => `- 任務「${f.summary || f.action}」失敗：${f.errorMessage}`,
        ),
        `請基於原意圖重新規劃：優先產出可達成同樣目標的替代路徑（如改其他渠道 / 調整日期時間 / 改為查詢引導）；若確無可行替代，回應 { "tasks": [] } 並在 message 中向用戶說明。`,
        ``,
      ]
    : [];

  // 組裝 user 正文（各預算檔位共用；緊湊序列化——縮進排版對 LLM 無增益，
  // 帶縮進可多佔 ~30% 字元，是撞爆上限的常量之一）
  const assemble = (skills: SkillMetaSlim[], maxRecentMsgs: number): string => {
    const skillsJson = JSON.stringify(skills);
    const contextStr = buildContextString(input.ctx, maxRecentMsgs);
    return [
      `## 用戶意圖`,
      `> ${input.userIntent}`,
      ``,
      ...replanSection,
      `## 上下文`,
      contextStr,
      ``,
      `## 可用 SKILL 簡表`,
      '```json',
      skillsJson,
      '```',
      ``,
      `請輸出 JSON 計劃（嚴格遵守下方 schema，不要任何多餘文字）：`,
    ].join('\n');
  };

  // 降載階梯（犧牲價值由低到高）：最近對話 6→2→0 條 → 撤動態技能（增強
  // 能力，優先於內置技能犧牲）→ 逐條截斷技能表尾 → 硬截兜底（意圖本身
  // 超長的極端場景，截斷勝於整體 400）。常規會話（16 技能 + 6 條對話，
  // 2026-10-16 實測 ~16.9K）零降載直達；注意：截尾固定犧牲註冊序末位技能
  let skills = input.availableSkills;
  let maxMsgs = 6;
  let userContent = assemble(skills, maxMsgs);
  const degraded = userContent.length > BUDGET_CHARS;
  for (const step of [2, 0] as const) {
    if (userContent.length <= BUDGET_CHARS) break;
    maxMsgs = step;
    userContent = assemble(skills, maxMsgs);
  }
  if (userContent.length > BUDGET_CHARS) {
    const builtinOnly = skills.filter((s) => !s.id.startsWith('skill.dynamic.'));
    if (builtinOnly.length < skills.length) {
      skills = builtinOnly;
      userContent = assemble(skills, maxMsgs);
    }
  }
  while (userContent.length > BUDGET_CHARS && skills.length > 1) {
    skills = skills.slice(0, -1);
    userContent = assemble(skills, maxMsgs);
  }
  if (userContent.length > BUDGET_CHARS) {
    userContent = userContent.slice(0, BUDGET_CHARS);
  }
  if (degraded) {
    logWarn(
      `規劃 prompt 超預算已降載（${userContent.length} 字元，保留 ${skills.length} 個 SKILL、最近對話 ${maxMsgs} 條）`,
    );
  }
  return [
    {
      role: 'system',
      content: PLANNER_SYSTEM,
    },
    {
      role: 'user',
      content: userContent,
    },
  ];
}

/** 構造上下文摘要字串（maxRecentMsgs：最近對話保留條數，降載階梯用） */
function buildContextString(ctx: AgentContext, maxRecentMsgs = 6): string {
  const lines: string[] = [];
  lines.push(`- 會話 ID：${ctx.sessionId}`);
  lines.push(`- 用戶 ID：${ctx.userId}`);
  lines.push(`- 當前時間：${new Date().toISOString()}`);

  // 出發城市權威行（交通任務 from 的取值依據；地址簿 > 定位 > 追問）。
  // 必須置於位置行之前——LLM 對「用戶位置」的追問衝動由本行直接抑制。
  // 2026-10-16 黑盒測試 D5 修訂：用戶點名出發地優先級明確高於本行——
  // 蓄意以「授權默認值」語義表述，禁止定位 / 地址簿默認值覆蓋用戶明說
  // 的出發地（badcase：「明天從北京到廣州」被定位城市珠海覆蓋為 from=廣州）
  const depCity = ctx.userProfile.location?.city;
  if (depCity) {
    const src =
      ctx.userProfile.location?.citySource === 'address_book' ? '地址簿默認地址' : '定位';
    lines.push(
      `- 出發城市：${depCity}（來源：${src}，僅為「用戶未點名出發地」時的授權默認值）——交通任務（search_train / search_flights）的 from 取值優先級：用戶意圖或最近對話明確說出的出發地（如「從北京出發」「北京到上海」的北京）永遠最高，其次才用本行默認值；兩者衝突時嚴禁以本行覆蓋用戶點名的出發地，也禁止向用戶追問出發城市`,
    );
  } else {
    lines.push(
      '- 出發城市：未知（地址簿未填寫且定位不可用）——交通任務缺出發城市時必須回空 tasks 追問（提示可在「我的」頁填寫常用地址或開啟定位），嚴禁猜測或使用任何缺省城市',
    );
  }

  // 當前城市權威行（2026-10-16 新增；get_forecast 天氣預報的城市取值依據）：
  // 與出發城市刻意分離——預報語義是「我現在在哪」，定位城市優先，地址簿
  // 家城市不壓制（badcase：人在澳門、家在廣州，預報錯查廣州）
  const curCity = ctx.userProfile.location?.currentCity;
  if (curCity) {
    lines.push(
      `- 當前城市：${curCity}（定位所得）——get_forecast（天氣預報）的 city 在用戶未點名城市時直接取此值，嚴禁改用「出發城市」行代替`,
    );
  } else {
    const homeCity = ctx.userProfile.homeAddress?.city;
    const opt = homeCity ? `，家地址城市「${homeCity}」可作選項` : '';
    lines.push(
      `- 當前城市：未知（定位不可用或城市解析失敗）——get_forecast 缺城市時回空 tasks 追問（提示開啟定位或說出城市名${opt}），嚴禁以「出發城市」行代替或猜測`,
    );
  }

  if (ctx.userProfile.location) {
    // 位置行只反映定位事實（當前城市 / 座標）——地址簿家城市屬「出發城市」
    // 行語義，混入此行會在「人在澳門、家在廣州」時自相矛盾（城市與座標對不上）
    const { currentCity, lat, lng } = ctx.userProfile.location;
    const hasCoord = lat !== undefined && lng !== undefined;
    if (currentCity && hasCoord) {
      lines.push(`- 用戶位置：${currentCity} (${lat}, ${lng})（定位已授權）`);
    } else if (currentCity) {
      lines.push(`- 用戶位置：${currentCity}（定位已授權）`);
    } else if (hasCoord) {
      lines.push(`- 用戶位置：城市未知（座標 ${lat}, ${lng}，定位已授權）——任務參數需要城市時應向用戶確認，勿由座標臆測`);
    } else {
      // 定位不可用（未授權 / 失敗 / 未嘗試）而地址簿給過出發城市：location
      // 為真值會遮蔽下方 denied / error 引導行——需座標任務的提示在此還原
      // （2026-10-16 審計 Low-2）
      const auth = ctx.userProfile.locationAuth;
      const why = auth === 'denied' ? '未授權' : auth === 'error' ? '定位失敗' : '定位未嘗試';
      lines.push(`- 用戶位置：定位不可用（${why}），僅有地址簿出發城市——需座標的任務（如 get_weather）應引導開啟定位或改用具名城市查詢（get_forecast）`);
    }
  } else if (ctx.userProfile.locationAuth === 'denied') {
    lines.push('- 用戶位置：定位已被拒絕授權——需座標的任務（如天氣）應回覆引導用戶到小程序設置開啟定位授權，勿假設可獲取座標');
  } else if (ctx.userProfile.locationAuth === 'error') {
    lines.push('- 用戶位置：定位失敗（非拒絕授權，可能系統定位開關關閉 / 網路異常）——需座標的任務應向用戶說明定位暫不可用，建議稍後重試');
  }
  // POI 查詢中心三級規則（2026-10-14 修訂：定位為默認中心，顯式地點線索才覆蓋）：
  //   1. 「附近 / 周邊 / 最近」無地點限定 → 定位座標（lat/lng）
  //   2. 「我家 / 家附近 / 我的收貨地址」→ 家地址權威行 address 字面值
  //   3. 「<用戶口述的具體地址 / 道路 / 小區 / 地標>附近」→ address=意圖原文地址
  // （badcase：「？我家，不是我定位附近」——用戶明確區分家與當前定位）
  if (ctx.userProfile.homeAddress) {
    lines.push(
      `- 家地址（地址簿默認收貨地址）：${ctx.userProfile.homeAddress.full}——search_poi 查詢中心規則：僅說「附近 / 周邊」時用定位座標（lat/lng）；提到「我家 / 家附近 / 我的收貨地址」時以本行字面值填 address（不填 lat/lng）；口述具體地址（如「XX路 / XX小區附近」）時以意圖原文地址填 address；均嚴禁改用定位座標`,
    );
  } else {
    lines.push(
      '- 家地址：未知（地址簿未填寫）——「我家 / 我的收貨地址」類意圖回空 tasks 追問（提示到「我的 → 收貨地址」添加默認地址，或請用戶直接說出具體地址）；僅說「附近」時正常用定位座標，嚴禁以定位代替家位置',
    );
  }
  if (Object.keys(ctx.userProfile.preferences).length > 0) {
    // 帶中文域標籤 + 採用指令：白名單域的鍵空間與規則 12 memory 欄位一致；
    // 「優先採用」確保沉澱的長期記憶真正影響規劃（僅注入不指令則 LLM 易忽略）
    const parts = Object.entries(ctx.userProfile.preferences).map(
      ([k, v]) => `${PREFERENCE_DOMAINS[k as keyof typeof PREFERENCE_DOMAINS] ?? k}=${String(v)}`,
    );
    lines.push(`- 用戶偏好（長期記憶）：${parts.join('、')}——規劃任務參數時優先採用（用戶本輪另有明確要求的除外）`);
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
  // 已收集的行程要素：行程複合意圖的多輪收集依賴（「下周去北京」→「看話劇」），
  // 固定注入不受滑動窗口擠出（與乘車人同構）；LLM 據此判斷三要素（日期 /
  // 目的地 / 活動）缺哪個就只追問哪個，不得重複追問已提供的
  const tripSlots = extractTripSlots(ctx.messages, '');
  if (tripSlots.date || tripSlots.city || tripSlots.activity) {
    const parts: string[] = [];
    if (tripSlots.date) parts.push(`日期 ${tripSlots.dateLabel ?? tripSlots.date}`);
    if (tripSlots.city) parts.push(`目的地 ${tripSlots.city}`);
    if (tripSlots.activity) parts.push(`活動 ${tripSlots.activity}`);
    lines.push(`- 已收集行程要素：${parts.join('、')}（規劃行程時僅追問缺失要素）`);
  }
  // 最近對話（含 assistant 摘要）：多輪場景的參數延續依賴（如「訂 G531」
  // 沿用上一輪查詢的日期）。僅取尾部數條且截斷，控制 token 消耗。
  // maxRecentMsgs 由 buildPlannerPrompt 降載階梯控制（超預算時 6→2→0）
  const recentMsgs = maxRecentMsgs > 0
    ? ctx.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-maxRecentMsgs)
    : [];
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
3. 任務之間若有資料依賴（如「查到的車次」要傳給「下單」），必須用 inputBindings 串接，否則並行執行。每個 task 必須帶 "id" 欄位（"task_001" 起連續編號），inputBindings.fromTaskId 與 dependsOn 只能引用這些 id 原文——自編 id（如 task_e01）會導致執行時綁定失敗回滚。
4. 任務物件不含 requiresHumanConfirm 欄位（確認檔位由各 capability 元數據統一聲明，2026-10 最小打擾修訂：可回滾寫操作默認自動執行，支付 / 不可逆場景才攔確認）——嚴禁在輸出中自造該欄位。
5. 無依賴的任務可並行（dependsOn: []）。
6. 若用戶意圖無法對應任何 SKILL，分兩種情況回應空 tasks：
   - **缺必要參數**（補充後可規劃，如缺乘車人）→ 回應 { "tasks": [] } 並在
     "message" 中追問；
   - **能力缺口**（現有 SKILL 範圍外，補參數也無法解決，如查農曆、匯率換算
     等不在簡表中的能力）→ 回應
     { "tasks": [], "missingCapability": { "skillName": "≤12字技能名", "suggestion": "≤60字建議（說明可到技能中心鍛造此能力）" }, "message": "同 suggestion 文案" }。
     missingCapability 僅在 tasks 為空時合法，能對應簡表能力時嚴禁輸出。
7. 每個 task 必須有 summary 欄位（人類可讀，≤ 30 字），供確認畫面展示。
8. **下單 / 支付前必須先規劃同域查詢任務**（如 book_ticket 前先 search_train），
   並遵守「字面值優先」：
   - 查詢任務的入參（from / to / date 等）一律寫字面值：from 取值三級
     優先——用戶意圖中明確點名的出發地最高（如「從北京到廣州」的
     北京，嚴禁以定位 / 地址簿默認城市覆蓋），其次取上下文「出發城市」
     行（僅為用戶未點名時的授權默認值）；其餘參數從用戶意圖或
     「最近對話」推斷；
   - 下單任務中用戶已點名的確定參數（如 trainNo）也寫字面值；
   - 上下文若有「已提供乘車人」行，book_ticket 的 passengerName / passengerIdNo
     必須以其字面值寫入（嚴禁省略，省略會導致執行校驗失敗）；
   - 上下文若無「已提供乘車人」行，嚴禁規劃 book_ticket / book_flight
     下單任務（即使意圖含買詞）——應按規則 9 回空 tasks 追問；
   - 演出票務買票意圖為三級鏈：search_events → list_sessions → create_order
     依序規劃，dependsOn 逐級建立，綁定固定路徑：list_sessions 綁
     { "eventId": { "fromField": "data.firstEventId" } }；create_order 綁
     eventId ← data.firstEventId、sessionId ← data.firstAvailableSessionId、
     tierId ← data.firstAvailableTierId、priceCent ← data.firstAvailablePriceCent
     （均引自前級任務）；觀演人 viewerName / viewerIdNo 用戶未提供時回空
     tasks 追問（與乘車人同規則，嚴禁編造，也嚴禁以乘車人簿 / 上下文
     乘車人信息代替觀演人——觀演人必須由用戶針對本演出明確提供）；
   - 預約意圖為兩級鏈：search_services → create_reservation，綁定固定路徑：
     serviceId ← data.firstServiceId、startTime ← data.firstAvailableStartTime、
     priceCent ← data.firstPriceCent；用戶已點名時段時 startTime 寫字面值（如
     "15:00"，嚴禁改绑首約時段覆盖用戶點名）；用戶點名服務時 serviceId 寫
     字面值（如 svc_001，此時 priceCent 用 data.priceCentByService.svc_001）；
   - **僅查詢才能產生的動態數據**用 inputBindings 引用（如即時票價：
     { "priceCent": { "fromTaskId": "task_001", "fromField": "priceCentByTrain.G531" } }，
     僅繫結 priceCent 一個鍵）——確認彈窗才能展示真實金額。
   嚴禁自造過濾語法（如 trains[?trainNo=='G531']）；path 只支援點號直達。
   fromField 只能使用本規則列出的各域固定路徑，嚴禁自編欄位名或跨域
   借用（如把票務的 firstAvailableSessionId 用於預約域、自編
   data.firstTrainId / data.firstStoreId 之類不存在的欄位）——非法路徑
   會在規劃校驗被直接攔截並降級，規劃白做。
   注意：下單任務（book_ticket / book_flight）為跳轉模式——生成資訊卡
   後跳轉官方渠道（12306 / OTA）完成真實下單與支付，無需也不應規劃任何
   支付類任務。
9. **嚴禁佔位符與空字符串**（如 "<需要用戶提供出行日期>"、"TBD"、null、""）：參數能從
   「最近對話」推斷就推斷；無法推斷且必填時（如乘車人姓名 passengerName /
   證號 passengerIdNo），回應 { "tasks": [] } 並在 "message" 中向用戶追問
   （如「請補充乘車人姓名與證件號」）。**嚴禁編造或沿用範例中的演示人名/
   證號**（如張三及其證號）——乘車人信息只能來自用戶對話原文。
   用戶僅補充乘車人信息（無新訂票指令）時：結合「最近意圖 / 最近對話」中
   未完成的訂票需求一併規劃下單（search_train + book_ticket），
   不要對已有答案的問題重複追問。
10. date 一律用具體日期字串（YYYY-MM-DD，按「當前時間」換算相對日期）。
11. **行程複合意圖**（「什麼時候去什麼地方幹什麼」，如「我周六想去上海看
   周杰倫的演唱會」「下周去北京」）：三要素 = 日期（date）/ 目的地城市
   （city）/ 活動（activity）。
   - 缺任一要素：回應 { "tasks": [] } 並在 "message" 追問（一次只問
     一個缺口，優先順序 date → city → activity；上下文「已收集行程要素」
     中已有的要素嚴禁重複追問）。
   - 三要素齊全：頂層輸出 "trip" 對象，並展開出行行程 DAG——
     交通為核心（search_train，出發城市取上下文「出發城市」行，到達 = 目的地；
     「出發城市」未知時先回空 tasks 追問出發城市，嚴禁猜測）；
     每個任務附 "timeLabel"（如 "10/11 周六"）。天氣任務僅當目的地與
     用戶當前城市相同時規劃（get_weather 只支援當前定位座標）。
   - 寫操作（book_ticket）僅在意圖含買詞（買 / 訂 /
     下單 / 搶票）且點名車票時追加——「想去看看」只查詢不下單。
12. **偏好記憶沉澱**：用戶在對話中**顯式表達長期偏好**時（如「以後高鐵
   都幫我選靠窗」「記住我喝拿鐵」），在頂層輸出 "memory" 對象——鍵僅限
   seat（高鐵座位）/ cabin（機艙等級）/ coffee（常用咖啡）/ diet（飲食
   偏好）/ budget（預算檔位），值為簡短偏好值（≤ 20 字）。約束：僅此類
   長期意圖才沉澱，「這次靠窗」類一次性需求嚴禁輸出；上下文「用戶偏好
   （長期記憶）」已有的鍵若無變化不必重複輸出；無偏好增量時省略欄位。
13. **設備通訊域**（dial_phone / draft_mail / send_mail）：電話號碼
   （phoneNumber）與郵箱地址（to）只能原樣取自用戶原文（字面值優先），
   **嚴禁推測 / 編造或沿用範例號碼與地址**；缺失時回應 { "tasks": [] } 並在
   "message" 中追問（如「請告訴我要撥打的電話號碼」）。撥打 12306 /
   10086 等熱線是 dial_phone 而非火車票域；send_mail 由雲端 SMTP 代發
   （不可用時自動降級複製引導，無需規劃備用任務），也不得向用戶承諾必達。
   **起草場景拆兩任務**：用戶給了收件地址但正文要你代寫（「幫我寫封請假
   郵件到 xx@xx.com，就說明天生病」）時，先 draft_mail（input 攜 to /
   topic / context，context 原樣摘自用戶要求不得擴編事實），再 send_mail
   （dependsOn 該起草任務，inputBindings 綁 data.subject → subject、
   data.body → body）；用戶已給全文（主題 + 正文都明確）時單任務
   send_mail 直達，不經 draft_mail。

## 輸出 schema

\`\`\`json
{
  "intent": "<用戶原始意圖>",
  "trip": { "date": "YYYY-MM-DD", "dateLabel": "周六", "city": "上海", "activity": "看一場演出" },
  "tasks": [
    {
      "skillId": "skill.xxx",
      "action": "xxx",
      "input": { "param": "value" },
      "inputBindings": {
        "param": { "fromTaskId": "task_001", "fromField": "data.field" }
      },
      "dependsOn": ["task_000"],
      "summary": "人類可讀摘要",
      "timeLabel": "10/11 周六"
    }
  ],
  "message": "可選：當 tasks 為空時的理由或追問",
  "missingCapability": { "skillName": "農曆查詢", "suggestion": "暫無農曆換算能力，可到技能中心鍛造「農曆查詢」技能" },
  "memory": { "seat": "靠窗" }
}
\`\`\`

（trip 與 timeLabel 僅行程複合意圖攜帶；missingCapability 僅規則 6 能力缺口
時攜帶（此時 tasks 必為空）；memory 僅規則 12 命中時攜帶，普通意圖省略這四個欄位）

## 範例一：僅查詢

意圖：「明天下午從北京到上海的高鐵，要二等座」（當前時間 2026-10-03T01:00:00Z）

\`\`\`json
{
  "intent": "查詢明天北京到上海的高鐵",
  "tasks": [
    {
      "id": "task_001",
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
      "id": "task_001",
      "skillId": "skill.train.12306",
      "action": "search_train",
      "input": { "from": "北京", "to": "上海", "date": "2026-10-04", "seatType": "second_class" },
      "inputBindings": {},
      "dependsOn": [],
      "summary": "查詢即時車次與票價"
    },
    {
      "id": "task_002",
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
      "summary": "生成購票卡跳轉 12306 下單（張三）需確認"
    }
  ],
  "message": ""
}
\`\`\`

## 範例三：行程複合意圖（出行行程 DAG + 時間線；多輪收集見規則 11）

意圖：「我周六想去上海看球賽」（當前時間 2026-10-08T02:00:00Z 周四；用戶位置：北京 (39.9, 116.4)）

\`\`\`json
{
  "intent": "周六去上海看球賽",
  "trip": { "date": "2026-10-11", "dateLabel": "周六", "city": "上海", "activity": "看球賽" },
  "tasks": [
    {
      "id": "task_001",
      "skillId": "skill.train.12306",
      "action": "search_train",
      "input": { "from": "北京", "to": "上海", "date": "2026-10-11", "seatType": "second_class" },
      "inputBindings": {},
      "dependsOn": [],
      "timeLabel": "10/11 周六",
      "summary": "查 10-11 北京→上海車次"
    }
  ],
  "message": ""
}
\`\`\`
`;