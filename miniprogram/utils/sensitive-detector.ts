/**
 * 敏感情境識別（純函數內核，永不 import wx）
 *
 * 依據 Agent.md「緊急情況處理」與「敏感話題處理」：
 * - crisis：識別自殺傾向表達 → 立即停止流程指引，心理支持置於一切之前；
 * - grief：識別情緒崩潰／重度悲傷 → 給予溫柔回應，流程可繼續；
 * - none：正常輸入。
 *
 * 匹配策略：包含式短語匹配，兼顧簡繁體；寧可多做一次溫柔回應，
 * 也不漏掉一次求助。回應文案見 knowledge/templates.ts。
 */

export type SensitiveLevel = 'none' | 'grief' | 'crisis';

export interface SensitiveResult {
  level: SensitiveLevel;
  matched: string[];
}

/** 自殺傾向類：使用足夠長的短語，避免「走」等單字誤報 */
const CRISIS_PATTERNS: string[] = [
  '不想活',
  '活不下去',
  '想不開',
  '想不开',
  '自殺',
  '自杀',
  '輕生',
  '轻生',
  '想死',
  '尋短',
  '寻短',
  '解脫了',
  '解脱了',
  '跟他一起走',
  '跟她一起走',
  '跟我媽一起走',
  '跟我爸一起走',
  '陪他一起走',
  '陪她一起走',
  '一起離開這個世界',
  '一起离开这个世界',
  '隨他而去',
  '随他而去',
  '隨她而去',
  '随她而去',
];

/** 情緒崩潰／重度悲傷類 */
const GRIEF_PATTERNS: string[] = [
  '崩潰',
  '崩溃',
  '受不了',
  '撐不住',
  '撑不住',
  '睡不著',
  '睡不着',
  '太痛苦',
  '難受',
  '难受',
  '無助',
  '无助',
  '疲憊',
  '疲惫',
  '難熬',
  '难熬',
  '心痛',
  '眼淚',
  '眼泪',
  '哭',
];

export function detectSensitive(text: string): SensitiveResult {
  const input = (text || '').trim();
  if (!input) {
    return { level: 'none', matched: [] };
  }
  const crisis = CRISIS_PATTERNS.filter((word) => input.includes(word));
  if (crisis.length > 0) {
    return { level: 'crisis', matched: crisis };
  }
  const grief = GRIEF_PATTERNS.filter((word) => input.includes(word));
  if (grief.length > 0) {
    return { level: 'grief', matched: grief };
  }
  return { level: 'none', matched: [] };
}
