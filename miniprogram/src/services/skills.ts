/**
 * 動態技能雲端 API 服務（skills/center/forge/review/run 五端點的 wx 唯一封裝）
 *
 * 規範來源：.qoder/rules/Agent.md § 12.3（services/ 為 wx API 唯一封裝層）、
 * 動態技能計劃（manifest 為小程序動態註冊單一來源）。
 *
 * 錯誤語義與 services/cloud.ts 對齊：HTTP 200 + code 非 0 為業務失敗
 * （SKILL 層翻譯 SkillError），負數碼為雲基礎設施不可用（開發環境降級鏈兜底）。
 */

import { getContainer, postContainer } from './cloud';
import type { CloudResponse } from './cloud';
import type {
  DynamicForgeResult,
  DynamicReviewDecision,
  DynamicReviewResult,
  DynamicSkillCenter,
  DynamicSkillManifest,
} from '../types/dynamic-skill';

/**
 * 拉取動態技能清單（每輪規劃前同步用）
 *
 * retry:false + 短超時：清單同步位於規劃關鍵路徑，失敗快速返回
 * （fail-closed 語義由 skills/dynamic.ts 處理——撤下動態技能、不阻斷內置規劃）
 */
export function fetchSkillManifest(
  env: string,
  sessionId?: string,
): Promise<CloudResponse<DynamicSkillManifest>> {
  return getContainer<DynamicSkillManifest>(env, '/api/skills/manifest', {
    sessionId,
    retry: false,
    timeoutMs: 8_000,
  });
}

/** 技能中心數據（本人提案 + 公開技能 + 管理員審批視圖） */
export function fetchSkillCenter(
  env: string,
  sessionId?: string,
): Promise<CloudResponse<DynamicSkillCenter>> {
  return getContainer<DynamicSkillCenter>(env, '/api/skills/center', {
    sessionId,
    retry: false,
    timeoutMs: 10_000,
  });
}

/** LLM 起草技能（requestId 為客戶端生成的冪等鍵） */
export function forgeDynamicSkill(
  env: string,
  requestId: string,
  requirement: string,
  sourceText?: string,
  sessionId?: string,
): Promise<CloudResponse<DynamicForgeResult>> {
  return postContainer<DynamicForgeResult>(
    env,
    '/api/skills/forge',
    { requestId, requirement, ...(sourceText ? { sourceText } : {}) },
    { sessionId, timeoutMs: 60_000 },
  );
}

/** 管理員審批（expectedVersion 為 CAS 樂觀鎖；衝突時重新拉取 center） */
export function reviewDynamicSkill(
  env: string,
  skillId: string,
  decision: DynamicReviewDecision,
  expectedVersion: number,
  note: string | undefined,
  sessionId?: string,
): Promise<CloudResponse<DynamicReviewResult>> {
  return postContainer<DynamicReviewResult>(
    env,
    '/api/skills/review',
    { skillId, decision, expectedVersion, ...(note ? { note } : {}) },
    { sessionId },
  );
}
