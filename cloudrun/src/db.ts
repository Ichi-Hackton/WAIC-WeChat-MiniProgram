/**
 * 訂單持久化層 — 雲托管 MySQL 落庫 + 記憶體降級 DAO
 *
 * 2026-10 真實渠道上線改造：跳轉模式下「訂單」語義為外部渠道成交意圖
 * （pending_external），必須跨容器重啟留存（行程頁重跳轉、歷史回溯），
 * 故由各 skill-*.ts 的記憶體 Map 統一遷移至本模組。
 *
 * 環境變數（微信雲托管 MySQL 開通後自動注入，本地開發可不配）：
 *   MYSQL_ADDRESS   —— 連線位址（格式 host:port）
 *   MYSQL_USERNAME  —— 帳號
 *   MYSQL_PASSWORD  —— 密碼
 *   MYSQL_DATABASE  —— 資料庫名（選配，預設 micromate）
 *
 * 降級策略：MYSQL_ADDRESS 未配置 / 連線失敗 / 建表失敗時降級為記憶體
 * Map（重啟丟失），記 ERROR 日誌但不阻斷啟動——自用場景可接受，避免
 * DB 抖動拖垮整個 SKILL 層。
 *
 * 唯一例外依賴：mysql2（打破雲端零依賴原則，見計劃 §3.1）。
 */

import { createPool, type Pool, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';

/**
 * 訂單業務域：train=火車票 flight=機票 shop=購物訂單 shop_cart=購物車明細
 * booking=生活預約 trip=行程分享（2026-10 評審 #4） metrics=埋點上報（#5）
 */
export type OrderDomain = 'train' | 'flight' | 'shop' | 'shop_cart' | 'booking' | 'trip' | 'metrics';

/**
 * 訂單狀態：
 *   pending_external —— 已生成跳轉資訊，等待用戶在外部渠道（12306/京東/美團…）完成真實交易
 *   completed        —— 用戶確認已在外部渠道成交（行程歸檔用）
 *   cancelled        —— 已取消（放棄購買 / rollback）
 */
export type OrderStatus = 'pending_external' | 'completed' | 'cancelled';

/** 統一訂單記錄（payload 承載各域差異欄位） */
export interface ExternalOrder {
  orderId: string;
  owner: string;
  domain: OrderDomain;
  status: OrderStatus;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** 取消 / 狀態變更結果分流（呼叫方分別映射 404 / 403 / ok） */
export type MutateResult = 'ok' | 'not_found' | 'forbidden';

/** 連線池（lazy init；記憶體降級時恆為 null） */
let pool: Pool | null = null;

/** 初始化僅執行一次的守衛（並發呼叫共享同一 Promise） */
let initPromise: Promise<void> | null = null;

/** 已以 ERROR 級提示過降級（避免每筆訂單重複刷屏） */
let degradedLogged = false;

/** 記憶體降級表：orderId → 記錄（刪除即取消） */
const memoryOrders = new Map<string, ExternalOrder>();

/** 建表 DDL（幂等；payload 承載各域差異結構，避免為每域建表） */
const DDL = `
  CREATE TABLE IF NOT EXISTS external_orders (
    order_id   VARCHAR(64)  NOT NULL PRIMARY KEY,
    owner      VARCHAR(128) NOT NULL,
    domain     VARCHAR(16)  NOT NULL,
    status     VARCHAR(24)  NOT NULL,
    payload    JSON         NOT NULL,
    created_at BIGINT       NOT NULL,
    KEY idx_owner_domain (owner, domain)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

/** 解析 MYSQL_ADDRESS（host:port）；缺失視為本地開發未配置，走記憶體 */
function parseAddress(addr: string): { host: string; port: number } {
  const idx = addr.lastIndexOf(':');
  if (idx <= 0) return { host: addr, port: 3306 };
  return { host: addr.slice(0, idx), port: Number(addr.slice(idx + 1)) || 3306 };
}

/**
 * 惰性初始化：建池 + 建表；任何失敗降級記憶體（不拋出，保證伺服器可用）
 *
 * server.ts 啟動時 fire-and-forget 呼叫一次；DAO 首次呼叫亦會確保完成。
 */
export function initDb(): Promise<void> {
  if (!initPromise) {
    initPromise = doInit().catch(() => {
      /* doInit 內部已處理降級與日誌，此處僅吸收拒絕避免未處理 Promise */
    });
  }
  return initPromise;
}

async function doInit(): Promise<void> {
  const addr = process.env.MYSQL_ADDRESS;
  if (!addr) {
    logDegraded('MYSQL_ADDRESS 未配置（本地開發），訂單持久化降級記憶體');
    return;
  }
  const { host, port } = parseAddress(addr);
  try {
    pool = createPool({
      host,
      port,
      user: process.env.MYSQL_USERNAME ?? '',
      password: process.env.MYSQL_PASSWORD ?? '',
      database: process.env.MYSQL_DATABASE ?? 'micromate',
      waitForConnections: true,
      connectionLimit: 4, // 自用單實例，小池即可
      connectTimeout: 8_000,
      enableKeepAlive: true,
    });
    await pool.query(DDL);
    console.log(`[db] MySQL 訂單持久化已就緒（${host}:${port}/${process.env.MYSQL_DATABASE ?? 'micromate'}）`);
  } catch (e) {
    pool = null;
    logDegraded(`MySQL 初始化失敗，訂單持久化降級記憶體：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 降級提示（僅首次 ERROR，後續靜默） */
function logDegraded(reason: string): void {
  if (degradedLogged) return;
  degradedLogged = true;
  console.error(`[db] ${reason}`);
}

/** DAO 進入前確保初始化已結束（冪等） */
async function ensureReady(): Promise<void> {
  if (!initPromise) await initDb();
  else await initPromise;
}

/** DB 記錄 → 領域物件（payload 為 JSON 欄位，驅動返回物件或字串兩種形態） */
function rowToOrder(row: RowDataPacket): ExternalOrder {
  const raw = row.payload;
  let payload: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  } else if (raw && typeof raw === 'object') {
    payload = raw as Record<string, unknown>;
  } else {
    payload = {};
  }
  return {
    orderId: String(row.order_id),
    owner: String(row.owner),
    domain: String(row.domain) as OrderDomain,
    status: String(row.status) as OrderStatus,
    payload,
    createdAt: Number(row.created_at),
  };
}

/** 建立訂單（記憶體降級時直接入 Map） */
export async function createOrder(order: ExternalOrder): Promise<void> {
  await ensureReady();
  if (!pool) {
    memoryOrders.set(order.orderId, order);
    return;
  }
  await pool.execute(
    'INSERT INTO external_orders (order_id, owner, domain, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [order.orderId, order.owner, order.domain, order.status, JSON.stringify(order.payload), order.createdAt],
  );
}

/** 按 ID 取單（含已取消）；不存在回 null */
export async function getOrder(orderId: string): Promise<ExternalOrder | null> {
  await ensureReady();
  if (!pool) return memoryOrders.get(orderId) ?? null;
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT order_id, owner, domain, status, payload, created_at FROM external_orders WHERE order_id = ?',
    [orderId],
  );
  return rows.length > 0 ? rowToOrder(rows[0]) : null;
}

