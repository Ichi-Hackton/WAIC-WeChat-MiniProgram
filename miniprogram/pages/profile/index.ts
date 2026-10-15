/**
 * 個人資料頁（實名證件 + 收貨地址；2026-10 恢復雙分區）
 *
 * 雙分區列表：乘車人簿（src/storage/passenger）+ 地址簿
 * （src/storage/address），點行進編輯；證號 / 手機號一律脫敏展示。
 *
 * 地址簿的出發城市職責：默認地址市級為 Agent 出發城市第一優先級
 * （地址簿 > 定位 > 追問，見 core/context.ts fetchLocation）。
 * 空簿提供「一鍵帶入微信地址」直存入口（表單頁的導入僅回填）。
 *
 * 本頁只做列表展示與導航；增刪改校驗全部下沉編輯頁與數據層。
 * onShow 刷新：從編輯頁返回後即時反映最新簿內容。
 */

import { listPassengers, maskIdNo } from '../../src/storage/passenger';
import {
  listAddresses,
  addAddress,
  validateAddressForm,
  fromWechatAddress,
} from '../../src/storage/address';
import { pickWechatAddress } from '../../src/services/address';
import { getMailAccount, maskEmail } from '../../src/storage/mail-account';
import { clearHistory, clearMessages, sanitizeIntent } from '../../src/storage/session';
import { getPreferences, clearPreferences, PREFERENCE_DOMAINS } from '../../src/storage/preferences';
import { clearQuickPhrases, topQuickPhrases } from '../../src/storage/quick-phrases';
import { clearRoutines, listRoutines } from '../../src/storage/routines';
import { listActivities, clearActivities } from '../../src/storage/activity';
import {
  getPermissionTier,
  setPermissionTier,
  clearPermissionOverrides,
  type PermissionTier,
} from '../../src/storage/permissions';
import { SkillRegistry } from '../../src/skills/registry';
import { isWriteAction } from '../../src/utils/review';
import { listTrips } from '../../src/storage/trip';
import type { AgentRuntime } from '../../src/app';

/** 乘車人列表行（脫敏後的展示形態） */
interface PassengerRow {
  id: string;
  name: string;
  idNoMasked: string;
  isDefault: boolean;
  /** 來源標籤（對話捕獲保存顯示「對話」，表單錄入為空串不展示） */
  sourceTag: string;
}

/** 地址列表行（脫敏後的展示形態） */
interface AddressRow {
  id: string;
  receiverName: string;
  phoneMasked: string;
  regionLine: string;
  detail: string;
  isDefault: boolean;
  /** 來源標籤（對話捕獲保存顯示「對話」，表單錄入為空串不展示） */
  sourceTag: string;
}

/** 頁面資料結構 */
interface ProfilePageData {
  passengers: PassengerRow[];
  addresses: AddressRow[];
  /** 郵箱帳戶綁定狀態（單帳戶，展示形態） */
  mailBound: boolean;
  mailEmailMasked: string;
  mailSmtpLine: string;
  /** 技能權限分區（項B）：含寫操作的技能域 + 當前檔位 */
  permSkills: PermSkillRow[];
  /** 執行記錄分區（項E）：時間倒序的執行留痕 */
  activities: ActivityRow[];
  [key: string]: unknown;
}

/** 技能權限行（展示形態） */
interface PermSkillRow {
  skillId: string;
  /** 技能中文名 */
  name: string;
  /** 當前檔位（default / auto / confirm） */
  tier: PermissionTier;
  /** 當前檔位中文標籤 */
  tierLabel: string;
}

/** 執行記錄行（展示形態，項E） */
interface ActivityRow {
  /** 合成鍵（同毫秒多條時綴序號防重） */
  key: string;
  /** 意圖脱敏摘要 */
  intent: string;
  /** 結果徽章文案 */
  outcomeLabel: string;
  /** 結果徽章樣式態（completed / mixed / failed） */
  outcome: string;
  /** 任務標籤單行串接 */
  labelsLine: string;
  /** 時間（MM-DD HH:mm） */
  timeLabel: string;
}

