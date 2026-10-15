/**
 * 條件監控域（monitor）— 雲端 CRUD + 定時掃描 tick
 *
 * 2026-10 第二梯隊·項A：準常駐監控（餘票類條件任務）。用戶在首頁車次卡
 * 售罄行點「監控」創建，雲托管定時觸發器（部署側配置，建議 ≥10 分鐘
 * 一跳）按節拍調 tick 掃描，命中即推送 / 落標記。
 *
 * 設計要點：
 * 1. 復用 db.ts ExternalOrder 泛化記錄（domain='monitor'），payload 承載
 *    監控參數與掃描狀態；命中即目標達成 → status 轉 'completed'（tick
 *    不再掃，需要繼續監控可重新創建——避免重複推送轟炸）
 * 2. CRUD 三端點走 x-wx-openid 鑒權（寫操作紅線，歸屬鑒權內建於 DAO）；
 *    tick 走 CRON_TOKEN 服務端鑒權（定時觸發器無 openid，token 走 body）
 * 3. 命中檢測直接調 skill-train 的 handleSearch（RouteHandler 簽名復用，
 *    owner 作為 RequestContext 傳入——查詢鏈 Tripmatch → MCP → 模擬分層
 *    與用戶自查同源，不另造旁路）
 * 4. 「不演」紅線：資料源為 mock_deterministic（確定性模擬）時不產生
 *    命中——模擬餘票會造成「已命中」的虛假承諾，僅如實記錄待真實源
 * 5. 推送配置驅動（WX_APPID + WX_APPSECRET + MONITOR_TMPL_ID 缺一即
 *    拉模式：僅落 hit 標記，小程序行程頁刷新可見；部署側三配置就位後
 *    自動升級推模式，代碼不變——「真實或誠實缺失，不演」）
 * 6. 掃描節流：lastCheckedAt 距今不足 CHECK_INTERVAL_MS 的跳過（觸發器
 *    節拍可密於此值，多次觸發不重複打上游）
 */

import type { RouteHandler } from './api';
import { ok, fail, badRequest, unauthorized } from './api';
import {
  createOrder,
  deleteOrder,
  listOrders,
  listAllByDomain,
  completeOrder,
  updateOrderPayload,
  type ExternalOrder,
} from './db';
import { handleSearch } from './skill-train';

/** 每用戶活躍監控上限（防濫用；超出提示先清理） */
const MAX_ACTIVE_PER_USER = 5;

/** label 長度上限 */
const MAX_LABEL_LEN = 60;

/** 掃描節流間隔（10 分鐘；定時觸發器建議節拍 ≥ 此值） */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** tick 單輪最多處理條數（定時觸發器超時保護，餘量下輪接續） */
const TICK_BATCH_LIMIT = 20;

/** 監控種類（目前僅餘票；票價 / 天氣監控為後續擴展位） */
type MonitorKind = 'train_tickets';

/** 監控 payload（db ExternalOrder.payload 的結構契約） */
interface MonitorPayload {
  kind: MonitorKind;
  params: {
    from: string;
    to: string;
    date: string;
    /** 指定車次（不指定 = 線路任一車次有票即命中） */
    trainNo?: string;
    /** 內部查詢用席別（展示形態剝離） */
    seatType?: string;
  };
  label: string;
  createdAt: number;
  /** 上次掃描時間（0 = 尚未掃描；節流判據） */
  lastCheckedAt: number;
  hit: boolean;
  hitAt?: number;
  /** 最近一次掃描結論（命中詳情 / 待真實源 / 查詢不可用） */
  lastMessage: string;
}

/** 對外展示形態（GET 返回；小程序端 storage 同構消費） */
export interface MonitorItem {
  monitorId: string;
  kind: MonitorKind;
  params: { from: string; to: string; date: string; trainNo?: string };
  label: string;
  createdAt: number;
  lastCheckedAt: number;
  hit: boolean;
  hitAt?: number;
  lastMessage: string;
}

