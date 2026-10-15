/**
 * 輕量記憶體滑動窗口配額（2026-10 審計 P2-2）
 *
 * 背景：llm-chat / stt 是全服務「最貴入口」——上游按 token / 音頻時長計費
 * 且共享帳戶金鑰，此前無身份、無頻次、無輸入上限（對比：動態技能執行器
 * 已有每 openid 每小時 30 次配額——防護意識存在但未覆蓋最貴的兩個端點）。
 *
 * 設計取捨：
 *   - 記憶體滑動窗口（非持久化）：單實例部署量級足夠；重啟清零可接受
 *     （只有運維能重啟容器，攻擊者無法藉此重置配額）
 *   - 雙層配額：身份桶（openid，缺省回退 clientIp）+ 端點全局桶——全局桶
 *     不依賴身份，公網直連者偽造任意 openid 也繞不過端點總量封頂
 *   - 惰性清理：每次 check 順帶過濾當前鍵的過期時間戳；鍵數達上限時才做
 *     全量掃描清理，常規路徑零額外開銷
 *   - 與 dynamic-executor 既有配額並存不衝突（各自獨立計數域）
 */

/** 各配額域（bucket）的鍵值 store：bucket -> 身份鍵 -> 命中時間戳們 */
const buckets = new Map<string, Map<string, number[]>>();

/** 單桶最大鍵數（防偽造海量身份鍵撐爆記憶體；正常單實例活躍鍵遠低於此） */
const MAX_KEYS_PER_BUCKET = 10_000;

/**
 * 滑動窗口配額檢查（超限時不計入本次命中，窗口自然滑動）
 *
 * @param bucket   配額域（如 'llm' / 'stt'，各端點獨立計數）
 * @param key      身份鍵（openid / `ip:<位址>`；全局桶慣例用 '__global__'）
 * @param limit    窗口內允許的最大次數
 * @param windowMs 窗口長度（毫秒）
 * @returns true = 放行並記錄本次命中；false = 超限（調用方以 429 業務碼回絕）
 */
export function checkQuota(bucket: string, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  let keys = buckets.get(bucket);
  if (!keys) {
    keys = new Map();
    buckets.set(bucket, keys);
  }

  // 惰性清理：剔除當前鍵窗口外的歷史命中
  const hits = keys.get(key) ?? [];
  const fresh = hits.filter((t) => now - t < windowMs);
  if (fresh.length >= limit) {
    keys.set(key, fresh); // 回寫已清理的時間戳，避免死鍵堆積
    return false;
  }

  // 鍵數上限保護：僅「新鍵 + 桶已滿」時觸發全量過期清理；仍滿則拒新鍵
  //（老鍵繼續正常滑動，正常用戶不受牽連）
  if (!keys.has(key) && keys.size >= MAX_KEYS_PER_BUCKET) {
    for (const [k, ts] of keys) {
      const alive = ts.filter((t) => now - t < windowMs);
      if (alive.length === 0) keys.delete(k);
      else keys.set(k, alive);
    }
    if (keys.size >= MAX_KEYS_PER_BUCKET) return false;
  }

  fresh.push(now);
  keys.set(key, fresh);
  return true;
}
