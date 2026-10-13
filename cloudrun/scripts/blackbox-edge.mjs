// MicroMate 黑盒邊界測試（臨時，針對本地 dev 服務 8787；與冒煙腳本互補：
// 聚焦鑒權 / 參數校驗 / 售罄 / IDOR / 危機短路 / 未知路由等異常路徑）
// 用法：先 .\dev-start.ps1 起服務，再 node scripts/blackbox-edge.mjs
// 對確定行為硬斷言（FAIL 即退出碼 1）；對未成文契約的行為以 OBSV 觀察記錄
const H = process.env.PORT ? `http://127.0.0.1:${process.env.PORT}` : 'http://127.0.0.1:8787';
const OWNER = { 'content-type': 'application/json', 'x-wx-openid': 'blackbox-edge-owner' };
const OTHER = { 'content-type': 'application/json', 'x-wx-openid': 'blackbox-edge-other' };
const NOID = { 'content-type': 'application/json' };

let pass = 0, fail = 0;
const results = [];
async function call(path, headers, body) {
  const r = await fetch(H + path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON 回應 */ }
  return { status: r.status, code: j?.code, data: j?.data, message: j?.message };
}
function assert(name, cond, detail) {
  if (cond) { pass++; results.push(`PASS ${name}`); }
  else { fail++; results.push(`FAIL ${name} :: ${detail}`); }
}
function observe(name, res) {
  results.push(`OBSV ${name} :: HTTP ${res.status} code=${res.code} msg=${(res.message ?? '').slice(0, 60)} data=${JSON.stringify(res.data)?.slice(0, 120)}`);
}

// --- 鑒權邊界（寫操作無身份一律 401）---
for (const [name, path, body] of [
  ['coffee place_order 無身份', '/api/skill/skill.coffee.starbucks/place_order', { storeId: 'sb_001', items: [{ sku: 'demo_latte', name: '拿鐵', quantity: 1, size: '中杯' }], pickupType: 'in_store' }],
  ['booking create_reservation 無身份', '/api/skill/skill.booking.center/create_reservation', { serviceId: 'svc_001', date: '2026-10-13', startTime: '12:00' }],
  ['ticket create_order 無身份', '/api/skill/skill.ticket.show/create_order', { eventId: 'ev_001', sessionId: 'ev_001_s1', tierId: 'ev_001_s1_t1', quantity: 1, viewerName: '演示觀演人', viewerIdNo: '110101199001011234' }],
]) {
  const res = await call(path, NOID, body);
  assert(name + ' → 401', res.status === 401, `HTTP ${res.status}`);
}

// --- 參數校驗邊界（api.ts 契約：unauthorized/badRequest 為真 HTTP 4xx；
//     fail(業務碼) 為 HTTP 200 + body.code，故業務碼斷言看 res.code）---
let res = await call('/api/skill/skill.coffee.starbucks/search_store', NOID, {});
observe('coffee search_store 缺 city（空入參）', res);
res = await call('/api/skill/skill.coffee.starbucks/place_order', OWNER, { storeId: 'sb_999', items: [{ sku: 'demo_latte', name: '拿鐵', quantity: 1, size: '中杯' }], pickupType: 'in_store' });
assert('coffee place_order 不存在門市 sb_999 → code=404', res.code === 404, JSON.stringify(res).slice(0, 100));
res = await call('/api/skill/skill.coffee.starbucks/place_order', OWNER, { storeId: 'sb_001', items: [], pickupType: 'in_store' });
observe('coffee place_order 空 items', res);
res = await call('/api/skill/skill.shopping.mall/add_to_cart', OWNER, { productId: 'p_001', quantity: 0 });
assert('shopping add_to_cart quantity=0 → 400', res.status === 400, `HTTP ${res.status} ${res.message}`);
res = await call('/api/skill/skill.shopping.mall/add_to_cart', OWNER, { productId: 'p_999', quantity: 1 });
assert('shopping add_to_cart 未知商品 p_999 → code=404', res.code === 404, JSON.stringify(res).slice(0, 100));

