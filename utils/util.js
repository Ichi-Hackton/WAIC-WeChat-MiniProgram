/**
 * 通用工具函数
 */

/** 格式化时间为 YYYY-MM-DD HH:mm */
function formatTime(date) {
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  )
}

/** 生成简易唯一 id */
function genId() {
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/** 防抖 */
function debounce(fn, wait) {
  let timer = null
  return function () {
    const args = arguments
    const ctx = this
    clearTimeout(timer)
    timer = setTimeout(() => fn.apply(ctx, args), wait)
  }
}

/** 从回复首行解析能力标签【能力：教案生成】→ '教案生成' */
function parseCategory(content) {
  if (!content) return null
  const m = String(content).match(/^【能力[:：]([^】]+)】/)
  return m ? m[1].trim() : null
}

module.exports = {
  formatTime,
  genId,
  debounce,
  parseCategory
}
