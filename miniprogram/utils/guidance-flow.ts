/**
 * 對話引導狀態機（純函數內核，永不 import wx）
 *
 * 依據 Agent.md「流程一：初次引導」與「對話設計原則」：
 * - 一次只問一個問題；
 * - 已回答的信息不再重複詢問（斷點恢復時自動跳過已完成的步驟）；
 * - 每次回答後給出簡短、有溫度的回應，再推進下一小步。
 */

export type RelationKey = 'father' | 'mother' | 'spouse' | 'sibling' | 'child' | 'other';
export type PlaceKey = 'hospital' | 'home' | 'care-home' | 'away' | 'other';
export type ReligionKey = 'han-default' | 'ethnic-minority' | 'religious' | 'skip';
export type SocialKey = 'insured' | 'none' | 'unsure';

/** 引導過程中收集的逝者與辦理信息（不含任何身份證號等敏感字段） */
export interface GuideProfile {
  relation?: RelationKey;
  relationLabel?: string;
  place?: PlaceKey;
  city?: string;
  religion?: ReligionKey;
  socialSecurity?: SocialKey;
}

/** 對話消息：kind=crisis 時在氣泡下方渲染心理支持卡片 */
export interface ChatMessage {
  id: string;
  role: 'agent' | 'user';
  text: string;
  kind?: 'normal' | 'crisis';
  ts: number;
}

export interface GuideOption {
  value: string;
  label: string;
}

export interface GuideStep {
  key: 'relation' | 'place' | 'city' | 'religion' | 'socialSecurity';
  question: string;
  options: GuideOption[];
  allowCustom: boolean;
  customPlaceholder?: string;
  customHint?: string;
}

const RELATION_OPTIONS: GuideOption[] = [
  { value: 'father', label: '父親' },
  { value: 'mother', label: '母親' },
  { value: 'spouse', label: '配偶' },
  { value: 'sibling', label: '兄弟姐妹' },
  { value: 'child', label: '子女' },
  { value: 'other', label: '其他親人' },
];

const PLACE_OPTIONS: GuideOption[] = [
  { value: 'hospital', label: '醫院' },
  { value: 'home', label: '家中' },
  { value: 'care-home', label: '養老機構' },
  { value: 'away', label: '外地（非辦理城市）' },
  { value: 'other', label: '其他地點' },
];

const CITY_OPTIONS: GuideOption[] = [
  { value: '北京', label: '北京' },
  { value: '上海', label: '上海' },
  { value: '廣州', label: '廣州' },
  { value: '杭州', label: '杭州' },
];

const RELIGION_OPTIONS: GuideOption[] = [
  { value: 'han-default', label: '漢族一般習俗' },
  { value: 'ethnic-minority', label: '少數民族習俗' },
  { value: 'religious', label: '有宗教信仰' },
  { value: 'skip', label: '暫不考慮' },
];

const SOCIAL_OPTIONS: GuideOption[] = [
  { value: 'insured', label: '有社保（在職或退休）' },
  { value: 'none', label: '沒有社保' },
  { value: 'unsure', label: '不確定' },
];

/** 引導步驟順序：關係 → 離世地點 → 城市 → 宗教／民族 → 社保情況 */
export const GUIDE_STEPS: GuideStep[] = [
  {
    key: 'relation',
    question: '首先想確認：逝者與您的關係是？',
    options: RELATION_OPTIONS,
    allowCustom: true,
    customPlaceholder: '也可以直接輸入，如「爺爺」',
  },
  {
    key: 'place',
    question: '逝者是在哪裡離世的？',
    options: PLACE_OPTIONS,
    allowCustom: false,
  },
  {
    key: 'city',
    question: '您目前計劃在哪座城市辦理後續事宜？',
    options: CITY_OPTIONS,
    allowCustom: true,
    customPlaceholder: '輸入城市名，如「成都」',
  },
  {
    key: 'religion',
    question: '是否需要考慮宗教或民族方面的安排？',
    options: RELIGION_OPTIONS,
    allowCustom: false,
  },
  {
    key: 'socialSecurity',
    question: '逝者生前是否有社保？',
    options: SOCIAL_OPTIONS,
    allowCustom: false,
  },
];

/** 返回當前應提問的步驟下標；全部完成時返回 -1 */
export function getActiveStepIndex(profile: GuideProfile): number {
  return GUIDE_STEPS.findIndex((step) => profile[step.key] === undefined);
}

/** 將一次回答寫入檔案（純函數，返回新對象） */
export function applyAnswer(
  profile: GuideProfile,
  stepKey: GuideStep['key'],
  value: string,
  label: string,
): GuideProfile {
  const next: GuideProfile = { ...profile };
  switch (stepKey) {
    case 'relation':
      next.relation = value as RelationKey;
      next.relationLabel = label;
      break;
    case 'place':
      next.place = value as PlaceKey;
      break;
    case 'city':
      next.city = value;
      break;
    case 'religion':
      next.religion = value as ReligionKey;
      break;
    case 'socialSecurity':
      next.socialSecurity = value as SocialKey;
      break;
  }
  return next;
}

