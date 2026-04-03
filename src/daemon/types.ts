/**
 * 守护进程模块 — 类型定义
 *
 * 本文件定义了 daemon（守护进程）系统的所有类型。
 *
 * 什么是守护进程？
 * ─────────────
 * 守护进程是一种在后台运行、不依赖终端的长期运行进程。
 * 传统 Unix 守护进程（如 sshd、nginx）在系统启动时自动启动，
 * 持续在后台提供服务，直到被显式停止。
 *
 * 在 claude-code-haha 中，daemon 是 kairos（24/7 agent）系统的基础。
 * 它让 claude-haha 能够脱离终端，作为后台服务持续运行，
 * 管理多个会话、处理定时任务，并通过 Unix Domain Socket 接受控制命令。
 *
 * 架构概述：
 *   CLI (daemonManager) ──UDS──> Daemon Process (daemonProcess)
 *                                    ├── Session 1 (child process)
 *                                    ├── Session 2 (child process)
 *                                    └── Heartbeat Loop
 */

// ─────────────────────────────────────────────
// 守护进程状态机
// ─────────────────────────────────────────────
//
// 状态流转：
//   stopped ──> starting ──> running ──> stopping ──> stopped
//                              │  ▲
//                              ▼  │
//                            paused
//                              │
//                              ▼
//                            error ──> stopping ──> stopped
//
// 说明：
// - starting: 正在初始化（写 PID 文件、创建 UDS 服务器）
// - running:  正常运行中，接受命令
// - paused:   暂停状态，不处理新会话但保持 socket 和心跳
// - stopping: 正在优雅关闭（等待子进程退出、清理资源）
// - stopped:  已完全停止
// - error:    发生不可恢复的错误，等待重启或人工干预

export type DaemonStatus = 'starting' | 'running' | 'paused' | 'stopping' | 'stopped' | 'error'

// ─────────────────────────────────────────────
// 守护进程配置
// ─────────────────────────────────────────────
//
// 所有路径默认在 ~/.claude/ 下，与项目的 .claude/ 配置目录分开。
// 这样设计的原因：
// 1. daemon 是系统级服务，不应绑定到特定项目
// 2. PID 文件和 socket 文件需要全局唯一
// 3. 日志文件需要持久保存，不受项目目录影响

export interface DaemonConfig {
  /**
   * PID 文件路径。
   * PID 文件是 Unix 守护进程的标准机制：
   * - 写入守护进程的进程 ID，供其他程序查询
   * - 用于防止多实例运行（通过 lockfile）
   * - 在守护进程退出时删除
   * 默认: ~/.claude/daemon.pid
   */
  pidFile: string

  /**
   * 日志文件路径。
   * 守护进程没有终端输出，所有日志写入文件。
   * 支持日志轮转防止文件无限增长。
   * 默认: ~/.claude/daemon.log
   */
  logFile: string

  /**
   * Unix Domain Socket 路径。
   * UDS 是一种进程间通信（IPC）机制：
   * - 比 TCP 更快（不经过网络栈）
   * - 通过文件系统权限控制访问
   * - 仅限本机通信，天然安全
   * 默认: ~/.claude/daemon.sock
   */
  socketPath: string

  /**
   * 心跳间隔（毫秒）。
   * 守护进程定期执行心跳检查：
   * - 清理僵死的子进程
   * - 更新状态信息
   * - 检查资源使用情况
   * 默认: 30000 (30秒)
   */
  heartbeatInterval: number

  /**
   * 最大自动重启次数。
   * 当守护进程因异常崩溃时，管理器会尝试自动重启。
   * 超过此次数后不再重启，防止无限崩溃循环。
   * 默认: 5
   */
  maxRestarts: number

  /**
   * 重启延迟（毫秒）。
   * 两次重启之间的等待时间，给系统恢复的时间。
   * 默认: 3000 (3秒)
   */
  restartDelay: number

  /**
   * 工作目录。
   * 守护进程的工作目录，影响子进程的默认 cwd。
   */
  workDir: string

  /**
   * 远程服务器地址（可选）。
   * 连接到 claude-code-haha-server 以获取远程任务。
   */
  serverUrl?: string

  /**
   * API Key（可选）。
   * 用于与远程服务器通信的认证密钥。
   */
  apiKey?: string
}

// ─────────────────────────────────────────────
// 守护进程运行时信息
// ─────────────────────────────────────────────
//
// 描述守护进程当前的运行状态，用于状态查询和监控。

export interface DaemonInfo {
  /** 守护进程的进程 ID（PID）。每个进程在 OS 中的唯一标识。 */
  pid: number

