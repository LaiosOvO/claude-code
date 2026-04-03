/**
 * Kairos 模块 — 类型定义
 *
 * Kairos（希腊语 καιρός，意为"恰当的时机"）是 claude-code-haha 的
 * 24/7 主动式 Agent 系统。它构建于 daemon（守护进程）模块之上，
 * 为用户提供持续在线、主动感知、自主行动的能力。
 *
 * 核心理念：
 * ─────────
 * 传统 CLI 工具是"被动应答"模式——用户提问，工具回答。
 * Kairos 打破这一范式，实现"主动服务"：
 *   - 文件变化时自动响应（如代码保存后自动运行 lint）
 *   - 按时间表执行任务（如每天早上汇总 Git 状态）
 *   - 基于规则主动通知（如检测到安全漏洞时推送告警）
 *   - 并行派生子 Agent 处理多任务
 *
 * 与 daemon 模块的关系：
 * ────────────────────
 *   daemon 提供"后台运行"的基础设施（PID 管理、UDS、心跳）。
 *   Kairos 在 daemon 事件循环内运行，利用 daemon 的会话管理
 *   来 spawn 子 Agent 进程，并通过 daemon 的 UDS 接口接收指令。
 *
 *   ┌──────────────────────────────────────┐
 *   │           Daemon Process             │
 *   │  ┌──────────────────────────────┐    │
 *   │  │       Kairos Engine          │    │
 *   │  │  ├── Scheduler (定时任务)    │    │
 *   │  │  ├── Watcher (文件监控)      │    │
 *   │  │  ├── Notifier (通知系统)     │    │
 *   │  │  └── AgentPool (Agent 池)    │    │
 *   │  └──────────────────────────────┘    │
 *   │  ┌──────┐ ┌──────┐ ┌──────┐         │
 *   │  │Agent1│ │Agent2│ │Agent3│  ...     │
 *   │  └──────┘ └──────┘ └──────┘         │
 *   └──────────────────────────────────────┘
 */

import type { ChildProcess } from 'child_process'

// ─────────────────────────────────────────────
// Kairos 任务类型
// ─────────────────────────────────────────────
//
// 任务类型决定了触发方式和执行逻辑：
//
// - scheduled: 按 cron 表达式定时触发。
//   复用现有 cronScheduler 的基础设施，但增加了优先级和依赖。
//   例：每天 9:00 汇总 Git 日志
//
// - reactive: 由外部事件触发（文件变化、消息到达等）。
//   Watcher 检测到匹配的事件后，将 reactive 任务加入执行队列。
//   例：*.test.ts 文件修改后自动运行测试
//
// - proactive: 由 Kairos 自身基于规则主动发起。
//   规则可以是复合条件（如"最近 1 小时没有提交 && 有未保存的修改"）。
//   例：检测到长时间未提交时提醒用户
//
// - watch: 纯监控任务，不执行 Agent，只记录和通知。
//   轻量级，用于状态监控和告警。
//   例：磁盘空间低于 10% 时发送告警

export type KairosTaskType = 'scheduled' | 'reactive' | 'proactive' | 'watch'

// ─────────────────────────────────────────────
// 任务状态机
// ─────────────────────────────────────────────
//
// 状态流转：
//   pending ──> queued ──> running ──> completed
//                │                       │
//                │                       ▼
//                │                    failed ──> pending (重试)
//                ▼
//              cancelled
//
// - pending:   已注册但尚未到达触发条件
// - queued:    已触发，等待 Agent 池分配资源
// - running:   正在被子 Agent 执行
// - completed: 成功完成
// - failed:    执行失败（可配置自动重试）
// - cancelled: 被用户或系统取消

export type KairosTaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

// ─────────────────────────────────────────────
// 任务优先级
// ─────────────────────────────────────────────
//
// 优先级影响任务在队列中的排序。
// 数值越高越优先（借鉴 Unix nice 的反向思维——nice 值越低优先级越高，
// 但这里我们用直觉更友好的"越高越优先"）。
//
// - critical (100): 安全告警、系统错误等紧急任务
// - high (75):      用户显式请求的任务
// - normal (50):    常规定时任务
// - low (25):       后台清理、统计等非紧急任务
// - idle (0):       系统空闲时才执行的任务

export type KairosTaskPriority = 'critical' | 'high' | 'normal' | 'low' | 'idle'

