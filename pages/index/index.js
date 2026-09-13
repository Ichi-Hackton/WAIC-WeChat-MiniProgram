// 主聊天页：欢迎语注入、快捷指令、流式打字机、节流渲染、会话自动落盘
const aiService = require('../../services/ai-service.js')
const storageService = require('../../services/storage-service.js')
const { WELCOME_MESSAGE } = require('../../config/system-prompt.js')
const { CATEGORY_LABELS } = require('../../config/tools-schema.js')
const aiConfig = require('../../config/ai-config.js')
const quickCommands = require('../../config/quick-commands.js')
const loadingTips = require('../../config/loading-tips.js')
const { genId, parseCategory } = require('../../utils/util.js')

Page({
  data: {
    messages: [],          // [{ id, role, content, ts }]
    inputValue: '',
    typing: false,         // 是否正在流式输出
    loadingTip: '',        // 幼教场景加载提示语（轮播）
    quickCommands,
    showQuickGrid: true,   // 新会话首屏显示 2x3 快捷指令宫格
    scrollIntoView: ''
  },

  onLoad() {
    this.currentStream = null
    this.conversation = null
    this._pendingFull = ''
    this._throttleTimer = null
    this._tipTimer = null
    this.initConversation()
  },

  onUnload() {
    this.abortCurrent()
  },

  onHide() {
    // 切到历史 tab 时停止提示语轮播，流式继续后台接收
    this.stopLoadingTips()
  },

  /* ==================== 会话管理 ==================== */

  initConversation() {
    const curId = storageService.getCurrentId()
    let conv = curId ? storageService.getConversation(curId) : null
    if (!conv) conv = this.createNewConversation(false)
    this.conversation = conv
    storageService.setCurrentId(conv.id)
    // 无正式消息的新会话：注入欢迎语（Agent.md 第 8 节，仅展示不落盘）
    const messages = conv.messages.length
      ? conv.messages
      : [this.welcomeMessage()]
    this.setData({
      messages,
      showQuickGrid: conv.messages.length === 0
    })
    this.scrollToBottom()
  },

  createNewConversation(persistPointer) {
    const conv = storageService.createConversation()
    this.conversation = conv
    if (persistPointer !== false) storageService.setCurrentId(conv.id)
    return conv
  },

  welcomeMessage() {
    return { id: genId(), role: 'assistant', content: WELCOME_MESSAGE, ts: Date.now() }
  },

  onNewChat() {
    this.abortCurrent()
    this.createNewConversation(true)
    this.setData({
      messages: [this.welcomeMessage()],
      inputValue: '',
      typing: false,
      showQuickGrid: true
    })
  },

  /** 消息写入会话并落盘（欢迎语不落盘，避免历史列表出现空会话） */
  persist(msg) {
    if (!this.conversation) return
    const list = this.conversation.messages
    const idx = list.findIndex((m) => m.id === msg.id)
    if (idx >= 0) list[idx] = msg
    else list.push(msg)
    storageService.saveConversation(this.conversation)
  },

  /* ==================== 输入与发送 ==================== */

  onInput(e) {
    this.setData({ inputValue: e.detail.value })
  },

  onSend() {
    const content = (this.data.inputValue || '').trim()
    if (!content || this.data.typing) return
    this.setData({ inputValue: '' })
    this.send(content)
  },

  onQuickCommand(e) {
    if (this.data.typing) return
    const preset = e.currentTarget.dataset.preset
    if (preset) this.send(preset)
  },

  onMic() {
    wx.showToast({ title: '语音输入即将上线，敬请期待', icon: 'none' })
  },

  send(content) {
    const userMsg = { id: genId(), role: 'user', content, ts: Date.now() }
    const aiMsg = { id: genId(), role: 'assistant', content: '', ts: Date.now() }
    const messages = this.data.messages.concat([userMsg, aiMsg])
    this.setData({ messages, typing: true, showQuickGrid: false })
    this.scrollToBottom()
    this.persist(userMsg)

    this.startLoadingTips()

    // 组装模型上下文：剔除欢迎语首条，限制窗口长度
    const reqMessages = messages
      .filter((m) => m.content)
      .filter((m) => !(m.role === 'assistant' && m.content === WELCOME_MESSAGE))
      .map((m) => ({ role: m.role, content: m.content }))
      .slice(-aiConfig.MAX_CONTEXT_MESSAGES)

    this.currentStream = aiService.streamChat({
      messages: reqMessages,
      onDelta: (chunk, full) => this.throttledUpdate(aiMsg.id, full),
      onDone: (full) => this.finishStream(aiMsg.id, full || '（没有收到内容，请重试）'),
      onError: (err) => this.finishStream(aiMsg.id, '⚠️ ' + ((err && err.message) || '出错了，请稍后重试'))
    })
  },

  /* ==================== 流式渲染（节流） ==================== */

  throttledUpdate(id, full) {
    this._pendingFull = full
    if (this._throttleTimer) return
    this._throttleTimer = setTimeout(() => {
      this._throttleTimer = null
      this.updateMessage(id, this._pendingFull)
    }, aiConfig.RENDER_THROTTLE)
  },

  updateMessage(id, content) {
    const messages = this.data.messages.map((m) => (m.id === id ? { ...m, content } : m))
    this.setData({ messages })
    this.scrollToBottom()
  },

  finishStream(id, content) {
    if (this._throttleTimer) {
      clearTimeout(this._throttleTimer)
      this._throttleTimer = null
    }
    this.updateMessage(id, content)
    this.setData({ typing: false })
    this.stopLoadingTips()

    // 解析能力标签 → 会话分类（历史记录展示用）
    if (this.conversation) {
      const cat = parseCategory(content)
      if (cat && CATEGORY_LABELS[cat]) this.conversation.category = CATEGORY_LABELS[cat]
    }
    this.persist({ id, role: 'assistant', content, ts: Date.now() })
  },

  abortCurrent() {
    if (this.currentStream) {
      this.currentStream.abort()
      this.currentStream = null
    }
    if (this._throttleTimer) {
      clearTimeout(this._throttleTimer)
      this._throttleTimer = null
    }
    this.stopLoadingTips()
  },

  /* ==================== 加载提示语轮播 ==================== */

  startLoadingTips() {
    let i = 0
    this.setData({ loadingTip: loadingTips[0] })
    this._tipTimer = setInterval(() => {
      i = (i + 1) % loadingTips.length
      this.setData({ loadingTip: loadingTips[i] })
    }, 2500)
  },

  stopLoadingTips() {
    if (this._tipTimer) {
      clearInterval(this._tipTimer)
      this._tipTimer = null
    }
  },

  scrollToBottom() {
    const last = this.data.messages[this.data.messages.length - 1]
    if (last) this.setData({ scrollIntoView: 'msg-' + last.id })
  }
})