/**
 * 取消訂單（歸屬鑒權內建，防 IDOR——與各 skill 原 Map 版語義一致）
 *
 * 回傳分流：not_found（404）/ forbidden（403）/ ok
 */
export async function cancelOrder(orderId: string, owner: string): Promise<MutateResult> {
  return mutateStatus(orderId, owner, 'cancelled');
}

/** 標記外部渠道已成交（行程歸檔） */
export async function completeOrder(orderId: string, owner: string): Promise<MutateResult> {
  return mutateStatus(orderId, owner, 'completed');
}

/** 狀態變更共用：歸屬鑒權 → 更新（含從記憶體 / DB 刪除取消態的統一語義為狀態標記） */
async function mutateStatus(orderId: string, owner: string, next: OrderStatus): Promise<MutateResult> {
  await ensureReady();
  if (!pool) {
    const order = memoryOrders.get(orderId);
    if (!order) return 'not_found';
    if (order.owner !== owner) return 'forbidden';
    if (next === 'cancelled') memoryOrders.delete(orderId);
    else order.status = next;
    return 'ok';
  }
  // 單條 UPDATE 同時完成存在性與歸屬校驗（affectedRows=0 ⇒ 不存在或越權，
  // 再以 SELECT 分流 404 / 403，避免兩次寫前讀的競態）
  const [res] = await pool.execute<ResultSetHeader>(
    'UPDATE external_orders SET status = ? WHERE order_id = ? AND owner = ?',
    [next, orderId, owner],
  );
  if (res.affectedRows > 0) return 'ok';
  const [rows] = await pool.query<RowDataPacket[]>('SELECT owner FROM external_orders WHERE order_id = ?', [orderId]);
  return rows.length > 0 ? 'forbidden' : 'not_found';
}

/** 刪除記錄（購物車明細移除專用：與 cancel 同為 owner 鑒權刪除） */
export async function deleteOrder(orderId: string, owner: string): Promise<MutateResult> {
  await ensureReady();
  if (!pool) {
    const order = memoryOrders.get(orderId);
    if (!order) return 'not_found';
    if (order.owner !== owner) return 'forbidden';
    memoryOrders.delete(orderId);
    return 'ok';
  }
  const [res] = await pool.execute<ResultSetHeader>(
    'DELETE FROM external_orders WHERE order_id = ? AND owner = ?',
    [orderId, owner],
  );
  if (res.affectedRows > 0) return 'ok';
  const [rows] = await pool.query<RowDataPacket[]>('SELECT owner FROM external_orders WHERE order_id = ?', [orderId]);
  return rows.length > 0 ? 'forbidden' : 'not_found';
}

/** 列出某用戶某域的訂單（新→舊；可過濾狀態） */
export async function listOrders(
  owner: string,
  domain: OrderDomain,
  statuses?: OrderStatus[],
): Promise<ExternalOrder[]> {
  await ensureReady();
  if (!pool) {
    return Array.from(memoryOrders.values())
      .filter((o) => o.owner === owner && o.domain === domain && (!statuses || statuses.includes(o.status)))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  const statusFilter = statuses?.length
    ? ` AND status IN (${statuses.map(() => '?').join(',')})`
    : '';
  const params: unknown[] = [owner, domain, ...statuses ?? []];
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT order_id, owner, domain, status, payload, created_at FROM external_orders
     WHERE owner = ? AND domain = ?${statusFilter} ORDER BY created_at DESC LIMIT 100`,
    params,
  );
  return rows.map(rowToOrder);
}