  /** 当前状态 */
  status: DaemonStatus

  /** 启动时间的 Unix 时间戳（毫秒） */
  startTime: number

  /** 运行时长（毫秒），由 Date.now() - startTime 计算 */
  uptime: number

  /** 工作目录 */
  workDir: string

  /** UDS 套接字路径 */
  socketPath: string

  /** 当前管理的所有会话 */
  sessions: DaemonSession[]

  /** claude-code-haha 版本号 */
  version: string
}

// ─────────────────────────────────────────────
// 会话（Session）
// ─────────────────────────────────────────────
//
// 守护进程管理的每个会话对应一个 claude 子进程。
// 会话是 daemon 的核心工作单元：
// - 用户可以通过 daemon 远程创建/销毁会话
// - 每个会话有独立的工作目录和输出缓冲区
// - daemon 监控会话的生命周期（启动、活跃、完成、错误）

export interface DaemonSession {
  /** 会话唯一标识（UUID） */
  id: string

  /**
   * 会话状态：
   * - active:    正在处理消息
   * - idle:      等待输入
   * - completed: 已正常结束
   * - error:     发生错误
   */
  status: 'active' | 'idle' | 'completed' | 'error'

  /** 会话的工作目录 */
  cwd: string

  /** 会话启动时间（Unix 时间戳，毫秒） */
  startTime: number

  /** 最后一次活动时间（Unix 时间戳，毫秒） */
  lastActivity: number

  /** 已处理的消息数量 */
  messageCount: number
}

// ─────────────────────────────────────────────
// 守护进程命令协议
// ─────────────────────────────────────────────
//
// 客户端通过 UDS 向 daemon 发送 JSON 格式的命令。
// 使用 TypeScript 的联合类型（discriminated union）
// 实现类型安全的命令分发：
//
//   客户端: { type: 'status' }  ──UDS──>  守护进程: handleCommand(cmd)
//   客户端: <── DaemonResponse ──UDS──   守护进程

export type DaemonCommand =
  /** 查询守护进程状态 */
  | { type: 'status' }
  /** 请求停止守护进程 */
  | { type: 'stop' }
  /** 请求重启守护进程 */
  | { type: 'restart' }
  /** 暂停守护进程（停止接受新会话，但保持现有会话） */
  | { type: 'pause' }
  /** 恢复守护进程 */
  | { type: 'resume' }
  /** 创建新会话。cwd 指定工作目录，prompt 是可选的初始提示词 */
  | { type: 'spawn-session'; cwd: string; prompt?: string }
  /** 终止指定会话 */
  | { type: 'kill-session'; sessionId: string }
  /** 列出所有会话 */
  | { type: 'list-sessions' }
  /** 向指定会话发送消息 */
  | { type: 'send-message'; sessionId: string; message: string }
  /** 获取指定会话的输出。offset 可选，用于增量获取 */
  | { type: 'get-output'; sessionId: string; offset?: number }

// ─────────────────────────────────────────────
// 守护进程命令响应
// ─────────────────────────────────────────────
//
// 统一的响应格式：成功时 data 包含结果，失败时 error 包含错误信息。
// 这种设计避免了在 UDS 上实现复杂的错误码体系。

export interface DaemonResponse {
  /** 命令是否执行成功 */
  success: boolean

  /** 成功时的返回数据（类型取决于具体命令） */
  data?: unknown

  /** 失败时的错误信息 */
  error?: string
}

// ─────────────────────────────────────────────
// UDS 消息帧协议
// ─────────────────────────────────────────────
//
// Unix Domain Socket 是流式协议，没有消息边界。
// 我们需要自己定义"一条消息在哪里结束"。
// 方案：每条消息以换行符 '\n' 分隔（类似 JSON Lines / ndjson）。
// 简单可靠，调试时也方便用 socat 等工具测试。

/** 消息分隔符 */
export const MESSAGE_DELIMITER = '\n'

// ─────────────────────────────────────────────
// 默认配置
// ─────────────────────────────────────────────
//
// 集中管理所有默认值，方便调整和测试。

/** 获取默认的守护进程配置 */
export function getDefaultDaemonConfig(workDir?: string): DaemonConfig {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  const claudeDir = `${home}/.claude`

  return {
    pidFile: `${claudeDir}/daemon.pid`,
    logFile: `${claudeDir}/daemon.log`,
    socketPath: `${claudeDir}/daemon.sock`,
    heartbeatInterval: 30_000,
    maxRestarts: 5,
    restartDelay: 3_000,
    workDir: workDir || process.cwd(),
  }
}
