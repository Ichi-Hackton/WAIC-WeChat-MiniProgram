/**
 * 敏感情境識別單元測試：三級識別與誤報邊界。
 */
import { detectSensitive } from '../miniprogram/utils/sensitive-detector';

describe('敏感情境識別', () => {
  test('自殺傾向 → crisis（繁體）', () => {
    expect(detectSensitive('我也想跟我媽一起走').level).toBe('crisis');
  });

  test('自殺傾向 → crisis（簡體）', () => {
    expect(detectSensitive('我不想活了').level).toBe('crisis');
    expect(detectSensitive('撑不下去了，想自杀').level).toBe('crisis');
  });

  test('情緒崩潰 → grief，且不升級為 crisis', () => {
    const result = detectSensitive('我完全撐不住了，幾天沒睡');
    expect(result.level).toBe('grief');
    expect(result.matched.length).toBeGreaterThan(0);
  });

  test('正常輸入 → none', () => {
    expect(detectSensitive('父親在醫院離世，我是兒子').level).toBe('none');
    expect(detectSensitive('想問下殯儀館電話').level).toBe('none');
  });

  test('單字「走」不觸發 crisis（避免長句誤報）', () => {
    expect(detectSensitive('我們一起走到醫院辦手續').level).toBe('none');
  });

  test('空字符串與空白 → none', () => {
    expect(detectSensitive('').level).toBe('none');
    expect(detectSensitive('   ').level).toBe('none');
  });

  test('crisis 優先於 grief', () => {
    expect(detectSensitive('太痛苦了，我想自殺').level).toBe('crisis');
  });

  test('返回具體命中詞', () => {
    const result = detectSensitive('想不開');
    expect(result.matched).toContain('想不開');
  });
});
