/**
 * 個人資料對話捕獲提取（純函數，零依賴）
 *
 * 規範來源：.qoder/rules/Agent.md § 12.3（utils 純函數約束，不得 import wx.*）
 *
 * 職責：從本輪意圖文本提取「收貨地址」結構與顯式保存指令判定，供
 * storage/profile-proposal 的捕獲管線消費。乘車人提取不在此重複實現
 * ——復用 utils/passenger 的 extractPassenger（構造單條 user 消息即可）。
 *
 * 安全定位（分層決策，與乘車人同構）：提取層保持寬鬆（僅結構正則），
 * 全量校驗（validateAddressForm）由捕獲管線在「落盤前」強制執行——
 * 錯誤地址在提議層擋下，不進地址簿（地址簿是 checkout 注入與出發
 * 城市推斷的數據源，髒數據會被反覆帶入）。
 *
 * 省市區不做地圖編碼核驗（MVP 正則 + 表單校驗）；接入雲端正向地理
 * 編碼核驗為後續增強項，接口形態不變。
 */

/** 地址提取結果（欄位可缺席，由 validateAddressForm 判缺） */
export interface ExtractedAddress {
  receiverName: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
}

/** 顯式保存指令詞（「記住 / 保存」——用戶明確要求持久化才直存） */
const EXPLICIT_SAVE_RE = /記住|记住|保存|儲存|储存/;

/** 是否顯式保存指令（顯式 = 直接落盤 + 回執；推斷 = 確認卡詢問） */
export function isExplicitSaveText(text: string): boolean {
  return EXPLICIT_SAVE_RE.test(text);
}

/**
 * 手機號（與 rule-planner PHONE_PATTERNS 首選形態對齊）
 *
 * \b 邊界保證 18 位證件號的內部 11 位子串不會誤配（證號內部前後皆
 * 數字 = \w，無邊界；中文側同樣形成邊界）。
 */
const PHONE_RE = /\b1[3-9]\d{9}\b/;

/**
 * 省市區匹配（省段可選捕獲組）：
 *   三級形態「廣東省深圳市南山區」；直轄市兩級「北京市朝陽區」（省段
 *   缺席，由捕獲管線以直轄市判定補 province = 市）。
 * 區段僅認 [区區縣县] 結尾（「市中心」「市區周邊」類閒聊不誤配）。
 */
const REGION_RE =
  /([\u4e00-\u9fa5]{2,8}(?:省|自治[区區]))?([\u4e00-\u9fa5]{2,10}(?:市|自治州))([\u4e00-\u9fa5]{2,12}(?:[区區縣县]))/;

/** 直轄市判定（省段缺席時僅此四市可補 province = 市） */
const MUNICIPALITY_RE = /北京|上海|天津|重庆|重慶/;

/**
 * 省段 / 市段前綴引導詞剝離表（實測坑：可選捕獲組無左邊界，
 * 「保存地址北京市」會把動詞短語整段捕入市段）——循環剝頭至穩定，
 * 與 utils/passenger 的 cleanSeg 同思路；長詞在前防短詞截斷。
 */
const LEAD_WORDS_RE =
  /^(?:收[貨货]地址|收件地址|記住|记住|保存|儲存|储存|添加|新增|送到|送貨|送货|住在|大後天|大后天|明天|後天|后天|今天|下周|下週|我家|我的|地址|在|到|去|至|幫|帮|給|给|請|请|：|:)+/;

/** 段頭引導詞剝離（循環至穩定） */
function stripLead(seg: string): string {
  let prev = '';
  while (prev !== seg && seg) {
    prev = seg;
    seg = seg.replace(LEAD_WORDS_RE, '');
  }
  return seg;
}

/** 收貨人顯式詞後姓名：「收貨人張三」/「收件人：李四」（[貨货] 涵蓋簡繁） */
const RECEIVER_RE = /(?:收[貨货]人|收件人)[:：]?\s*([\u4e00-\u9fa5]{2,4})/;

