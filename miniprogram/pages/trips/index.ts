/**
 * 我的行程頁（行程簿時間線瀏覽 + 分享 / 訂閱提醒）
 *
 * 規範來源：.qoder/rules/Agent.md § 4（storage/ 業務持久化）
 *
 * 展示 storage/trip 行程簿：日期徽章（MM-DD + 口語標籤）+ 城市 + 活動 +
 * 狀態徽章；點卡片頭展開豎向時間線（任務 timeLabel + 標題 + 狀態徽章，
 * 完成節點打勾），時間線底部掛操作區（分享同伴 / 訂閱提醒 / 刪除行程）。
 *
 * 2026-10 產品評審 #4 增長循環：
 *   - 行程分享：open-type=share 按鈕 → 白化上傳雲端換不可枚舉 shareId →
 *     分享卡攜 ?shared=shareId，同伴打開本頁頂部只讀展示同一時間線
 *     （行程簿存本機，跨設備經雲端中轉，見 services/trip-share）
 *   - 訂閱出發提醒：模板 ID（src/app.ts SUBSCRIBE_TMPL_TRIP_REMIND）
 *     配置後才渲染按鈕，tap 觸發微信授權（真實或誠實缺失，不演）
 *   - 半屏跳轉 + 成交確認（2026-10 半屏升級）：「去下單」經 services/jump
 *     統一入口（半屏白名單命中時半屏打開，渠道側支付完成後關閉即回對話流）；
 *     「標記已支付」為跳轉模式的支付閉環——真實支付在官方渠道收銀台，
 *     用戶自證成交後雲端歸檔 completed + 本地 paidAt 落盤
 *   - 餘票監控（2026-10 第二梯隊·項A）：首頁售罄車次可一鍵加入監控，
 *     雲端定時 tick 掃描回寫命中狀態，本頁展示與刪除（services/monitors）
 *   - 行程完整性差距（2026-10 第三梯隊·L4 試探）：行程升級為持續目標載體，
 *     臨近 7 天內展開可計算的缺項清單（交通票 / 住宿 / 天氣提醒），數據
 *     驅動推導即持續對齊——補齊即收斂，不拿舊目標硬推（見 buildChecklist）
 *
 * 行程建檔（Plan 確認後 orchestrator 調 saveTripFromPlan）與狀態同步
 * （調度結束調 updateTripFromPlan）均為自動完成。onShow 刷新：從首頁
 * 返回後即時反映最新行程簿。
 */

import { listTrips, removeTrip, markSubscribed, markNodePaid, getTrip, markShared, clearShared } from '../../src/storage/trip';
import { listMonitors, replaceMonitors, removeMonitorLocal, type MonitorEntry } from '../../src/storage/monitors';
import { shareTripToCloud, fetchSharedTrip, revokeSharedTrip } from '../../src/services/trip-share';
import { registerTripRemind, removeTripRemind } from '../../src/services/trip-remind';
import { fetchMyMonitors, removeMonitorCloud } from '../../src/services/monitors';
import { jumpExternal, confirmExternalPaid } from '../../src/services/jump';
import { recordEvent } from '../../src/services/metrics';
import { METRIC_NAMES } from '../../src/utils/metrics';
import { CLOUD_ENV, SUBSCRIBE_TMPL_TRIP_REMIND, EMBEDDED_JUMP_APPIDS } from '../../src/app';
import { BRAND_NAME } from '../../src/types/brand';
import type { SharedTrip } from '../../src/services/trip-share';
import type { TripEntry } from '../../src/types/trip';

/** 時間線節點（展示形態） */
interface TimelineRow {
  taskId: string;
  /** 時間線標籤（如「10/11 下周六」；缺省回退活動日 MM-DD） */
  timeLabel: string;
  title: string;
  statusLabel: string;
  statusClass: string;
  /** 已成功任務（時間線節點打勾） */
  done: boolean;
  /** 跳轉下單入口：寫任務成功的 jump 包（真實交易在渠道側完成）；appId 空串時僅複製 */
  jumpBtn?: { appId: string; path: string };
  /** 成交確認入口（節點攜帶渠道訂單號時渲染「標記已支付」） */
  confirmBtn?: { tripId: string; taskId: string };
  /** 已自證成交（渠道側支付完成；按鈕態轉為「已成交」標記） */
  paid?: boolean;
  /** 複製資訊（購票需求摘要，渠道側下單時粘貼使用） */
  copyText?: string;
}

