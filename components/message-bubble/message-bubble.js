// 消息气泡组件：用户消息纯文本 / 助手消息 Markdown 渲染 + 复制
// 流式期间（typing=true）显示纯文本+闪烁光标，完成后切换 rich-text 渲染，
// 兼顾性能与视觉效果
const markdownParser = require('../../utils/markdown-parser.js')

Component({
  properties: {
    // { id, role: 'user'|'assistant', content, ts }
    message: { type: Object, value: {} },
    // 是否正在流式输出（仅对最后一条 assistant 消息生效）
    typing: { type: Boolean, value: false }
  },

  data: {
    nodes: [],      // rich-text nodes（完成后渲染）
    codeBlock: ''   // 首个代码块内容（供"复制话术"）
  },

  observers: {
    'message.content, typing': function (content, typing) {
      const role = this.data.message.role
      if (role !== 'assistant') return
      if (typing) return // 流式中不解析，完成后再渲染 Markdown
      const md = String(content || '')
      const blocks = markdownParser.extractCodeBlocks(md)
      this.setData({
        nodes: markdownParser.parse(md),
        codeBlock: blocks[0] || ''
      })
    }
  },

  methods: {
    onCopyAll() {
      wx.setClipboardData({
        data: String(this.data.message.content || ''),
        success: () => wx.showToast({ title: '已复制全文', icon: 'success' })
      })
    },
    onCopyCode() {
      wx.setClipboardData({
        data: this.data.codeBlock,
        success: () => wx.showToast({ title: '话术已复制', icon: 'success' })
      })
    }
  }
})
