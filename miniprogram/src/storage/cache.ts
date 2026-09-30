/**
 * SKILL 結果快取
 *
 * 規範來源：.qoder/rules/Agent.md § 4 (storage/cache.ts)
 *
 * MVP：簡單 TTL 快取，避免重複 SKILL 呼叫
 *   - key 格式：skill:<id>:<action>:<hash(input)>
 *   - TTL：預設 5 分鐘
 */

import { setItem, getItem } from '../services/storage';

export interface CacheOptions {
  ttlMs?: number;
}

interface CacheEntry<T> {
  value: T;
  expireAt: number;
}

const DEFAULT_TTL = 5 * 60 * 1000;

/** 計算入參的簡易 hash（FNV-1a 32-bit） */
function hashInput(input: unknown): string {
  const json = JSON.stringify(input ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/** 取得快取（命中且未過期才返回） */
export function get<T>(skillId: string, action: string, input: unknown): T | null {
  const key = `cache:${skillId}:${action}:${hashInput(input)}`;
  const entry = getItem<CacheEntry<T>>(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) return null;
  return entry.value;
}

/** 寫入快取 */
export function set<T>(skillId: string, action: string, input: unknown, value: T, options: CacheOptions = {}): void {
  const key = `cache:${skillId}:${action}:${hashInput(input)}`;
  const entry: CacheEntry<T> = {
    value,
    expireAt: Date.now() + (options.ttlMs ?? DEFAULT_TTL),
  };
  setItem(key, entry);
}

/** 清除特定 SKILL 的快取 */
export function invalidateSkill(skillId: string): void {
  // MVP 簡化：不做 keys 列舉清除，依靠 TTL 自然過期
}