/**
 * 從意圖文本提取收貨地址（未命中地址結構返回 null）
 *
 * 語序容忍（主路徑）：「…廣東省深圳市南山區科技園路1號2棟，收貨人張三，
 * 電話13800138000」。詳址 = 區段之後的剩餘文本，按分隔符切段後剔除
 * 手機號段 / 收貨人段 / 電話詞段 / 已提取姓名段，避免人名與號碼混入詳址。
 */
export function extractAddressFromText(text: string): ExtractedAddress | null {
  const m = REGION_RE.exec(text);
  if (!m || m.index === undefined) return null;

  // 前綴引導詞剝離（「保存地址北京市」→「北京市」；剝空 = 假行政區匹配）
  const provinceRaw = m[1] ? stripLead(m[1]) : '';
  const city = stripLead(m[2]);
  if (!city) return null;
  const district = m[3];
  // 省段缺席：直轄市補 province = 市（微信 region picker 直轄市即重複市名）；
  // 非直轄市不硬補（留空由 validateAddressForm 判缺引導補全——錯誤省段
  // 會污染 checkout 的 region 注入，寧缺毋錯）
  const province = provinceRaw || (MUNICIPALITY_RE.test(city) ? city : '');

  const phoneMatch = text.match(PHONE_RE);
  const phone = phoneMatch ? phoneMatch[0] : '';

  // 收貨人姓名：顯式詞優先；缺席時手機號左側倒序找 2-4 純漢字段
  const receiverMatch = RECEIVER_RE.exec(text);
  let receiverName = receiverMatch ? receiverMatch[1] : '';
  if (!receiverName && phoneMatch && phoneMatch.index !== undefined) {
    receiverName = extractNameBeforePhone(text.slice(0, phoneMatch.index));
  }

  // 詳址：區段結束之後的剩餘文本，切段剔除非地址成分
  const after = text.slice(m.index + m[0].length);
  const detail = cleanDetail(after, phone, receiverName);

  return {
    receiverName,
    phone,
    province,
    city,
    district,
    detail,
  };
}

/**
 * 手機號左側文本 → 收貨人姓名（倒序逐段找 2-4 純漢字整段）
 *
 * 與 utils/passenger 的 extractNameBefore 同構，但剔除詞表換成地址
 * 語境（送貨 / 下單類詞）；姓名通常緊鄰手機號（「…，張三，138…」）。
 */
function extractNameBeforePhone(left: string): string {
  const stop =
    '收[貨货]人|收件人|電話|电话|手機|手机|聯繫|联系|號碼|号码|地址|送到|送貨|送货|下單|下单|幫|帮|给|給|是|叫|我|你|他|她|的|了';
  const parts = left.split(/[，,、。；;:：（）()\s]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i].replace(new RegExp(`^(?:${stop})`), '').replace(new RegExp(`(?:${stop})$`), '');
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(seg)) return seg;
  }
  return '';
}

/**
 * 區段後剩餘文本 → 詳址（切段剔除非地址成分後回拼）
 *
 * 剔除規則：含手機號整段、含收貨人詞段、含電話詞段、等於已提取姓名
 * 的段、純標點段；其餘段直接拼接（詳址本身連續，通常僅剩一至兩段）。
 */
function cleanDetail(after: string, phone: string, receiverName: string): string {
  const PHONE_WORD_RE = /電話|电话|手機|手机|聯繫|联系|號碼|号码/;
  const RECEIVER_WORD_RE = /收[貨货]人|收件人/;
  const parts = after.split(/[，,、。；;:：（）()\s]+/).filter(Boolean);
  const kept: string[] = [];
  for (const seg of parts) {
    if (phone && seg.includes(phone)) continue;
    if (RECEIVER_WORD_RE.test(seg)) continue;
    if (PHONE_WORD_RE.test(seg)) continue;
    if (receiverName && seg === receiverName) continue;
    kept.push(seg);
  }
  return kept.join('').slice(0, 120);
}

/** 手機號脫敏（卡面展示用）：保留前 3 位與後 4 位 */
export function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;
}
