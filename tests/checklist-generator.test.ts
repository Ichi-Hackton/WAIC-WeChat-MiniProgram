/**
 * 個性化清單生成器單元測試：地點／社保／宗教分支與結構完整性。
 */
import {
  STAGE_DEFS,
  emptyChecklistState,
  generateChecklist,
} from '../miniprogram/utils/checklist-generator';
import type { GuideProfile } from '../miniprogram/utils/guidance-flow';

const BASE: GuideProfile = {
  relation: 'father',
  relationLabel: '父親',
  place: 'hospital',
  city: '杭州',
  religion: 'han-default',
  socialSecurity: 'insured',
};

function idsOf(profile: GuideProfile): string[] {
  return generateChecklist(profile).tasks.map((t) => t.id);
}

describe('個性化清單生成器', () => {
  test('醫院離世＋有社保：包含死亡證明與社保結算，不含運輸與社保核對', () => {
    const ids = idsOf(BASE);
    expect(ids).toContain('death-cert');
    expect(ids).toContain('social-security');
    expect(ids).not.toContain('body-transport');
    expect(ids).not.toContain('ss-verify');
  });

  test('外地離世：增加遺體運輸任務', () => {
    const ids = idsOf({ ...BASE, place: 'away' });
    expect(ids).toContain('body-transport');
  });

  test('家中離世：死亡證明途徑指向社區／派出所', () => {
    const task = generateChecklist({ ...BASE, place: 'home' }).tasks.find((t) => t.id === 'death-cert');
    expect(task).toBeDefined();
    expect(`${task?.title}${task?.where}`).toMatch(/派出所|社區/);
  });

  test('無社保／不確定：先核對社保狀態，再申領補助', () => {
    for (const social of ['none', 'unsure'] as const) {
      const ids = idsOf({ ...BASE, socialSecurity: social });
      expect(ids).toContain('ss-verify');
      expect(ids).toContain('subsidy-apply');
      expect(ids).not.toContain('social-security');
    }
  });

  test('有宗教／民族需求：增加儀軌安排；一般習俗則沒有', () => {
    expect(idsOf({ ...BASE, religion: 'religious' })).toContain('religion-arrange');
    expect(idsOf({ ...BASE, religion: 'ethnic-minority' })).toContain('religion-arrange');
    expect(idsOf(BASE)).not.toContain('religion-arrange');
  });

  test('任務 id 唯一且按時段單調遞增', () => {
    const tasks = generateChecklist(BASE).tasks;
    const idSet = new Set(tasks.map((t) => t.id));
    expect(idSet.size).toBe(tasks.length);
    let lastStage = 0;
    for (const t of tasks) {
      expect(t.stage).toBeGreaterThanOrEqual(0);
      expect(t.stage).toBeLessThanOrEqual(3);
      expect(t.stage).toBeGreaterThanOrEqual(lastStage);
      lastStage = t.stage;
    }
  });

  test('每個時段至少有一項，第一天必含死亡證明與聯繫殯儀館', () => {
    const tasks = generateChecklist(BASE).tasks;
    for (const def of STAGE_DEFS) {
      expect(tasks.some((t) => t.stage === def.id)).toBe(true);
    }
    const dayOne = tasks.filter((t) => t.stage === 0).map((t) => t.id);
    expect(dayOne).toContain('death-cert');
    expect(dayOne).toContain('funeral-contact');
  });

  test('時限要求出現在戶籍註銷上', () => {
    const task = generateChecklist(BASE).tasks.find((t) => t.id === 'household-cancel');
    expect(task?.deadline).toMatch(/30天/);
  });

  test('空狀態工廠：無勾選、無認領、無自定義項', () => {
    const state = emptyChecklistState();
    expect(state.done).toEqual({});
    expect(state.claimers).toEqual({});
    expect(state.customItems).toEqual([]);
  });
});
