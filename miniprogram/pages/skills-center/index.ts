/**
 * 技能中心 — 動態技能鍛造 / 提案追踪 / 公開技能 / 管理員審批
 *
 * 規範來源：.qoder/rules/Agent.md § 7（SKILL 規範）、動態技能計劃（L3 鍛造閉環）
 *
 * 交互鏈路（與雲端生命週期對齊）：
 *   1. 鍛造：需求（＋可選教材）→ 提交前確認（含去敏告知）→ 服務端 LLM 起草
 *      draft → 管理員審批 approved → 進入 manifest 全員可用
 *   2. 我的提案：本人全部記錄（draft 待審 / blocked 已攔截 / approved 已上架 /
 *      rejected 已拒絕 / disabled 已停用）；需求原文僅本人與管理員可見
 *   3. 公開技能：他人 approved 技能瀏覽
 *   4. 審批台（管理員）：approve / reject / disable / enable 四鍵操作，
 *      expectedVersion 為 CAS 樂觀鎖，版本衝突（2014）自動重新載入
 *
 * 安全邊界（計劃紅線）：提交前必須經用戶確認去敏語義（敏感信息服務端
 * 自動遮罩後才存儲）；不自動發布——所有技能須管理員核准方可上架。
 */

import { CLOUD_ENV } from '../../src/app';
import { fetchSkillCenter, forgeDynamicSkill, reviewDynamicSkill } from '../../src/services/skills';
import type {
  DynamicCenterRecord,
  DynamicReviewDecision,
  DynamicSkillCenter,
} from '../../src/types/dynamic-skill';
import { info as logInfo, error as logError } from '../../src/utils/logger';

/* ============ 渲染模型 ============ */

/** center 記錄 → 頁面渲染模型（狀態徽章 / 類型標籤 / 操作鍵預格式化） */
interface DisplayRecord {
  id: string;
  name: string;
  description: string;
  status: string;
  statusLabel: string;
  kindLabel: string;
  /** 是否本人提案（審批台來源標籤用） */
  mine: boolean;
  version: number;
  /** 需求摘要（僅本人 / 管理員記錄攜帶） */
  requirement: string;
  /** blocked / rejected 原因（對本人可見） */
  reason: string;
  /** 「MM/DD HH:mm」 */
  timeLabel: string;
  /** 管理員可執行操作（由狀態推導，與雲端 TRANSITIONS 對齊） */
  actions: Array<{ decision: string; label: string; primary: boolean }>;
}

/** 生命週期狀態 → 徽章文案 */
const STATUS_LABELS: Record<string, string> = {
  draft: '待審批',
  blocked: '已攔截',
  approved: '已上架',
  rejected: '已拒絕',
  disabled: '已停用',
};

/** 執行器 → 類型標籤 */
const KIND_LABELS: Record<string, string> = {
  http: 'HTTP 數據源',
  mcp: 'MCP 工具',
  llm: 'AI 生成',
};

/** 管理員可執行操作（與雲端 TRANSITIONS 轉移表逐字對齊；由狀態推導） */
function reviewActions(status: string): DisplayRecord['actions'] {
  if (status === 'draft') {
    return [
      { decision: 'approve', label: '核准上架', primary: true },
      { decision: 'reject', label: '拒絕', primary: false },
    ];
  }
  if (status === 'approved') return [{ decision: 'disable', label: '停用', primary: false }];
  if (status === 'disabled') return [{ decision: 'enable', label: '重新上架', primary: true }];
  return []; // blocked / rejected 為終態，無後續操作
}

/** 時間戳 →「MM/DD HH:mm」 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** center 記錄 → 渲染模型（防禦性窄化，§ 12.2 禁 any） */
function toDisplay(r: DynamicCenterRecord): DisplayRecord {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    statusLabel: STATUS_LABELS[r.status] ?? r.status,
    kindLabel: KIND_LABELS[r.kind] ?? r.kind,
    mine: r.mine,
    version: r.version,
    requirement: (r.requirement ?? '').slice(0, 160),
    reason: r.reason ?? '',
    timeLabel: formatTime(r.createdAt),
    actions: reviewActions(r.status),
  };
}

/** center 回應 → 三分區渲染數據（我的提案 / 公開技能 / 管理員審批台） */
function toGroups(data: DynamicSkillCenter): Pick<
  SkillsCenterData,
  'mine' | 'publicSkills' | 'reviewList' | 'connectors' | 'connectorNames'
