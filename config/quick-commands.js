/**
 * 快捷指令（Prompt Templates）—— Agent.md 附录"开发者落地建议"落地
 * 每个指令预绑定意图与预填信息，降低幼师输入门槛；
 * 预设文案中涉及幼儿一律用"宝贝"代称，避免出现真实姓名（红线 6.1）
 */
module.exports = [
  {
    id: 'lesson-science',
    icon: '📝',
    label: '大班科学教案',
    tool: 'generate_lesson_plan',
    preset: '请帮我写一份【大班】【科学领域】的教案，主题是"神奇的影子"，活动时长约30分钟。'
  },
  {
    id: 'semester-comment',
    icon: '🌟',
    label: '帮我写期末评语',
    tool: 'generate_semester_comment',
    preset: '到期末了，请帮我写评语。我带的是【大班】，这位宝贝性格活泼、特别喜欢在建构区搭积木、很有创意，但集体教学活动中容易分心。请帮我写一段期末评语。'
  },
  {
    id: 'peer-conflict',
    icon: '💬',
    label: '孩子打架怎么跟家长说',
    tool: 'generate_parent_communication',
    preset: '今天班里两位宝贝因为争抢玩具发生了冲突，其中一位的小手臂被抓伤了（已第一时间消毒处理，保健老师也检查过）。请帮我写一段跟受伤宝贝家长的沟通话术，要共情、专业、有后续措施。'
  },
  {
    id: 'observation',
    icon: '👀',
    label: '写观察记录',
    tool: 'generate_observation_record',
    preset: '我想写一篇幼儿观察记录。我带的是【中班】，今天上午区角活动时，一位宝贝在建构区连续搭了20分钟积木，中途"塔"倒了两次，他没有哭也没有放弃，重新调整底座再搭，最后搭成了一座"高架桥"，还主动邀请同伴一起玩。请帮我生成专业的观察记录。'
  },
  {
    id: 'env-design',
    icon: '🎨',
    label: '环创灵感：废旧纸箱',
    tool: 'generate_env_design',
    preset: '我们班是【大班】，正在开展"我们的城市"主题活动，收集了很多废旧纸箱，请帮我设计环创方案和自制教玩具玩法。'
  },
  {
    id: 'separation-anxiety',
    icon: '🤗',
    label: '小班入园焦虑沟通',
    tool: 'generate_parent_communication',
    preset: '小班刚开学，有位宝贝入园焦虑比较严重，早上哭着不让妈妈走，家长很担心孩子在园的情况。请帮我写一段安抚家长的沟通话术。'
  }
]
