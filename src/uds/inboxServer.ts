/**
 * UDS Inbox 服务端 (Central Message Hub)
 *
 * ===== 架构概述 =====
 *
 * Inbox 服务端是整个跨会话通信系统的中心枢纽 (hub)。
 * 它采用"星型拓扑 (star topology)"——所有客户端只与服务端通信，
 * 客户端之间不直接建立连接。
 *
 *        ┌──────────┐
 *        │ Session A │──┐
 *        └──────────┘  │
 *                       │
 *        ┌──────────┐  │  ┌──────────────┐
 *        │ Session B │──┼──│ Inbox Server │
 *        └──────────┘  │  └──────────────┘
 *                       │
 *        ┌──────────┐  │
 *        │ Session C │──┘
 *        └──────────┘
 *
 * 优点:
 * - 简单: 每个客户端只需维护一个连接
 * - 可控: 服务端可以实现访问控制、消息过滤、流量限制
 * - 可观测: 服务端知道所有消息的流转情况
 *
 * 缺点:
 * - 单点故障: 服务端挂了，所有通信中断
 * - 瓶颈: 所有消息都经过服务端
 *
 * 对于同机器上的 claude-code 实例通信，这些缺点可以接受。
 *
 * ===== 单例模式 =====
 *
 * 系统中只能有一个 Inbox Server 运行（监听同一个 socket 文件）。
 * 启动时尝试监听，如果端口被占用，说明已有服务端在运行，
 * 此时直接作为客户端连接即可。
 *
 * ===== 消息路由逻辑 =====
 *
 * 1. 单播 (unicast): to=具体的 sessionId → 查找注册表，发送给目标
 * 2. 广播 (broadcast): to='*' → 发送给除发送者外的所有人
 * 3. 离线缓冲: 目标不在线 → 存入缓冲区，上线后投递
 */

import { createServer, type Server, type Socket } from 'net'
import { existsSync, unlinkSync } from 'fs'
import { InboxRegistry, type GenericSocket } from './inboxRegistry.js'
import { encodeFrame, createFrameReader, createMessage } from './inboxProtocol.js'
import type {
  InboxMessage,
  UDSServerConfig,
  UDSPeerInfo,
  RegisterPayload,
} from './types.js'
import {
  getDefaultSocketPath,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MESSAGE_TIMEOUT,
  OFFLINE_BUFFER_MAX,
  HEARTBEAT_INTERVAL,
} from './types.js'

// ============================================================
// InboxServer 类
// ============================================================

export class InboxServer {
  private server: Server | null = null
  private registry: InboxRegistry
  private config: UDSServerConfig
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  /**
   * 离线消息缓冲区
   *
   * 当目标会话暂时不在线时，消息被缓存在这里。
   * 结构: sessionId -> 消息数组
   *
   * 为什么需要离线缓冲？
   *   想象一个场景: Session A 让 Session B 执行一个命令，
   *   但 Session B 恰好在重连中（可能正在自动重启）。
   *   没有缓冲区的话，这条消息就丢失了。
   *   有了缓冲区，Session B 重连后可以收到之前的消息。
   *
   * 注意: 缓冲区有大小限制，不是可靠的消息队列。
   * 如果需要可靠投递，应该使用持久化消息队列 (如 Redis Streams)。
   */
  private offlineBuffer: Map<string, InboxMessage[]> = new Map()

  /**
   * 消息处理器映射
   *
   * 某些消息类型需要服务端自己处理（而非转发），
   * 比如 register、listPeers、ping 等。
   */
  private internalHandlers: Map<
    string,
    (msg: InboxMessage, socket: GenericSocket) => void
  > = new Map()

  constructor(config?: Partial<UDSServerConfig>) {
    this.config = {
      socketPath: config?.socketPath ?? getDefaultSocketPath(),
      maxConnections: config?.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      messageTimeout: config?.messageTimeout ?? DEFAULT_MESSAGE_TIMEOUT,
    }

    this.registry = new InboxRegistry()

    // 注册内部消息处理器
    this.setupInternalHandlers()
  }

  // ========================================================
  // 内部消息处理器
  // ========================================================

