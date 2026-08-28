/**
 * 家庭協作清單文本格式化（純函數內核，永不 import wx）
 *
 * 依據 Agent.md「示例3：生成家庭協作清單」與「輸出格式」：
 * - 勾選框 ☐／☑，可邊辦邊勾；
 * - 每項帶「認領人」，家庭成員可分工認領；
 * - 結尾必須附免責聲明。
 */

import type { GeneratedChecklist, ChecklistState, ChecklistTask } from './checklist-generator';
import { STAGE_DEFS } from './checklist-generator';
import { relationDisplay } from './guidance-flow';

/** 將 ISO 時間格式化為「2026年8月27日 14:05」 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function taskLine(task: ChecklistTask, state: ChecklistState): string {
  const checked = state.done[task.id] ? '☑' : '☐';
  const claimer = state.claimers[task.id] || '___';
  return `${checked} ${task.title} —— 認領人：${claimer}`;
}

/**
 * 生成可複製轉發到家庭群的純文本清單。
 * 逝者姓名留空（＿＿＿），由家人自行填寫——本應用不收集逝者姓名等敏感信息。
 */
export function buildFamilyShareText(checklist: GeneratedChecklist, state: ChecklistState): string {
  const all: ChecklistTask[] = [...checklist.tasks, ...state.customItems];
  const lines: string[] = [];

  lines.push('【身後事家庭協作清單】');
  lines.push(
    `逝者：＿＿＿（${relationDisplay(checklist.profile)}） ｜ 城市：${checklist.profile.city || '—'} ｜ 更新時間：${formatDateTime(checklist.generatedAt)}`,
  );

  for (const stage of STAGE_DEFS) {
    const stageTasks = all.filter((t) => t.stage === stage.id);
    if (stageTasks.length === 0) {
      continue;
    }
    lines.push('');
    lines.push(`■ ${stage.title}`);
    for (const task of stageTasks) {
      lines.push(taskLine(task, state));
    }
  }

  lines.push('');
  lines.push('信息僅供參考，請以官方窗口實際要求為準。');
  lines.push('——來自「身後事導航助手」微信小程序');
  return lines.join('\n');
}