/** 行程列表行（展示形態） */
interface TripRow {
  id: string;
  /** 日期徽章主行（MM-DD） */
  dateBadge: string;
  /** 口語日期標籤（如「下周六」；字面日期時為空不重複展示） */
  dateLabel: string;
  city: string;
  activity: string;
  statusLabel: string;
  statusClass: string;
  expanded: boolean;
  /** 已訂閱出發提醒（訂閱按鈕態） */
  subscribed: boolean;
  /** 分享仍在生效（sharedId 已落盤；撤銷入口渲染條件） */
  shared: boolean;
  timeline: TimelineRow[];
  /** 完整性差距清單（臨近窗口內非空；遠期為空僅提示文案） */
  checklist: ChecklistItem[];
  checklistHint: string;
}

/** 行程完整性 checklist 項（展示形態；差距 = ok=false 的缺項） */
interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  /** 缺項補齊路徑提示（ok=false 時展示） */
  hint: string;
}

/** 臨近窗口（差距清單完整展開的紅線口徑；不做泛泛待辦，遠期不逐項轟炸） */
const CHECKLIST_NEAR_DAYS = 7;

/** 距出發天數（東八區日界；負值 = 行程日已過） */
function daysUntil(date: string): number {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  return Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
}

/**
 * 行程完整性差距推導（2026-10 第三梯隊·L4 試探：可計算目標）
 *
 * 「N 月 N 日去 X 做 Y」即一個可計算目標，差距 = 具體缺項清單，從既有
 * timeline / 監控副本純函數推導。數據驅動即「持續對齊」：用戶補齊任一
 * 缺項（下單 / 訂閱），下次 onShow 刷新即收斂，不拿舊目標硬推。
 *
 * 紅線（Daisy 教訓）：差距清單只綁定具體行程、只在臨近窗口完整展開。
 * 「預算內」一項因無預算數據源不展示（真實或誠實缺失，不演）。
 */
function buildChecklist(t: TripEntry, monitors: MonitorEntry[]): ChecklistItem[] {
  // 交通票：時間線存在交通域下單節點（skillId 為下單節點才攜帶的欄位）
  const transit = t.timeline.find(
    (n) => n.orderId && (n.skillId?.startsWith('skill.train.') || n.skillId?.startsWith('skill.flight.')),
  );
  // 住宿：無專門住宿 SKILL，以標題啟發式 + 下單節點判定（沒有就如實示缺）
  const lodging = t.timeline.find(
    (n) => n.orderId && /酒店|住宿|民宿|旅館/.test(n.title),
  );
  // 天氣提醒：出發提醒已訂閱（wxa_ 天氣監控隨登記同源展開）
  const weatherWatched = Boolean(t.subscribedAt) || monitors.some((m) => m.monitorId === `wxa_${t.id}`);
  return [
    {
      key: 'transit',
      label: transit?.paidAt ? '交通票（已成交）' : '交通票',
      ok: Boolean(transit),
      hint: '未見車票 / 機票訂單，可回首頁查詢並預訂',
    },
    {
      key: 'lodging',
      label: '住宿',
      ok: Boolean(lodging),
      hint: '未規劃住宿，如需可回首頁說出酒店需求',
    },
    {
      key: 'weather',
      label: '天氣提醒',
      ok: weatherWatched,
      hint: '可在下方「訂閱出發提醒」補上',
    },
  ];
}