  /**
   * 设置服务端内部处理的消息类型
   *
   * 有些消息是"控制平面 (control plane)"消息，
   * 由服务端自己消费，而非转发给其他客户端:
   *
   * - register: 客户端注册自己
   * - ping/pong: 心跳（pong 是客户端的响应，服务端更新活动时间）
   * - listPeers: 请求在线对端列表
   */
  private setupInternalHandlers(): void {
    // 处理客户端注册
    this.internalHandlers.set('register', (msg, socket) => {
      this.handleRegister(msg, socket)
    })

    // 处理心跳响应
    // 客户端收到 ping 后回复 pong，服务端更新其最后活动时间
    this.internalHandlers.set('pong', (msg) => {
      this.registry.touch(msg.from)
    })

    // 处理对端列表查询
    this.internalHandlers.set('listPeers', (msg, socket) => {
      const peers = this.registry.getAllPeers()
      const reply = createMessage(
        '__server__',
        msg.from,
        'status',
        { peers },
        msg.id // replyTo: 关联到原始请求，让客户端能匹配请求和响应
      )
      this.sendToSocket(socket, reply)
    })
  }

  /**
   * 处理客户端注册
   *
   * 当新客户端连接后，它发送的第一条消息应该是 register 类型。
   * 服务端提取其中的身份信息，将其加入注册表。
   *
   * 注册完成后:
   * 1. 回复确认消息
   * 2. 投递该客户端的离线消息缓冲区中的消息
   */
  private handleRegister(msg: InboxMessage, socket: GenericSocket): void {
    const payload = msg.payload as RegisterPayload
    const now = Date.now()

    const peerInfo: UDSPeerInfo = {
      sessionId: payload.sessionId,
      cwd: payload.cwd,
      pid: payload.pid,
      connectedAt: now,
      lastActivity: now,
    }

    this.registry.register(payload.sessionId, socket, peerInfo)

    // 回复注册成功
    const ack = createMessage(
      '__server__',
      payload.sessionId,
      'status',
      { registered: true, sessionId: payload.sessionId }
    )
    this.sendToSocket(socket, ack)

    // 投递离线消息
    this.flushOfflineBuffer(payload.sessionId)
  }

  // ========================================================
  // 消息路由
  // ========================================================

  /**
   * 路由一条消息到目标
   *
   * 这是消息系统的核心方法。根据 to 字段决定消息走向:
   *
   * 1. to === '*' → 广播: 发送给除发送者外的所有在线对端
   *    广播适用于通知类消息，比如"我开始执行一个大任务了"
   *
   * 2. to === '__server__' → 内部: 由服务端自己处理
   *    目前没有这种情况（内部消息走 internalHandlers），但预留接口
   *
   * 3. to === 具体的 sessionId → 单播: 发送给指定对端
   *    如果对端在线，直接发送
   *    如果对端不在线，缓存到离线缓冲区
   */
  private routeMessage(msg: InboxMessage): void {
    // 更新发送者的活动时间
    this.registry.touch(msg.from)

    if (msg.to === '*') {
      // 广播模式: 发给除了发送者之外的所有人
      this.broadcast(msg)
    } else {
      // 单播模式: 发给指定对端
      this.unicast(msg)
    }
  }

  /**
   * 广播消息
   *
   * 遍历所有注册的对端，跳过发送者，依次发送。
   * 如果某个对端发送失败（可能连接已断但还没被清理），
   * 记录错误但不影响其他对端的投递。
   *
   * 注意: 广播是"尽力投递 (best-effort)"，不保证所有人都收到。
   */
  private broadcast(msg: InboxMessage): void {
    const entries = this.registry.getAllEntries()
    for (const { sessionId, socket } of entries) {
      // 不要发回给发送者自己
      if (sessionId === msg.from) continue

      try {
        this.sendToSocket(socket, msg)
      } catch (err) {
        console.error(
          `[InboxServer] 广播到 ${sessionId} 失败:`,
          err
        )
      }
    }
  }

