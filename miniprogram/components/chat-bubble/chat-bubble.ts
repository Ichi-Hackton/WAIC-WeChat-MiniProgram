/**
 * 對話氣泡：agent（左，暖白底）／user（右，主色底）。
 * 危機消息（kind=crisis）使用更柔和的底色。
 */
Component({
  properties: {
    role: { type: String, value: 'agent' },
    text: { type: String, value: '' },
    kind: { type: String, value: 'normal' },
  },
});