/** 單行程的差距展示上下文（臨近窗口口徑：遠期收斂為一行提示） */
function buildChecklistContext(t: TripEntry, monitors: MonitorEntry[]): { checklist: ChecklistItem[]; checklistHint: string } {
  const daysLeft = daysUntil(t.date);
  if (daysLeft < 0) return { checklist: [], checklistHint: '' };
  const daysLabel = daysLeft === 0 ? '今天' : `${daysLeft} 天`;
  if (daysLeft > CHECKLIST_NEAR_DAYS) {
    return { checklist: [], checklistHint: `距出發 ${daysLabel}，臨近（7 天內）將跟進完整性差距` };
  }
  const checklist = buildChecklist(t, monitors);
  const missing = checklist.filter((c) => !c.ok).map((c) => c.label);
  const hint = missing.length > 0
    ? `距出發 ${daysLabel}，還缺：${missing.join('、')}`
    : `距出發 ${daysLabel}，關鍵項已齊`;
  return { checklist, checklistHint: hint };
}

/** 條件監控行（展示形態；雲端 tick 掃描回寫命中狀態，命中即終態） */
interface MonitorRow {
  id: string;
  /** 展示摘要（「北京→上海 2026-10-20 G5」/「上海 2026-10-20 天氣」） */
  label: string;
  statusLabel: string;
  statusClass: string;
  /** 最近掃描結論 / 命中詳情 */
  lastMessage: string;
  /** 命中且可組裝直達意圖（入口渲染條件；告知型監控如天氣不渲染） */
  canBook: boolean;
  /** 直達入口文案（餘票=去預訂；機票降價=去查看——落地為航班查詢卡，選班決策留給用戶） */
  bookLabel: string;
}

/** 朋友分享的只讀行程（展示形態；?shared=shareId 打開時頂部區塊） */
interface SharedBlockData {
  loading: boolean;
  /** 拉取失敗（失效 / 網路不暢）時展示引導文案 */
  failed: boolean;
  dateBadge: string;
  dateLabel: string;
  city: string;
  activity: string;
  timeline: Array<{ idx: string; timeLabel: string; title: string; statusLabel: string }>;
}

/** 任務狀態 → 中文標籤（與首頁計劃卡徽章口徑一致） */
const TASK_STATUS_LABELS: Record<string, string> = {
  pending: '待執行',
  running: '執行中',
  succeeded: '已完成',
  failed: '失敗',
  skipped: '已跳過',
  waiting_human: '待確認',
};

/** 行程狀態 → 中文標籤 */
const TRIP_STATUS_LABELS: Record<string, string> = {
  planned: '已規劃',
  done: '已完成',
  partial: '部分完成',
};

/** 頁面資料結構 */
interface TripsPageData {
  trips: TripRow[];
  /** 訂閱消息模板 ID 已配置（true 才渲染「訂閱出發提醒」按鈕） */
  subReady: boolean;
  /** 朋友分享的只讀行程（分享卡打開時存在） */
  sharedBlock: SharedBlockData | null;
  /** 條件監控列表（餘票 / 天氣 / 機票降價；雲端權威同步後的展示行） */
  monitors: MonitorRow[];
  [key: string]: unknown;
}

/** 分享內容（onShareAppMessage 返回形態） */
interface ShareContent {
  title: string;
  path: string;
}

