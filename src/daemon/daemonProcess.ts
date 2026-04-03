/**
 * 守护进程核心 — 后台服务主进程
 *
 * 这是 daemon 模块的心脏。当 `claude-haha daemon start` 被执行时，
 * daemonManager 会 fork 一个新进程运行此模块的 startDaemonProcess()。
 *
 * 守护进程的职责：
 * ────────────────
 * 1. PID 文件管理 — 写入自己的 PID，防止多实例运行
 * 2. UDS 服务器   — 监听 Unix Domain Socket，接受控制命令
 * 3. 会话管理     — 创建/销毁 claude 子进程
 * 4. 心跳循环     — 定期检查健康状态
 * 5. 信号处理     — 响应 SIGTERM/SIGINT/SIGHUP
 * 6. 日志记录     — 所有活动写入 daemon.log
 *
 * Unix 守护进程的标准做法（"double fork"）：
 * ─────────────────────────────────────────────
 * 传统 Unix 中，创建守护进程需要 "double fork" 技巧：
 *   1. 父进程 fork 子进程，父进程退出
 *   2. 子进程调用 setsid() 创建新会话，成为会话领导
 *   3. 子进程再次 fork，第二个子进程退出会话领导身份
 *   4. 关闭 stdin/stdout/stderr，重定向到 /dev/null
 *
 * 在 Node.js/Bun 中，我们使用 child_process.spawn 的 detached 选项
 * 和 unref() 来达到类似效果，不需要手动实现 double fork。
 *
 * 进程间通信（IPC）选型：
 * ─────────────────────
 * 可选方案：TCP、Unix Domain Socket、Named Pipe、共享内存
 * 选择 UDS 的原因：
 * - 比 TCP 快 2-3 倍（不经过网络栈）
 * - 文件系统权限控制（chmod 600 只允许属主访问）
 * - 不需要端口号，避免端口冲突
 * - 天然安全：仅限本机通信
 */

import { type ChildProcess, spawn } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { createSignal } from '../utils/signal.js'
import { DaemonLogger, initDaemonLogger } from './daemonLogger.js'
import {
  type DaemonCommand,
  type DaemonConfig,
  type DaemonInfo,
  type DaemonResponse,
  type DaemonSession,
  type DaemonStatus,
  MESSAGE_DELIMITER,
  getDefaultDaemonConfig,
} from './types.js'

// ─────────────────────────────────────────────
// 版本号
// ─────────────────────────────────────────────
const DAEMON_VERSION = '1.0.0'

// ─────────────────────────────────────────────
// 会话输出缓冲区大小
// ─────────────────────────────────────────────
// 每个会话保留最近的输出行，供客户端拉取。
// 使用环形缓冲区避免无限内存增长。
const MAX_OUTPUT_LINES = 10_000

// ─────────────────────────────────────────────
// 内部会话状态
// ─────────────────────────────────────────────
//
// 对外暴露的 DaemonSession 是精简的状态快照，
// 内部需要保存更多信息来管理子进程。

interface InternalSession {
  /** 会话元信息（对外暴露的部分） */
  meta: DaemonSession

  /** 子进程句柄。null 表示进程已退出。 */
  process: ChildProcess | null

  /**
   * 输出缓冲区（环形缓冲区）。
   * 保存子进程的 stdout + stderr 输出。
   * 客户端通过 get-output 命令拉取。
   */
  outputBuffer: string[]

  /**
   * 输出写入位置。
   * 客户端记录自己读到的 offset，下次请求时从 offset 开始读取，
   * 实现增量输出流。
   */
  totalLines: number
}

// ─────────────────────────────────────────────
// DaemonProcess 类
// ─────────────────────────────────────────────

export class DaemonProcess {
  private config: DaemonConfig
  private logger!: DaemonLogger
  private status: DaemonStatus = 'stopped'
  private startTime = 0
  private sessions = new Map<string, InternalSession>()

  /**
   * UDS 服务器实例。
   * 使用 Bun.serve 的 unix socket 模式。
   * Bun 原生支持 UDS，不需要额外依赖。
   */
  private server: ReturnType<typeof Bun.serve> | null = null

  /** 心跳定时器 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  /** 状态变更信号，用于通知内部组件 */
  private statusChanged = createSignal<[DaemonStatus]>()