/** 檔位選項（picker 順序與值映射，雙端同步維護此處單源） */
const TIER_VALUES: PermissionTier[] = ['default', 'auto', 'confirm'];
const TIER_LABELS = ['跟隨技能聲明', '自動執行', '每次確認'];

/** 檔位 → 中文標籤 */
function tierLabel(tier: PermissionTier): string {
  return TIER_LABELS[TIER_VALUES.indexOf(tier)] ?? TIER_LABELS[0];
}

/** 組裝技能權限分區數據：註冊表中含寫操作 capability 的技能域（項B） */
function buildPermSkills(): PermSkillRow[] {
  return SkillRegistry.list()
    .filter((meta) => meta.capabilities.some((c) => isWriteAction(c.action)))
    .map((meta) => {
      const tier = getPermissionTier(meta.id);
      return { skillId: meta.id, name: meta.name, tier, tierLabel: tierLabel(tier) };
    });
}

/** 時間戳 → MM-DD HH:mm（本機時區；記錄僅存近 50 條，省略年份無歧義） */
function formatActTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 組裝執行記錄分區數據（項E）：listActivities 已倒序，直接映射展示形態 */
function buildActivities(): ActivityRow[] {
  return listActivities().map((a, i) => ({
    key: `${a.ts}-${i}`,
    intent: a.intent,
    outcome: a.outcome,
    outcomeLabel: a.outcome === 'completed' ? '已完成' : a.outcome === 'mixed' ? '部分完成' : '未完成',
    labelsLine: a.labels.join(' → '),
    timeLabel: formatActTime(a.ts),
  }));
}

/** Page 內部 this 實例 */
interface ProfilePageThis {
  data: ProfilePageData;
  setData: (patch: Partial<ProfilePageData>) => void;
  onShow: () => void;
  onAddPassenger: () => void;
  onTapPassenger: (e: { currentTarget?: { dataset?: { id?: string } } }) => void;
  onAddAddress: () => void;
  onTapAddress: (e: { currentTarget?: { dataset?: { id?: string } } }) => void;
  onTapImportAddress: () => void;
  onBindMail: () => void;
  /** 隱私控制中心（項5）：清除會話歷史（含 runtime 記憶歸零） */
  onClearSession: () => void;
  /** 隱私控制中心（項5）：清除偏好記憶與快捷數據（話語 / 例程） */
  onClearPrefs: () => void;
  /** 隱私控制中心（項5）：導出我的數據（脱敏 JSON 複製到剪貼板） */
  onExportData: () => void;
  /** 技能權限（項B）：picker 切換檔位 */
  onTierChange: (e: { currentTarget?: { dataset?: { skillId?: string } }, detail?: { value?: unknown } }) => void;
}

/** 手機號脫敏（列表展示用）：保留前 3 位與後 4 位 */
function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : phone;
}

/** 取得 Agent Runtime（清除會話時同步重置内存上下文，防護性判空） */
function getAgent(): AgentRuntime | null {
  const app = getApp() as unknown as { globalData?: { agent?: AgentRuntime } };
  return app?.globalData?.agent ?? null;
}

/**
 * 組裝「導出我的數據」脱敏 JSON（項5，借鑑 Spark 數據自主權模式）
 *
 * 全部欄位出口即脱敏：證號 / 手機 / 郵箱以展示態遮罩，話語 / 口令過
 * sanitizeIntent 打碼——導出物本身不含強敏感明文，用戶可安全轉存。
 */
