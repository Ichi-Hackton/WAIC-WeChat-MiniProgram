// 診斷：report_explain 降級原因——對 mode:'text' 的 reply 原文做 JSON.parse，
// 打印具體語法錯誤位置與括號平衡掃描結果
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

const res = await fetch(`${BASE}/api/skill/skill.health.advisor/report_explain`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({
    reportText: '白細胞 11.5 ×10^9/L（參考 3.5-9.5），血紅蛋白 130 g/L（參考 115-150），血小板 90 ×10^9/L（參考 125-350）',
  }),
});
const body = await res.json();
console.log('HTTP', res.status, 'code', body.code, 'mode', body.data?.mode);
if (body.data?.mode !== 'text') {
  console.log('本次為 structured，無需診斷');
  process.exit(0);
}
const reply = body.data.reply;
console.log('--- reply 原文（repr 前 1200 字）---');
console.log(JSON.stringify(reply).slice(0, 1200));

// 1) 直接 parse（模擬 extractJsonObject 的貪婪正則 + parse）
const m = reply.match(/\{[\s\S]*\}/);
if (!m) {
  console.log('貪婪正則未匹配到 {..}');
  process.exit(0);
}
try {
  JSON.parse(m[0]);
  console.log('直接 JSON.parse 成功（則降級原因應為 items 窄化為空）');
} catch (e) {
  console.log('直接 JSON.parse 失敗:', e.message);
}

// 2) 括號平衡掃描：從首個 { 起找平衡的頂層物件
function balancedSlice(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
const slice = balancedSlice(reply);
if (slice) {
  try {
    const parsed = JSON.parse(slice);
    console.log('平衡掃描切片 parse 成功：items =', parsed.items?.length, 'summary 長 =', parsed.summary?.length);
  } catch (e) {
    console.log('平衡掃描切片 parse 仍失敗:', e.message);
    console.log('切片末尾 200 字:', JSON.stringify(slice.slice(-200)));
  }
} else {
  console.log('括號不平衡（有多餘閉括號）：reply 末尾 200 字 =', JSON.stringify(reply.slice(-200)));
}