/** 优先级到数值的映射，方便排序比较 */
export const PRIORITY_VALUES: Record<KairosTaskPriority, number> = {
  critical: 100,
  high: 75,
  normal: 50,
  low: 25,
  idle: 0,
}

// ─────────────────────────────────────────────
// Kairos 配置
// ─────────────────────────────────────────────
//
// 核心配置项，控制 Kairos 引擎的行为边界。
// 可通过 .claude/kairos.json 或 settings 覆盖默认值。

export interface KairosConfig {
  /**
   * 调度器主循环间隔（毫秒）。
   *
   * Kairos 引擎采用"轮询 + 事件驱动"的混合模式：
   * - 轮询间隔决定检查定时任务和规则的频率
   * - 文件变化等事件可以在轮询间隔之外立即触发
   *
   * 较短的间隔提高响应速度但增加 CPU 开销。
   * 默认 5 秒是一个平衡点——对于 cron 任务（分钟级精度）绰绰有余，
   * 而文件变化由 chokidar 事件直接驱动，不受此间隔影响。
   *
   * 默认: 5000 (5秒)
   */
  schedulerIntervalMs: number

  /**
   * 最大并发 Agent 数量。
   *
   * 每个 Agent 是一个独立的子进程，消耗 CPU 和内存。
   * 限制并发数是防止资源耗尽的关键手段。
   *
   * 计算依据：
   * - 每个 Agent 进程约占 100-200MB 内存
   * - macOS 默认最大进程数约 2048（ulimit -u）
   * - 考虑到 API 调用并发限制，3 个通常是合理上限
   *
   * 默认: 3
   */
  maxConcurrentAgents: number

  /**
   * 通知设置。
   * 控制各通知渠道的开关和配置。
   */
  notification: KairosNotificationConfig

  /**
   * 文件监控模式列表。
   * 每个条目定义一个 glob 模式和对应的处理规则。
   */
  watchPatterns: KairosWatchRule[]

  /**
   * 任务执行的默认工作目录。
   * 子 Agent 进程启动时的 cwd。
   * 默认继承 daemon 的 workDir。
   */
  defaultCwd: string

  /**
   * 每小时最大任务执行数（速率限制）。
   *
   * 防止失控的 reactive 任务（如文件频繁变化）导致
   * 大量 Agent 生成，耗尽 API 配额。
   *
   * 默认: 60 (每分钟最多 1 个任务)
   */
  maxTasksPerHour: number

  /**
   * 失败任务的最大重试次数。
   * 使用指数退避策略：delay = baseDelay * 2^(retryCount - 1)
   * 默认: 3
   */
  maxRetries: number

  /**
   * 重试基础延迟（毫秒）。
   * 第一次重试的等待时间。
   * 默认: 5000 (5秒)
   */
  retryBaseDelayMs: number

  /**
   * 任务历史保留条数。
   * 超过此数量后，最早的记录被丢弃。
   * 默认: 200
   */
  maxHistorySize: number

  /**
   * Bridge 服务器地址（可选）。
   * 用于向手机端推送通知。
   * 如果未配置，Bridge 通知渠道将被禁用。
   */
  bridgeServerUrl?: string

  /**
   * Bridge API Key（可选）。
   * 与 bridge 服务器通信的认证凭据。
   */
  bridgeApiKey?: string
}

// ─────────────────────────────────────────────
// 通知配置
// ─────────────────────────────────────────────

export interface KairosNotificationConfig {
  /** 启用终端内通知（写入当前 TTY）。默认: true */
  terminal: boolean

  /** 启用文件通知（写入 ~/.claude/notifications/）。默认: true */
  file: boolean

  /**
   * 启用 UDS inbox 通知（发送给连接中的会话）。默认: true
   * 依赖 UDS inbox server 正在运行。
   */
  udsInbox: boolean

  /**
   * 启用 Bridge 推送通知（发送到手机端）。默认: false
   * 需要配置 bridgeServerUrl 和 bridgeApiKey。
   */
  bridge: boolean

  /**
   * 启用 macOS 系统通知（通过 osascript）。默认: true
   * 仅在 macOS 上有效，其他平台静默忽略。
   */
  system: boolean
}

// ─────────────────────────────────────────────
// Kairos 任务定义
// ─────────────────────────────────────────────
//
// 任务是 Kairos 的核心工作单元。每个任务描述了：
// "在什么条件下（触发器）做什么事（prompt）以什么优先级（priority）"

