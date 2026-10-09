# Orchestrator编排器

<cite>
**本文引用的文件**   
- [orchestrator.ts](file://miniprogram/src/core/orchestrator.ts)
- [scheduler.ts](file://miniprogram/src/core/scheduler.ts)
- [agent-state.d.ts](file://miniprogram/src/types/agent-state.d.ts)
- [plan.d.ts](file://miniprogram/src/types/plan.d.ts)
- [task.d.ts](file://miniprogram/src/types/task.d.ts)
- [checkpoint.d.ts](file://miniprogram/src/types/checkpoint.d.ts)
</cite>

## 更新摘要
**已进行的变更**   
- 更新了执行令牌系统从实例级 runToken 到模块级 ACTIVE_RUNS 的架构变更
- 增强了跨实例稳定性和重置接管机制的说明
- 添加了失败检测能力的详细解释
- 更新了相关流程图和架构图以反映新的令牌管理机制

## 目录
1. [引言](#引言)
2. [项目结构](#项目结构)
3. [核心组件](#核心组件)
4. [架构总览](#架构总览)
5. [详细组件分析](#详细组件分析)
6. [依赖关系分析](#依赖关系分析)
7. [性能与并发特性](#性能与并发特性)
8. [故障排查指南](#故障排查指南)
9. [结论](#结论)
10. [附录：使用示例与扩展指南](#附录使用示例与扩展指南)

## 引言
本技术文档围绕 Orchestrator 编排器展开，系统性解释其状态机设计、意图理解到计划确认再到任务执行的完整流程、**升级后的模块级 ACTIVE_RUNS 令牌机制**防止并发冲突与死锁的原理、回滚逻辑的可逆任务识别与反序撤销策略，以及错误处理与异常恢复。同时提供面向开发者的扩展方法与最佳实践，帮助在保持系统稳定性的前提下扩展自定义状态和行为。

**重要更新**：执行令牌系统已从实例级的 runToken 升级到模块级的 ACTIVE_RUNS，提供了跨实例稳定性、重置接管能力和失败检测功能。

## 项目结构
Orchestrator 位于 miniprogram/src/core 目录，配合 scheduler、类型定义与技能适配器共同构成编排与调度体系。关键文件职责如下：
- orchestrator.ts：编排器主类，负责状态机、意图理解、计划确认、执行协调与结果聚合。
- scheduler.ts：DAG 调度器，负责任务就绪判断、并行执行、人类确认序列化、死锁检测与级联跳过。
- agent-state.d.ts：AgentState 状态机类型与对外响应卡片类型。
- plan.d.ts：Plan 生命周期与数据结构。
- task.d.ts：Task 生命周期、输入绑定与依赖关系。
- checkpoint.d.ts：Checkpoint 交互协议类型定义。

```mermaid
graph TB
subgraph "核心层"
O["Orchestrator<br/>状态机与编排"]
S["Scheduler<br/>DAG调度器"]
A["ACTIVE_RUNS<br/>模块级运行注册表"]
end
subgraph "类型定义"
T1["AgentState<br/>状态类型"]
T2["Plan<br/>计划结构"]
T3["Task<br/>任务结构"]
T4["Checkpoint<br/>交互协议"]
end
O --> S
O --> A
O --> T1
O --> T2
O --> T3
O --> T4
S --> T2
S --> T3
S --> T4
```

**图表来源**
- [orchestrator.ts:1-376](file://miniprogram/src/core/orchestrator.ts#L1-L376)
- [scheduler.ts:1-249](file://miniprogram/src/core/scheduler.ts#L1-L249)
- [agent-state.d.ts:1-47](file://miniprogram/src/types/agent-state.d.ts#L1-L47)
- [plan.d.ts:1-51](file://miniprogram/src/types/plan.d.ts#L1-L51)
- [task.d.ts:1-59](file://miniprogram/src/types/task.d.ts#L1-L59)
- [checkpoint.d.ts:1-44](file://miniprogram/src/types/checkpoint.d.ts#L1-L44)

## 核心组件
- **Orchestrator**：对外入口 handle(intent, ctx) → AgentResponse；内部维护 state、currentPlan、options（confirmPlan、checkpoint、autoConfirm、autoApproveCheckpoint、onTaskUpdate、onPlanUpdate、onStateChange）以及模块级 ACTIVE_RUNS 令牌管理。
- **Scheduler**：run(plan, ctx, options) 实现 DAG 调度，包含 checkpoint 序列化、isRunActive 令牌探测、死锁检测与级联跳过。
- **ACTIVE_RUNS**：模块级 Set<number> 运行注册表，提供跨实例稳定性、重置接管和失败检测能力。
- **类型定义**：AgentState、Plan、Task、CheckpointInput 明确状态机与数据流边界。

**章节来源**
- [orchestrator.ts:28-48](file://miniprogram/src/core/orchestrator.ts#L28-L48)
- [orchestrator.ts:73-88](file://miniprogram/src/core/orchestrator.ts#L73-L88)
- [scheduler.ts:27-44](file://miniprogram/src/core/scheduler.ts#L27-L44)
- [agent-state.d.ts:7-17](file://miniprogram/src/types/agent-state.d.ts#L7-L17)
- [plan.d.ts:11-33](file://miniprogram/src/types/plan.d.ts#L11-L33)
- [task.d.ts:11-59](file://miniprogram/src/types/task.d.ts#L11-L59)
- [checkpoint.d.ts:17-44](file://miniprogram/src/types/checkpoint.d.ts#L17-L44)

## 架构总览
Orchestrator 作为编排中枢，串联意图理解、LLM 规划、用户确认、任务调度与结果聚合。Scheduler 负责将 Plan 中的 Task 按依赖关系并行执行，并在需要时通过 checkpoint 进行人类确认。**新增的模块级 ACTIVE_RUNS 机制确保跨实例的稳定性和可靠性**。

```mermaid
sequenceDiagram
participant U as "调用方"
participant O as "Orchestrator"
participant A as "ACTIVE_RUNS<br/>模块级注册表"
participant LLM as "LLM客户端"
participant UI as "交互层(confirmPlan/checkpoint)"
participant S as "Scheduler"
participant SK as "技能适配器"
U->>O : handle(intent)
O->>A : 注册新令牌 (RUN_SEQ++)
O->>O : transition("understanding")
O->>LLM : understand(intent, ctx)
LLM-->>O : clarify或意图对象
alt 需澄清
O->>O : transition("idle")
O-->>U : 返回clarify消息
else 进入规划
O->>O : transition("planning")
O->>LLM : llmPlan(intent, ctx, skills)
LLM-->>O : Plan(tasks)
O->>UI : confirmPlan({intent,tasks,ctx})
UI-->>O : 确认/取消
alt 取消
O->>O : transition("idle")
O-->>U : 返回取消消息
else 已确认
O->>O : transition("executing")
O->>S : run(plan, ctx, {checkpoint,onTaskUpdate,isRunActive})
S->>SK : invoke(task.skillId, action, input, ctx)
SK-->>S : result
S-->>O : finalPlan
O->>O : transition("aggregating")
O->>LLM : aggregate(finalPlan)
O->>O : transition("completed")
O-->>U : 返回完成消息
end
end
```

**图表来源**
- [orchestrator.ts:119-256](file://miniprogram/src/core/orchestrator.ts#L119-L256)
- [orchestrator.ts:129-134](file://miniprogram/src/core/orchestrator.ts#L129-L134)
- [scheduler.ts:77-131](file://miniprogram/src/core/scheduler.ts#L77-L131)

## 详细组件分析

### 状态机设计与 ALLOWED_TRANSITIONS
- 状态集合：idle、understanding、planning、confirming_plan、executing、awaiting_human、aggregating、rolling_back、completed、failed。
- 允许转移表 ALLOWED_TRANSITIONS 定义了每个状态的合法下一状态，确保状态机时序正确。
- transition(next) 方法会检查当前状态是否允许转移到 next，非法转移仅告警不中断（MVP宽松模式），并触发 onStateChange 回调用于 UI 提示。

```mermaid
stateDiagram-v2
[*] --> idle
idle --> understanding : "handle开始"
understanding --> planning : "意图可解析"
understanding --> idle : "clarify提前返回"
planning --> confirming_plan : "生成非空Plan"
planning --> idle : "EMPTY_PLAN提前返回"
confirming_plan --> executing : "用户确认"
confirming_plan --> idle : "用户取消"
executing --> awaiting_human : "任务waiting_human"
awaiting_human --> executing : "用户确认后继续"
executing --> aggregating : "全部成功"
executing --> rolling_back : "失败需回滚"
rolling_back --> failed : "回滚完成"
rolling_back --> completed : "回滚后完成(可选)"
aggregating --> completed : "聚合完成"
completed --> idle : "reset或新轮次"
failed --> idle : "reset或新轮次"
```

**图表来源**
- [orchestrator.ts:60-71](file://miniprogram/src/core/orchestrator.ts#L60-L71)
- [orchestrator.ts:356-364](file://miniprogram/src/core/orchestrator.ts#L356-L364)
- [agent-state.d.ts:7-17](file://miniprogram/src/types/agent-state.d.ts#L7-L17)

**章节来源**
- [orchestrator.ts:60-71](file://miniprogram/src/core/orchestrator.ts#L60-L71)
- [orchestrator.ts:356-364](file://miniprogram/src/core/orchestrator.ts#L356-L364)
- [agent-state.d.ts:7-17](file://miniprogram/src/types/agent-state.d.ts#L7-L17)

### handle方法的完整执行流程
handle(intent) 是 Orchestrator 的对外入口，执行阶段如下：
1. BUSY守卫：若当前状态不是 idle/completed/failed，直接返回 BUSY 错误码。
2. **模块级令牌分配**：token = ++RUN_SEQ，并将 token 注册到 ACTIVE_RUNS 集合中。
3. 状态归位：若处于 completed/failed，先合法转回 idle。
4. 意图理解：transition("understanding")，调用 understand(intent, ctx)。
   - 若返回 clarify：transition("idle") 并返回澄清消息。
5. 计划生成：transition("planning")，调用 llmPlan(intent, ctx, SkillRegistry.listSlim())。
   - 若 tasks 为空：transition("idle") 并返回 EMPTY_PLAN 错误码。
6. 计划确认：transition("confirming_plan")，构造 planCards 并通过 confirmPlan 回调请求用户确认。
   - 若取消：transition("idle") 并返回取消消息。
7. 任务执行：transition("executing")，调用 runScheduler(plan, ctx, {checkpoint, onTaskUpdate, isRunActive})。
   - **isRunActive 现在基于 ACTIVE_RUNS.has(token) 检查**。
   - 若被 reset（ACTIVE_RUNS.clear()）：返回 RUN_RESET 错误码。
8. 结果聚合：若 finalPlan.status === 'failed'，则 rollbackIfNeeded 并 transition("failed")；否则 transition("aggregating")，调用 llmAggregate 并 transition("completed")。
9. 异常处理：捕获异常，根据 PlannerLLMError 与 SchedulerDeadlockError 分别处理，必要时先回滚再进入 failed。

```mermaid
flowchart TD
Start(["handle入口"]) --> BusyCheck{"BUSY守卫"}
BusyCheck --> |否| TokenAssign["RUN_SEQ++<br/>ACTIVE_RUNS.add(token)"]
BusyCheck --> |是| ReturnBusy["返回BUSY"]
TokenAssign --> ResetState["completed/failed→idle"]
ResetState --> Understand["transition('understanding')<br/>understand(intent,ctx)"]
Understand --> Clarify{"clarify?"}
Clarify --> |是| IdleReturn["transition('idle')<br/>返回澄清消息"]
Clarify --> |否| Plan["transition('planning')<br/>llmPlan(...)"]
Plan --> EmptyPlan{"tasks为空?"}
EmptyPlan --> |是| IdleReturn2["transition('idle')<br/>返回EMPTY_PLAN"]
EmptyPlan --> |否| Confirm["transition('confirming_plan')<br/>confirmPlan()"]
Confirm --> Cancelled{"用户取消?"}
Cancelled --> |是| IdleReturn3["transition('idle')<br/>返回取消消息"]
Cancelled --> |否| Execute["transition('executing')<br/>runScheduler(...)"]
Execute --> CheckActive{"ACTIVE_RUNS.has(token)?"}
CheckActive --> |否| ReturnReset["返回RUN_RESET"]
CheckActive --> |是| Aggregate{"finalPlan.failed?"}
Aggregate --> |是| Rollback["rollbackIfNeeded()<br/>transition('failed')"]
Aggregate --> |否| Agg["transition('aggregating')<br/>llmAggregate()<br/>transition('completed')"]
Rollback --> End(["结束"])
Agg --> End
ReturnBusy --> End
IdleReturn --> End
IdleReturn2 --> End
IdleReturn3 --> End
ReturnReset --> End
```

**图表来源**
- [orchestrator.ts:119-256](file://miniprogram/src/core/orchestrator.ts#L119-L256)
- [orchestrator.ts:129-134](file://miniprogram/src/core/orchestrator.ts#L129-L134)
- [orchestrator.ts:208-216](file://miniprogram/src/core/orchestrator.ts#L208-L216)

**章节来源**
- [orchestrator.ts:119-256](file://miniprogram/src/core/orchestrator.ts#L119-L256)

### 升级的执行令牌机制：模块级 ACTIVE_RUNS
**重大架构变更**：执行令牌系统已从实例级的 runToken 升级到模块级的 ACTIVE_RUNS，提供了更强的稳定性和可靠性。

#### 核心设计原理
- **模块级注册表**：ACTIVE_RUNS = new Set<number>() 存储当前有效的执行令牌。
- **令牌分配**：每次 handle() 递增 RUN_SEQ 并注册到 ACTIVE_RUNS。
- **跨实例稳定性**：闭包捕获原始 token 值，不受实例重建影响。
- **重置接管**：reset() 调用 ACTIVE_RUNS.clear() 使所有旧令牌失效。
- **失败检测**：isRunActive() 检查 ACTIVE_RUNS.has(token)，提供实时有效性验证。

#### 令牌生命周期管理
```mermaid
sequenceDiagram
participant H as "handle()"
participant A as "ACTIVE_RUNS"
participant R as "reset()"
participant S as "Scheduler"
H->>A : RUN_SEQ++, add(token)
Note over H,A : 新轮次开始
H->>S : 传入 isRunActive()
loop 调度循环
S->>A : has(token)?
alt 有效
S->>S : 继续执行
else 无效(reset或新轮)
S->>S : abortRun()
end
end
R->>A : clear()
Note over R,A : 所有令牌失效
```

**图表来源**
- [orchestrator.ts:73-88](file://miniprogram/src/core/orchestrator.ts#L73-L88)
- [orchestrator.ts:129-134](file://miniprogram/src/core/orchestrator.ts#L129-L134)
- [orchestrator.ts:208-216](file://miniprogram/src/core/orchestrator.ts#L208-L216)
- [orchestrator.ts:293-306](file://miniprogram/src/core/orchestrator.ts#L293-L306)
- [scheduler.ts:87-93](file://miniprogram/src/core/scheduler.ts#L87-L93)

#### 优势对比
| 特性 | 旧版 runToken | 新版 ACTIVE_RUNS |
|------|---------------|------------------|
| 作用域 | 实例级变量 | 模块级集合 |
| 跨实例稳定性 | ❌ 实例重建丢失 | ✅ 闭包捕获原值 |
| 重置接管 | ⚠️ 需要手动比较 | ✅ 自动失效 |
| 失败检测 | ⚠️ 简单数值比较 | ✅ 集合成员检查 |
| 热重载支持 | ❌ 可能泄漏 | ✅ 安全清理 |

**章节来源**
- [orchestrator.ts:73-88](file://miniprogram/src/core/orchestrator.ts#L73-L88)
- [orchestrator.ts:129-134](file://miniprogram/src/core/orchestrator.ts#L129-L134)
- [orchestrator.ts:208-216](file://miniprogram/src/core/orchestrator.ts#L208-L216)
- [orchestrator.ts:293-306](file://miniprogram/src/core/orchestrator.ts#L293-L306)
- [scheduler.ts:87-93](file://miniprogram/src/core/scheduler.ts#L87-L93)

### rollbackIfNeeded回滚逻辑：可逆任务识别与反序撤销
- 目标选择：筛选 status === 'succeeded' 且 getCapability(skillId, action).reversible === true 的任务。
- 反序策略：targets.reverse()，确保后完成的先撤销，与执行顺序对称。
- 执行回滚：逐个调用 skillAdapter.rollback(skillId, action, input, result, ctx)，若 r.rolled 则更新 task.status='rolled_back' 并触发 onTaskUpdate。
- 单点失败处理：单个任务回滚失败仅记录 ERROR 并继续其余任务，不中断整体回滚。
- 状态转移：进入 rolling_back 状态，完成后由调用方决定是否转入 failed 或 completed。

```mermaid
flowchart TD
StartRB(["rollbackIfNeeded入口"]) --> Filter["筛选succeeded且reversible=true的任务"]
Filter --> Reverse["反序排列targets"]
Reverse --> CheckEmpty{"无目标?"}
CheckEmpty --> |是| Noop["无需回滚，返回"]
CheckEmpty --> |否| TransitionRB["transition('rolling_back')"]
TransitionRB --> Loop["遍历targets"]
Loop --> RollCall["skillAdapter.rollback(...)"]
RollCall --> Rolled{"r.rolled?"}
Rolled --> |是| UpdateTask["task.status='rolled_back'<br/>finishedAt=now()<br/>onTaskUpdate(task)"]
Rolled --> |否| LogFail["记录ERROR并继续"]
UpdateTask --> Next["下一个任务"]
LogFail --> Next
Next --> DoneRB(["回滚完成"])
```

**图表来源**
- [orchestrator.ts:314-339](file://miniprogram/src/core/orchestrator.ts#L314-L339)

**章节来源**
- [orchestrator.ts:314-339](file://miniprogram/src/core/orchestrator.ts#L314-L339)

### 错误处理与异常恢复策略
- BUSY守卫：非空闲/完成/失败状态直接返回 errorCode='BUSY'。
- EMPTY_PLAN：LLM未识别意图返回 errorCode='EMPTY_PLAN'。
- **RUN_RESET**：**升级后基于 ACTIVE_RUNS.has(token) 检查**，提供更可靠的重置检测。
- LLM_ERROR：PlannerLLMError 捕获并返回 errorCode='LLM_ERROR'。
- DEADLOCK：SchedulerDeadlockError 捕获并返回 errorCode='DEADLOCK'。
- UNEXPECTED：其他异常统一返回 errorCode='UNEXPECTED'，必要时先回滚已成功任务。

**章节来源**
- [orchestrator.ts:119-256](file://miniprogram/src/core/orchestrator.ts#L119-L256)
- [orchestrator.ts:256-289](file://miniprogram/src/core/orchestrator.ts#L256-L289)
- [scheduler.ts:46-52](file://miniprogram/src/core/scheduler.ts#L46-L52)

## 依赖关系分析
- Orchestrator 依赖：
  - LLM客户端：understand、llmPlan、aggregate。
  - 技能适配器：skillAdapter.invoke、getCapability。
  - 调度器：runScheduler。
  - **模块级 ACTIVE_RUNS**：跨实例令牌管理。
  - 类型定义：AgentContext、AgentState、Plan、Task。
  - 工具：logger、idgen、brand常量。
- Scheduler 依赖：
  - 技能适配器：adapter.invoke、getCapability。
  - 工具：binding.applyBindings、indexTasks、logger。
  - **ACTIVE_RUNS 令牌探测**：isRunActive 回调。
  - 类型：AgentContext、Plan、Task、CheckpointFn。

```mermaid
graph LR
O["Orchestrator"] --> LLM["LLM客户端"]
O --> SKA["技能适配器"]
O --> SCH["Scheduler"]
O --> ACT["ACTIVE_RUNS<br/>模块级注册表"]
O --> TYPES["类型定义"]
SCH --> SKA
SCH --> UTILS["工具(binding/logger)"]
SCH --> ACT
SCH --> TYPES
```

**图表来源**
- [orchestrator.ts:13-26](file://miniprogram/src/core/orchestrator.ts#L13-L26)
- [orchestrator.ts:73-88](file://miniprogram/src/core/orchestrator.ts#L73-L88)
- [scheduler.ts:18-26](file://miniprogram/src/core/scheduler.ts#L18-L26)

**章节来源**
- [orchestrator.ts:13-26](file://miniprogram/src/core/orchestrator.ts#L13-L26)
- [orchestrator.ts:73-88](file://miniprogram/src/core/orchestrator.ts#L73-L88)
- [scheduler.ts:18-26](file://miniprogram/src/core/scheduler.ts#L18-L26)

## 性能与并发特性
- 并行执行：Scheduler 使用 Promise.allSettled 并行执行 ready 任务，提升吞吐。
- 人类确认序列化：checkpointChain 模块级 Promise 链确保同一时刻仅一个确认弹窗，避免 wx.showModal 覆盖导致确认结果丢失。
- **升级的令牌探测**：**ACTIVE_RUNS.has(token)** 每轮检查，及时中止无效调度，降低资源浪费。
- 迭代保护：guard > 1000 抛出错误，防止无限循环。
- **跨实例稳定性**：模块级 ACTIVE_RUNS 确保热重载和实例重建时的安全性。

**章节来源**
- [scheduler.ts:117-122](file://miniprogram/src/core/scheduler.ts#L117-L122)
- [scheduler.ts:62-74](file://miniprogram/src/core/scheduler.ts#L62-L74)
- [scheduler.ts:87-93](file://miniprogram/src/core/scheduler.ts#L87-L93)
- [orchestrator.ts:73-88](file://miniprogram/src/core/orchestrator.ts#L73-L88)

## 故障排查指南
- BUSY：检查当前 Orchestrator 状态是否为 idle/completed/failed；若处于中间状态，等待完成或调用 reset。
- EMPTY_PLAN：确认 LLM 是否能识别意图；检查 SkillRegistry 注册的技能是否覆盖该意图。
- **RUN_RESET**：**升级后检查 ACTIVE_RUNS.has(token)**，确认是否在任务执行过程中调用了 reset；确保上层 UI 不会在用户确认前重置。
- DEADLOCK：查看 pending 任务与 running/waiting_human 任务；检查依赖图是否存在环或上游任务未成功。
- LLM_ERROR：检查 LLM 客户端配置与网络；捕获具体 message 定位问题。
- UNEXPECTED：记录异常堆栈；必要时先回滚已成功任务再进入 failed。
- **跨实例问题**：检查 ORCHESTRATOR_SEQ 实例序号，确认是否存在多个 Orchestrator 实例竞争。

**章节来源**
- [orchestrator.ts:119-256](file://miniprogram/src/core/orchestrator.ts#L119-L256)
- [orchestrator.ts:256-289](file://miniprogram/src/core/orchestrator.ts#L256-L289)
- [scheduler.ts:102-114](file://miniprogram/src/core/scheduler.ts#L102-L114)

## 结论
Orchestrator 通过严谨的状态机与 ALLOWED_TRANSITIONS 约束，结合**升级后的模块级 ACTIVE_RUNS 令牌机制**与 Scheduler 的并行执行、人类确认序列化与死锁检测，实现了高内聚、低耦合的编排与调度能力。**新的 ACTIVE_RUNS 机制提供了跨实例稳定性、重置接管能力和失败检测功能**，显著提升了系统的可靠性和可维护性。rollbackIfNeeded 的反序撤销策略确保了写操作的可逆性与一致性。开发者可通过注入 confirmPlan、checkpoint 等回调扩展交互行为，并通过 getCapability.reversible 控制回滚范围。

## 附录：使用示例与扩展指南

### 使用 Orchestrator 类及其API
- 构建上下文与选项：
  - 使用 buildContext(ctxOpts) 创建 AgentContext。
  - 注入 confirmPlan、checkpoint、autoConfirm、autoApproveCheckpoint、onTaskUpdate、onPlanUpdate、onStateChange。
- 单次处理：
  - 调用 handleOnce(intent, ctxOpts, options) 便捷工厂，内部自动构建 Orchestrator 并执行 handle。
- 持续对话：
  - 手动 new Orchestrator(ctx, options)，多次调用 handle(intent) 以维持多轮会话。

**章节来源**
- [orchestrator.ts:367-376](file://miniprogram/src/core/orchestrator.ts#L367-L376)
- [orchestrator.ts:28-48](file://miniprogram/src/core/orchestrator.ts#L28-L48)

### 扩展自定义状态与行为
- 自定义状态：
  - 在 agent-state.d.ts 中扩展 AgentState 联合类型。
  - 在 orchestrator.ts 的 ALLOWED_TRANSITIONS 中添加合法转移对。
  - 在 transition 与 handle 流程中增加对应分支。
- 自定义行为：
  - 通过 onTaskUpdate、onPlanUpdate、onStateChange 回调扩展 UI 展示与日志。
  - 在 SkillRegistry 中注册新技能，并在 getCapability 中声明 reversible 与 requiresHumanConfirm。
- 回滚扩展：
  - 在技能适配器中实现 rollback 逻辑，返回 { rolled: boolean, reason?: string }。
  - 确保 reversible 标记准确，避免误回滚不可逆操作。

**章节来源**
- [agent-state.d.ts:7-17](file://miniprogram/src/types/agent-state.d.ts#L7-L17)
- [orchestrator.ts:60-71](file://miniprogram/src/core/orchestrator.ts#L60-L71)
- [orchestrator.ts:356-364](file://miniprogram/src/core/orchestrator.ts#L356-L364)

### 模块级 ACTIVE_RUNS 扩展指南
- **令牌管理最佳实践**：
  - 不要在 handle() 外部直接操作 ACTIVE_RUNS。
  - 使用 reset() 方法确保令牌正确清理。
  - 利用 isRunActive 回调进行令牌有效性检查。
- **跨实例稳定性保证**：
  - 闭包捕获的 token 值在热重载后仍然有效。
  - ACTIVE_RUNS.clear() 确保旧轮次立即失效。
  - ORCHESTRATOR_SEQ 用于诊断多实例问题。

**章节来源**
- [orchestrator.ts:73-88](file://miniprogram/src/core/orchestrator.ts#L73-L88)
- [orchestrator.ts:129-134](file://miniprogram/src/core/orchestrator.ts#L129-L134)
- [orchestrator.ts:293-306](file://miniprogram/src/core/orchestrator.ts#L293-L306)