// --- 票務邊界 ---
res = await call('/api/skill/skill.ticket.show/create_order', OWNER, { eventId: 'ev_001', sessionId: 'ev_001_s1', tierId: 'ev_001_s1_t3', quantity: 1, viewerName: '演示觀演人', viewerIdNo: '110101199001011234' });
assert('ticket create_order 售罄票檔 t3 → 業務碼 1002（餘票不足）', res.code === 1002, JSON.stringify(res).slice(0, 100));
res = await call('/api/skill/skill.ticket.show/create_order', OWNER, { eventId: 'ev_001', sessionId: 'ev_001_s1', tierId: 'ev_001_s1_t999', quantity: 1, viewerName: '演示觀演人', viewerIdNo: '110101199001011234' });
assert('ticket create_order 不存在票檔 t999 → code=404', res.code === 404, JSON.stringify(res).slice(0, 100));
res = await call('/api/skill/skill.ticket.show/list_sessions', NOID, { eventId: 'ev_999' });
assert('ticket list_sessions 未知演出 → code=404', res.code === 404, JSON.stringify(res).slice(0, 100));
res = await call('/api/skill/skill.ticket.show/search_events', NOID, {});
assert('ticket search_events 空入參 → 400', res.status === 400, `HTTP ${res.status} ${res.message}`);
res = await call('/api/skill/skill.ticket.show/search_events', NOID, { keyword: '不存在的演出團體xyz' });
assert('ticket search_events 未知關鍵詞 → 空 events（code=0）', res.status === 200 && res.code === 0 && Array.isArray(res.data?.events) && res.data.events.length === 0, JSON.stringify(res).slice(0, 100));

// --- 預約邊界（含 IDOR 與生命週期）---
res = await call('/api/skill/skill.booking.center/create_reservation', OWNER, { serviceId: 'svc_001', date: '2026-10-12', startTime: '10:00' });
observe('booking 任意時段建卡（跳轉模式不校驗本地時段可用性，10:00 僅演示）', res);
const slot10 = res.data?.reservationId;
const myRes = await call('/api/skill/skill.booking.center/create_reservation', OWNER, { serviceId: 'svc_002', date: '2026-10-13', startTime: '10:00' });
assert('booking create_reservation 正常建卡', myRes.status === 200 && myRes.code === 0 && myRes.data?.status === 'pending_external', JSON.stringify(myRes).slice(0, 100));
const rid = myRes.data?.reservationId;
if (rid) {
  res = await call('/api/skill/skill.booking.center/cancel_reservation', OTHER, { reservationId: rid });
  assert('booking 他人取消 → 403（IDOR 防線）', res.status === 403, `HTTP ${res.status} ${res.message}`);
  res = await call('/api/skill/skill.booking.center/cancel_reservation', OWNER, { reservationId: rid });
  assert('booking 本人取消 → ok', res.status === 200 && res.data?.ok === true, JSON.stringify(res).slice(0, 80));
  res = await call('/api/skill/skill.booking.center/cancel_reservation', OWNER, { reservationId: rid });
  assert('booking 重複取消 → code=404', res.code === 404, JSON.stringify(res).slice(0, 100));
}

// --- 支付聚合邊界（先清理不可約時段觀察所生的訂單，再驗空清單）---
if (slot10) {
  await call('/api/skill/skill.booking.center/cancel_reservation', OWNER, { reservationId: slot10 });
}
res = await call('/api/skill/skill.payment.aicard/pay_orders', OWNER, {});
assert('pay_orders 有身份無訂單 → count=0', res.status === 200 && res.code === 0 && res.data?.count === 0, JSON.stringify(res).slice(0, 100));

// --- 諮詢危機短路（本地靜態文案，不調 LLM）---
res = await call('/api/skill/skill.mind.counseling/chat_companion', OWNER, { message: '我不想活了', history: [] });
assert('counseling 危機詞 → crisis=true', res.status === 200 && res.code === 0 && res.data?.crisis === true, JSON.stringify(res).slice(0, 150));
observe('counseling 危機回覆內容', res);

// --- 未知路由 ---
res = await call('/api/skill/skill.not.exist/foo', NOID, {});
assert('未知 SKILL 路由 → 404', res.status === 404, `HTTP ${res.status}`);

console.log(results.join('\n'));
console.log(`\n===== 黑盒邊界結果：PASS=${pass} FAIL=${fail} =====`);
process.exit(fail > 0 ? 1 : 0);