function buildExportJson(): string {
  const prefs = getPreferences();
  const prefOut: Record<string, string> = {};
  for (const [k, e] of Object.entries(prefs)) {
    if (e && typeof e.value === 'string' && e.value) {
      prefOut[PREFERENCE_DOMAINS[k as keyof typeof PREFERENCE_DOMAINS] ?? k] = e.value;
    }
  }
  return JSON.stringify(
    {
      匯出時間: new Date().toISOString(),
      乘車人: listPassengers().map((p) => ({
        姓名: p.name,
        證號: maskIdNo(p.idNo),
        默認: p.isDefault ? '是' : '否',
      })),
      收貨地址: listAddresses().map((a) => ({
        收件人: a.receiverName,
        電話: maskPhone(a.phone),
        地區: `${a.province} ${a.city} ${a.district}`,
        詳址: a.detail,
        默認: a.isDefault ? '是' : '否',
      })),
      偏好記憶: prefOut,
      常問話語: topQuickPhrases(40).map((p) => ({
        話語: sanitizeIntent(p.text),
        次數: p.count,
      })),
      快捷例程: listRoutines().map((r) => ({
        口令: sanitizeIntent(r.text),
        流程: r.label,
      })),
      行程: listTrips().map((t) => ({
        日期: `${t.date}（${t.dateLabel}）`,
        城市: t.city,
        活動: t.activity,
        狀態: t.status === 'done' ? '已完成' : t.status === 'partial' ? '部分完成' : '已計劃',
      })),
      執行記錄: listActivities().map((a) => ({
        時間: formatActTime(a.ts),
        意圖: a.intent,
        結果: a.outcome === 'completed' ? '已完成' : a.outcome === 'mixed' ? '部分完成' : '未完成',
        任務: a.labels.join(' → '),
      })),
    },
    null,
    2,
  );
}