/** Page 內部 this 實例 */
interface TripsPageThis {
  data: TripsPageData;
  setData: (patch: Partial<TripsPageData>) => void;
  /** 展開中的行程 ID 集（刷新時保留展開態；Set 不可入 data，掛實例欄位） */
  expandedIds: Set<string>;
  /** 已換發的 shareId 緩存（tripId → shareId；重複分享免二次上傳） */
  shareIds: Map<string, string>;
  refresh: () => void;
  onLoad: (query: Record<string, string | undefined>) => void;
  loadShared: (shareId: string) => void;
  onShareAppMessage: (
    res?: { from?: 'button' | 'menu'; target?: { dataset?: Record<string, string> } },
  ) => ShareContent | Promise<ShareContent>;
  onTapSubscribe: (e: { currentTarget?: { dataset?: { id?: string } } }) => void;
  onTapToggle: (e: { currentTarget?: { dataset?: { id?: string } } }) => void;
  onTapRemove: (e: { currentTarget?: { dataset?: { id?: string } } }) => void;
  onTapNodeJump: (e: { currentTarget?: { dataset?: { appid?: string; path?: string } } }) => void;
  onTapNodePaid: (e: { currentTarget?: { dataset?: { tripid?: string; taskid?: string } } }) => void;
  onTapNodeCopy: (e: { currentTarget?: { dataset?: { text?: string } } }) => void;
  /** 撤銷分享（雲端刪除成功才清本地標記，防幽靈分享） */
  onTapRevokeShare: (e: { currentTarget?: { dataset?: { id?: string } } }) => void;
  /** 同步餘票監控（雲端權威 → 本地副本 → 展示行） */
  syncMonitors: () => void;
  /** 刪除監控（雲端刪除成功才移除本地副本，防幽靈監控） */
  onTapRemoveMonitor: (e: { currentTarget?: { dataset?: { id?: string } } }) => void;
  /** 命中監控「去預訂」：攜 monhit 跳首頁直達下單確認卡（起草待確認檔） */
  onTapMonitorBook: (e: { currentTarget?: { dataset?: { id?: string } } }) => void;
}

/** 行程條目 → 列表行（口語標籤與字面日期同值時不重複展示） */
function toTripRows(book: TripEntry[], expandedIds: Set<string>, monitors: MonitorEntry[]): TripRow[] {
  return book.map((t) => ({
    id: t.id,
    dateBadge: t.date.slice(5),
    dateLabel: t.dateLabel !== t.date ? t.dateLabel : '',
    city: t.city,
    activity: t.activity,
    statusLabel: TRIP_STATUS_LABELS[t.status] ?? t.status,
    statusClass: t.status,
    expanded: expandedIds.has(t.id),
    subscribed: Boolean(t.subscribedAt),
    shared: Boolean(t.sharedId),
    ...buildChecklistContext(t, monitors),
    timeline: t.timeline.map((n) => {
      const jump = n.jump;
      // 成交態優先於跳轉態：已自證支付 → 已成交；未確認攜 jump → 待跳轉下單
      const paid = Boolean(n.paidAt);
      return {
        taskId: n.taskId,
        timeLabel: n.timeLabel,
        title: n.title,
        // 攜帶 jump 包的節點 = 跳轉訂單待渠道側完成，徽章口徑覆蓋任務成功態
        statusLabel: paid ? '已成交' : jump ? '待跳轉下單' : (TASK_STATUS_LABELS[n.status] ?? n.status),
        statusClass: paid ? 'jump-paid' : jump ? 'jump-pending' : n.status,
        done: n.status === 'succeeded',
        ...(jump
          ? {
              copyText: jump.copyText,
              // jCommand（渠道轉鏈指令）優先於通用 path 作為跳轉路徑
              ...(jump.appId ? { jumpBtn: { appId: jump.appId, path: jump.jCommand ?? jump.path ?? '' } } : {}),
            }
          : {}),
        // 標記已支付入口：訂單要素落盤的節點才渲染（確認流經雲端歸檔 completed）
        ...(n.orderId ? { confirmBtn: { tripId: t.id, taskId: n.taskId }, paid } : {}),
      };
    }),
  }));
}

/** 監控條目 → 列表行（命中即終態：徽章轉綠，tick 不再掃描該條；
 * 命中且為餘票 / 機票降價監控時攜帶直達入口——餘票去預訂、降價去查看） */
function toMonitorRows(list: MonitorEntry[]): MonitorRow[] {
  return list.map((m) => ({
    id: m.monitorId,
    label: m.label,
    statusLabel: m.hit ? '已命中' : '監控中',
    statusClass: m.hit ? 'monitor-hit' : 'monitor-waiting',
    lastMessage: m.lastMessage,
    canBook: m.hit && (m.kind === 'train_tickets' || m.kind === 'flight_price'),
    bookLabel: m.kind === 'flight_price' ? '去查看' : '去預訂',
  }));
}

