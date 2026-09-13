// 历史详情页：完整渲染会话内容，支持复制全文与删除
const storageService = require('../../services/storage-service.js')

Page({
  data: {
    conversation: null,
    messages: []
  },

  onLoad(options) {
    const conv = storageService.getConversation(options.id)
    if (!conv || !conv.messages.length) {
      wx.showToast({ title: '记录不存在', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    this.conversationId = conv.id
    this.setData({ conversation: conv, messages: conv.messages })
    wx.setNavigationBarTitle({ title: conv.title || '对话详情' })
  },

  /** 一键复制整段会话 */
  onCopyAll() {
    const text = this.data.messages
      .map((m) => (m.role === 'user' ? '【老师】' : '【智多星】') + '\n' + m.content)
      .join('\n\n————————\n\n')
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制整段对话', icon: 'success' })
    })
  },

  onDelete() {
    wx.showActionSheet({
      itemList: ['删除这条记录'],
      itemColor: '#e64340',
      success: (res) => {
        if (res.tapIndex === 0) {
          storageService.deleteConversation(this.conversationId)
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 600)
        }
      }
    })
  }
})