export interface KairosTask {
  /** 任务唯一标识。使用 UUID 前 8 位，与 cronTask 保持一致。 */
  id: string

  /** 任务类型，决定触发和执行方式 */
  type: KairosTaskType

  /** 人类可读的任务名称。用于日志和通知中的标识。 */
  name: string

  /**
   * 触发条件。
   * - 对于 scheduled 类型：cron 表达式（5 段，本地时间）
   * - 对于 reactive 类型：事件匹配模式（如 "file:*.test.ts:modify"）
   * - 对于 proactive 类型：规则表达式（如 "idle:30m" 表示空闲 30 分钟后触发）
   * - 对于 watch 类型：glob 模式（如 "src/**/*.ts"）
   */
  trigger: string

  /**
   * 发送给子 Agent 的 prompt。
   * 这是任务的"指令"——子 Agent 收到此 prompt 后自主执行。
   *
   * prompt 可以包含模板变量，在执行时替换：
   *   {{file}}     - 触发变化的文件路径
   *   {{event}}    - 触发事件类型
   *   {{timestamp}} - 触发时间戳
   */
  prompt: string

  /** 当前执行状态 */
  status: KairosTaskStatus

  /** 优先级 */
  priority: KairosTaskPriority

  /** 任务创建时间（Unix 时间戳，毫秒） */
  createdAt: number

  /** 上次执行时间（Unix 时间戳，毫秒）。未执行过为 undefined。 */
  lastRun?: number

  /** 下次计划执行时间（Unix 时间戳，毫秒）。仅对 scheduled 类型有效。 */
  nextRun?: number

  /** 是否为循环任务。scheduled 类型默认为 true。 */
  recurring: boolean

  /** 已执行次数 */
  runCount: number

  /** 连续失败次数（成功后重置为 0） */
  failCount: number

  /** 最大重试次数。覆盖全局配置。 */
  maxRetries?: number

  /**
   * 依赖的前置任务 ID 列表。
   * 只有所有依赖任务完成后，本任务才能执行。
   * 用于构建任务 DAG（有向无环图）。
   */
  dependsOn?: string[]

  /**
   * 任务执行的工作目录。
   * 覆盖全局 defaultCwd。
   */
  cwd?: string

  /** 任务附加的元数据，供自定义扩展使用 */
  metadata?: Record<string, unknown>
}

// ─────────────────────────────────────────────
// 通知类型
// ─────────────────────────────────────────────
//
// Kairos 支持多种通知类型：
// - message: 纯文本消息（如任务完成通知）
// - file:    文件传输（如生成的报告）
// - push:    推送通知（短消息，适合手机查看）
// - alert:   告警通知（高优先级，多渠道同时推送）

export type KairosNotificationType = 'message' | 'file' | 'push' | 'alert'

export interface KairosNotification {
  /** 通知类型 */
  type: KairosNotificationType

  /**
   * 通知目标。
   * 可以是：
   * - session ID: 发送到特定会话
   * - '*': 广播到所有会话
   * - 'bridge': 发送到手机端
   * - 'system': 系统通知
   */
  target: string

  /** 通知内容 */
  payload: KairosNotificationPayload

  /** 通知时间戳 */
  timestamp: number

  /** 关联的任务 ID（可选，用于追踪） */
  taskId?: string
}

/** 通知载荷——根据通知类型承载不同内容 */
export interface KairosNotificationPayload {
  /** 通知标题（用于 push 和 alert） */
  title?: string

  /** 通知正文 */
  body: string

  /**
   * 文件路径（用于 file 类型通知）。
   * 可以是绝对路径或相对于 cwd 的路径。
   */
  filePath?: string

  /** 文件内容（用于小文件的内联传输） */
  fileContent?: string

  /** 严重程度（用于 alert 类型） */
  severity?: 'info' | 'warning' | 'error' | 'critical'

  /** 附加数据 */
  data?: Record<string, unknown>
}

// ─────────────────────────────────────────────
// Agent 句柄
// ─────────────────────────────────────────────
//
// AgentHandle 是对子 Agent 进程的抽象引用。
// 它不直接暴露 ChildProcess，而是提供一个
// 更安全的接口来查询和控制 Agent。

export type KairosAgentStatus = 'spawning' | 'running' | 'completed' | 'failed' | 'killed'

export interface KairosAgentHandle {
  /** Agent 唯一标识（UUID） */
  id: string