  /**
   * 单播消息
   *
   * 查找目标对端，如果在线则直接发送，
   * 如果不在线则存入离线缓冲区。
   */
  private unicast(msg: InboxMessage): void {
    const target = this.registry.getPeer(msg.to as string)
    if (target) {
      try {
        this.sendToSocket(target.socket, msg)
      } catch (err) {
        console.error(
          `[InboxServer] 发送到 ${msg.to} 失败，缓存为离线消息:`,
          err
        )
        this.bufferOfflineMessage(msg.to as string, msg)
      }
    } else {
      // 对端不在线，缓存消息
      this.bufferOfflineMessage(msg.to as string, msg)
    }
  }

  // ========================================================
  // 离线消息缓冲
  // ========================================================

  /**
   * 缓存离线消息
   *
   * 当目标对端不在线时，将消息存入缓冲区。
   * 缓冲区有大小限制，超出时丢弃最旧的消息（FIFO 淘汰）。
   *
   * FIFO = First In, First Out (先进先出)
   * 最先缓存的消息最先被丢弃——
   * 因为越旧的消息通常越不重要（可能已经过时了）。
   */
  private bufferOfflineMessage(sessionId: string, msg: InboxMessage): void {
    let buffer = this.offlineBuffer.get(sessionId)
    if (!buffer) {
      buffer = []
      this.offlineBuffer.set(sessionId, buffer)
    }

    buffer.push(msg)

    // 如果超出缓冲区上限，丢弃最旧的消息
    while (buffer.length > OFFLINE_BUFFER_MAX) {
      const discarded = buffer.shift()
      if (discarded) {
        console.warn(
          `[InboxServer] 离线缓冲区已满，丢弃消息 ${discarded.id} (to=${sessionId})`
        )
      }
    }
  }

  /**
   * 投递离线消息
   *
   * 当对端重新上线（注册成功）后，
   * 将缓冲区中的所有消息依次发送给它。
   */
  private flushOfflineBuffer(sessionId: string): void {
    const buffer = this.offlineBuffer.get(sessionId)
    if (!buffer || buffer.length === 0) return

    const target = this.registry.getPeer(sessionId)
    if (!target) return

    console.log(
      `[InboxServer] 投递 ${buffer.length} 条离线消息给 ${sessionId}`
    )

    // 逐条发送缓冲的消息
    for (const msg of buffer) {
      try {
        this.sendToSocket(target.socket, msg)
      } catch (err) {
        console.error(
          `[InboxServer] 投递离线消息 ${msg.id} 失败:`,
          err
        )
      }
    }

    // 清空缓冲区
    this.offlineBuffer.delete(sessionId)
  }

  // ========================================================
  // Socket 数据发送
  // ========================================================

  /**
   * 通过 socket 发送一条消息
   *
   * 使用 inboxProtocol.encodeFrame 将消息编码为线路格式，
   * 然后写入 socket。
   *
   * @param socket - 目标 socket
   * @param msg - 要发送的消息
   */
  private sendToSocket(socket: GenericSocket, msg: InboxMessage): void {
    const frame = encodeFrame(msg)
    socket.write(frame)
  }

  // ========================================================
  // 连接处理
  // ========================================================

