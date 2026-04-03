/**
 * 守护进程客户端 — 与 daemon 进程通信
 *
 * 本模块提供一个客户端类，通过 Unix Domain Socket
 * 与运行中的守护进程通信。
 *
 * 通信模型：
 * ──────────
 * 客户端与守护进程之间使用 HTTP-over-UDS 协议：
 *
 *   DaemonClient ──POST JSON──> DaemonProcess (Bun.serve on UDS)
 *   DaemonClient <──JSON──────  DaemonProcess
 *
 * 为什么用 HTTP 而不是原始 TCP/UDS 流？
 * 1. 天然的请求/响应模型（不需要自己实现消息边界和匹配）
 * 2. Bun 的 fetch() 原生支持 unix socket（通过 `unix` 选项）
 * 3. 调试方便：可以用 curl --unix-socket 测试
 *
 * 使用示例：
 * ─────────
 *   const client = new DaemonClient('/path/to/daemon.sock')
 *   const status = await client.getStatus()
 *   console.log(status)
 *   // 不需要显式 disconnect —— 每次请求都是独立的 HTTP 连接
 *
 * 流式输出：
 * ─────────
 *   for await (const lines of client.streamOutput(sessionId)) {
 *     for (const line of lines) console.log(line)
 *   }
 */

import {
  type DaemonCommand,
  type DaemonInfo,
  type DaemonResponse,
  type DaemonSession,
  getDefaultDaemonConfig,
} from './types.js'

// ─────────────────────────────────────────────
// 客户端配置
// ─────────────────────────────────────────────

export interface DaemonClientOptions {
  /** UDS 套接字路径。默认: ~/.claude/daemon.sock */
  socketPath?: string

  /**
   * 请求超时时间（毫秒）。
   * 如果守护进程在这段时间内没有响应，请求将失败。
   * 默认: 10000 (10秒)
   */
  timeout?: number
}

// ─────────────────────────────────────────────
// 客户端错误类型
// ─────────────────────────────────────────────
//
// 自定义错误类让调用者可以区分不同类型的失败：
// - 连接失败（守护进程未运行）
// - 超时（守护进程无响应）
// - 协议错误（响应格式异常）

export class DaemonConnectionError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message)
    this.name = 'DaemonConnectionError'
  }
}

export class DaemonTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`守护进程未在 ${timeoutMs}ms 内响应`)
    this.name = 'DaemonTimeoutError'
  }
}

// ─────────────────────────────────────────────
// DaemonClient 实现
// ─────────────────────────────────────────────

export class DaemonClient {
  private socketPath: string
  private timeout: number

  constructor(options: DaemonClientOptions = {}) {
    const defaults = getDefaultDaemonConfig()
    this.socketPath = options.socketPath ?? defaults.socketPath
    this.timeout = options.timeout ?? 10_000
  }

  // ═══════════════════════════════════════════
  // 底层通信
  // ═══════════════════════════════════════════

  /**
   * 向守护进程发送命令并等待响应。
   *
   * 实现细节：
   * ──────────
   * Bun 的 fetch() 支持 `unix` 选项，可以直接通过 UDS 发送 HTTP 请求。
   * 这是 Bun 相比 Node.js 的优势之一 —— Node.js 需要用 undici 或
   * http.request 的 socketPath 选项。
   *
   * URL 中的 host 部分（localhost）在 UDS 模式下会被忽略，
   * 但 HTTP 协议要求必须有一个 host，所以我们用 localhost 作占位符。
   *
   * 超时实现：
   * 使用 AbortController + setTimeout 来实现请求超时。
   * AbortController 是 Web 标准的取消机制：
   *   1. 创建 AbortController 和对应的 signal
   *   2. 将 signal 传给 fetch
   *   3. setTimeout 到期后调用 controller.abort()
   *   4. fetch 收到 abort 信号后抛出 AbortError
   */
  async sendCommand(command: DaemonCommand): Promise<DaemonResponse> {
    // 创建超时控制器
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch('http://localhost/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
        signal: controller.signal,
        // Bun 特有选项：通过 Unix Domain Socket 发送请求
        // @ts-expect-error -- Bun 的 fetch 支持 unix 选项，但 TypeScript 类型定义中没有
        unix: this.socketPath,
      })