  /** 当前状态 */
  status: KairosAgentStatus

  /** 关联的任务 */
  task: KairosTask

  /** 启动时间（Unix 时间戳，毫秒） */
  startTime: number

  /** 结束时间（完成/失败后填写） */
  endTime?: number

  /**
   * 底层子进程句柄。
   * 标记为可选——进程退出后置为 undefined，
   * 防止对已退出进程的操作。
   */
  process?: ChildProcess

  /** 进程 PID */
  pid?: number

  /** Agent 的工作目录 */
  cwd: string

  /** Agent 的输出收集（最近 N 行） */
  output: string[]

  /** 退出码（进程结束后填写） */
  exitCode?: number | null

  /** Agent 执行的 prompt */
  prompt: string

  /** 估算的内存使用量（字节）。通过 process.memoryUsage 采样。 */
  memoryUsage?: number

  /** 估算的 CPU 使用率（百分比）。通过 /proc/stat 或 ps 命令采样。 */
  cpuUsage?: number
}

// ─────────────────────────────────────────────
// 事件系统
// ─────────────────────────────────────────────
//
// Kairos 使用事件驱动架构进行组件间通信。
// 所有事件流经统一的事件总线（event bus），
// 各组件通过订阅感兴趣的事件类型来响应。
//
// 事件类型覆盖 Kairos 生命周期的所有关键节点：

export type KairosEventType =
  | 'engine:start'          // 引擎启动
  | 'engine:stop'           // 引擎停止
  | 'task:added'            // 任务注册
  | 'task:removed'          // 任务移除
  | 'task:triggered'        // 任务触发（进入队列）
  | 'task:started'          // 任务开始执行（Agent 已 spawn）
  | 'task:completed'        // 任务成功完成
  | 'task:failed'           // 任务执行失败
  | 'task:cancelled'        // 任务被取消
  | 'task:retrying'         // 任务正在重试
  | 'agent:spawned'         // 子 Agent 已创建
  | 'agent:completed'       // 子 Agent 执行完成
  | 'agent:failed'          // 子 Agent 执行失败
  | 'agent:killed'          // 子 Agent 被终止
  | 'agent:health'          // 子 Agent 健康检查结果
  | 'watcher:change'        // 文件变化检测
  | 'watcher:error'         // 文件监控错误
  | 'notification:sent'     // 通知已发送
  | 'notification:failed'   // 通知发送失败
  | 'scheduler:tick'        // 调度器 tick（每个调度周期）
  | 'inbox:message'         // 收到 UDS inbox 消息
  | 'bridge:message'        // 收到 Bridge 消息

export interface KairosEvent {
  /** 事件类型 */
  type: KairosEventType

  /**
   * 事件来源。
   * 标识产生事件的组件，便于调试和过滤。
   * 例：'scheduler', 'watcher', 'agent-pool', 'notifier'
   */
  source: string

  /** 事件数据。具体结构取决于事件类型。 */
  data: Record<string, unknown>

  /** 事件发生时间（Unix 时间戳，毫秒） */
  timestamp: number
}

// ─────────────────────────────────────────────
// 文件监控规则
// ─────────────────────────────────────────────
//
// WatchRule 定义了"当某种文件变化发生时，执行什么操作"。
// 这是 reactive 任务的配置基础。

export type KairosWatchEventType = 'create' | 'modify' | 'delete'

export interface KairosWatchRule {
  /**
   * Glob 匹配模式。
   * 使用 chokidar 支持的 glob 语法。
   * 例：'src/**\/*.ts', '*.test.{ts,tsx}', 'package.json'
   */
  pattern: string

  /**
   * 监控的事件类型。
   * 可以是单个事件或事件数组。
   */
  events: KairosWatchEventType[]

  /**
   * 触发后执行的动作。
   * prompt 字段支持模板变量：{{file}}, {{event}}
   */
  action: KairosWatchAction

  /**
   * 防抖延迟（毫秒）。
   * 在此时间窗口内的连续变化只触发一次。
   *
   * 为什么需要防抖？
   * 编辑器保存文件时通常会产生多次写入事件：
   * 1. 清空文件
   * 2. 写入新内容
   * 3. 可能还有 .swp 文件的创建和删除
   *
   * 如果每次写入都触发任务，一次保存可能导致 3-4 次执行。
   * 防抖可以将这些合并为一次。
   *
   * 默认: 1000 (1秒)
   */
  debounceMs: number

