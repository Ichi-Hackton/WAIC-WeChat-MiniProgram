/**
 * Tools / Functions Schema —— 补全 Agent.md 第 5 节缺失的 JSON 工具定义
 * 对应文档 2.1~2.4 四大核心能力（其中 2.3 家园沟通拆分为"日常沟通"与"期末评语"两个工具）
 *
 * 用途：
 *  1. 随 chat/completions 请求下发（OpenAI 兼容 function calling），约束模型
 *     的意图识别与参数补全行为（缺必填参数时模型应先追问）
 *  2. 被 quick-commands.js 复用：每个快捷指令预绑定 tool 与预填参数
 *  3. 与 system-prompt.js 中的分场景模板一一对应
 */

const AGE_GROUP_ENUM = ['小班', '中班', '大班']
const DOMAIN_ENUM = ['健康', '语言', '社会', '科学', '艺术']

module.exports = [
  {
    type: 'function',
    function: {
      name: 'generate_lesson_plan',
      description: '生成符合规范的结构化幼儿园教案。所需关键信息（年龄段/领域/主题）缺失时应先向用户追问补全。',
      parameters: {
        type: 'object',
        properties: {
          age_group: {
            type: 'string',
            enum: AGE_GROUP_ENUM,
            description: '年龄段：小班(3-4岁)/中班(4-5岁)/大班(5-6岁)'
          },
          domain: {
            type: 'string',
            enum: DOMAIN_ENUM,
            description: '五大领域'
          },
          topic: {
            type: 'string',
            description: '活动主题，如"神奇的影子""秋天的树叶"'
          },
          duration: {
            type: 'number',
            description: '活动时长（分钟），小班默认15-20，中班默认20-25，大班默认25-30'
          }
        },
        required: ['age_group', 'domain', 'topic']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_observation_record',
      description: '将幼儿行为白描转化为专业观察记录（客观描述+专业分析+支持策略），自动对标《3-6岁儿童学习与发展指南》。',
      parameters: {
        type: 'object',
        properties: {
          behavior_description: {
            type: 'string',
            description: '幼儿行为的客观白描（不要包含幼儿真实姓名，用"宝贝"代称）'
          },
          age_group: {
            type: 'string',
            enum: AGE_GROUP_ENUM,
            description: '幼儿所在年龄段'
          },
          scene: {
            type: 'string',
            description: '观察场景，如"建构区""户外活动""午餐"'
          },
          observation_focus: {
            type: 'string',
            description: '期望重点分析的领域（可选），如"社会交往""科学探究"'
          }
        },
        required: ['behavior_description', 'age_group']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_parent_communication',
      description: '生成高情商家园沟通话术，采用"共情+事实+专业建议"三明治结构，提供多个语气版本供一键复制。',
      parameters: {
        type: 'object',
        properties: {
          scenario: {
            type: 'string',
            enum: ['磕碰受伤', '同伴冲突', '情绪问题', '饮食睡眠', '入园焦虑', '行为习惯', '学习表现', '其他'],
            description: '沟通场景'
          },
          incident_brief: {
            type: 'string',
            description: '事件简述（已发生的处理措施请一并提供）'
          },
          tone: {
            type: 'string',
            enum: ['专业严谨版', '温柔共情版', '简洁清晰版'],
            description: '期望的语气版本，默认同时提供2-3个版本'
          },
          age_group: {
            type: 'string',
            enum: AGE_GROUP_ENUM,
            description: '幼儿所在年龄段（可选）'
          }
        },
        required: ['scenario', 'incident_brief']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_semester_comment',
      description: '撰写期末幼儿评语，采用"具体行为描述+闪光点肯定+委婉期许"模式，拒绝标签化与空话套话。',
      parameters: {
        type: 'object',
        properties: {
          age_group: {
            type: 'string',
            enum: AGE_GROUP_ENUM,
            description: '幼儿所在年龄段'
          },
          child_traits: {
            type: 'string',
            description: '幼儿的性格与行为特点的具体描述（不要包含幼儿真实姓名）'
          },
          highlights: {
            type: 'string',
            description: '本学期的闪光点/进步表现，越具体越好'
          },
          expectations: {
            type: 'string',
            description: '期望委婉提及的改进方向（可选）'
          },
          style: {
            type: 'string',
            enum: ['温暖细腻', '活泼童趣', '正式规范'],
            description: '评语风格（可选），默认温暖细腻'
          }
        },
        required: ['age_group', 'child_traits', 'highlights']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_env_design',
      description: '提供环境创设方案或自制教玩具设计灵感，注重低结构材料与年龄适宜性，优先利用废旧材料。',
      parameters: {
        type: 'object',
        properties: {
          age_group: {
            type: 'string',
            enum: AGE_GROUP_ENUM,
            description: '幼儿所在年龄段'
          },
          theme: {
            type: 'string',
            description: '环创主题，如"我们的城市""春天来了"'
          },
          available_materials: {
            type: 'string',
            description: '现有材料清单，特别是废旧材料（纸箱、瓶罐、布料等）'
          },
          space_type: {
            type: 'string',
            enum: ['主题墙', '区角活动', '走廊过道', '自然角', '吊饰', '整体环创'],
            description: '环创空间类型（可选）'
          }
        },
        required: ['age_group', 'theme']
      }
    }
  }
]

/**
 * 能力标签映射：模型输出首行【能力：xxx】与历史记录分类的对应关系
 */
const CATEGORY_LABELS = {
  '教案生成': '教案',
  '观察记录': '观察',
  '家园沟通': '沟通',
  '期末评语': '评语',
  '环创设计': '环创'
}

module.exports.CATEGORY_LABELS = CATEGORY_LABELS