/** 分享標題（口語日期標籤 + 城市；字面日期回退 MM-DD） */
function shareTitle(t: TripEntry): string {
  const day = t.dateLabel && t.dateLabel !== t.date ? t.dateLabel : t.date.slice(5);
  return `${day} · ${t.city}出行計劃`;
}

Page({
  data: {
    trips: [],
    subReady: SUBSCRIBE_TMPL_TRIP_REMIND !== '',
    sharedBlock: null,
    monitors: [],
  } as TripsPageData,

  /** 分享卡入口：?shared=shareId 時拉取只讀行程展示於頂部 */
  onLoad(this: TripsPageThis, query: Record<string, string | undefined>): void {
    this.expandedIds = new Set();
    this.shareIds = new Map();
    const shared = query.shared?.trim();
    if (shared) this.loadShared(shared);
  },

  /** 每次現身刷新行程簿（首頁新增行程 / 調度完成同步後返回即時可見） */
  onShow(this: TripsPageThis): void {
    this.refresh();
    this.syncMonitors();
  },

  /**
   * 轉發內容（2026-10 評審 #4：補齊缺失的分享入口）
   *
   * - 行程卡分享按鈕（from=button）：白化上傳雲端換 shareId 後返回攜
   *   ?shared= 的路徑（已換發過則同步返回；上傳失敗回退為分享小程序
   *   本身——顯式動作不靜默吞錯，以 toast 告知）
   * - 右上角菜單（from=menu）：分享小程序首頁
   */
  onShareAppMessage(
    this: TripsPageThis,
    res?: { from?: 'button' | 'menu'; target?: { dataset?: Record<string, string> } },
  ): ShareContent | Promise<ShareContent> {
    const self = this;
    const fallback: ShareContent = { title: `${BRAND_NAME} — 一句話規劃出行`, path: '/pages/index/index' };
    const tripId = res?.from === 'button' ? res.target?.dataset?.id ?? '' : '';
    if (!tripId) return fallback;
    const trip = getTrip(tripId);
    if (!trip) return fallback;

    const cached = self.shareIds.get(tripId);
    if (cached) {
      return { title: shareTitle(trip), path: `/pages/trips/index?shared=${cached}` };
    }
    return shareTripToCloud(CLOUD_ENV, trip)
      .then((shareId) => {
        self.shareIds.set(tripId, shareId);
        // 落盤 sharedId（2026-10 審計 P3 遺留項：撤銷入口）：重啟後「分享中」
        // 狀態保持、撤銷鏈路可用（內存緩存會隨頁面卸载丟失）
        markShared(tripId, shareId);
        return { title: shareTitle(trip), path: `/pages/trips/index?shared=${shareId}` };
      })
      .catch(() => {
        wx.showToast({ title: '分享建立失敗，已改為分享小程序', icon: 'none' });
        return fallback;
      });
  },

  /** 拉取朋友分享的只讀行程（失敗展示引導文案，不阻斷自己行程簿瀏覽） */
  loadShared(this: TripsPageThis, shareId: string): void {
    this.setData({
      sharedBlock: { loading: true, failed: false, dateBadge: '', dateLabel: '', city: '', activity: '', timeline: [] },
    });
    void fetchSharedTrip(CLOUD_ENV, shareId)
      .then((trip: SharedTrip | null) => {
        if (!trip) {
          this.setData({
            sharedBlock: { loading: false, failed: true, dateBadge: '', dateLabel: '', city: '', activity: '', timeline: [] },
          });
          return;
        }
        this.setData({
          sharedBlock: {
            loading: false,
            failed: false,
            dateBadge: trip.date.slice(5),
            dateLabel: trip.dateLabel && trip.dateLabel !== trip.date ? trip.dateLabel : '',
            city: trip.city,
            activity: trip.activity,
            timeline: trip.timeline.map((n, i) => ({
              idx: `s${i}`,
              timeLabel: n.timeLabel,
              title: n.title,
              statusLabel: TASK_STATUS_LABELS[n.status] ?? n.status,
            })),
          },
        });
      })
      .catch(() => {
        this.setData({
          sharedBlock: { loading: false, failed: true, dateBadge: '', dateLabel: '', city: '', activity: '', timeline: [] },
        });
      });
  },

  /**
   * 訂閱出發提醒（tap 觸發微信授權；模板 ID 未配置時按鈕不渲染）
   *
   * 推模式閉環（2026-10 第二梯隊·項B）：授權成功 → 白化登記雲端
   * （register，同步展開 wxa_ 天氣監控）→ 雲托管定時觸發器前一天推送
   * （文案附天氣預報）。登記失敗如實告知（不虛報已就緒）；重複 tap
   * 為幂等 upsert，也可補充一次性訂閱額度。本地 subscribedAt 仍落盤
   * （按鈕態與雲端登記雙記錄）。
   */
  onTapSubscribe(this: TripsPageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const id = e.currentTarget?.dataset?.id ?? '';
    const trip = id ? getTrip(id) : null;
    if (!id || !trip) return;
    wx.requestSubscribeMessage({
      tmplIds: [SUBSCRIBE_TMPL_TRIP_REMIND],
      success: (r) => {
        if (r[SUBSCRIBE_TMPL_TRIP_REMIND] !== 'accept') {
          wx.showToast({ title: '未開啟提醒（可在設置中重新開啟）', icon: 'none' });
          return;
        }
        markSubscribed(id);
        this.refresh();
        void registerTripRemind(CLOUD_ENV, {
          tripId: trip.id,
          date: trip.date,
          city: trip.city,
          activity: trip.activity,
        })
          .then((res) => {
            if (res.code === 0) {
              wx.showToast({ title: '已訂閱，出發前一天提醒你', icon: 'none' });
              // 天氣監控同步刷入本地副本（行程頁監控區即時可見）
              this.syncMonitors();
            } else {
              wx.showToast({ title: res.message || '提醒登記失敗，請稍後重試', icon: 'none' });
            }
          })
          .catch(() => {
            wx.showToast({ title: '網路不暢，提醒登記未完成', icon: 'none' });
          });
      },
      fail: () => {
        wx.showToast({ title: '訂閱暫不可用，請稍後再試', icon: 'none' });
      },
    });
  },

  /** 內部：重讀行程簿並映射展示形態 */
  refresh(this: TripsPageThis): void {
    const book = listTrips();
    // 回填 shareId 內存緩存（仍在生效的分享，重啟後撤銷鏈路需要它換發刪除）
    for (const t of book) {
      if (t.sharedId && !this.shareIds.has(t.id)) this.shareIds.set(t.id, t.sharedId);
    }
    this.setData({ trips: toTripRows(book, this.expandedIds, listMonitors()) });
  },

  /**
   * 內部：同步餘票監控（雲端權威 → 本地副本 → 展示行）
   *
   * 先以本地副本立即渲染（離線可見 + 秒開），再拉雲端覆蓋（tick 掃描
   * 回寫的命中狀態以雲端為準）；拉取失敗保留本地副本——避免網路抖動
   * 導致監控「憑空消失」。
   */
  syncMonitors(this: TripsPageThis): void {
    this.setData({ monitors: toMonitorRows(listMonitors()) });
    void fetchMyMonitors(CLOUD_ENV)
      .then((res) => {
        if (res.code !== 0 || !Array.isArray(res.data)) return;
        replaceMonitors(
          res.data.map((m) => ({
            monitorId: m.monitorId,
            label: m.label,
            kind: m.kind,
            params: m.params,
            hit: m.hit,
            lastMessage: m.lastMessage,
            lastCheckedAt: m.lastCheckedAt,
            createdAt: m.createdAt,
          })),
        );
        this.setData({ monitors: toMonitorRows(listMonitors()) });
        // 行程完整性差距依賴監控副本（天氣提醒項），同步後重推
        this.refresh();
      })
      .catch(() => {
        /* 拉取失敗保留本地副本，靜默降級（下次 onShow 重試） */
      });
  },

  /** 刪除監控（模態確認；雲端刪除成功才移除本地副本——防「雲端仍在掃描、本地卻不可見」的幽靈監控） */
  onTapRemoveMonitor(this: TripsPageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const id = e.currentTarget?.dataset?.id ?? '';
    if (!id) return;
    wx.showModal({
      title: '刪除監控',
      content: '刪除後不再掃描該條件（餘票 / 天氣 / 機票降價），確定刪除嗎？',
      confirmText: '刪除',
      success: (res) => {
        if (!res.confirm) return;
        void removeMonitorCloud(CLOUD_ENV, id)
          .then((r) => {
            if (r.code !== 0) {
              wx.showToast({ title: r.message || '刪除失敗，請稍後再試', icon: 'none' });
              return;
            }
            removeMonitorLocal(id);
            this.syncMonitors();
            wx.showToast({ title: '已刪除', icon: 'success' });
          })
          .catch(() => {
            wx.showToast({ title: '網路不暢，請稍後再試', icon: 'none' });
          });
      },
    });
  },

  /** 命中監控「去預訂 / 去查看」（第二梯隊·項B/C）：攜 monhit 跳首頁，由首頁
   * 統一的命中直達處理組裝預訂 / 查詢意圖進規劃鏈路（確認彈窗把關下單）；
   * 跳轉而非本頁 dispatch，避免行程頁依賴首頁 Runtime 接線 */
  onTapMonitorBook(this: TripsPageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const id = e.currentTarget?.dataset?.id ?? '';
    if (!id) return;
    wx.navigateTo({ url: `/pages/index/index?monhit=${encodeURIComponent(id)}` });
  },

  /** 卡片頭點擊：展開 / 收起時間線 */
  onTapToggle(this: TripsPageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const id = e.currentTarget?.dataset?.id ?? '';
    if (!id) return;
    if (this.expandedIds.has(id)) this.expandedIds.delete(id);
    else this.expandedIds.add(id);
    this.refresh();
  },

  /** 刪除行程（模態確認；刪除僅清本地條目不觸發回滾。雲端出發提醒與
   * 天氣監控聯動清理（防幽靈提醒）：清理失敗不阻斷本地刪除，僅如實
   * 提示（過期推送為輕噪聲，卡住刪除為重體驗問題，取捨从輕） */
  onTapRemove(this: TripsPageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const id = e.currentTarget?.dataset?.id ?? '';
    if (!id) return;
    wx.showModal({
      title: '刪除行程',
      content: '刪除後不可恢復，確定刪除這條行程嗎？',
      confirmText: '刪除',
      success: (res) => {
        if (!res.confirm) return;
        removeTrip(id);
        this.expandedIds.delete(id);
        this.shareIds.delete(id);
        this.refresh();
        void removeTripRemind(CLOUD_ENV, id)
          .then((r) => {
            if (r.code !== 0) {
              wx.showToast({ title: '提醒清理失敗，若收到過期提醒請忽略', icon: 'none' });
            } else {
              this.syncMonitors();
            }
          })
          .catch(() => {
            wx.showToast({ title: '網路不暢，提醒未清理，請忽略過期提醒', icon: 'none' });
          });
      },
    });
  },

  /**
   * 撤銷分享（2026-10 審計 P3 遺留項：分享無撤銷）。雲端刪除成功才清本地
   * 標記（口徑同監控刪除——防「本地已清、同伴仍可打開」的幽靈態）；雲端
   * 已 404（TTL 過期後手動撤銷）視為成功收斂本地狀態。附註：刪除行程
   * 不自動撤銷分享（分享的是白化只讀副本，與本地條目生命周期獨立，TTL
   * 自然收斂），有意撤銷走本入口。
   */
  onTapRevokeShare(this: TripsPageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const tripId = e.currentTarget?.dataset?.id ?? '';
    const shareId = tripId ? (this.shareIds.get(tripId) ?? getTrip(tripId)?.sharedId ?? '') : '';
    if (!tripId || !shareId) return;
    wx.showModal({
      title: '撤銷分享',
      content: '撤銷後同伴打開的分享連結將立即失效，確定撤銷嗎？',
      confirmText: '撤銷',
      success: (res) => {
        if (!res.confirm) return;
        void revokeSharedTrip(CLOUD_ENV, shareId)
          .then(() => {
            clearShared(tripId);
            this.shareIds.delete(tripId);
            this.refresh();
            wx.showToast({ title: '已撤銷分享', icon: 'success' });
          })
          .catch((err: Error & { code?: number }) => {
            // 404（已過期 / 他端已撤銷）同樣收斂本地狀態——按數字業務碼判斷
            // （CodeReview Low #2），不依賴服務端文案字串匹配
            if (err.code === 404) {
              clearShared(tripId);
              this.shareIds.delete(tripId);
              this.refresh();
              return;
            }
            wx.showToast({ title: err.message || '撤銷失敗，請稍後再試', icon: 'none' });
          });
      },
    });
  },

  /**
   * 時間線節點「去下單」：重新跳轉官方渠道小程序（首頁跳轉卡被新對話淹沒後的
   * 重跳轉入口；經 services/jump 統一入口——半屏白名單命中時半屏打開，
   * 支付環節由渠道自行轉全屏，任何環境不可用時逐級降級，路徑不斷裂）
   */
  onTapNodeJump(this: TripsPageThis, e: { currentTarget?: { dataset?: { appid?: string; path?: string } } }): void {
    jumpExternal({
      env: CLOUD_ENV,
      appId: e.currentTarget?.dataset?.appid ?? '',
      path: e.currentTarget?.dataset?.path ?? '',
      embeddedAppIds: EMBEDDED_JUMP_APPIDS,
    });
  },

  /*
   * 時間線節點「標記已支付」（2026-10 半屏跳轉 + 支付閉環）：真實支付在
   * 官方渠道收銀台完成（渠道主體資質，本小程序不碰錢）；用戶回到行程頁
   * 自證成交，雲端訂單歸檔 completed + 本地 paidAt 落盤。模態二次確認
   * 防誤標（訂單號已展示，便於與渠道側核對）。
   */
  onTapNodePaid(this: TripsPageThis, e: { currentTarget?: { dataset?: { tripid?: string; taskid?: string } } }): void {
    const tripId = e.currentTarget?.dataset?.tripid ?? '';
    const taskId = e.currentTarget?.dataset?.taskid ?? '';
    const node = getTrip(tripId)?.timeline.find((n) => n.taskId === taskId);
    if (!node?.orderId || !node.skillId || !node.action) return;
    const { orderId, skillId, action } = node;
    wx.showModal({
      title: '標記已支付',
      content: `請確認已在官方渠道完成支付（訂單 ${orderId}），標記後行程歸檔為已成交。`,
      confirmText: '已支付',
      cancelText: '還沒',
      success: (res) => {
        if (!res.confirm) return;
        void confirmExternalPaid(CLOUD_ENV, skillId, action, orderId)
          .then((r) => {
            if (r !== true) {
              wx.showToast({ title: r, icon: 'none' });
              return;
            }
            markNodePaid(tripId, taskId);
            // 漏斗最深可觀測點：跳轉模式下唯一能採到的「成交」信號
            recordEvent(CLOUD_ENV, METRIC_NAMES.orderConfirmed);
            this.refresh();
            wx.showToast({ title: '已標記成交', icon: 'success' });
          })
          .catch(() => {
            wx.showToast({ title: '網路不暢，請稍後再試', icon: 'none' });
          });
      },
    });
  },

  /** 時間線節點「複製資訊」：憑證要素寫入剪貼板，渠道側下單時粘貼使用 */
  onTapNodeCopy(this: TripsPageThis, e: { currentTarget?: { dataset?: { text?: string } } }): void {
    const text = e.currentTarget?.dataset?.text;
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已複製', icon: 'success' }),
    });
  },
} as unknown as Parameters<typeof Page>[0]);
