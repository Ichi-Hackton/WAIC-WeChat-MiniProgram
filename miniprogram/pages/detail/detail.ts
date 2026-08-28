/**
 * 事項詳情（Agent.md「流程四：單項深挖」）。
 * 展開：辦理地點、所需材料、時限、⚠️注意、費用參考、常見問題、聯繫電話，
 * 並提供「加入我的代辦清單」。數據來自 services/knowledge（RAG 對接預留）。
 */
import type { ProcedureDetail } from '../../knowledge';
import { fetchProcedureDetail } from '../../services/knowledge';
import { callPhone } from '../../services/phone';
import { toast } from '../../services/feedback';
import { getChecklist, getChecklistState, saveChecklistState } from '../../services/storage';

Page({
  data: {
    loading: true,
    notFound: false,
    detail: null as ProcedureDetail | null,
  },

  onLoad(options: Record<string, string | undefined>) {
    const id = options?.id || '';
    void this.load(id);
  },

  async load(id: string) {
    this.setData({ loading: true, notFound: false });
    try {
      const detail = await fetchProcedureDetail(id);
      if (!detail) {
        this.setData({ loading: false, notFound: true, detail: null });
        return;
      }
      this.setData({ loading: false, detail });
    } catch (_e) {
      this.setData({ loading: false, notFound: true });
      toast('加載失敗，請返回重試', 'none');
    }
  },

  onCall() {
    const detail = this.data.detail;
    if (detail) {
      callPhone(detail.contact.number);
    }
  },

  onAddToTodo() {
    const detail = this.data.detail;
    if (!detail) {
      return;
    }
    const checklist = getChecklist();
    if (!checklist) {
      toast('請先完成引導並生成清單', 'none', 2200);
      return;
    }
    const state = getChecklistState();
    state.customItems.push({
      id: `custom-${Date.now()}`,
      stage: 2,
      title: detail.title,
      detailId: detail.id,
    });
    saveChecklistState(state);
    toast('已加入我的清單');
  },

  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    return {
      title: '身後事導航助手｜一步一步，把該辦的事辦好',
      path: '/pages/index/index',
    };
  },
});