/** DB 記錄 → 展示形態（髒數據窄化：形態不符的欄位回退缺省值） */
function toMonitorItem(o: ExternalOrder): MonitorItem {
  const p = (o.payload ?? {}) as Partial<MonitorPayload>;
  const params = (p.params ?? {}) as Partial<MonitorPayload['params']>;
  return {
    monitorId: o.orderId,
    kind: p.kind === 'train_tickets' ? 'train_tickets' : 'train_tickets',
    params: {
      from: String(params.from ?? ''),
      to: String(params.to ?? ''),
      date: String(params.date ?? ''),
      ...(params.trainNo ? { trainNo: String(params.trainNo) } : {}),
    },
    label: String(p.label ?? ''),
    createdAt: o.createdAt,
    lastCheckedAt: Number(p.lastCheckedAt ?? 0),
    hit: p.hit === true,
    ...(p.hitAt ? { hitAt: Number(p.hitAt) } : {}),
    lastMessage: String(p.lastMessage ?? ''),
  };
}

/** 創建監控（kind 目前僅 train_tickets；票價 / 天氣為擴展位） */
const handleCreate: RouteHandler = async (body, ctx) => {
  if (!ctx.openid) return unauthorized('缺少調用方身份（x-wx-openid）');
  const input = (body ?? {}) as { kind?: unknown; params?: unknown; label?: unknown };
  if (input.kind !== 'train_tickets') return badRequest('kind 僅支援 train_tickets');
  const p = (input.params ?? {}) as Record<string, unknown>;
  const from = typeof p.from === 'string' ? p.from.trim() : '';
  const to = typeof p.to === 'string' ? p.to.trim() : '';
  const date = typeof p.date === 'string' ? p.date.trim() : '';
  const trainNo = typeof p.trainNo === 'string' ? p.trainNo.trim().toUpperCase() : '';
  const seatType = typeof p.seatType === 'string' ? p.seatType : '';
  if (!from || !to || !date) return badRequest('params.from / to / date 必填');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest('date 格式必須為 YYYY-MM-DD');
  if (Date.parse(`${date}T23:59:59+08:00`) < Date.now()) {
    return fail(400, '監控日期已過去，無監控意義');
  }

  const actives = await listOrders(ctx.openid, 'monitor', ['pending_external']);
  if (actives.length >= MAX_ACTIVE_PER_USER) {
    return fail(400, `活躍監控已達上限（${MAX_ACTIVE_PER_USER} 條），請先在行程頁清理`);
  }

  const label = ((typeof input.label === 'string' ? input.label.trim() : '') || `${from}→${to} ${date}${trainNo ? ` ${trainNo}` : ''}`).slice(0, MAX_LABEL_LEN);
  const payload: MonitorPayload = {
    kind: 'train_tickets',
    params: { from, to, date, ...(trainNo ? { trainNo } : {}), ...(seatType ? { seatType } : {}) },
    label,
    createdAt: Date.now(),
    lastCheckedAt: 0,
    hit: false,
    lastMessage: '尚未掃描（等待定時觸發器節拍）',
  };
  const monitorId = `mon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await createOrder({
    orderId: monitorId,
    owner: ctx.openid,
    domain: 'monitor',
    status: 'pending_external',
    payload: { ...payload },
    createdAt: Date.now(),
  });
  return ok<MonitorItem>({ monitorId, ...payload, params: { from, to, date, ...(trainNo ? { trainNo } : {}) } });
};

/** 列出我的監控（活躍 + 已命中，新 → 舊） */
const handleList: RouteHandler = async (_body, ctx) => {
  if (!ctx.openid) return unauthorized('缺少調用方身份（x-wx-openid）');
  const list = await listOrders(ctx.openid, 'monitor');
  return ok<MonitorItem[]>(list.map(toMonitorItem));
};

/** 刪除監控（歸屬鑒權內建於 deleteOrder，防 IDOR） */
const handleRemove: RouteHandler = async (body, ctx) => {
  if (!ctx.openid) return unauthorized('缺少調用方身份（x-wx-openid）');
  const monitorId = typeof (body as { monitorId?: unknown } | undefined)?.monitorId === 'string'
    ? String((body as { monitorId?: unknown }).monitorId).trim()
    : '';
  if (!monitorId) return badRequest('monitorId 必填');
  const res = await deleteOrder(monitorId, ctx.openid);
  if (res === 'not_found') return fail(404, '監控不存在或已刪除');
  if (res === 'forbidden') return fail(403, '無權操作他人監控');
  return ok({ removed: true });
};

/** handleSearch 成功回應的查詢結果形態（trains 為擴充欄位的寬形態） */
interface TrainSearchData {
  source?: string;
  trains?: Array<{
    trainNo?: string;
    ticketsLeft?: number;
    seatClasses?: Array<{ name?: string; remain?: number }>;
  }>;
}

/** 命中判定後的 payload 回寫輔函數（保留原監控參數，僅更新掃描狀態） */
async function writeScanState(
  m: ExternalOrder,
  patch: Partial<Pick<MonitorPayload, 'lastCheckedAt' | 'hit' | 'hitAt' | 'lastMessage'>>,
): Promise<void> {
  const p = (m.payload ?? {}) as Partial<MonitorPayload>;
  await updateOrderPayload(m.orderId, { ...p, ...patch });
}

/**
 * 單條餘票檢查：復用 handleSearch 查詢鏈（Tripmatch → MCP → 模擬）
 *
 * @returns 命中詳情文案；未命中 / 查詢不可用 / 模擬源返回 null
 *   （差異寫入 lastMessage 供行程頁展示）
 */
async function checkTrainTickets(m: ExternalOrder): Promise<string | null> {
  const p = (m.payload ?? {}) as Partial<MonitorPayload>;
  const params = (p.params ?? {}) as Partial<MonitorPayload['params']>;
  const res = await handleSearch(
    {
      from: String(params.from ?? ''),
      to: String(params.to ?? ''),
      date: String(params.date ?? ''),
      seatType: params.seatType ?? 'second_class',
    },
    { openid: m.owner },
  );
  const now = Date.now();

  // 查詢失敗（上游不可用）：如實記錄，下個節拍重試（不虛報命中）
  if (res.body.code !== 0 || !res.body.data) {
    await writeScanState(m, {
      lastCheckedAt: now,
      lastMessage: `查詢暫不可用（${String(res.body.message ?? '').slice(0, 40)}），待下輪重試`,
    });
    return null;
  }

  const data = res.body.data as TrainSearchData;

  // 「不演」紅線：模擬數據源不產生命中（虛假承諾），僅如實標記待真實源
  if (data.source === 'mock_deterministic') {
    await writeScanState(m, {
      lastCheckedAt: now,
      lastMessage: '當前為模擬數據源，監控待真實餘票源（12306 / 飛常準）就位後生效',
    });
    return null;
  }

  const trains = data.trains ?? [];
  const targets = params.trainNo ? trains.filter((t) => t.trainNo === params.trainNo) : trains;
  const hitTrain = targets.find(
    (t) => (t.ticketsLeft ?? 0) > 0 || (t.seatClasses ?? []).some((s) => (s.remain ?? 0) > 0),
  );

  if (!hitTrain) {
    await writeScanState(m, {
      lastCheckedAt: now,
      lastMessage: `剛掃描：${params.trainNo ? `${params.trainNo} 暫無餘票` : '該線路暫無餘票'}`,
    });
    return null;
  }

  // 命中：餘票數取全席別最大可購（與首頁車次卡口徑一致）
  const remain = Math.max(hitTrain.ticketsLeft ?? 0, ...(hitTrain.seatClasses ?? []).map((s) => s.remain ?? 0), 0);
  const detail = `${hitTrain.trainNo ?? params.trainNo ?? '車次'} 有票（餘 ${remain} 張），可回小程序確認下單`;
  await writeScanState(m, { lastCheckedAt: now, hit: true, hitAt: now, lastMessage: detail });
  // 命中即目標達成：轉 completed，tick 不再掃（繼續監控可重新創建）
  await completeOrder(m.orderId, m.owner);
  return detail;
}

/**
 * 訂閱消息推送（推模式；WX_APPID / WX_APPSECRET / MONITOR_TMPL_ID 任一
 * 缺失即返回 false 走拉模式——不演）
 *
 * 注意：data 欄位名（thing1 / thing2 ...）須與實際申請的模板欄位一致，
 * 部署側申請模板後同步調整此處（模板 ID 就位前本路徑不執行）。
 */
async function pushSubscribeMessage(openid: string, label: string, detail: string): Promise<boolean> {
  const appid = process.env.WX_APPID;
  const secret = process.env.WX_APPSECRET;
  const tmplId = process.env.MONITOR_TMPL_ID;
  if (!appid || !secret || !tmplId) return false;
  try {
    const tokenRes = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`,
    );
    const tokenJson = (await tokenRes.json()) as { access_token?: string; errcode?: number; errmsg?: string };
    if (!tokenJson.access_token) {
      console.error('[monitors] access_token 獲取失敗：', tokenJson.errcode, tokenJson.errmsg);
      return false;
    }
    const sendRes = await fetch(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${tokenJson.access_token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          touser: openid,
          template_id: tmplId,
          page: 'pages/trips/index',
          data: {
            thing1: { value: label.slice(0, 20) },
            thing2: { value: detail.slice(0, 20) },
          },
        }),
      },
    );
    const sendJson = (await sendRes.json()) as { errcode?: number; errmsg?: string };
    if (sendJson.errcode !== 0) {
      // 43101 = 用戶未訂閱：正常業態（拉模式用戶），記 info 不報錯
      if (sendJson.errcode === 43101) {
        console.log('[monitors] 用戶未訂閱模板，命中僅落標記（拉模式）');
      } else {
        console.error('[monitors] 訂閱消息發送失敗：', sendJson.errcode, sendJson.errmsg);
      }
      return false;
    }
    return true;
  } catch (e) {
    console.error('[monitors] 推送異常：', e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * 定時掃描 tick（雲托管定時觸發器調用；CRON_TOKEN 鑒權，fail-closed）
 *
 * 響應體：{ scanned, hit }——掃描條數與命中條數（觸發器日誌可觀測）。
 * 單條異常不中斷整輪（記 ERROR 繼續下一條）；新創建優先（lastCheckedAt=0
 * 必為 due，用戶期待最快首掃）。
 */
const handleTick: RouteHandler = async (body) => {
  const expected = process.env.CRON_TOKEN;
  if (!expected) return unauthorized('CRON_TOKEN 未配置，掃描通道關閉（fail-closed）');
  const got = typeof (body as { token?: unknown } | undefined)?.token === 'string'
    ? String((body as { token?: unknown }).token)
    : '';
  if (got !== expected) return unauthorized('CRON_TOKEN 不符');

  const now = Date.now();
  const all = await listAllByDomain('monitor', ['pending_external']);
  const due = all
    .filter((o) => now - Number((o.payload as Partial<MonitorPayload>)?.lastCheckedAt ?? 0) >= CHECK_INTERVAL_MS)
    .slice(0, TICK_BATCH_LIMIT);

  let hitCount = 0;
  for (const m of due) {
    try {
      const detail = await checkTrainTickets(m);
      if (detail) {
        hitCount++;
        const label = String((m.payload as Partial<MonitorPayload>)?.label ?? '');
        await pushSubscribeMessage(m.owner, label, detail);
      }
    } catch (e) {
      console.error(`[monitors] 單條掃描異常（${m.orderId}）：`, e instanceof Error ? e.message : e);
    }
  }
  return ok({ scanned: due.length, hit: hitCount });
};

export const monitorRoutes: Array<[string, RouteHandler]> = [
  ['POST /api/monitors', handleCreate],
  ['GET /api/monitors', handleList],
  ['POST /api/monitors/remove', handleRemove],
  ['POST /internal/cron/monitors-tick', handleTick],
];
