// rule-planner 意圖路由黑盒斷言（自包含：腳本自行編譯 rule-planner 至臨時目錄後驅動，跑完自動清理）
// 以 Node 直接驅動編譯後的 rule-planner（純函數，無 wx 依賴），斷言六域
// 意圖 → 任務 DAG 的 skillId/action 序列，以及危機短路 / 支付短路 / 域互斥。
// 用法：node scripts/blackbox-planner.mjs（無需起服務，離線可跑）
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const tscBin = `${repoRoot}node_modules/typescript/bin/tsc`;
const src = `${repoRoot}miniprogram/src/llm/rule-planner.ts`;
const outDir = `${repoRoot}tmp-planner-blackbox/`;

// 編譯（commonjs 供 Node require；rule-planner 依賴鏈均為純函數，無 wx 依賴）
rmSync(outDir, { recursive: true, force: true });
execFileSync(process.execPath, [
  tscBin, src, '--ignoreConfig', '--outDir', outDir,
  '--module', 'commonjs', '--target', 'es2020', '--esModuleInterop',
  '--skipLibCheck', '--moduleResolution', 'bundler',
], { stdio: 'inherit' });

const requireCompiled = createRequire(outDir);
const { rulePlan } = requireCompiled('./llm/rule-planner.js');

function makeCtx(over = {}) {
  return {
    sessionId: 'test-session',
    userId: 'u1',
    userProfile: {
      location: { lat: 31.23, lng: 121.47, city: '上海', currentCity: '上海' },
      locationAuth: 'granted',
      preferences: {},
      history: [],
    },
    globals: {},
    messages: [],
    trace: { llmCalls: 0, skillCalls: 0, totalTokens: 0, startTime: Date.now() },
    ...over,
  };
}

let pass = 0, fail = 0;
const out = [];
function check(name, cond, detail) {
  if (cond) { pass++; out.push(`PASS ${name}`); }
  else { fail++; out.push(`FAIL ${name} :: ${detail}`); }
}
function actions(intent, ctx) {
  const plan = rulePlan(intent, ctx ?? makeCtx());
  return (plan.tasks ?? []).map((t) => `${t.skillId}:${t.action}`);
}

// --- 六域主鏈路 ---
let a = actions('來杯拿鐵');
check('咖啡「來杯拿鐵」→ search_store + place_order',
  a.includes('skill.coffee.starbucks:search_store') && a.includes('skill.coffee.starbucks:place_order'), a.join(' | '));

a = actions('幫我買無線降噪耳機');
check('購物「買耳機」→ search_products + add_to_cart',
  a.includes('skill.shopping.mall:search_products') && a.includes('skill.shopping.mall:add_to_cart'), a.join(' | '));

a = actions('結帳');
check('購物「結帳」→ checkout（單任務短路）',
  a.length === 1 && a[0] === 'skill.shopping.mall:checkout', a.join(' | '));

a = actions('預約明天下午羽毛球場地');
check('預約「羽毛球場地」→ search_services + create_reservation',
  a.includes('skill.booking.center:search_services') && a.includes('skill.booking.center:create_reservation'), a.join(' | '));
{
  const plan = rulePlan('預約明天下午羽毛球場地', makeCtx());
  const res = (plan.tasks ?? []).find((t) => t.action === 'create_reservation');
  check('預約卡時段「下午」→ 字面 14:00',
    res?.input?.startTime === '14:00', JSON.stringify(res?.input));
}

a = actions('幫我買周杰倫演唱會的票');
check('票務「周杰倫演唱會」（簡體口語）→ 三級鏈 search_events → list_sessions → create_order',
  a[0] === 'skill.ticket.show:search_events' && a[1] === 'skill.ticket.show:list_sessions' && a[2] === 'skill.ticket.show:create_order', a.join(' | '));
{
  const plan = rulePlan('幫我買周杰倫演唱會的票', makeCtx());
  const order = plan.tasks[2];
  const b = order.inputBindings ?? {};
  check('票務三級鏈 inputBindings 綁定正確（eventId/sessionId/tierId/priceCent）',
    b.eventId?.fromField === 'data.firstEventId' && b.sessionId?.fromField === 'data.firstAvailableSessionId'
    && b.tierId?.fromField === 'data.firstAvailableTierId' && b.priceCent?.fromField === 'data.firstAvailablePriceCent',
    JSON.stringify(b));
}

a = actions('有點難過，陪我聊聊');
check('諮詢「難過陪我聊聊」→ chat_companion（單任務）',
  a.length === 1 && a[0] === 'skill.mind.counseling:chat_companion', a.join(' | '));

