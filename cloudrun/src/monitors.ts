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
import { handleSearch as searchFlights } from './skill-flight';
import { getForecastByCity, type ForecastCast } from './skill-weather';
import { verifyCronToken, sendSubscribeMessage } from './wx-push';

/** 每用戶活躍監控上限（防濫用；超出提示先清理） */
const MAX_ACTIVE_PER_USER = 5;

/** label 長度上限 */
const MAX_LABEL_LEN = 60;

/** 掃描節流間隔（10 分鐘；定時觸發器建議節拍 ≥ 此值） */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** tick 單輪最多處理條數（定時觸發器超時保護，餘量下輪接續） */
const TICK_BATCH_LIMIT = 20;

/** 監控種類（train_tickets=餘票（項A）；weather_alert=行程日天氣突變
 *  （項B，出發提醒登記時自動創建，無用戶直接創建入口）；flight_price=
 *  機票降價（項C，降幅閾值由用戶創建時指定——問題定義權在用戶）） */
type MonitorKind = 'train_tickets' | 'weather_alert' | 'flight_price';

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
    /** weather_alert：行程城市（城市名，掃描時經地理編碼轉 adcode） */
    city?: string;
    /** flight_price：艙位（協議值 economy / business / first） */
    cabin?: string;
    /** flight_price：基準價（分，創建時查詢最低價快照） */
    baselineCent?: number;
    /** flight_price：降幅閾值（分，用戶創建時指定） */
    dropCent?: number;
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
  params: {
    from: string;
    to: string;
    date: string;
    trainNo?: string;
    city?: string;
    cabin?: string;
    baselineCent?: number;
    dropCent?: number;
  };
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
    kind: p.kind === 'weather_alert' || p.kind === 'flight_price' ? p.kind : 'train_tickets',
    params: {
      from: String(params.from ?? ''),
      to: String(params.to ?? ''),
      date: String(params.date ?? ''),
      ...(params.trainNo ? { trainNo: String(params.trainNo) } : {}),
      ...(params.city ? { city: String(params.city) } : {}),
      ...(params.cabin ? { cabin: String(params.cabin) } : {}),
      ...(typeof params.baselineCent === 'number' && params.baselineCent > 0
        ? { baselineCent: Math.round(params.baselineCent) } : {}),
      ...(typeof params.dropCent === 'number' && params.dropCent > 0
        ? { dropCent: Math.round(params.dropCent) } : {}),
    },
    label: String(p.label ?? ''),
    createdAt: o.createdAt,
    lastCheckedAt: Number(p.lastCheckedAt ?? 0),
    hit: p.hit === true,
    ...(p.hitAt ? { hitAt: Number(p.hitAt) } : {}),
    lastMessage: String(p.lastMessage ?? ''),
  };
}

/** 創建監控（kind=train_tickets 餘票 / flight_price 機票降價；weather_alert
 *  由 trip-remind 登記時服務端內部創建（createWeatherMonitor），不開放直建） */
