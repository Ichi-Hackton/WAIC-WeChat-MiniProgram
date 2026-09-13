// 历史记录列表页：本地缓存会话，支持查看详情与删除
const storageService = require('../../services/storage-service.js')

Page({
  data: {
    conversations: []
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    this.setData({ conversations: storageService.listConversations() })
  },

  onOpen(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/history-detail/history-detail?id=' + id })
  },

  /** 长按卡片 → 删除确认 */
  onLongPress(e) {
    const id = e.currentTarget.dataset.id
    wx.showActionSheet({
      itemList: ['删除这条记录'],
      itemColor: '#e64340',
      success: (res) => {
        if (res.tapIndex === 0) {
          storageService.deleteConversation(id)
          this.refresh()
          wx.showToast({ title: '已删除', icon: 'success' })
        }
      }
    })
  },

  /** 引导新建对话 */
  onGoChat() {
    wx.switchTab({ url: '/pages/index/index' })
  }
})