  /**
   * 关闭 Promise。
   * gracefulShutdown() 设置此 Promise，
   * 主循环等待它完成后退出进程。
   */
  private shutdownPromise: Promise<void> | null = null
  private shutdownResolve: (() => void) | null = null

  constructor(config: Partial<DaemonConfig> = {}) {
    this.config = { ...getDefaultDaemonConfig(), ...config }
  }

  // ═══════════════════════════════════════════
  // 启动流程
  // ═══════════════════════════════════════════

  /**
   * 启动守护进程。
   *
   * 启动序列：
   *   1. 设置状态为 starting
   *   2. 确保目录存在
   *   3. 初始化日志系统
   *   4. 写入 PID 文件
   *   5. 创建 UDS 服务器
   *   6. 注册信号处理器
   *   7. 启动心跳循环
   *   8. 设置状态为 running
   *
   * 任何步骤失败都会触发清理并抛出异常。
   */
  async start(): Promise<void> {
    if (this.status !== 'stopped') {
      throw new Error(`守护进程无法从 '${this.status}' 状态启动，只能从 'stopped' 状态启动`)
    }

    this.setStatus('starting')
    this.startTime = Date.now()

    try {
      // 步骤 1: 确保所需目录存在
      // mkdirSync + recursive 是幂等操作，目录存在也不会报错
      const configDir = dirname(this.config.pidFile)
      mkdirSync(configDir, { recursive: true })

      // 步骤 2: 初始化日志系统
      this.logger = initDaemonLogger({
        filePath: this.config.logFile,
        minLevel: 'debug',
        writeToStderr: process.stderr.isTTY ?? false, // 前台模式时也输出到终端
      })

      // 启动时检查日志轮转
      this.logger.rotateSync()
      this.logger.info('守护进程启动中...', {
        pid: process.pid,
        config: {
          workDir: this.config.workDir,
          socketPath: this.config.socketPath,
          heartbeatInterval: this.config.heartbeatInterval,
        },
      })

      // 步骤 3: 写入 PID 文件
      await this.writePidFile()

      // 步骤 4: 创建 UDS 服务器
      await this.createServer()

      // 步骤 5: 注册信号处理器
      this.setupSignalHandlers()

      // 步骤 6: 启动心跳循环
      this.startHeartbeat()

      // 一切就绪
      this.setStatus('running')
      this.logger.info('守护进程启动完成', {
        pid: process.pid,
        socketPath: this.config.socketPath,
      })
    } catch (err) {
      this.logger?.error('守护进程启动失败', { error: String(err) })
      await this.cleanup()
      this.setStatus('error')
      throw err
    }
  }

  // ═══════════════════════════════════════════
  // PID 文件管理
  // ═══════════════════════════════════════════

  /**
   * 写入 PID 文件。
   *
   * PID 文件的作用：
   * 1. 记录守护进程的 PID，供 `daemon status/stop` 查询
   * 2. 作为锁文件，防止同时运行多个守护进程
   *
   * 竞争条件防护：
   * - 先检查现有 PID 文件
   * - 如果存在，检查对应进程是否还活着
   * - 如果活着，拒绝启动（避免多实例）
   * - 如果进程已死，删除旧文件并创建新的
   *
   * process.kill(pid, 0) 技巧：
   * 信号 0 不会实际发送信号，只检查进程是否存在。
   * 如果进程存在，返回 true；否则抛出 ESRCH 异常。
   */
  private async writePidFile(): Promise<void> {
    // 检查是否已有守护进程在运行
    if (existsSync(this.config.pidFile)) {
      try {
        const existingPid = parseInt(readFileSync(this.config.pidFile, 'utf-8').trim(), 10)

        if (!isNaN(existingPid)) {
          try {
            // 信号 0：仅检查进程是否存在，不实际发送信号
            process.kill(existingPid, 0)
            // 进程存在，拒绝启动
            throw new Error(
              `另一个守护进程已在运行 (PID: ${existingPid})。` +
              `请先执行 'claude-haha daemon stop' 停止它。`
            )
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
              // ESRCH = "No such process"，旧进程已死
              this.logger.warn('发现过期的 PID 文件，旧进程已不存在', { oldPid: existingPid })
              unlinkSync(this.config.pidFile)
            } else {
              throw err // 其他错误（如权限不足），继续抛出
            }
          }
        }
      } catch (err) {
        // 如果是我们自己抛出的"另一个守护进程已在运行"错误，继续抛出
        if ((err as Error).message.includes('另一个守护进程')) throw err
        // 其他错误（PID 文件损坏等），删除并继续
        this.logger.warn('PID 文件读取失败，将覆盖', { error: String(err) })
      }
    }

