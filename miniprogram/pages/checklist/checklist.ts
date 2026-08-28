/**
 * 我的清單（Agent.md「流程二：生成個性化辦理清單」＋「示例3：家庭協作清單」）。
 * - 分時段展示，支持勾選（本地持久化）；
 * - 每項可填寫認領人，實現家庭分工；
 * - 一鍵複製純文本協作清單，粘貼到家庭群。
 */
import { STAGE_DEFS } from '../../utils/checklist-generator';
import type { ChecklistTask, GeneratedChecklist } from '../../utils/checklist-generator';
import { relationDisplay } from '../../utils/guidance-flow';
import { buildFamilyShareText, formatDateTime } from '../../utils/share-formatter';
import { copyText } from '../../services/clipboard';
import { toast } from '../../services/feedback';
import { goDetail, goGuide } from '../../services/navigation';
import { getChecklist, getChecklistState, saveChecklistState } from '../../services/storage';

interface TaskView extends ChecklistTask {
  done: boolean;
  claimer: string;
}

interface StageView {
  id: number;
  title: string;
  tasks: TaskView[];
}

interface EventDetail {
  id: string;
  name?: string;
  detailId?: string;
}

Page({
  data: {
    empty: true,
    stages: [] as StageView[],
    checklist: null as GeneratedChecklist | null,
    profileText: '',
    updatedText: '',
    progressText: '',
    progressPercent: 0,
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const checklist = getChecklist();
    if (!checklist) {
      this.setData({ empty: true, stages: [], checklist: null });
      return;
    }
    const state = getChecklistState();
    const all: ChecklistTask[] = [...checklist.tasks, ...state.customItems];
    const stages: StageView[] = STAGE_DEFS.map((def) => ({
      id: def.id,
      title: def.title,
      tasks: all
        .filter((t) => t.stage === def.id)
        .map((t) => ({
          ...t,
          done: !!state.done[t.id],
          claimer: state.claimers[t.id] || '',
        })),
    })).filter((s) => s.tasks.length > 0);

    const doneCount = all.filter((t) => state.done[t.id]).length;
    this.setData({
      empty: false,
      stages,
      checklist,
      profileText: `${relationDisplay(checklist.profile)} ｜ ${checklist.profile.city || '—'}`,
      updatedText: formatDateTime(checklist.generatedAt),
      progressText: `已完成 ${doneCount}／${all.length}`,
      progressPercent: all.length === 0 ? 0 : Math.round((doneCount / all.length) * 100),
    });
  },

  onTaskToggle(e: WechatMiniprogram.CustomEvent<EventDetail>) {
    const { id } = e.detail;
    const state = getChecklistState();
    state.done[id] = !state.done[id];
    saveChecklistState(state);
    this.refresh();
  },

  onTaskClaim(e: WechatMiniprogram.CustomEvent<EventDetail>) {
    const { id, name } = e.detail;
    const state = getChecklistState();
    if (name) {
      state.claimers[id] = name;
    } else {
      delete state.claimers[id];
    }
    saveChecklistState(state);
    this.refresh();
  },

  onTaskDetail(e: WechatMiniprogram.CustomEvent<EventDetail>) {
    const { detailId } = e.detail;
    if (detailId) {
      goDetail(detailId);
    } else {
      toast('該事項暫無單獨詳情，可撥打12345諮詢', 'none', 2200);
    }
  },

  onCopy() {
    const checklist = this.data.checklist;
    if (!checklist) {
      return;
    }
    const text = buildFamilyShareText(checklist, getChecklistState());
    copyText(text)
      .then(() => toast('已複製，可粘貼到家庭群'))
      .catch(() => toast('複製失敗，請重試', 'none'));
  },

  onEdit() {
    goGuide();
  },

  onGoGuide() {
    goGuide();
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return {
      title: '我們家的身後事協作清單，一起分工處理',
      path: '/pages/index/index',
    };
  },
});
