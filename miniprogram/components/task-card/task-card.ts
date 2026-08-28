/**
 * 清單事項卡片：勾選、展開（去哪裡／帶什麼／時限／費用／⚠️注意）、認領人、查看詳情。
 * 對應 Agent.md「輸出格式」清單範例的每一項結構。
 */
import type { ChecklistTask } from '../../utils/checklist-generator';

interface InputLikeEvent {
  detail: { value: string };
}

Component({
  properties: {
    task: { type: Object, value: {} },
    done: { type: Boolean, value: false },
    claimer: { type: String, value: '' },
  },
  data: {
    expanded: false,
    editingClaim: false,
    claimInput: '',
  },
  methods: {
    onToggleExpand() {
      this.setData({ expanded: !this.data.expanded });
    },
    onToggleDone() {
      this.triggerEvent('toggle', { id: (this.data.task as ChecklistTask).id });
    },
    onDetail() {
      const task = this.data.task as ChecklistTask;
      this.triggerEvent('detail', { id: task.id, detailId: task.detailId || '' });
    },
    onEditClaim() {
      this.setData({ editingClaim: true, claimInput: this.data.claimer });
    },
    onClaimInput(e: InputLikeEvent) {
      this.setData({ claimInput: e.detail.value });
    },
    onClaimConfirm() {
      // confirm 與 blur 都會觸發，這裡做一次性防抖
      if (!this.data.editingClaim) {
        return;
      }
      const task = this.data.task as ChecklistTask;
      const name = this.data.claimInput.trim();
      this.setData({ editingClaim: false, claimInput: name });
      this.triggerEvent('claim', { id: task.id, name });
    },
  },
});