a = actions('我要支付');
check('支付「我要支付」→ pay_orders（單任務短路）',
  a.length === 1 && a[0] === 'skill.payment.aicard:pay_orders', a.join(' | '));

// --- 原有三域回歸 ---
a = actions('明天北京到上海的高鐵，二等座');
check('高鐵查詢語義（無買詞）→ 僅 search_train',
  a.length === 1 && a[0] === 'skill.train.12306:search_train', a.join(' | '));
a = actions('訂明天北京到上海的高鐵，二等座');
check('高鐵訂票語義 → search_train + book_ticket',
  a.includes('skill.train.12306:search_train') && a.includes('skill.train.12306:book_ticket'), a.join(' | '));

a = actions('查上海天氣');
check('天氣意圖 → get_weather', a.includes('skill.weather.query:get_weather'), a.join(' | '));

{
  const plan = rulePlan('未來七天的天氣', makeCtx());
  const t = (plan.tasks ?? [])[0];
  check('預報「未來七天天氣」→ get_forecast，城市取定位 currentCity（非地址簿出發城市）',
    t?.action === 'get_forecast' && t?.input?.city === '上海', JSON.stringify(t?.input));
}

// --- 危機短路（優先於一切業務域，含支付）---
{
  const plan = rulePlan('我不想活了', makeCtx());
  check('危機詞 → 空 tasks + 關懷 message',
    (plan.tasks?.length ?? 0) === 0 && (plan.message ?? '').includes('12356'), JSON.stringify(plan).slice(0, 80));
}
{
  const plan = rulePlan('活不下去了，幫我付款', makeCtx());
  check('危機詞 + 支付詞 → 危機短路優先（不觸發 pay_orders）',
    (plan.tasks?.length ?? 0) === 0 && (plan.message ?? '').includes('12356'), JSON.stringify(plan).slice(0, 80));
}

// --- 域互斥 ---
a = actions('煩死了幫我訂杯咖啡');
check('互斥「煩 + 訂咖啡」→ 咖啡任務優先（非諮詢兜底）',
  a.includes('skill.coffee.starbucks:place_order'), a.join(' | '));

a = actions('買咖啡豆');
check('互斥「咖啡豆」→ 購物域（p_004）非咖啡域',
  a.includes('skill.shopping.mall:search_products') && !a.some((x) => x.startsWith('skill.coffee')), a.join(' | '));

a = actions('買周杰倫專輯');
check('互斥「專輯」非演出票 → 不觸發票務域（商品語境排除）',
  !a.some((x) => x.startsWith('skill.ticket')), a.join(' | '));

a = actions('買周杰倫專輯，順便看場演唱會');
check('互斥「專輯 + 演唱會」→ 演出語境優先歸票務域',
  a.some((x) => x === 'skill.ticket.show:search_events'), a.join(' | '));

// --- 詞表外透傳與簡繁邊界（路由翻轉 H1 + wantsTicket 正則 M1 修復固化）---
{
  const plan = rulePlan('今天穿什麼衣服好', makeCtx());
  check('詞表外意圖 → 空 tasks + 空 message（透傳 LLM 規劃，規則層不攔截）',
    (plan.tasks?.length ?? 0) === 0 && (plan.message ?? '') === '', JSON.stringify(plan).slice(0, 80));
}
a = actions('最近有什么音乐剧');
check('簡體「音乐剧」命中票務域（正則與 understand() 詞表同源化）',
  a.includes('skill.ticket.show:search_events'), a.join(' | '));

// --- 行程複合意圖 ---
{
  const beijingCtx = makeCtx();
  beijingCtx.userProfile.location = { lat: 39.9, lng: 116.4, city: '北京', currentCity: '北京' };
  a = actions('周六去上海看球賽', beijingCtx);
  check('行程（北京定位）「周六去上海看球賽」→ 多任務 DAG（交通 + 演出搜尋）',
    a.includes('skill.train.12306:search_train') && a.includes('skill.ticket.show:search_events'), a.join(' | '));
}
{
  const plan = rulePlan('周六去上海看球賽', makeCtx()); // 定位上海 = 目的地同城
  check('行程同城 → 不硬造跨城任務，追問出發城市',
    (plan.tasks?.length ?? 0) === 0 && (plan.message ?? '').includes('與目的地相同'), JSON.stringify(plan).slice(0, 80));
}

console.log(out.join('\n'));
console.log(`\n===== 意圖路由黑盒：PASS=${pass} FAIL=${fail} =====`);
rmSync(outDir, { recursive: true, force: true }); // 清理臨時編譯產物
process.exit(fail > 0 ? 1 : 0);
