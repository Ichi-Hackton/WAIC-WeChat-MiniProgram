/**
 * 引導狀態機單元測試：步驟順序、斷點恢復（不重複詢問）、回應文案分支。
 */
import {
  GUIDE_STEPS,
  OPENING_FIRST,
  applyAnswer,
  buildStepAck,
  buildSummary,
  getActiveStepIndex,
  relationDisplay,
} from '../miniprogram/utils/guidance-flow';
import type { GuideProfile } from '../miniprogram/utils/guidance-flow';

const FULL: GuideProfile = {
  relation: 'father',
  relationLabel: '父親',
  place: 'hospital',
  city: '杭州',
  religion: 'han-default',
  socialSecurity: 'insured',
};

describe('引導狀態機', () => {
  test('步驟順序：關係 → 地點 → 城市 → 宗教／民族 → 社保', () => {
    expect(GUIDE_STEPS.map((s) => s.key)).toEqual([
      'relation',
      'place',
      'city',
      'religion',
      'socialSecurity',
    ]);
  });

  test('空檔案：第一個待答步驟是 relation', () => {
    expect(getActiveStepIndex({})).toBe(0);
  });

  test('斷點恢復：已答信息不重複詢問', () => {
    const profile: GuideProfile = { relation: 'father', relationLabel: '父親', place: 'hospital' };
    expect(getActiveStepIndex(profile)).toBe(2); // 下一步應是 city
  });

  test('全部完成返回 -1', () => {
    expect(getActiveStepIndex(FULL)).toBe(-1);
  });

  test('applyAnswer：寫入城市與自定義關係', () => {
    let profile = applyAnswer({}, 'city', '成都', '成都');
    expect(profile.city).toBe('成都');
    profile = applyAnswer(profile, 'relation', '爺爺', '爺爺');
    expect(profile.relationLabel).toBe('爺爺');
    expect(getActiveStepIndex(profile)).toBe(1); // relation 已答，回到 place
  });

  test('子女離世的回應更溫和（放慢節奏）', () => {
    expect(buildStepAck('relation', 'child', '子女')).toContain('孩子');
    expect(buildStepAck('relation', 'father', '父親')).not.toContain('放慢節奏');
  });

  test('外地離世的回應提及遺體運輸', () => {
    expect(buildStepAck('place', 'away', '外地（非辦理城市）')).toContain('遺體運輸');
  });

  test('不確定社保時，回應引導先確認狀態', () => {
    expect(buildStepAck('socialSecurity', 'unsure', '不確定')).toContain('確認社保狀態');
  });

  test('relationDisplay：預設關係與自定義關係均正確顯示', () => {
    expect(relationDisplay({ relation: 'father' })).toBe('父親');
    expect(relationDisplay({ relation: 'other', relationLabel: '爺爺' })).toBe('爺爺');
    expect(relationDisplay({})).toBe('親人');
  });

  test('彙總文本包含城市與關係', () => {
    const summary = buildSummary(FULL);
    expect(summary).toContain('杭州');
    expect(summary).toContain('父親');
  });

  test('開場白非空且含哀悼語', () => {
    expect(OPENING_FIRST.length).toBeGreaterThan(0);
    expect(OPENING_FIRST.join('')).toContain('請節哀');
  });
});
