/**
 * AI 接入配置 —— 前端直连智谱 GLM（OpenAI 兼容接口）
 * 使用说明：
 *  1. 在智谱开放平台 https://open.bigmodel.cn 创建 API Key
 *  2. 填入下方 API_KEY 即启用真实模型（流式输出）
 *  3. 留空则自动降级为内置 Mock 演示模式，无需 Key 即可体验全部交互流程
 *  4. 开发者工具中需勾选「不校验合法域名」；正式上线需在小程序后台
 *     将 open.bigmodel.cn 配置为 request 合法域名
 */
module.exports = {
  API_KEY: '',
  BASE_URL: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  MODEL: 'glm-4-flash',
  TEMPERATURE: 0.7,
  // 上下文窗口：携带最近 N 条消息，控制 token 消耗
  MAX_CONTEXT_MESSAGES: 20,
  // 流式渲染节流间隔（ms），避免高频 setData 卡顿
  RENDER_THROTTLE: 150
}
