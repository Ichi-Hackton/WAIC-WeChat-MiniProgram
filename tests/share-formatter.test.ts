/**
 * 家庭協作清單格式化單元測試：表頭、勾選狀態、認領人、免責聲明、自定義項。
 */
import { emptyChecklistState, generateChecklist } from '../miniprogram/utils/checklist-generator';
import type { GuideProfile } from '../miniprogram/utils/guidance-flow';
import { buildFamilyShareText, formatDateTime } from '../miniprogram/utils/share-formatter';

const PROFILE: GuideProfile = {
  relation: 'father',
  relationLabel: '父親',
  place: 'hospital',
  city: '杭州',
  religion: 'han-default',
  socialSecurity: 'insured',
};

describe('分享文本格式化', () => {
  test('formatDateTime：ISO → 中文格式', () => {
    const text = formatDateTime('2026-08-27T14:05:00.000Z');
    expect(text).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/);
  });

  test('formatDateTime：非法輸入原樣返回', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });

  test('表頭包含清單標題、關係、城市與更新時間', () => {
    const checklist = generateChecklist(PROFILE);
    const text = buildFamilyShareText(checklist, emptyChecklistState());
    expect(text).toContain('【身後事家庭協作清單】');
    expect(text).toContain('父親');
    expect(text).toContain('杭州');
    expect(text).toContain('更新時間');
  });

  test('未認領顯示 ___，已認領顯示姓名', () => {
    const checklist = generateChecklist(PROFILE);
    const state = emptyChecklistState();
    state.claimers['death-cert'] = '大伯';
    const text = buildFamilyShareText(checklist, state);
    expect(text).toContain('認領人：大伯');
    expect(text).toContain('認領人：___');
  });

  test('勾選狀態：☐ 與 ☑ 並存', () => {
    const checklist = generateChecklist(PROFILE);
    const state = emptyChecklistState();
    state.done['death-cert'] = true;
    const text = buildFamilyShareText(checklist, state);
    expect(text).toContain('☑');
    expect(text).toContain('☐');
  });

  test('自定義追加項一併輸出', () => {
    const checklist = generateChecklist(PROFILE);
    const state = emptyChecklistState();
    state.customItems.push({
      id: 'custom-1',
      stage: 2,
      title: '辦理骨灰海葬登記',
      detailId: 'funeral',
    });
    const text = buildFamilyShareText(checklist, state);
    expect(text).toContain('辦理骨灰海葬登記');
  });

  test('結尾必須附免責聲明與來源署名', () => {
    const text = buildFamilyShareText(generateChecklist(PROFILE), emptyChecklistState());
    expect(text).toContain('信息僅供參考，請以官方窗口實際要求為準。');
    expect(text).toContain('身後事導航助手');
  });

  test('四個時段標題均出現', () => {
    const text = buildFamilyShareText(generateChecklist(PROFILE), emptyChecklistState());
    expect(text).toContain('第一天（今天）');
    expect(text).toContain('第2-3天');
    expect(text).toContain('第4-7天');
    expect(text).toContain('後續');
  });
});