      const data = await response.json() as DaemonResponse
      return data
    } catch (err) {
      // 区分不同类型的错误
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new DaemonTimeoutError(this.timeout)
      }

      // 连接被拒绝 = 守护进程未运行
      const errMsg = String(err)
      if (
        errMsg.includes('ECONNREFUSED') ||
        errMsg.includes('ENOENT') ||
        errMsg.includes('Connection refused') ||
        errMsg.includes('No such file')
      ) {
        throw new DaemonConnectionError(
          '无法连接到守护进程。它可能未在运行。请执行 `claude-haha daemon start` 启动它。',
          err instanceof Error ? err : undefined,
        )
      }

      throw new DaemonConnectionError(
        `与守护进程通信失败: ${err}`,
        err instanceof Error ? err : undefined,
      )
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // ═══════════════════════════════════════════
  // 高级 API
  // ═══════════════════════════════════════════
  //
  // 这些方法是 sendCommand 的类型安全封装。
  // 调用者不需要知道命令的 JSON 格式，
  // 只需要调用具名方法、传入参数、获得类型化的返回值。

  /**
   * 获取守护进程状态信息。
   *
   * 返回 DaemonInfo 对象，包含：
   * - PID、状态、运行时长
   * - 所有会话列表
   * - 版本号
   */
  async getStatus(): Promise<DaemonInfo> {
    const response = await this.sendCommand({ type: 'status' })
    if (!response.success) {
      throw new Error(response.error ?? '获取状态失败')
    }
    return response.data as DaemonInfo
  }

  /**
   * 启动新会话。
   *
   * @param cwd - 会话的工作目录
   * @param prompt - 可选的初始提示词
   * @returns 新会话的 ID 和子进程 PID
   */
  async startSession(cwd: string, prompt?: string): Promise<{ sessionId: string; pid: number }> {
    const response = await this.sendCommand({
      type: 'spawn-session',
      cwd,
      prompt,
    })
    if (!response.success) {
      throw new Error(response.error ?? '启动会话失败')
    }
    return response.data as { sessionId: string; pid: number }
  }

  /**
   * 停止指定会话。
   *
   * 会先发 SIGTERM 请求子进程优雅退出，
   * 超时后会发 SIGKILL 强制终止。
   */
  async stopSession(sessionId: string): Promise<void> {
    const response = await this.sendCommand({
      type: 'kill-session',
      sessionId,
    })
    if (!response.success) {
      throw new Error(response.error ?? '停止会话失败')
    }
  }

  /**
   * 向会话发送消息。
   *
   * 消息通过子进程的 stdin 发送，就像用户在终端中输入一样。
   */
  async sendMessage(sessionId: string, message: string): Promise<void> {
    const response = await this.sendCommand({
      type: 'send-message',
      sessionId,
      message,
    })
    if (!response.success) {
      throw new Error(response.error ?? '发送消息失败')
    }
  }

  /**
   * 获取会话输出。
   *
   * 支持增量获取：传入上次获取的 offset，
   * 只返回新增的输出行。
   *
   * @param sessionId - 会话 ID
   * @param offset - 上次读取的偏移量（由上次调用返回）
   * @returns 新输出行和新的偏移量
   */
  async getOutput(
    sessionId: string,
    offset?: number,
  ): Promise<{
    lines: string[]
    offset: number
    hasMore: boolean
    sessionStatus: string
  }> {
    const response = await this.sendCommand({
      type: 'get-output',
      sessionId,
      offset,
    })
    if (!response.success) {
      throw new Error(response.error ?? '获取输出失败')
    }
    return response.data as {
      lines: string[]
      offset: number
      hasMore: boolean
      sessionStatus: string
    }
  }

  /**
   * 列出所有会话。
   */
  async listSessions(): Promise<DaemonSession[]> {
    const response = await this.sendCommand({ type: 'list-sessions' })
    if (!response.success) {
      throw new Error(response.error ?? '列出会话失败')
    }
    return response.data as DaemonSession[]
  }

  /**
   * 流式获取会话输出。
   *
   * 这是一个 async generator（异步生成器），
   * 实现了类似"实时尾随"（tail -f）的效果。
   *
   * async generator 是 JavaScript 处理异步数据流的利器：
   * - 使用 yield 逐步产出数据
   * - 调用者使用 for-await-of 消费
   * - 支持背压（backpressure）：消费者处理完一批再请求下一批
   *
   * 内部使用轮询（polling）实现：
   * - 每 500ms 请求一次新输出
   * - 如果有新内容就 yield
   * - 如果会话结束就停止轮询
   *
   * 为什么用轮询而不是 WebSocket？
   * UDS + HTTP 更简单，而且 daemon 是本机通信，
   * 500ms 的延迟对于日志查看场景完全可以接受。
   *
   * 使用示例：
   *   for await (const lines of client.streamOutput('session-id')) {
   *     for (const line of lines) {
   *       process.stdout.write(line + '\n')
   *     }
   *   }
   */
  async *streamOutput(
    sessionId: string,
    pollIntervalMs = 500,
  ): AsyncGenerator<string[], void, unknown> {
    let offset = 0

    while (true) {
      try {
        const result = await this.getOutput(sessionId, offset)

        // 有新内容时产出
        if (result.lines.length > 0) {
          yield result.lines
          offset = result.offset
        }

        // 会话已结束，停止轮询
        if (result.sessionStatus === 'completed' || result.sessionStatus === 'error') {
          return
        }

        // 等待下次轮询
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
      } catch (err) {
        // 连接错误时停止
        if (err instanceof DaemonConnectionError) {
          return
        }
        throw err
      }
    }
  }

  /**
   * 请求守护进程关闭。
   *
   * 这是一个异步操作：守护进程收到命令后会开始优雅关闭，
   * 但不会等待关闭完成就返回响应。
   */
  async stop(): Promise<void> {
    try {
      const response = await this.sendCommand({ type: 'stop' })
      if (!response.success) {
        throw new Error(response.error ?? '停止守护进程失败')
      }
    } catch (err) {
      // 如果连接立即断开（守护进程快速退出），不算错误
      if (err instanceof DaemonConnectionError) {
        return
      }
      throw err
    }
  }

  /**
   * 暂停守护进程。
   * 暂停后不再创建新会话，但现有会话继续运行。
   */
  async pause(): Promise<void> {
    const response = await this.sendCommand({ type: 'pause' })
    if (!response.success) {
      throw new Error(response.error ?? '暂停守护进程失败')
    }
  }

  /**
   * 恢复守护进程。
   */
  async resume(): Promise<void> {
    const response = await this.sendCommand({ type: 'resume' })
    if (!response.success) {
      throw new Error(response.error ?? '恢复守护进程失败')
    }
  }

  // ═══════════════════════════════════════════
  // 连接管理
  // ═══════════════════════════════════════════

  /**
   * 检查是否能连接到守护进程。
   *
   * 通过发送 status 命令来检测连通性。
   * 这比检查 socket 文件是否存在更可靠 ——
   * socket 文件可能是上次崩溃残留的。
   */
  async isConnected(): Promise<boolean> {
    try {
      await this.getStatus()
      return true
    } catch {
      return false
    }
  }

  /**
   * 等待守护进程就绪。
   *
   * 在 daemon start 之后调用，轮询直到守护进程可响应。
   * 有最大等待时间限制。
   *
   * @param maxWaitMs - 最大等待时间（毫秒），默认 10 秒
   * @param pollMs - 轮询间隔（毫秒），默认 200ms
   * @returns 是否成功连接
   */
  async waitForReady(maxWaitMs = 10_000, pollMs = 200): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs

    while (Date.now() < deadline) {
      if (await this.isConnected()) {
        return true
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }

    return false
  }

  /**
   * 获取 socket 路径。
   * 用于诊断和日志。
   */
  getSocketPath(): string {
    return this.socketPath
  }
}
