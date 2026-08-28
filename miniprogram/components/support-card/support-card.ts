/**
 * 心理支持卡片：危機場景下置於一切流程之上（Agent.md 緊急情況處理）。
 * 提供熱線一鍵撥打與陪伴建議。
 */
import { CRISIS_HOTLINES } from '../../knowledge';
import { callPhone } from '../../services/phone';

Component({
  data: {
    hotlines: CRISIS_HOTLINES,
  },
  methods: {
    onCall(e: WechatMiniprogram.TouchEvent) {
      const { number } = e.currentTarget.dataset as { number: string };
      callPhone(number);
    },
  },
});