/** 每次回答後的簡短回應：有溫度，但不煽情（敏感場景用更溫和的措辭） */
export function buildStepAck(key: GuideStep['key'], value: string, label: string): string {
  switch (key) {
    case 'relation':
      if (value === 'child') {
        return '聽到孩子離開，非常不忍。接下來的每一步，我們都放慢節奏，以您和家人的狀態為先。';
      }
      if (value === 'spouse') {
        return '陪伴多年的人離開，這份沉重很難用語言形容。我們慢慢來，一步一步辦。';
      }
      if (value === 'other') {
        return `請節哀。已記下：逝者是您的${label}。我們一步一步來。`;
      }
      return `請節哀。已記下：逝者是您的${label}。我們一步一步來，我會陪您辦好每件事。`;
    case 'place':
      if (value === 'away') {
        return '在外地離世會涉及遺體運輸，我會在清單中為您特別標註這件事。';
      }
      if (value === 'home') {
        return '在家中離世時，死亡證明的開具流程會略有不同，我會在清單裡為您說明。';
      }
      return '好的，已記下離世地點。';
    case 'city':
      return `好的，將以「${label}」為主為您準備信息；若暫無該城市明細，會提供通用指引並明確標註。`;
    case 'religion':
      if (value === 'ethnic-minority' || value === 'religious') {
        return '已記下。殯儀館通常可以協調宗教儀軌與民族習俗，我會在清單中提醒您提前確認。';
      }
      return '好的，先按一般習俗準備，之後有需要隨時可以調整。';
    case 'socialSecurity':
      if (value === 'insured') {
        return '好的，清單會包含社保結算與喪葬補助金申領，這部分能覆蓋不少基礎費用。';
      }
      if (value === 'unsure') {
        return '沒關係，很多人一時也不確定。清單裡會先安排「確認社保狀態」這一步。';
      }
      return '好的，清單裡會安排「確認社保狀態」，城鄉居民養老保險也可能有喪葬補助。';
  }
}

/** 開場白：首次進入（Agent.md 示例1 的語氣）與斷點恢復 */
export const OPENING_FIRST: string[] = [
  '請節哀。這段時間一定很難熬，我們一步一步來，我會陪您把該辦的事一件件辦好。',
  '先確認幾個關鍵信息，之後我會為您生成一份可以照著辦的分時段清單。',
];

export const OPENING_RESUMED: string[] = [
  '歡迎回來。我們從上次停下的地方繼續，您不用重複之前說過的信息。',
];

const RELATION_LABELS: Record<RelationKey, string> = {
  father: '父親',
  mother: '母親',
  spouse: '配偶',
  sibling: '兄弟姐妹',
  child: '子女',
  other: '親人',
};

const PLACE_LABELS: Record<PlaceKey, string> = {
  hospital: '醫院',
  home: '家中',
  'care-home': '養老機構',
  away: '外地',
  other: '其他地點',
};

const RELIGION_LABELS: Record<ReligionKey, string> = {
  'han-default': '漢族一般習俗',
  'ethnic-minority': '少數民族習俗',
  religious: '有宗教信仰',
  skip: '暫不考慮',
};

const SOCIAL_LABELS: Record<SocialKey, string> = {
  insured: '有社保',
  none: '沒有社保',
  unsure: '不確定',
};

export function relationDisplay(profile: GuideProfile): string {
  // 預設關係查表；「其他親人」與自定義輸入（如「爺爺」）一律用 relationLabel
  const key = profile.relation;
  if (key && key !== 'other' && key in RELATION_LABELS) {
    return RELATION_LABELS[key];
  }
  return profile.relationLabel || '親人';
}

export function placeDisplay(profile: GuideProfile): string {
  return profile.place ? PLACE_LABELS[profile.place] : '—';
}

export function religionDisplay(profile: GuideProfile): string {
  return profile.religion ? RELIGION_LABELS[profile.religion] : '—';
}

export function socialDisplay(profile: GuideProfile): string {
  return profile.socialSecurity ? SOCIAL_LABELS[profile.socialSecurity] : '—';
}

/** 信息收集完成後的彙總文本（顯示在「生成清單」面板中） */
export function buildSummary(profile: GuideProfile): string {
  return [
    `逝者是您的${relationDisplay(profile)}`,
    `離世地點：${placeDisplay(profile)}`,
    `辦理城市：${profile.city || '—'}`,
    `習俗安排：${religionDisplay(profile)}`,
    `社保情況：${socialDisplay(profile)}`,
  ].join('\n');
}
