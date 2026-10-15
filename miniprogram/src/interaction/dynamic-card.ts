/**
 * 動態技能交付卡渲染（受控展示協議 → 頁面卡片模型）
 *
 * 規範來源：.qoder/rules/Agent.md § 7.4（動態技能結果以受控 display 卡展示，
 * 不暴露 raw JSON）
 *
 * 職責邊界（與 card-render.ts 分工）：通用兜底渲染面向任意 SKILL 的
 * RenderCard 模型；本模組面向動態技能 run 結果（DynamicRunResult 契約），
 * 產出頁面 AnyCard 協議的專用卡形狀。零運行時依賴（僅型別導入），
 * 保持可獨立單元測試。
 */

import type { DynamicRunResult } from '../types/dynamic-skill';

/** 動態技能交付卡（display 標題/明細行 + AI 生成標識；
 *  output.text 僅在無明細行時作摺疊補充） */
export interface DynamicDisplayCard {
  type: 'dynamic';
  /** 穩定 key（wxml wx:key 用） */
  key: string;
  title: string;
  lines: Array<{ label: string; value: string }>;
  /** 補充文字輸出（display 未覆蓋時的截斷展示） */
  text: string;
  aiGenerated: boolean;
}

/** 明細行展示上限（超出部分截斷，長結論應沉澱為技能定義的結構化輸出） */
const MAX_LINES = 8;

/** 補充文字截斷長度（與雲端 buildRunData 的 text 上限同量級） */
const MAX_TEXT = 400;

/** 單值截斷長度（防異常長欄位撐爆卡片） */
const MAX_VALUE = 120;

/** 標題截斷長度 */
const MAX_TITLE = 30;

/**
 * run（動態技能）成功結果 → 受控展示卡
 *
 * 防禦性窄化（§ 12.2 禁 any）：display 缺失時退化為截斷文字行，
 * display 與文字皆空返回 null（呼叫方走通用兜底卡，不放空卡）。
 */
export function buildDynamicDisplayCard(data: unknown): DynamicDisplayCard | null {
  const d = data as Partial<DynamicRunResult> | undefined;
  const display = d?.display;
  const rawText = typeof d?.output?.text === 'string' ? d.output.text : '';
  const text = rawText.length > MAX_TEXT ? `${rawText.slice(0, MAX_TEXT)}…` : rawText;
  const title = display && typeof display.title === 'string' && display.title.trim()
    ? display.title.slice(0, MAX_TITLE)
    : '動態技能結果';
  const lines = display && Array.isArray(display.lines)
    ? display.lines
        .filter((l) => typeof l?.label === 'string' && typeof l?.value === 'string')
        .slice(0, MAX_LINES)
        .map((l) => ({
          label: l.label.slice(0, 12),
          value: l.value.length > MAX_VALUE ? `${l.value.slice(0, MAX_VALUE)}…` : l.value,
        }))
    : [];
  if (lines.length === 0 && !text) return null;
  return {
    type: 'dynamic',
    key: `dynamic-${Date.now()}`,
    title,
    lines,
    // 明細行已承載結論時長文不再重複展示（最小訊息量原則）
    text: lines.length === 0 ? text : '',
    aiGenerated: d?.ai_generated === true,
  };
}