Page({
  data: {
    passengers: [],
    addresses: [],
    mailBound: false,
    mailEmailMasked: '',
    mailSmtpLine: '',
    permSkills: [],
    activities: [],
  } as ProfilePageData,

  /** 每次現身刷新兩簿 + 郵箱綁定狀態（編輯頁保存 / 解綁返回後即時同步） */
  onShow(this: ProfilePageThis): void {
    const mail = getMailAccount();
    this.setData({
      passengers: listPassengers().map((p) => ({
        id: p.id,
        name: p.name,
        idNoMasked: maskIdNo(p.idNo),
        isDefault: p.isDefault,
        sourceTag: (p.source ?? 'manual') === 'conversation' ? '對話' : '',
      })),
      addresses: listAddresses().map((a) => ({
        id: a.id,
        receiverName: a.receiverName,
        phoneMasked: maskPhone(a.phone),
        regionLine: `${a.province} ${a.city} ${a.district}`,
        detail: a.detail,
        isDefault: a.isDefault,
        sourceTag: (a.source ?? 'manual') === 'conversation' ? '對話' : '',
      })),
      mailBound: !!mail,
      mailEmailMasked: mail ? maskEmail(mail.email) : '',
      mailSmtpLine: mail ? `${mail.smtpHost}:${mail.smtpPort}` : '',
      permSkills: buildPermSkills(),
      activities: buildActivities(),
    });
  },

  /** 新增乘車人（無參進入編輯頁新增態） */
  onAddPassenger(this: ProfilePageThis): void {
    wx.navigateTo({ url: '/pages/passenger-edit/index' });
  },

  /** 編輯乘車人（列表行點擊，攜 id 進編輯態） */
  onTapPassenger(this: ProfilePageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const id = e.currentTarget?.dataset?.id ?? '';
    if (!id) return;
    wx.navigateTo({ url: `/pages/passenger-edit/index?id=${id}` });
  },

  /** 新增地址（無參進入編輯頁新增態） */
  onAddAddress(this: ProfilePageThis): void {
    wx.navigateTo({ url: '/pages/address-edit/index' });
  },

  /** 編輯地址（列表行點擊，攜 id 進編輯態） */
  onTapAddress(this: ProfilePageThis, e: { currentTarget?: { dataset?: { id?: string } } }): void {
    const id = e.currentTarget?.dataset?.id ?? '';
    if (!id) return;
    wx.navigateTo({ url: `/pages/address-edit/index?id=${id}` });
  },

  /**
   * 空簿一鍵帶入微信地址：導入即存（與表單頁僅回填不同——空簿場景
   * 用戶意圖明確，直接落盤最快建立出發城市來源；首條自動設默認）。
   *
   * 微信地址缺必填欄位時（暱稱含數字 / 詳址過短等），攜草稿導去表單
   * 頁補全（EventChannel 傳遞，URL query 不承載中文長文本），
   * 避免「提示補全卻開了張空表單」造成導入內容丢失。
   */
  async onTapImportAddress(this: ProfilePageThis): Promise<void> {
    const picked = await pickWechatAddress();
    if (!picked) {
      wx.showToast({ title: '未獲取到微信地址（可在授權設置中開啟後重試）', icon: 'none' });
      return;
    }
    const input = fromWechatAddress(picked);
    const err = validateAddressForm(input);
    if (err) {
      wx.showToast({ title: '微信地址信息不完整，已為你帶入表單', icon: 'none' });
      wx.navigateTo({
        url: '/pages/address-edit/index',
        success: (res) => res.eventChannel.emit('address:draft', input),
      });
      return;
    }
    const added = addAddress(input);
    if (!added) {
      wx.showToast({ title: '地址數量已達上限', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已帶入並設為默認', icon: 'success' });
    this.onShow();
  },
  /**
   * 郵箱帳戶綁定 / 編輯（單帳戶頁自判新増 / 編輯態，無需攜參）
   */
  onBindMail(this: ProfilePageThis): void {
    wx.navigateTo({ url: '/pages/mail-account-edit/index' });
  },

  /* ============ 技能權限（2026-10 第二梯隊·項B，借鑑 Muse / Dots）============ */

  /** 檔位切換：picker 選項 → 域級覆蓋落盤，分區行即時刷新（下一輪規劃
   *  執行生效——needCheckpoint 合成判定消費） */
  onTierChange(
    this: ProfilePageThis,
    e: { currentTarget?: { dataset?: { skillId?: string } }, detail?: { value?: unknown } },
  ): void {
    const skillId = e.currentTarget?.dataset?.skillId ?? '';
    const idx = typeof e.detail?.value === 'number' ? e.detail.value : Number(e.detail?.value ?? 0);
    const tier = TIER_VALUES[idx];
    if (!skillId || !tier) return;
    setPermissionTier(skillId, tier);
    this.setData({
      permSkills: this.data.permSkills.map((row) =>
        row.skillId === skillId ? { ...row, tier, tierLabel: tierLabel(tier) } : row,
      ),
    });
  },

  /* ============ 隱私控制中心（2026-10 第一梯隊·項5）============ */

  /** 清除會話歷史：本機對話訊息 + 歷史意圖摘要 + runtime 内存上下文歸零 */
  onClearSession(this: ProfilePageThis): void {
    wx.showModal({
      title: '清除會話歷史',
      content: '將清除本機保存的對話訊息與歷史意圖摘要，不影響乘車人簿、地址簿與偏好記憶。',
      confirmText: '清除',
      confirmColor: '#A04A3C',
      success: (res) => {
        if (!res.confirm) return;
        clearHistory();
        clearMessages();
        // 執行記錄屬會話類數據（項E）：隨清除會話聯動歸零，分區即時刷新
        clearActivities();
        this.setData({ activities: [] });
        // runtime 内存上下文同步歸零（否則規劃器仍可引用舊對話記憶）
        getAgent()?.resetAgent();
        wx.showToast({ title: '會話歷史已清除', icon: 'success' });
      },
    });
  },

  /** 清除偏好與快捷數據：偏好記憶 + 常問話語 + 快捷例程一併清空 */
  onClearPrefs(this: ProfilePageThis): void {
    wx.showModal({
      title: '清除偏好與快捷數據',
      content: '將清除偏好記憶、常問話語與快捷例程，不影響乘車人簿、地址簿與行程。',
      confirmText: '清除',
      confirmColor: '#A04A3C',
      success: (res) => {
        if (!res.confirm) return;
        clearPreferences();
        clearQuickPhrases();
        clearRoutines();
        // 權限覆蓋屬偏好類數據（項B）：清除偏好聯動回歸「跟隨技能聲明」
        clearPermissionOverrides();
        this.setData({ permSkills: buildPermSkills() });
        wx.showToast({ title: '偏好與快捷數據已清除', icon: 'success' });
      },
    });
  },

  /** 導出我的數據：脱敏 JSON 複製到剪貼板（用戶自主轉存） */
  onExportData(this: ProfilePageThis): void {
    wx.setClipboardData({
      data: buildExportJson(),
      success: () => wx.showToast({ title: '已複製導出數據（脱敏 JSON）', icon: 'none' }),
    });
  },
} as unknown as Parameters<typeof Page>[0]);