const handleCreate: RouteHandler = async (body, ctx) => {
  if (!ctx.openid) return unauthorized('缺少調用方身份（x-wx-openid）');
  const input = (body ?? {}) as { kind?: unknown; params?: unknown; label?: unknown };
  if (input.kind !== 'train_tickets' && input.kind !== 'flight_price') {
    return badRequest('kind 僅支援 train_tickets / flight_price');
  }
  const kind = input.kind;
  const p = (input.params ?? {}) as Record<string, unknown>;
  const from = typeof p.from === 'string' ? p.from.trim() : '';
  const to = typeof p.to === 'string' ? p.to.trim() : '';
  const date = typeof p.date === 'string' ? p.date.trim() : '';
  if (!from || !to || !date) return badRequest('params.from / to / date 必填');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest('date 格式必須為 YYYY-MM-DD');
  if (Date.parse(`${date}T23:59:59+08:00`) < Date.now()) {
    return fail(400, '監控日期已過去，無監控意義');
  }

  // train_tickets 專屬：指定車次 + 內部查詢席別
  const trainNo = kind === 'train_tickets' && typeof p.trainNo === 'string' ? p.trainNo.trim().toUpperCase() : '';
  const seatType = kind === 'train_tickets' && typeof p.seatType === 'string' ? p.seatType : '';

  // flight_price 專屬：艙位 + 降幅閾值 + 基準價（均為正整數分；基準價為
  // 創建時查詢最低價快照，命中口徑 = 即時最低價 ≤ 基準 − 降幅）
  let cabin = 'economy';
  let dropCent = 0;
  let baselineCent = 0;
  if (kind === 'flight_price') {
    cabin = typeof p.cabin === 'string' ? p.cabin : 'economy';
    if (!['economy', 'business', 'first'].includes(cabin)) {
      return badRequest('cabin 必須為 economy / business / first');
    }
    dropCent = typeof p.dropCent === 'number' ? Math.round(p.dropCent) : 0;
    baselineCent = typeof p.baselineCent === 'number' ? Math.round(p.baselineCent) : 0;
    if (dropCent <= 0) return badRequest('dropCent（降幅，單位分）必須為正整數');
    if (baselineCent <= 0) return badRequest('baselineCent（基準價，單位分）必須為正整數');
  }

  const actives = await listOrders(ctx.openid, 'monitor', ['pending_external']);
  if (actives.length >= MAX_ACTIVE_PER_USER) {
    return fail(400, `活躍監控已達上限（${MAX_ACTIVE_PER_USER} 條），請先在行程頁清理`);
  }

  const defaultLabel = kind === 'flight_price'
    ? `${from}→${to} ${date} 機票降價`
    : `${from}→${to} ${date}${trainNo ? ` ${trainNo}` : ''}`;
  const label = ((typeof input.label === 'string' ? input.label.trim() : '') || defaultLabel).slice(0, MAX_LABEL_LEN);
  const payload: MonitorPayload = kind === 'flight_price'
    ? {
      kind,
      params: { from, to, date, cabin, baselineCent, dropCent },
      label,
      createdAt: Date.now(),
      lastCheckedAt: 0,
      hit: false,
      lastMessage: '尚未掃描（等待定時觸發器節拍）',
    }
    : {
      kind,
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
  // 返回形態與 toMonitorItem 白名單口徑一致（seatType 為內部欄位不透出）
  const item = toMonitorItem({ orderId: monitorId, owner: ctx.openid, domain: 'monitor', status: 'pending_external', payload: { ...payload }, createdAt: Date.now() });
  return ok<MonitorItem>(item);
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

/**
 * 服務端內部創建天氣監控（trip-remind 登記時自動展開：一次「訂閱出發提醒」
 *  的用戶定義問題，被 Agent 拆解為時間規則（出發推送）+ 外部事件（天氣
 *  突變）兩條準常駐線——主動性分層的 L2+L3 組合，問題定義權仍在用戶）
 *
 * 冪等鍵 wxa_{tripId}：重複登記覆蓋舊監控（先刪後建，沿用登記方的 upsert 語義）
 */
export async function createWeatherMonitor(owner: string, tripId: string, city: string, date: string): Promise<void> {
  const orderId = `wxa_${tripId}`;
  await deleteOrder(orderId, owner).catch(() => undefined);
  await createOrder({
    orderId,
    owner,
    domain: 'monitor',
    status: 'pending_external',
    payload: {
      kind: 'weather_alert',
      params: { from: '', to: '', date, city },
      label: `${city} ${date} 天氣`,
      createdAt: Date.now(),
      lastCheckedAt: 0,
      hit: false,
      lastMessage: '尚未掃描（等待定時觸發器節拍）',
    },
    createdAt: Date.now(),
  });
}

/** 刪除行程聯動的天氣監控（trip-remind remove 並行清理；不存在靜默容忍） */
export async function removeWeatherMonitor(owner: string, tripId: string): Promise<void> {
  await deleteOrder(`wxa_${tripId}`, owner).catch(() => undefined);
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
 * 餘票命中推送（推模式；MONITOR_TMPL_ID 未配置 / 發送失敗時 sendSubscribeMessage
 * 返回非 'ok'，調用方僅落標記——拉模式語義不變）
 *
 * 命中直達下單（2026-10 第二梯隊·項B）：推送落地頁攜帶 monhit={monitorId}，
 * 小程序首頁落地後從監控參數組裝預訂意圖重新進入規劃鏈路——把「告知」
 * 升級為「起草待確認」（最終下單仍經確認彈窗把關，問題定義權在用戶）。
 * 不直接在 URL 攜帶業務參數（from/to/trainNo），落地後以 monitorId 回查
 * 雲端落庫參數，防外部拼參偽造意圖。
 */
async function pushSubscribeMessage(
  openid: string,
  monitorId: string,
  label: string,
  detail: string,
): Promise<boolean> {
  const tmplId = process.env.MONITOR_TMPL_ID;
  if (!tmplId) return false;
  const res = await sendSubscribeMessage(openid, tmplId, `pages/index/index?monhit=${encodeURIComponent(monitorId)}`, {
    thing1: { value: label.slice(0, 20) },
    thing2: { value: detail.slice(0, 20) },
  });
  return res === 'ok';
}

/** 降水間接命中詞（不含「雨/雪」字的現象，2026-10-15 高德預報文案觀察補充） */
const PRECIP_WORDS = ['雨', '雪', '陣雨', '雷陣', '雨夾雪', '凍雨', '冰雹'];

/**
 * 單條天氣突變檢查（第二梯隊·項B）：行程日預報出現降水 / 極端溫度即命中。
 *
 * 命中規則（可計算的驗收口徑，創建時文案已告知）：
 *   - 降水：白天 / 夜間天氣現象含雨雪類詞 → 「帶傘 / 考慮改簽」
 *   - 極端溫度：白天最高 ≥ 35°C（防暑）或 ≤ -5°C（保暖）
 *
 * 高德預報窗口僅 3~4 天：目標日在窗口外時如實記錄「等待臨近」（不虚報
 * 無異常）；窗口内無命中記錄掃描結論。命中即 complete（避免重複轟炸），
 * V1 推送為擴展位（WEATHER_TMPL_ID 配置後啓用；用戶未單獨授權天氣模板，
 * 未配置時純拉模式——行程頁監控區可見，真實或誠實缺失，不演）。
 *
 * @returns 命中詳情文案；未命中 / 窗口外 / 上游不可用返回 null
 */
async function checkWeatherAlert(m: ExternalOrder): Promise<string | null> {
  const p = (m.payload ?? {}) as Partial<MonitorPayload>;
  const params = (p.params ?? {}) as Partial<MonitorPayload['params']>;
  const city = String(params.city ?? '');
  const date = String(params.date ?? '');
  const now = Date.now();

  if (!city || !date) {
    await writeScanState(m, { lastCheckedAt: now, lastMessage: '監控參數缺失（city / date）' });
    return null;
  }
  // 目標日已過：無監控意義，收斂終態（tick 不再掃）
  if (Date.parse(`${date}T23:59:59+08:00`) < now) {
    await completeOrder(m.orderId, m.owner).catch(() => undefined);
    await writeScanState(m, { lastCheckedAt: now, lastMessage: '行程日已過，監控自動收斂' });
    return null;
  }

  const casts = await getForecastByCity(city, date);
  if (casts === null) {
    await writeScanState(m, {
      lastCheckedAt: now,
      lastMessage: `天氣預報暫不可用（上游 / 配置），待下輪重試`,
    });
    return null;
  }
  if (casts.length === 0) {
    await writeScanState(m, {
      lastCheckedAt: now,
      lastMessage: `預報窗口尚未覆蓋 ${date}（高德預報 3~4 天），臨近後自動生效`,
    });
    return null;
  }

  const cast: ForecastCast = casts[0];
  const weather = `${cast.dayweather}／${cast.nightweather}`;
  const tempRange = `${cast.nighttemp}~${cast.daytemp}°C`;

  const hasPrecip = PRECIP_WORDS.some((w) => weather.includes(w));
  const daytemp = parseInt(cast.daytemp, 10);
  const hasHeat = !Number.isNaN(daytemp) && daytemp >= 35;
  const hasCold = !Number.isNaN(daytemp) && daytemp <= -5;

  if (!hasPrecip && !hasHeat && !hasCold) {
    await writeScanState(m, {
      lastCheckedAt: now,
      lastMessage: `剛掃描：${date} ${city} ${weather}（${tempRange}），無突變`,
    });
    return null;
  }

  const detail = hasPrecip
    ? `${date} ${city}有降水（${weather}，${tempRange}），出行記得帶傘，必要時考慮改簽`
    : hasHeat
      ? `${date} ${city}高溫（白天 ${cast.daytemp}°C），注意防暑降溫`
      : `${date} ${city}嚴寒（白天 ${cast.daytemp}°C），注意保暖`;
  await writeScanState(m, { lastCheckedAt: now, hit: true, hitAt: now, lastMessage: detail });
  await completeOrder(m.orderId, m.owner);
  return detail;
}

/** searchFlights 成功回應的機票查詢結果形態（監控消費 priceCent 欄位） */
interface FlightSearchData {
  source?: string;
  flights?: Array<{ flightNo?: string; priceCent?: number }>;
}

/** 分值 → 元展示（整數元，推送文案與 lastMessage 共用） */
function yuan(cent: number): string {
  return (cent / 100).toFixed(0);
}

/**
 * 單條機票降價檢查（第二梯隊·項C）：即時最低價 ≤ 基準價 − 降幅閾值即命中。
 *
 * 命中口徑為可計算的驗收規則：基準價 = 創建時查詢最低價快照，降幅由用戶
 * 創建時指定（問題定義權在用戶，Agent 只負責按規則掃描）。命中即 complete
 * （避免重複轟炸），推送落地攜 monhit 直達航班查詢卡——選班與否的決策
 * 仍留給用戶（「起草待確認」而非代下單）。
 *
 * 「不演」紅線：模擬數據源（未配置 VARIFLIGHT_API_KEY / 連線失敗降級）
 * 不產生命中；本輪無有效報價（上游 priceCent 為 -1）如實記錄待下輪。
 *
 * @returns 命中詳情文案；未命中 / 查詢不可用 / 模擬源返回 null
 */
async function checkFlightPrice(m: ExternalOrder): Promise<string | null> {
  const p = (m.payload ?? {}) as Partial<MonitorPayload>;
  const params = (p.params ?? {}) as Partial<MonitorPayload['params']>;
  const from = String(params.from ?? '');
  const to = String(params.to ?? '');
  const date = String(params.date ?? '');
  const baselineCent = Number(params.baselineCent ?? 0);
  const dropCent = Number(params.dropCent ?? 0);
  const now = Date.now();

  if (!from || !to || !date || baselineCent <= 0 || dropCent <= 0) {
    await writeScanState(m, { lastCheckedAt: now, lastMessage: '監控參數缺失（from / to / date / 基準價 / 降幅）' });
    return null;
  }
  // 航班日已過：票價無監控意義，收斂終態（tick 不再掃）
  if (Date.parse(`${date}T23:59:59+08:00`) < now) {
    await completeOrder(m.orderId, m.owner).catch(() => undefined);
    await writeScanState(m, { lastCheckedAt: now, lastMessage: '航班日期已過，監控自動收斂' });
    return null;
  }

  const res = await searchFlights(
    { from, to, date, cabin: String(params.cabin ?? 'economy') },
    { openid: m.owner },
  );

  // 查詢失敗（上游不可用）：如實記錄，下個節拍重試（不虛報命中）
  if (res.body.code !== 0 || !res.body.data) {
    await writeScanState(m, {
      lastCheckedAt: now,
      lastMessage: `查詢暫不可用（${String(res.body.message ?? '').slice(0, 40)}），待下輪重試`,
    });
    return null;
  }

  const data = res.body.data as FlightSearchData;

  // 「不演」紅線：模擬數據源不產生命中（虛假承諾），僅如實標記待真實源
  if (data.source !== 'variflight_realtime') {
    await writeScanState(m, {
      lastCheckedAt: now,
      lastMessage: '當前為模擬數據源，監控待真實票價源（飛常準）就位後生效',
    });
    return null;
  }

  // 取即時最低有效報價（priceCent ≤ 0 為「未取到價」，不參與判定）
  const priced = (data.flights ?? []).filter(
    (f) => typeof f.priceCent === 'number' && f.priceCent > 0,
  );
  if (priced.length === 0) {
    await writeScanState(m, {
      lastCheckedAt: now,
      lastMessage: '剛掃描：本輪無有效報價（上游未取到價），待下輪重試',
    });
    return null;
  }

  const minCent = Math.min(...priced.map((f) => f.priceCent as number));
  const targetCent = baselineCent - dropCent;
  if (minCent > targetCent) {
    await writeScanState(m, {
      lastCheckedAt: now,
      lastMessage: `剛掃描：最低 ¥${yuan(minCent)}（較創建時降 ¥${yuan(baselineCent - minCent)}），未達 ¥${yuan(dropCent)} 降幅`,
    });
    return null;
  }

  const detail = `機票降價：${date} ${from}飛${to}最低 ¥${yuan(minCent)}（較創建時降 ¥${yuan(baselineCent - minCent)}），可回小程序查看航班`;
  await writeScanState(m, { lastCheckedAt: now, hit: true, hitAt: now, lastMessage: detail });
  // 命中即目標達成：轉 completed，tick 不再掃（繼續監控可重新創建）
  await completeOrder(m.orderId, m.owner);
  return detail;
}

/**
 * 單條掃描分派（kind → 對應檢查器；新增監控種類時在此接線）
 *
 * @returns 命中詳情文案；未命中 / 不可用返回 null
 */
async function checkMonitor(m: ExternalOrder): Promise<string | null> {
  const kind = (m.payload as Partial<MonitorPayload>)?.kind;
  if (kind === 'weather_alert') return checkWeatherAlert(m);
  if (kind === 'flight_price') return checkFlightPrice(m);
  return checkTrainTickets(m);
}

/**
 * 定時掃描 tick（雲托管定時觸發器調用；CRON_TOKEN 鑒權，fail-closed）
 *
 * 響應體：{ scanned, hit }——掃描條數與命中條數（觸發器日誌可觀測）。
 * 單條異常不中斷整輪（記 ERROR 繼續下一條）；新創建優先（lastCheckedAt=0
 * 必為 due，用戶期待最快首掃）。
 */
const handleTick: RouteHandler = async (body) => {
  const denied = verifyCronToken(body);
  if (denied) return denied;

  const now = Date.now();
  const all = await listAllByDomain('monitor', ['pending_external']);
  const due = all
    .filter((o) => now - Number((o.payload as Partial<MonitorPayload>)?.lastCheckedAt ?? 0) >= CHECK_INTERVAL_MS)
    .slice(0, TICK_BATCH_LIMIT);

  let hitCount = 0;
  for (const m of due) {
    try {
      const kind = (m.payload as Partial<MonitorPayload>)?.kind;
      const detail = await checkMonitor(m);
      if (detail) {
        hitCount++;
        const label = String((m.payload as Partial<MonitorPayload>)?.label ?? '');
        // V1 天氣監控純拉模式（無用戶授權入口，推送為 WEATHER_TMPL_ID 擴展位）；
        // 餘票 / 機票降價命中走推模式（monhit 直達下單 / 查詢）
        if (kind !== 'weather_alert') {
          await pushSubscribeMessage(m.owner, m.orderId, label, detail);
        }
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
