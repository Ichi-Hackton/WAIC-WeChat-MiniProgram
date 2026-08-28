/**
 * 首次使用隱私告知（Agent.md 隱私承諾：隱私政策需在首次使用時明確告知）。
 */
import { DISCLAIMER, PRIVACY_POINTS } from '../../knowledge';

Component({
  properties: {
    show: { type: Boolean, value: false },
  },
  data: {
    points: PRIVACY_POINTS,
    disclaimer: DISCLAIMER,
  },
  methods: {
    onAck() {
      this.triggerEvent('ack');
    },
  },
});