  /**
   * 处理新的客户端连接
   *
   * 当客户端连接到 Unix Domain Socket 时，这个方法被调用。
   * 它为每个连接创建一个独立的帧读取器 (FrameReader)，
   * 然后监听数据和断开事件。
   *
   * 为什么每个连接需要独立的 FrameReader？
   *   因为每个连接有独立的数据流，
   *   部分帧 (partial frame) 是每个连接独立的状态。
   *   如果共享一个 FrameReader，不同连接的数据会混在一起。
   *
   * @param socket - 新连接的 socket 对象
   */
  private handleConnection(socket: Socket): void {
    // 检查连接数量限制
    if (this.registry.size >= this.config.maxConnections) {
      console.warn(
        `[InboxServer] 连接数已达上限 ${this.config.maxConnections}，拒绝新连接`
      )
      socket.end()
      return
    }

    // 为此连接创建独立的帧读取器
    const reader = createFrameReader()

    // 此连接对应的 session ID（注册后才知道）
    let connSessionId: string | null = null

    // 将 net.Socket 包装为 GenericSocket
    // net.Socket 已经有 write 和 end 方法，直接使用
    const genericSocket: GenericSocket = socket

    // ---- 数据到达事件 ----
    // socket.on('data') 是 Node.js 流 (Stream) 的标准事件。
    // 每当从连接中读到数据时触发。
    // 注意: 一次 'data' 事件的数据量是不确定的——
    // 可能是一个完整消息，也可能是半个，也可能是多个。
    // FrameReader 负责处理这种不确定性。
    socket.on('data', (chunk: Buffer) => {
      let messages: InboxMessage[]
      try {
        messages = reader.push(chunk)
      } catch (err) {
        console.error('[InboxServer] 帧解析错误，关闭连接:', err)
        socket.end()
        return
      }

      for (const msg of messages) {
        // 检查是否有内部处理器
        const handler = this.internalHandlers.get(msg.type)
        if (handler) {
          handler(msg, genericSocket)
          // 如果是 register 消息，记住这个连接的 session ID
          if (msg.type === 'register') {
            connSessionId = (msg.payload as RegisterPayload).sessionId
          }
          continue
        }

        // 非内部消息，路由到目标
        this.routeMessage(msg)
      }
    })

    // ---- 连接关闭事件 ----
    // 'close' 事件在连接完全关闭后触发。
    // hadError 参数指示关闭是否由错误引起。
    socket.on('close', (hadError: boolean) => {
      if (connSessionId) {
        this.registry.unregister(connSessionId)
        console.log(
          `[InboxServer] 连接关闭: ${connSessionId}` +
          (hadError ? ' (因错误)' : '')
        )
      }
      reader.reset()
    })

    // ---- 错误事件 ----
    // 必须监听 'error' 事件！在 Node.js 中，
    // 未处理的 'error' 事件会导致进程崩溃 (uncaughtException)。
    // 即使只是记录日志，也要监听。
    socket.on('error', (err: Error) => {
      console.error(
        `[InboxServer] 连接错误 (${connSessionId ?? 'unregistered'}):`,
        err.message
      )
    })
  }

  // ========================================================
  // 心跳机制
  // ========================================================

