/**
 * 历史记录本地缓存服务 —— Agent.md 附录"本地缓存与历史记录"落地
 * 幼师生成的教案和评语是重要资产，通过 wx.setStorageSync 本地持久化，
 * 方便随时在"历史记录"中找回并复制
 *
 * 存储结构：
 *   kc_conversations = [ Conversation ]
 *   Conversation = {
 *     id: string,
 *     title: string,          // 首条用户消息前 20 字
 *     category: string,       // 能力分类（教案/观察/沟通/评语/环创），可空
 *     createdAt: 'YYYY-MM-DD HH:mm',
 *     updatedAt: 'YYYY-MM-DD HH:mm',
 *     messages: [{ id, role, content, ts }]
 *   }
 */

const KEY = 'kc_conversations'
const CURRENT_KEY = 'kc_current_id'
const { formatTime, genId } = require('../utils/util.js')

/** 全部会话列表（按更新时间倒序） */
function listConversations() {
  const list = wx.getStorageSync(KEY) || []
  return list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

/** 按 id 获取会话 */
function getConversation(id) {
  return (wx.getStorageSync(KEY) || []).find((c) => c.id === id) || null
}

/** 新建会话对象（不落盘） */
function createConversation() {
  const now = formatTime(new Date())
  return { id: genId(), title: '', category: '', createdAt: now, updatedAt: now, messages: [] }
}

/** 保存/更新会话：自动补标题、更新时间 */
function saveConversation(conv) {
  if (!conv || !conv.id) return conv
  conv.updatedAt = formatTime(new Date())
  if (!conv.title) {
    const firstUser = (conv.messages || []).find((m) => m.role === 'user')
    if (firstUser) conv.title = firstUser.content.slice(0, 20)
  }
  const list = wx.getStorageSync(KEY) || []
  const idx = list.findIndex((c) => c.id === conv.id)
  if (idx >= 0) list[idx] = conv
  else list.unshift(conv)
  wx.setStorageSync(KEY, list)
  return conv
}

/** 删除会话；若删除的是当前会话则同时清除指针 */
function deleteConversation(id) {
  wx.setStorageSync(KEY, (wx.getStorageSync(KEY) || []).filter((c) => c.id !== id))
  if (getCurrentId() === id) wx.removeStorageSync(CURRENT_KEY)
}

/** 当前会话指针（切换 tab / 重进小程序后恢复现场） */
function setCurrentId(id) {
  wx.setStorageSync(CURRENT_KEY, id)
}
function getCurrentId() {
  return wx.getStorageSync(CURRENT_KEY) || null
}

module.exports = {
  listConversations,
  getConversation,
  createConversation,
  saveConversation,
  deleteConversation,
  setCurrentId,
  getCurrentId
}
