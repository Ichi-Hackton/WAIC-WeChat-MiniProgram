/**
 * 快捷選項：點選式回答（降低打字負擔——用戶在悲傷中難以輸入長文本）。
 */
Component({
  properties: {
    options: { type: Array, value: [] },
    disabled: { type: Boolean, value: false },
  },
  methods: {
    onPick(e: WechatMiniprogram.TouchEvent) {
      if (this.data.disabled) {
        return;
      }
      const { value, label } = e.currentTarget.dataset as { value: string; label: string };
      this.triggerEvent('select', { value, label });
    },
  },
});