  /**
   * 启动心跳检测
   *
   * ===== 为什么需要心跳？=====
   *
   * TCP/IPC 连接可能"静默死亡"——连接实际已断开，
   * 但没有触发 close/error 事件（比如进程被 SIGKILL 杀死）。
   * 服务端不主动探测的话，永远不知道对方已经不在了。
   *
   * 心跳的工作方式:
   * 1. 服务端定期向所有客户端发送 ping 消息
   * 2. 客户端收到 ping 后必须回复 pong
   * 3. 如果客户端在超时时间内没有回复，
   *    注册表的 cleanupStale() 会将其清理掉
   *
   * 心跳间隔和超时的关系:
   *   超时 > 间隔（通常是 2 倍）
   *   这样即使一个 ping 丢了，还有下一个 ping 的机会。
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const entries = this.registry.getAllEntries()
      for (const { sessionId, socket } of entries) {
        try {
          const ping = createMessage('__server__', sessionId, 'ping', {})
          this.sendToSocket(socket, ping)
        } catch (err) {
          console.error(
            `[InboxServer] 发送心跳到 ${sessionId} 失败:`,
            err
          )
        }
      }

      // 心跳发送完后，顺便清理僵尸连接
      this.registry.cleanupStale()
    }, HEARTBEAT_INTERVAL)

    // 心跳定时器不应阻止进程退出
    if (this.heartbeatTimer && typeof this.heartbeatTimer === 'object' && 'unref' in this.heartbeatTimer) {
      ;(this.heartbeatTimer as NodeJS.Timeout).unref()
    }
  }

  /**
   * 停止心跳检测
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  // ========================================================
  // 服务端生命周期
  // ========================================================

  /**
   * 启动服务端
   *
   * 步骤:
   * 1. 清理可能存在的旧 socket 文件
   *    如果上次服务端没有正常退出，socket 文件会残留。
   *    此时需要删除旧文件才能重新监听。
   *
   * 2. 创建 Unix Domain Socket 服务端
   *    使用 Node.js 的 net.createServer()，
   *    传入 { path: socketPath } 来监听 Unix Socket 而非 TCP。
   *
   * 3. 启动心跳和清理定时器
   *
   * 4. 设置进程退出时的清理钩子
   *
   * @returns Promise，监听成功后 resolve
   */
  async start(): Promise<void> {
    // 清理旧的 socket 文件
    // 注意: 如果另一个进程正在使用这个 socket，删除文件后
    // 那个进程的现有连接不受影响（因为 inode 还在），
    // 但新连接会连到我们的新 socket。
    if (existsSync(this.config.socketPath)) {
      try {
        unlinkSync(this.config.socketPath)
        console.log(
          `[InboxServer] 清理旧 socket 文件: ${this.config.socketPath}`
        )
      } catch (err) {
        console.error(
          '[InboxServer] 清理旧 socket 文件失败:',
          err
        )
      }
    }

    return new Promise<void>((resolve, reject) => {
      // 创建服务端
      // net.createServer 返回一个 TCP/IPC 服务器。
      // 当传入 Unix socket 路径（而非端口号）时，它工作在 IPC 模式。
      this.server = createServer((socket: Socket) => {
        this.handleConnection(socket)
      })

      // 监听错误
      this.server.on('error', (err: Error) => {
        console.error('[InboxServer] 服务端错误:', err.message)
        // 如果是启动时的错误（如 EADDRINUSE），reject promise
        // EADDRINUSE 通常意味着另一个进程已经在监听这个 socket
        if (
          'code' in err &&
          (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ) {
          reject(
            new Error(
              `Socket 地址已被占用: ${this.config.socketPath}。可能已有服务端在运行。`
            )
          )
        }
      })

      // 开始监听
      // 对于 Unix Domain Socket，listen 接受一个路径字符串
      this.server.listen(this.config.socketPath, () => {
        console.log(
          `[InboxServer] 开始监听: ${this.config.socketPath}`
        )

        // 启动心跳检测
        this.startHeartbeat()

        // 启动注册表清理
        this.registry.startCleanup()

        resolve()
      })

      // 设置最大连接数
      this.server.maxConnections = this.config.maxConnections
    })
  }

  /**
   * 停止服务端
   *
   * 优雅关闭 (graceful shutdown) 的步骤:
   * 1. 停止接受新连接
   * 2. 停止心跳
   * 3. 关闭所有现有连接
   * 4. 清理 socket 文件
   *
   * 优雅关闭 vs 暴力关闭:
   *   优雅关闭给客户端机会处理断开事件，
   *   暴力关闭 (如 kill -9) 则什么都不做。
   */
  async stop(): Promise<void> {
    console.log('[InboxServer] 正在停止...')

    // 停止心跳
    this.stopHeartbeat()

    // 销毁注册表（关闭所有连接）
    this.registry.destroy()

    // 关闭服务端（停止接受新连接）
    if (this.server) {
      return new Promise<void>((resolve) => {
        this.server!.close(() => {
          console.log('[InboxServer] 服务端已关闭')

          // 清理 socket 文件
          try {
            if (existsSync(this.config.socketPath)) {
              unlinkSync(this.config.socketPath)
            }
          } catch {
            // 忽略清理错误
          }

          this.server = null
          resolve()
        })
      })
    }
  }

  // ========================================================
  // 公共查询接口
  // ========================================================

  /**
   * 获取所有在线对端
   */
  getPeers(): UDSPeerInfo[] {
    return this.registry.getAllPeers()
  }

  /**
   * 获取服务端是否正在运行
   */
  get isRunning(): boolean {
    return this.server !== null && this.server.listening
  }

  /**
   * 获取当前连接数
   */
  get connectionCount(): number {
    return this.registry.size
  }

  /**
   * 获取配置信息
   */
  getConfig(): Readonly<UDSServerConfig> {
    return { ...this.config }
  }
}

// ============================================================
// 便利函数: 创建并启动服务端
// ============================================================

/**
 * 创建并启动一个 Inbox 服务端
 *
 * 使用方式:
 *   const server = await startInboxServer()
 *   // ... 使用服务端 ...
 *   await server.stop()
 *
 * @param config - 可选的配置覆盖
 * @returns 已启动的服务端实例
 */
export async function startInboxServer(
  config?: Partial<UDSServerConfig>
): Promise<InboxServer> {
  const server = new InboxServer(config)
  await server.start()
  return server
}