    // 写入当前进程的 PID
    await writeFile(this.config.pidFile, String(process.pid), 'utf-8')
    this.logger.debug('PID 文件已写入', { pid: process.pid, path: this.config.pidFile })
  }

  /**
   * 删除 PID 文件。
   * 在守护进程退出时调用。
   * 只删除自己写入的 PID 文件，避免误删其他实例的文件。
   */
  private async removePidFile(): Promise<void> {
    try {
      // 先验证 PID 文件中的 PID 是否是自己的
      const content = await readFile(this.config.pidFile, 'utf-8')
      const filePid = parseInt(content.trim(), 10)

      if (filePid === process.pid) {
        await unlink(this.config.pidFile)
        this.logger.debug('PID 文件已删除')
      } else {
        this.logger.warn('PID 文件中的 PID 不是当前进程，跳过删除', {
          filePid,
          myPid: process.pid,
        })
      }
    } catch {
      // PID 文件可能已被删除，忽略
    }
  }

  // ═══════════════════════════════════════════
  // UDS 服务器
  // ═══════════════════════════════════════════

  /**
   * 创建 Unix Domain Socket 服务器。
   *
   * UDS 的工作方式：
   * - 服务器 bind 一个文件路径（如 ~/.claude/daemon.sock）
   * - 客户端 connect 到这个路径
   * - 两端通过这个文件进行全双工通信
   * - 文件本身不存储数据，只是一个"会合点"
   *
   * 使用 Bun.serve 的优势：
   * - 原生支持 unix socket
   * - 自动处理并发连接
   * - 高效的 I/O 处理
   *
   * 我们在 UDS 上运行一个简单的 HTTP 服务器。
   * 客户端通过 POST 请求发送 JSON 命令，
   * 服务器返回 JSON 响应。这比原始的流式协议更简单可靠：
   * - 不需要自己处理消息边界
   * - HTTP 天然支持请求/响应模式
   * - 调试时可以用 curl 直接测试
   */
  private async createServer(): Promise<void> {
    // 清理可能残留的旧 socket 文件
    // UDS 文件在服务器意外退出时可能不会被清理，
    // 导致下次启动时 bind 失败（EADDRINUSE）。
    if (existsSync(this.config.socketPath)) {
      this.logger.debug('清理残留的 socket 文件', { path: this.config.socketPath })
      unlinkSync(this.config.socketPath)
    }

    const self = this

    this.server = Bun.serve({
      // unix 选项告诉 Bun 使用 Unix Domain Socket 而不是 TCP
      unix: this.config.socketPath,

      /**
       * 请求处理器。
       * 每个客户端连接都会调用此函数。
       * 我们使用简单的 HTTP POST + JSON 协议。
       */
      async fetch(req: Request): Promise<Response> {
        // 只接受 POST 请求
        if (req.method !== 'POST') {
          return new Response(
            JSON.stringify({ success: false, error: '仅支持 POST 请求' }),
            { status: 405, headers: { 'Content-Type': 'application/json' } },
          )
        }

        try {
          // 解析命令
          const body = await req.text()
          const command = JSON.parse(body) as DaemonCommand

          // 处理命令并返回响应
          const response = await self.handleCommand(command)

          return new Response(JSON.stringify(response), {
            status: response.success ? 200 : 400,
            headers: { 'Content-Type': 'application/json' },
          })
        } catch (err) {
          self.logger.error('处理请求时出错', { error: String(err) })
          return new Response(
            JSON.stringify({ success: false, error: `请求处理失败: ${err}` }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          )
        }
      },

      /**
       * 错误处理器。
       * 当 fetch 函数抛出未捕获的异常时调用。
       */
      error(err: Error): Response {
        self.logger.error('服务器内部错误', { error: err.message })
        return new Response(
          JSON.stringify({ success: false, error: '服务器内部错误' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      },
    })

    this.logger.info('UDS 服务器已启动', { socketPath: this.config.socketPath })
  }

  // ═══════════════════════════════════════════
  // 命令处理
  // ═══════════════════════════════════════════

  /**
   * 处理来自客户端的命令。
   *
   * 使用 TypeScript 的类型缩窄（type narrowing）：
   * 通过 switch(command.type) 分发命令，
   * TypeScript 编译器能在每个 case 中推断出精确的命令类型。
   *
   * 这是"命令模式"（Command Pattern）的简化实现：
   * 每条命令是一个自描述的对象，处理器根据 type 字段分发。
   */
  private async handleCommand(command: DaemonCommand): Promise<DaemonResponse> {
    this.logger.debug('收到命令', { type: command.type })

    switch (command.type) {
      case 'status':
        return this.handleStatus()

      case 'stop':
        return this.handleStop()

      case 'restart':
        return this.handleRestart()

      case 'pause':
        return this.handlePause()

      case 'resume':
        return this.handleResume()

      case 'spawn-session':
        return this.handleSpawnSession(command.cwd, command.prompt)

      case 'kill-session':
        return this.handleKillSession(command.sessionId)

      case 'list-sessions':
        return this.handleListSessions()

      case 'send-message':
        return this.handleSendMessage(command.sessionId, command.message)

      case 'get-output':
        return this.handleGetOutput(command.sessionId, command.offset)

      default:
        return { success: false, error: `未知命令类型: ${(command as { type: string }).type}` }
    }
  }

  // ─────────────────────────────────────────
  // 命令处理器实现
  // ─────────────────────────────────────────

  /** 返回守护进程状态信息 */
  private handleStatus(): DaemonResponse {
    const info: DaemonInfo = {
      pid: process.pid,
      status: this.status,
      startTime: this.startTime,
      uptime: Date.now() - this.startTime,
      workDir: this.config.workDir,
      socketPath: this.config.socketPath,
      sessions: this.getSessionList(),
      version: DAEMON_VERSION,
    }
    return { success: true, data: info }
  }

  /** 处理停止命令 */
  private handleStop(): DaemonResponse {
    this.logger.info('收到停止命令')
    // 异步执行关闭，立即返回响应
    // 使用 setImmediate 确保响应先发回客户端，再开始关闭
    setImmediate(() => void this.gracefulShutdown())
    return { success: true, data: { message: '守护进程正在关闭...' } }
  }

  /** 处理重启命令 */
  private handleRestart(): DaemonResponse {
    this.logger.info('收到重启命令')
    // 重启由 daemonManager 处理：先 stop 再 start
    // daemon 本身只负责 stop
    setImmediate(() => void this.gracefulShutdown())
    return { success: true, data: { message: '守护进程正在重启（将由 manager 重新拉起）...' } }
  }

  /** 暂停守护进程 */
  private handlePause(): DaemonResponse {
    if (this.status !== 'running') {
      return { success: false, error: `当前状态 '${this.status}' 无法暂停` }
    }
    this.setStatus('paused')
    this.logger.info('守护进程已暂停')
    return { success: true, data: { message: '守护进程已暂停' } }
  }

  /** 恢复守护进程 */
  private handleResume(): DaemonResponse {
    if (this.status !== 'paused') {
      return { success: false, error: `当前状态 '${this.status}' 无法恢复` }
    }
    this.setStatus('running')
    this.logger.info('守护进程已恢复')
    return { success: true, data: { message: '守护进程已恢复' } }
  }

  /** 列出所有会话 */
  private handleListSessions(): DaemonResponse {
    return { success: true, data: this.getSessionList() }
  }

  // ═══════════════════════════════════════════
  // 会话管理
  // ═══════════════════════════════════════════

  /**
   * 创建新的 claude 会话。
   *
   * 会话是一个运行 claude-haha 的子进程。
   * 守护进程像一个"进程管理器"（类似 pm2 或 systemd），
   * 负责子进程的整个生命周期。
   *
   * 子进程的输出（stdout/stderr）被捕获到内存缓冲区，
   * 客户端通过 get-output 命令拉取。
   *
   * 关键设计：
   * - 使用 pipe 模式捕获子进程输出
   * - 输出保存在环形缓冲区中（防止内存泄漏）
   * - 子进程退出时更新会话状态
   */
  private async handleSpawnSession(cwd: string, prompt?: string): Promise<DaemonResponse> {
    if (this.status === 'paused') {
      return { success: false, error: '守护进程已暂停，无法创建新会话' }
    }

    if (this.status !== 'running') {
      return { success: false, error: `守护进程当前状态 '${this.status}'，无法创建会话` }
    }

    // 生成唯一的会话 ID
    // crypto.randomUUID() 生成 v4 UUID，在密码学上安全且唯一
    const sessionId = crypto.randomUUID()

    this.logger.info('创建新会话', { sessionId, cwd, hasPrompt: !!prompt })

    try {
      // 确保工作目录存在
      await mkdir(cwd, { recursive: true })

      // 构建子进程命令
      // 使用 process.execPath 获取当前 Bun 运行时路径
      // 使用 process.argv[1] 获取 claude-haha 脚本路径
      const args: string[] = []

      // 如果有初始提示词，使用 -p (print) 模式
      if (prompt) {
        args.push('-p', prompt)
      }

      // 设置子进程环境变量
      const childEnv = {
        ...process.env,
        CLAUDE_DAEMON_SESSION_ID: sessionId,
        CLAUDE_DAEMON_SOCKET: this.config.socketPath,
      }

      /**
       * 使用 spawn 创建子进程。
       *
       * stdio 选项说明：
       * - stdin: 'pipe'   — 允许守护进程向子进程写入（发送消息）
       * - stdout: 'pipe'  — 捕获子进程的标准输出
       * - stderr: 'pipe'  — 捕获子进程的错误输出
       *
       * 不使用 'inherit'，因为守护进程本身没有终端。
       */
      const child = spawn(process.execPath, [process.argv[1]!, ...args], {
        cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 不使用 detached：子进程的生命周期由守护进程管理
      })

      // 创建内部会话对象
      const session: InternalSession = {
        meta: {
          id: sessionId,
          status: 'active',
          cwd,
          startTime: Date.now(),
          lastActivity: Date.now(),
          messageCount: 0,
        },
        process: child,
        outputBuffer: [],
        totalLines: 0,
      }

      this.sessions.set(sessionId, session)

      // 捕获子进程输出
      // readline 接口按行读取，方便管理输出行数
      if (child.stdout) {
        child.stdout.on('data', (data: Buffer) => {
          this.appendOutput(sessionId, data.toString('utf-8'))
        })
      }

      if (child.stderr) {
        child.stderr.on('data', (data: Buffer) => {
          this.appendOutput(sessionId, `[stderr] ${data.toString('utf-8')}`)
        })
      }

      /**
       * 子进程退出处理。
       *
       * exit 事件的参数：
       * - code: 退出码。0 = 正常退出，非0 = 错误退出，null = 被信号杀死
       * - signal: 导致退出的信号（如 SIGTERM），正常退出时为 null
       */
      child.on('exit', (code, signal) => {
        this.logger.info('会话子进程退出', { sessionId, code, signal })
        const s = this.sessions.get(sessionId)
        if (s) {
          s.process = null
          s.meta.status = code === 0 ? 'completed' : 'error'
          s.meta.lastActivity = Date.now()

          this.appendOutput(
            sessionId,
            `\n[session] 进程已退出 (code=${code}, signal=${signal})`,
          )
        }
      })

      child.on('error', (err) => {
        this.logger.error('会话子进程错误', { sessionId, error: err.message })
        const s = this.sessions.get(sessionId)
        if (s) {
          s.meta.status = 'error'
          s.meta.lastActivity = Date.now()
          this.appendOutput(sessionId, `\n[session] 进程错误: ${err.message}`)
        }
      })

      return {
        success: true,
        data: { sessionId, pid: child.pid },
      }
    } catch (err) {
      this.logger.error('创建会话失败', { sessionId, error: String(err) })
      return { success: false, error: `创建会话失败: ${err}` }
    }
  }

  /**
   * 终止指定会话。
   *
   * 优雅终止策略：
   * 1. 先发 SIGTERM（请求子进程优雅退出）
   * 2. 等待 5 秒
   * 3. 如果仍未退出，发 SIGKILL（强制杀死）
   *
   * 为什么用两步？
   * SIGTERM 允许子进程保存状态、清理资源后退出。
   * SIGKILL 是最后手段，直接由内核杀死进程，无法被捕获或忽略。
   */
  private async handleKillSession(sessionId: string): Promise<DaemonResponse> {
    const session = this.sessions.get(sessionId)

    if (!session) {
      return { success: false, error: `会话不存在: ${sessionId}` }
    }

    if (!session.process) {
      // 进程已退出，清理会话记录
      this.sessions.delete(sessionId)
      return { success: true, data: { message: '会话已结束，已清理记录' } }
    }

    this.logger.info('终止会话', { sessionId, pid: session.process.pid })

    // 步骤 1: 发送 SIGTERM
    session.process.kill('SIGTERM')

    // 步骤 2: 设置 SIGKILL 超时
    const killTimeout = setTimeout(() => {
      if (session.process && !session.process.killed) {
        this.logger.warn('会话子进程未响应 SIGTERM，发送 SIGKILL', { sessionId })
        session.process.kill('SIGKILL')
      }
    }, 5_000)
    killTimeout.unref()

    session.meta.status = 'completed'
    session.meta.lastActivity = Date.now()

    return { success: true, data: { message: `会话 ${sessionId} 正在终止` } }
  }

  /**
   * 向会话发送消息。
   *
   * 通过子进程的 stdin 写入数据。
   * 这就像用户在终端中输入一样 —— 子进程的 readline
   * 会读取这些输入并处理。
   */
  private async handleSendMessage(sessionId: string, message: string): Promise<DaemonResponse> {
    const session = this.sessions.get(sessionId)

    if (!session) {
      return { success: false, error: `会话不存在: ${sessionId}` }
    }

    if (!session.process || !session.process.stdin) {
      return { success: false, error: '会话进程已退出或 stdin 不可用' }
    }

    try {
      // 写入 stdin，追加换行符模拟用户按回车
      session.process.stdin.write(message + '\n')
      session.meta.messageCount++
      session.meta.lastActivity = Date.now()
      session.meta.status = 'active'

      this.logger.debug('消息已发送到会话', { sessionId, messageLength: message.length })
      return { success: true, data: { message: '消息已发送' } }
    } catch (err) {
      return { success: false, error: `发送消息失败: ${err}` }
    }
  }

  /**
   * 获取会话输出。
   *
   * 支持增量获取：客户端传入 offset（上次读到的行号），
   * 服务器返回 offset 之后的新内容。
   *
   * 这比 WebSocket 流更简单，适合守护进程的轮询模式。
   * 如果需要实时推送，可以在 daemonClient 中用短轮询模拟。
   */
  private handleGetOutput(sessionId: string, offset?: number): DaemonResponse {
    const session = this.sessions.get(sessionId)

    if (!session) {
      return { success: false, error: `会话不存在: ${sessionId}` }
    }

    const startOffset = offset ?? 0

    // 计算需要返回的行
    // 如果 offset 太旧（已超出缓冲区），从缓冲区开头返回
    const bufferStart = Math.max(0, session.totalLines - session.outputBuffer.length)
    const effectiveOffset = Math.max(startOffset, bufferStart)
    const bufferIndex = effectiveOffset - bufferStart
    const lines = session.outputBuffer.slice(bufferIndex)

    return {
      success: true,
      data: {
        lines,
        offset: session.totalLines, // 客户端应保存此值作为下次请求的 offset
        hasMore: false, // 当前没有更多数据
        sessionStatus: session.meta.status,
      },
    }
  }

  // ─────────────────────────────────────────
  // 输出缓冲区管理
  // ─────────────────────────────────────────

  /**
   * 向会话的输出缓冲区追加内容。
   *
   * 环形缓冲区的工作原理：
   * 当缓冲区超过 MAX_OUTPUT_LINES 时，移除最旧的行。
   * totalLines 持续递增，作为全局偏移量。
   *
   * 例如：MAX_OUTPUT_LINES=3, totalLines=10
   *   outputBuffer = [第8行, 第9行, 第10行]
   *   bufferStart = 10 - 3 = 7
   *   客户端 offset=8 → slice(8-7=1) → [第9行, 第10行]
   */
  private appendOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // 按行分割（保留空行）
    const lines = data.split('\n')

    for (const line of lines) {
      session.outputBuffer.push(line)
      session.totalLines++

      // 环形缓冲区：超出限制时移除最旧的行
      if (session.outputBuffer.length > MAX_OUTPUT_LINES) {
        session.outputBuffer.shift()
      }
    }

    session.meta.lastActivity = Date.now()
  }

  // ═══════════════════════════════════════════
  // 心跳循环
  // ═══════════════════════════════════════════

  /**
   * 启动心跳循环。
   *
   * 心跳是守护进程的"脉搏"，定期执行以下检查：
   * 1. 清理已退出的僵尸会话
   * 2. 记录运行状态（用于监控和调试）
   * 3. 检查资源使用情况
   *
   * 为什么需要心跳？
   * 子进程可能在任何时候退出（被 OOM Killer 杀死、段错误等），
   * 如果不定期检查，守护进程会持有死掉的进程引用，导致资源泄漏。
   *
   * setInterval + unref 的组合：
   * - setInterval 确保定期执行
   * - unref() 确保心跳定时器不会阻止进程退出
   *   （如果所有其他工作都完成了，不应该因为心跳而保持进程存活）
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat()
    }, this.config.heartbeatInterval)

    // unref 让这个定时器不阻止进程自然退出
    this.heartbeatTimer.unref()
  }

  /**
   * 执行一次心跳检查。
   */
  private heartbeat(): void {
    const activeSessions = this.getSessionList().filter(s => s.status === 'active' || s.status === 'idle')
    const completedSessions = this.getSessionList().filter(s => s.status === 'completed' || s.status === 'error')

    this.logger.debug('心跳', {
      status: this.status,
      uptime: Date.now() - this.startTime,
      activeSessions: activeSessions.length,
      completedSessions: completedSessions.length,
      totalSessions: this.sessions.size,
      memoryUsageMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    })

    // 清理长期处于终态的会话（保留 1 小时）
    const ONE_HOUR = 60 * 60 * 1000
    for (const [id, session] of this.sessions) {
      if (
        (session.meta.status === 'completed' || session.meta.status === 'error') &&
        Date.now() - session.meta.lastActivity > ONE_HOUR
      ) {
        this.logger.debug('清理过期会话', { sessionId: id })
        this.sessions.delete(id)
      }
    }
  }

  // ═══════════════════════════════════════════
  // 信号处理
  // ═══════════════════════════════════════════

  /**
   * 注册 Unix 信号处理器。
   *
   * Unix 信号是操作系统向进程发送的异步通知。
   * 守护进程需要正确处理以下信号：
   *
   * SIGTERM (15):
   *   "请优雅地退出"。systemd、docker、kill 命令的默认信号。
   *   收到后应保存状态、关闭连接、然后退出。
   *
   * SIGINT (2):
   *   Ctrl+C。在前台调试时可能收到。
   *   处理方式同 SIGTERM。
   *
   * SIGHUP (1):
   *   "终端挂断"。传统上用于通知守护进程重新加载配置。
   *   我们用它来切换调试日志级别（类似 nginx -s reload）。
   *
   * SIGKILL (9):
   *   不能被捕获。操作系统直接杀死进程。
   *   我们无法处理，所以不注册。
   */
  private setupSignalHandlers(): void {
    // SIGTERM: 优雅关闭
    process.on('SIGTERM', () => {
      this.logger.info('收到 SIGTERM 信号，开始优雅关闭')
      void this.gracefulShutdown()
    })

    // SIGINT: Ctrl+C（前台调试时）
    process.on('SIGINT', () => {
      this.logger.info('收到 SIGINT 信号，开始优雅关闭')
      void this.gracefulShutdown()
    })

    // SIGHUP: 重新加载配置 / 切换调试模式
    if (process.platform !== 'win32') {
      process.on('SIGHUP', () => {
        this.logger.info('收到 SIGHUP 信号，切换调试日志')
        // 在 debug 和 info 之间切换
        const currentLevel = this.logger ? 'info' : 'debug'
        const newLevel = currentLevel === 'debug' ? 'info' : 'debug'
        this.logger.setLevel(newLevel)
        this.logger.info(`日志级别已切换为: ${newLevel}`)
      })
    }

    // 未捕获的异常处理
    // 守护进程不应因为一个未捕获的异常就崩溃。
    // 记录错误但继续运行。
    process.on('uncaughtException', (err) => {
      this.logger.error('未捕获的异常', {
        error: err.message,
        stack: err.stack?.slice(0, 2000),
      })
    })

    process.on('unhandledRejection', (reason) => {
      this.logger.error('未处理的 Promise 拒绝', {
        reason: String(reason),
      })
    })
  }

  // ═══════════════════════════════════════════
  // 优雅关闭
  // ═══════════════════════════════════════════

  /**
   * 优雅关闭守护进程。
   *
   * "优雅"意味着：
   * 1. 停止接受新请求
   * 2. 等待正在进行的工作完成（或超时后强制终止）
   * 3. 清理资源（关闭文件、删除临时文件）
   * 4. 退出进程
   *
   * 关闭顺序很重要：
   * 1. 先标记状态为 stopping（拒绝新请求）
   * 2. 终止所有子进程
   * 3. 关闭 UDS 服务器
   * 4. 删除 PID 文件和 socket 文件
   * 5. 关闭日志
   * 6. 退出进程
   *
   * 幂等性保证：
   * 多次调用 gracefulShutdown() 只执行一次。
   * 这很重要 —— SIGTERM 和 stop 命令可能同时到达。
   */
  async gracefulShutdown(): Promise<void> {
    // 幂等检查：已经在关闭了
    if (this.status === 'stopping' || this.status === 'stopped') {
      return
    }

    this.setStatus('stopping')
    this.logger.info('开始优雅关闭...')

    // 步骤 1: 停止心跳
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    // 步骤 2: 终止所有活跃会话
    const killPromises: Promise<void>[] = []
    for (const [id, session] of this.sessions) {
      if (session.process && !session.process.killed) {
        this.logger.info('终止会话子进程', { sessionId: id, pid: session.process.pid })
        session.process.kill('SIGTERM')

        // 为每个子进程设置超时强杀
        const killPromise = new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (session.process && !session.process.killed) {
              this.logger.warn('子进程未响应 SIGTERM，发送 SIGKILL', { sessionId: id })
              session.process.kill('SIGKILL')
            }
            resolve()
          }, 5_000)
          timeout.unref()

          // 如果子进程已退出，立即 resolve
          if (session.process) {
            session.process.on('exit', () => {
              clearTimeout(timeout)
              resolve()
            })
          } else {
            clearTimeout(timeout)
            resolve()
          }
        })

        killPromises.push(killPromise)
      }
    }

    // 等待所有子进程退出（最多 10 秒）
    if (killPromises.length > 0) {
      this.logger.info(`等待 ${killPromises.length} 个子进程退出...`)
      await Promise.race([
        Promise.all(killPromises),
        new Promise<void>(resolve => {
          const t = setTimeout(resolve, 10_000)
          t.unref()
        }),
      ])
    }

    // 步骤 3: 清理资源
    await this.cleanup()

    this.setStatus('stopped')
    this.logger.info('守护进程已停止')
    await this.logger.close()

    // 步骤 4: 退出进程
    process.exit(0)
  }

  /**
   * 清理资源。
   * 关闭服务器、删除文件、释放引用。
   */
  private async cleanup(): Promise<void> {
    // 关闭 UDS 服务器
    if (this.server) {
      this.server.stop(true) // force: true 立即关闭所有连接
      this.server = null
    }

    // 删除 socket 文件
    try {
      if (existsSync(this.config.socketPath)) {
        unlinkSync(this.config.socketPath)
      }
    } catch {
      // 忽略
    }

    // 删除 PID 文件
    await this.removePidFile()

    // 清除会话引用
    this.sessions.clear()
  }

  // ═══════════════════════════════════════════
  // 辅助方法
  // ═══════════════════════════════════════════

  /** 获取会话列表（外部视图） */
  private getSessionList(): DaemonSession[] {
    return Array.from(this.sessions.values()).map(s => ({ ...s.meta }))
  }

  /**
   * 设置守护进程状态并触发信号。
   * 集中管理状态变更，便于调试和监控。
   */
  private setStatus(status: DaemonStatus): void {
    const oldStatus = this.status
    this.status = status
    this.logger?.debug('状态变更', { from: oldStatus, to: status })
    this.statusChanged.emit(status)
  }

  /** 获取当前状态 */
  getStatus(): DaemonStatus {
    return this.status
  }

  /** 获取当前配置（只读副本） */
  getConfig(): Readonly<DaemonConfig> {
    return { ...this.config }
  }
}

// ═══════════════════════════════════════════════
// 模块入口点
// ═══════════════════════════════════════════════
//
// 当此文件作为主模块运行时（通过 fork 或直接执行），
// 自动启动守护进程。
//
// Bun 使用 import.meta.main 判断是否是主模块
// （类似 Python 的 if __name__ == '__main__'）。

if (import.meta.main) {
  const configJson = process.env.DAEMON_CONFIG
  const config: Partial<DaemonConfig> = configJson ? JSON.parse(configJson) : {}

  const daemon = new DaemonProcess(config)
  daemon.start().catch((err) => {
    // 启动失败，输出错误后以非零状态码退出
    process.stderr.write(`守护进程启动失败: ${err}\n`)
    process.exit(1)
  })
}