  /** 是否启用此规则。可以在不删除规则的情况下暂时禁用。 */
  enabled: boolean
}

export interface KairosWatchAction {
  /** 触发时发送给 Agent 的 prompt */
  prompt: string

  /** 优先级（覆盖默认） */
  priority?: KairosTaskPriority

  /** 工作目录（覆盖默认） */
  cwd?: string

  /**
   * 是否只通知而不执行 Agent。
   * 设置为 true 时，只发送通知，不 spawn Agent。
   * 适用于纯监控场景。
   */
  notifyOnly?: boolean
}

// ─────────────────────────────────────────────
// 任务执行历史
// ─────────────────────────────────────────────
//
// 记录每次任务执行的详细信息，用于审计和调试。

export interface KairosTaskHistoryEntry {
  /** 执行记录 ID */
  id: string

  /** 关联的任务 ID */
  taskId: string

  /** 任务名称（冗余存储，方便在任务删除后仍可查看历史） */
  taskName: string

  /** 执行开始时间 */
  startTime: number

  /** 执行结束时间 */
  endTime: number

  /** 执行时长（毫秒） */
  durationMs: number

  /** 执行结果 */
  result: 'success' | 'failure' | 'cancelled'

  /** Agent 输出摘要（截取前 500 字符） */
  outputSummary: string

  /** 错误信息（失败时填写） */
  error?: string

  /** Agent 退出码 */
  exitCode?: number | null
}

// ─────────────────────────────────────────────
// 引擎状态快照
// ─────────────────────────────────────────────
//
// 用于 getStatus() API 返回引擎的当前状态，
// 包含所有关键指标的只读快照。

export interface KairosEngineStatus {
  /** 引擎是否正在运行 */
  running: boolean

  /** 启动时间 */
  startTime: number | null

  /** 运行时长（毫秒） */
  uptime: number

  /** 已注册的任务数 */
  totalTasks: number

  /** 各状态的任务数 */
  tasksByStatus: Record<KairosTaskStatus, number>

  /** 当前活跃的 Agent 数 */
  activeAgents: number

  /** Agent 池容量 */
  maxAgents: number

  /** 排队中的任务数 */
  queuedTasks: number

  /** 过去一小时执行的任务数 */
  tasksLastHour: number

  /** 监控的文件模式数 */
  watchPatterns: number

  /** 最近一次任务执行的时间 */
  lastTaskTime: number | null

  /** 最近一次错误 */
  lastError: string | null
}

// ─────────────────────────────────────────────
// spawn Agent 选项
// ─────────────────────────────────────────────

export interface KairosSpawnOptions {
  /** 工作目录 */
  cwd?: string

  /** 环境变量 */
  env?: Record<string, string>

  /** 超时时间（毫秒）。超时后 Agent 被强制终止。默认: 5 分钟 */
  timeoutMs?: number

  /** 任务优先级 */
  priority?: KairosTaskPriority

  /** 关联的任务（可选） */
  task?: KairosTask

  /** 最大输出缓冲行数。默认: 1000 */
  maxOutputLines?: number
}

// ─────────────────────────────────────────────
// 默认配置
// ─────────────────────────────────────────────

/** 获取 Kairos 的默认配置 */
export function getDefaultKairosConfig(cwd?: string): KairosConfig {
  return {
    schedulerIntervalMs: 5_000,
    maxConcurrentAgents: 3,
    notification: {
      terminal: true,
      file: true,
      udsInbox: true,
      bridge: false,
      system: true,
    },
    watchPatterns: [],
    defaultCwd: cwd || process.cwd(),
    maxTasksPerHour: 60,
    maxRetries: 3,
    retryBaseDelayMs: 5_000,
    maxHistorySize: 200,
  }
}

/** Agent 输出缓冲区默认最大行数 */
export const DEFAULT_AGENT_OUTPUT_LINES = 1000

/** Agent 默认超时时间：5 分钟 */
export const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000

/** Kairos 配置文件名（相对于项目 .claude/ 目录） */
export const KAIROS_CONFIG_FILE = 'kairos.json'

/** 通知文件存放目录（相对于 ~/.claude/） */
export const KAIROS_NOTIFICATIONS_DIR = 'notifications'

/** 任务历史文件名 */
export const KAIROS_HISTORY_FILE = 'kairos_history.json'