> {
  return {
    mine: data.records.filter((r) => r.mine).map(toDisplay),
    publicSkills: data.records.filter((r) => !r.mine && r.status === 'approved').map(toDisplay),
    // 審批台為管理員工作視角：全部記錄（含本人提案，標註來源）
    reviewList: data.isAdmin ? data.records.map(toDisplay) : [],
    connectors: data.connectors,
    connectorNames: data.connectors.map((c) => c.name).join('、'),
  };
}

/** 生成 forge 冪等鍵（雲端契約：^[a-z0-9][a-z0-9_-]{5,61}$ 小寫字母數字） */
function genRequestId(): string {
  return `dyn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* ============ 頁面模型 ============ */

/** 頁面資料結構 */
interface SkillsCenterData {
  /** 首次載入中（整頁佔位） */
  loading: boolean;
  /** 雲端功能開關（ENABLE_DYNAMIC_SKILLS；關閉時整頁提示） */
  enabled: boolean;
  /** 當前用戶是否管理員（DYNAMIC_SKILL_ADMIN_OPENIDS） */
  isAdmin: boolean;
  /** 'mysql' | 'memory' | 'unavailable'（unavailable 時展示降級橫幅） */
  storage: string;
  requirement: string;
  sourceText: string;
  /** 補充教材輸入區展開態（預設收起，保持輕量） */
  sourceExpanded: boolean;
  /** 起草請求進行中（防重複提交） */
  forging: boolean;
  mine: DisplayRecord[];
  publicSkills: DisplayRecord[];
  reviewList: DisplayRecord[];
  connectors: Array<{ id: string; name: string; kind: string; description: string }>;
  /** 連接器名稱串（鍛造區提示行用） */
  connectorNames: string;
  [key: string]: unknown;
}

/** Page 內部 this 實例 */
interface SkillsCenterThis {
  data: SkillsCenterData;
  setData: (patch: Partial<SkillsCenterData>) => void;
  onLoad: (options: { intent?: string }) => void;
  onPullDownRefresh: () => Promise<void>;
  /** 拉取技能中心數據並分組渲染 */
  loadCenter: () => Promise<void>;
  onRequirementInput: (e: { detail: { value: string } }) => void;
  onSourceInput: (e: { detail: { value: string } }) => void;
  onToggleSource: () => void;
  /** 提交 AI 起草（提交前確認去敏語義，計劃紅線） */
  onForgeTap: () => Promise<void>;
  /** 審批台操作鍵（approve / reject / disable / enable；CAS 版本鎖） */
  onReviewTap: (e: { currentTarget?: { dataset?: { id?: string; decision?: string; version?: string } } }) => Promise<void>;
}

/* ============ 頁面 ============ */

Page({
  data: {
    loading: true,
    enabled: true,
    isAdmin: false,
    storage: 'mysql',
    requirement: '',
    sourceText: '',
    sourceExpanded: false,
    forging: false,
    mine: [],
    publicSkills: [],
    reviewList: [],
    connectors: [],
    connectorNames: '',
  } as SkillsCenterData,

  onLoad(this: SkillsCenterThis, options: { intent?: string }) {
    // 缺口卡「去技能中心起草」跳轉帶 intent：預填鍛造需求（缺口引導閉環）
    const intent = options?.intent ? decodeURIComponent(options.intent) : '';
    if (intent) this.setData({ requirement: intent.slice(0, 1200) });
    void this.loadCenter();
  },

  async onPullDownRefresh(this: SkillsCenterThis) {
    await this.loadCenter();
    wx.stopPullDownRefresh();
  },

  async loadCenter(this: SkillsCenterThis) {
    try {
      const res = await fetchSkillCenter(CLOUD_ENV);
      if (res.code === 0 && res.data) {
        const d = res.data;
        const groups = toGroups(d);
        this.setData({
          loading: false,
          enabled: d.enabled,
          isAdmin: d.isAdmin,
          storage: d.storage,
          ...groups,
        });
        logInfo(`技能中心已載入：我的提案 ${groups.mine.length}、公開技能 ${groups.publicSkills.length}、連接器 ${d.connectors.length}`);
      } else {
        this.setData({ loading: false });
        wx.showToast({ title: res.message ?? '技能中心載入失敗', icon: 'none' });
      }
    } catch (e) {
      logError('技能中心載入失敗', e);
      this.setData({ loading: false });
      wx.showToast({ title: '網路異常，請下拉重試', icon: 'none' });
    }
  },

  onRequirementInput(this: SkillsCenterThis, e: { detail: { value: string } }) {
    this.setData({ requirement: e.detail.value });
  },

  onSourceInput(this: SkillsCenterThis, e: { detail: { value: string } }) {
    this.setData({ sourceText: e.detail.value });
  },

  onToggleSource(this: SkillsCenterThis) {
    this.setData({ sourceExpanded: !this.data.sourceExpanded });
  },

  async onForgeTap(this: SkillsCenterThis) {
    if (this.data.forging) return;
    const requirement = this.data.requirement.trim();
    if (requirement.length < 4) {
      wx.showToast({ title: '請先描述需求（至少 4 字）', icon: 'none' });
      return;
    }
    // 提交前確認（計劃紅線：用戶確認去敏語義後才發送 forge——
    // 手機號 / 證件號等敏感信息由服務端自動遮罩後才存儲）
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '提交 AI 起草？',
        content: '需求將交給 AI 起草技能定義，起草完成後交管理員審批。手機號、證件號等敏感信息會先自動遮罩才存儲，不會原樣上傳。',
        confirmText: '提交起草',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    this.setData({ forging: true });
    const source = this.data.sourceText.trim();
    try {
      // requestId 為冪等鍵：同一鍵重複提交返回既有記錄（網路重試安全）
      const res = await forgeDynamicSkill(
        CLOUD_ENV,
        genRequestId(),
        requirement,
        source.length > 0 ? source : undefined,
      );
      if (res.code === 0 && res.data) {
        const { status, duplicate, record } = res.data;
        if (status === 'blocked') {
          wx.showModal({
            title: '未能起草',
            content: record.reason || '該需求涉及即時數據或安全限制，無法生成技能。請調整描述後再試。',
            showCancel: false,
          });
        } else if (duplicate) {
          wx.showToast({ title: '該需求此前已提交', icon: 'none' });
        } else {
          wx.showToast({ title: '已起草，待管理員審批', icon: 'none' });
        }
        await this.loadCenter();
      } else {
        // 業務碼：2001 未開放 / 2002 配額 / 2003 輸出非法 / 2004 存儲不可用
        wx.showToast({ title: res.message ?? '起草失敗，請稍後再試', icon: 'none' });
      }
    } catch (e) {
      logError('技能起草失敗', e);
      wx.showToast({ title: '網路異常，請稍後再試', icon: 'none' });
    } finally {
      this.setData({ forging: false });
    }
  },

  async onReviewTap(
    this: SkillsCenterThis,
    e: { currentTarget?: { dataset?: { id?: string; decision?: string; version?: string } } },
  ) {
    const id = e.currentTarget?.dataset?.id ?? '';
    const decision = e.currentTarget?.dataset?.decision ?? '';
    const version = Number(e.currentTarget?.dataset?.version ?? Number.NaN);
    const decisions: DynamicReviewDecision[] = ['approve', 'reject', 'disable', 'enable'];
    if (!id || !decisions.includes(decision as DynamicReviewDecision) || !Number.isFinite(version)) return;

    // 破壞性操作二次確認（disable / reject 影響他人已上架或待審技能）
    if (decision === 'disable' || decision === 'reject') {
      const confirmed = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: decision === 'disable' ? '停用該技能？' : '拒絕該提案？',
          content: decision === 'disable'
            ? '停用後所有用戶立即不可呼叫該技能（可重新上架）。'
            : '拒絕後提案人將看到已拒絕狀態（終態，不可再審）。',
          success: (r) => resolve(r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }

    try {
      const res = await reviewDynamicSkill(CLOUD_ENV, id, decision as DynamicReviewDecision, version, undefined);
      if (res.code === 0) {
        wx.showToast({ title: '已更新技能狀態', icon: 'none' });
      } else if (res.code === 2014) {
        // CAS 版本衝突：清單已被其他管理員變更，自動重新載入後由用戶重試
        wx.showToast({ title: '清單已變更，已重新載入', icon: 'none' });
      } else {
        wx.showToast({ title: res.message ?? '操作失敗，請重試', icon: 'none' });
      }
      await this.loadCenter();
    } catch (e) {
      logError('技能審批失敗', e);
      wx.showToast({ title: '網路異常，請稍後再試', icon: 'none' });
    }
  },
} as unknown as Parameters<typeof Page>[0]);
