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
 *
 * 行程建檔（Plan 確認後 orchestrator 調 saveTripFromPlan）與狀態同步
 * （調度結束調 updateTripFromPlan）均為自動完成。onShow 刷新：從首頁
 * 返回後即時反映最新行程簿。
 */

import { listTrips, removeTrip, markSubscribed, markNodePaid, getTrip } from '../../src/storage/trip';
import { shareTripToCloud, fetchSharedTrip } from '../../src/services/trip-share';
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
  timeline: TimelineRow[];
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
}

/** 行程條目 → 列表行（口語標籤與字面日期同值時不重複展示） */
function toTripRows(book: TripEntry[], expandedIds: Set<string>): TripRow[] {
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
   * 授權結果本地記錄（subscribedAt）；出發前推送由雲托管定時觸發器
   * 完成（部署側配置，見 src/app.ts SUBSCRIBE_TMPL_TRIP_REMIND 注釋）。
   */
  onTapSubscribe(this: TripsPageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const id = e.currentTarget?.dataset?.id ?? '';
    if (!id) return;
    wx.requestSubscribeMessage({
      tmplIds: [SUBSCRIBE_TMPL_TRIP_REMIND],
      success: (r) => {
        if (r[SUBSCRIBE_TMPL_TRIP_REMIND] === 'accept') {
          markSubscribed(id);
          this.refresh();
          wx.showToast({ title: '已訂閱出行提醒', icon: 'none' });
        } else {
          wx.showToast({ title: '未開啟提醒（可在設置中重新開啟）', icon: 'none' });
        }
      },
      fail: () => {
        wx.showToast({ title: '訂閱暫不可用，請稍後再試', icon: 'none' });
      },
    });
  },

  /** 內部：重讀行程簿並映射展示形態 */
  refresh(this: TripsPageThis): void {
    this.setData({ trips: toTripRows(listTrips(), this.expandedIds) });
  },

  /** 卡片頭點擊：展開 / 收起時間線 */
  onTapToggle(this: TripsPageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const id = e.currentTarget?.dataset?.id ?? '';
    if (!id) return;
    if (this.expandedIds.has(id)) this.expandedIds.delete(id);
    else this.expandedIds.add(id);
    this.refresh();
  },

  /** 刪除行程（模態確認；刪除僅清本地條目不觸發回滾） */
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
