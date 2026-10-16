// 驗證 extractJsonObject 增強版對典型 LLM 畸形輸出的挽救能力
// （直接對 dist 產物不可行——未導出；此處以同款邏輯對拍驗證行為契約）
function balancedJsonSlice(raw) {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return raw.slice(start, i + 1); }
  }
  return null;
}
function extract(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  for (const candidate of [raw.match(/\{[\s\S]*\}/)?.[0], balancedJsonSlice(raw)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      return parsed;
    } catch { /* 試下一個候選 */ }
  }
  return null;
}

const cases = [
  // [名稱, LLM 原文, 期望結論]
  ['乾淨 JSON', '{"items":[]}'],
  ['圍欄包裹', '好的：\n```json\n{"a":1}\n```\n以上'],
  ['前置引導語', '以下為解讀：{"a":1,"b":{"c":2}}'],
  ['尾隨附言含右括號', '{"a":1}\n注意：若指標異常（如偏低 }）請複查'],
  ['多餘閉括號（冒煙實測畸形）', '{"items":[{"n":1}],"summary":"s"}\n}'],
  ['字符串內含括號', '{"a":"內容有 } 和 { 符號"}'],
  ['非物件頂層', '[1,2,3]'],
  ['無 JSON', '抱歉，無法解讀'],
];
let fail = 0;
for (const [name, text, ] of cases) {
  const r = extract(text);
  let expectNonNull = name !== '非物件頂層' && name !== '無 JSON';
  const ok = expectNonNull ? r !== null : r === null;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} => ${r === null ? 'null' : JSON.stringify(r).slice(0, 60)}`);
  if (!ok) fail++;
}
process.exit(fail ? 1 : 0);
