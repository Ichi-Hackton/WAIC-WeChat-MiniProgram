/**
 * 技能權限覆蓋儲存（域級 permissionTier，2026-10 第二梯隊·項B，借鑑
 * Muse 權限時效分級 / Dots 四級自定義規則）
 *
 * 設計定位：capability 元數據的 requiresHumanConfirm 是「技能作者聲明」
 * 的確認檔位；本儲存是「用戶側域級覆蓋」——兩級合成為最終執行檔位：
 *
 *   用戶覆蓋 'confirm' → 恆確認（域內全部寫操作走確認卡）
 *   用戶覆蓋 'auto'    → 自動執行（僅放寬未聲明確認的寫操作；聲明
 *                        requiresHumanConfirm=true 的能力不可被壓制）
 *   用戶覆蓋 'default' / 未覆蓋 → 跟隨技能聲明（requiresHumanConfirm）
 *
 * 四級語義的取捨（對照 Dots 的「直接執行 / 僅被要求時 / 每次詢問 /
 * 始終交還用戶」）：契約式調度下 LLM 僅在意圖要求時才規劃寫任務
 * （「僅被要求時」天然成立）；「始終交還」的極端保守檔與跳轉模式的
 * 信息卡引導重複——落地為三檔（default / auto / confirm）已覆蓋
 * 用戶可控性的全部有效組合，不引入無行為差異的空檔位。
 *
 * 紅線約束：大額支付唯一二次確認等安全底線由 capability 元數據 +
 * 渠道側承擔，用戶覆蓋只能「收緊」體驗或對非支付域「放寬」，支付 /
 * 不可逆域（由技能聲明 requiresHumanConfirm=true 且標記不可覆蓋的）
 * 不在本儲存的放寬範圍內（見 scheduler 的合成判定）。
 */

import { setItem, getItem } from '../services/storage';

const PERMISSIONS_KEY = 'skill:permission-overrides';

/** 權限檔位（default = 跟隨技能聲明） */
export type PermissionTier = 'default' | 'auto' | 'confirm';

/** 全部合法檔位（窄化用） */
const KNOWN_TIERS: ReadonlySet<string> = new Set(['default', 'auto', 'confirm']);

/** 讀取並窄化（防髒數據：非法 skillId / 檔位的條目靜默丟棄） */
function loadOverrides(): Record<string, PermissionTier> {
  const raw = getItem<unknown>(PERMISSIONS_KEY, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, PermissionTier> = {};
  for (const [skillId, tier] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof tier === 'string' && KNOWN_TIERS.has(tier) && skillId.startsWith('skill.')) {
      out[skillId] = tier as PermissionTier;
    }
  }
  return out;
}

/** 查詢技能的用戶覆蓋檔位（未覆蓋返回 'default'，跟隨技能聲明） */
export function getPermissionTier(skillId: string): PermissionTier {
  return loadOverrides()[skillId] ?? 'default';
}

/** 全量覆蓋（隱私中心「技能權限」分區展示用） */
export function listPermissionOverrides(): Record<string, PermissionTier> {
  return loadOverrides();
}

/**
 * 設置技能權限檔位（'default' 時刪除條目，回到跟隨技能聲明）
 *
 * @returns 是否實際變更（同檔位冪等返回 false）
 */
export function setPermissionTier(skillId: string, tier: PermissionTier): boolean {
  if (!skillId.startsWith('skill.')) return false;
  const cur = loadOverrides();
  if (tier === 'default') {
    if (!(skillId in cur)) return false;
    delete cur[skillId];
  } else {
    if (cur[skillId] === tier) return false;
    cur[skillId] = tier;
  }
  setItem(PERMISSIONS_KEY, cur);
  return true;
}

/** 清空全部權限覆蓋（隱私控制中心「清除偏好」聯動——權限屬偏好類數據） */
export function clearPermissionOverrides(): void {
  setItem(PERMISSIONS_KEY, {});
}
