/**
 * AI 流式服务 —— 前端直连智谱 GLM（OpenAI 兼容接口）
 *
 * 核心能力：
 *  1. 红线预检（safety-guard）：体罚/负面情绪本地拦截，医疗/隐私注入上下文
 *  2. 真流式：wx.request 开启 enableChunked，onChunkReceived 解析 SSE，
 *     处理 UTF-8 多字节跨 chunk 截断与 SSE 事件跨 chunk 截断
 *  3. Mock 降级：API_KEY 为空时走 mock-engine，无 Key 也能完整演示
 *
 * 返回统一句柄 { abort }，页面卸载/新对话时可中断
 */

const config = require('../config/ai-config.js')
const { SYSTEM_PROMPT } = require('../config/system-prompt.js')
const toolsSchema = require('../config/tools-schema.js')
const safetyGuard = require('../utils/safety-guard.js')
const mockEngine = require('./mock-engine.js')

/**
 * 流式对话
 * @param {Object} options
 * @param {Array}  options.messages        [{role:'user'|'assistant', content}]
 * @param {Function} options.onDelta       (chunk, fullText) 增量回调
 * @param {Function} options.onDone        (fullText) 完成回调
 * @param {Function} [options.onError]     ({message}) 错误回调
 * @returns {{abort: Function}}
 */
function streamChat({ messages, onDelta, onDone, onError }) {
  // ---- 1. 红线预检（第一道防线）----
  const lastUser = [...(messages || [])].reverse().find((m) => m.role === 'user')
  const verdict = safetyGuard.inspect(lastUser ? lastUser.content : '')

  if (verdict.action === 'block') {
    // 体罚/强烈负面情绪：本地安抚话术直接响应，不请求模型（红线 6.2）
    return mockStreamText(verdict.localReply, { onDelta, onDone })
  }

  // ---- 2. Mock 降级（无 API_KEY）----
  if (!config.API_KEY) {
    return mockEngine.respond(messages || [], verdict.injections, { onDelta, onDone, onError })
  }

  // ---- 3. 真实流式请求 ----
  const reqMessages = buildRequestMessages(messages, verdict.injections)
  return realStream(reqMessages, { onDelta, onDone, onError })
}

/** 组装请求消息：system 提示词（+ 红线注入指令）+ 截断后的历史消息 */
function buildRequestMessages(messages, injections) {
  const sys = {
    role: 'system',
    content: SYSTEM_PROMPT +
      (injections && injections.length
        ? '\n\n' + injections.map((i) => i.instruction).join('\n')
        : '')
  }
  const history = (messages || [])
    .filter((m) => m.content)
    .slice(-config.MAX_CONTEXT_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }))
  return [sys, ...history]
}

/* ==================== 真实流式（SSE over enableChunked） ==================== */

function realStream(reqMessages, { onDelta, onDone, onError }) {
  let byteRest = null      // 尾部不完整 UTF-8 字节
  let sseBuffer = ''       // 尾部不完整 SSE 行
  let full = ''
  let finished = false

  const finish = () => {
    if (finished) return
    finished = true
    onDone && onDone(full)
  }

  const fail = (message) => {
    if (finished) return
    finished = true
    onError && onError({ message })
  }

  const task = wx.request({
    url: config.BASE_URL,
    method: 'POST',
    enableChunked: true,
    timeout: 180000,
    header: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + config.API_KEY
    },
    data: {
      model: config.MODEL,
      messages: reqMessages,
      stream: true,
      temperature: config.TEMPERATURE,
      tools: toolsSchema,
      tool_choice: 'auto'
    },
    success: (res) => {
      if (res.statusCode === 200) {
        finish() // 服务端已结束（可能未发 [DONE]）
      } else {
        fail(interpretHttpError(res.statusCode))
      }
    },
    fail: () => {
      fail('网络连接失败，请检查网络或稍后重试')
    }
  })

  task.onChunkReceived((res) => {
    if (finished) return
    // 1) 拼接残留字节，整体解码 UTF-8（处理多字节跨 chunk 截断）
    const incoming = new Uint8Array(res.data)
    let merged
    if (byteRest) {
      merged = new Uint8Array(byteRest.length + incoming.length)
      merged.set(byteRest)
      merged.set(incoming, byteRest.length)
    } else {
      merged = incoming
    }
    const decoded = decodeUtf8(merged)
    byteRest = decoded.remaining
    sseBuffer += decoded.text

    // 2) 按行解析 SSE（最后一行可能不完整，留在缓冲区）
    const lines = sseBuffer.split('\n')
    sseBuffer = lines.pop() || ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        finish()
        return
      }
      try {
        const json = JSON.parse(payload)
        const delta = json.choices && json.choices[0] && json.choices[0].delta
        if (delta && delta.content) {
          full += delta.content
          onDelta && onDelta(delta.content, full)
        }
      } catch (e) {
        // 半行 JSON 或心跳行，忽略，等待后续 chunk 补全
      }
    }
  })

  return {
    abort() {
      finished = true
      try { task.abort() } catch (e) { /* 已结束则忽略 */ }
    }
  }
}

/** UTF-8 ArrayBuffer → string，返回 { text, remaining(Uint8Array|null) } */
function decodeUtf8(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i += 1
    } else if (b < 0xe0) {
      if (i + 1 >= bytes.length) break // 尾部不完整
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
      i += 2
    } else if (b < 0xf0) {
      if (i + 2 >= bytes.length) break
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f))
      i += 3
    } else {
      if (i + 3 >= bytes.length) break
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)
      const offset = cp - 0x10000
      out += String.fromCharCode(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff))
      i += 4
    }
  }
  return { text: out, remaining: i < bytes.length ? bytes.slice(i) : null }
}

function interpretHttpError(statusCode) {
  switch (statusCode) {
    case 401: return 'API Key 无效或已过期，请检查 config/ai-config.js 中的 API_KEY'
    case 403: return '无权限访问该模型，请确认智谱账户状态'
    case 429: return '请求太频繁啦，请稍等几秒再试'
    default: return '模型服务暂时不可用（HTTP ' + statusCode + '），请稍后重试'
  }
}

/* ==================== 本地文本模拟流式（红线拦截响应复用） ==================== */

function mockStreamText(text, { onDelta, onDone }) {
  let idx = 0
  const timer = setInterval(() => {
    if (idx >= text.length) {
      clearInterval(timer)
      onDone && onDone(text)
      return
    }
    const end = Math.min(idx + 3, text.length)
    onDelta && onDelta(text.slice(idx, end), text.slice(0, end))
    idx = end
  }, 40)
  return { abort() { clearInterval(timer) } }
}

module.exports = {
  streamChat
}
