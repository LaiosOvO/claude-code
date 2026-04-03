/**
 * UDS Inbox 客户端
 *
 * ===== 客户端职责 =====
 *
 * 每个 claude-code 会话实例创建一个 InboxClient，
 * 通过它与 Inbox Server 通信。
 *
 * 客户端的核心能力:
 * 1. 连接管理: 连接、断开、自动重连
 * 2. 消息发送: 单播、广播、请求-响应
 * 3. 消息接收: 事件驱动的消息处理
 * 4. 对端查询: 获取在线会话列表
 *
 * ===== 自动重连 (Auto-Reconnect) =====
 *
 * 网络连接不可靠——服务端可能重启、系统资源可能紧张。
 * 一个健壮的客户端应该能自动恢复连接。
 *
 * 重连策略:
 * - 检测到连接断开后，等待 reconnectInterval 毫秒再重连
 * - 如果重连失败，继续等待并重试
 * - 最多重试 maxReconnects 次，超过后放弃
 * - 重连成功后重置计数器
 *
 * 更高级的策略（本模块未实现但值得了解）:
 * - 指数退避 (Exponential Backoff): 每次重试间隔翻倍，避免"雷鸣群 (thundering herd)"
 * - 抖动 (Jitter): 在退避时间上加随机偏移，分散重连请求
 *
 * ===== 请求-响应模式 (Request-Reply) =====
 *
 * 有时候发送消息后需要等待回复。比如:
 *   "请告诉我你当前在编辑什么文件" → 等待对方回复文件信息
 *
 * 实现方式:
 * 1. 发送消息，记录消息 ID
 * 2. 注册一个"等待者 (waiter)"，匹配条件: replyTo === 消息 ID
 * 3. 设置超时
 * 4. 收到匹配的回复时，resolve Promise
 * 5. 超时后，reject Promise
 *
 * 这类似于 HTTP 请求-响应，但在消息系统中需要自己实现关联逻辑。
 */

import { connect, type Socket } from 'net'
import { createSignal } from '../utils/signal.js'
import {
  encodeFrame,
  createFrameReader,
  createMessage,
  type FrameReader,
} from './inboxProtocol.js'
import type {
  InboxMessage,
  InboxMessageType,
  UDSClientConfig,
  UDSPeerInfo,
  RegisterPayload,
} from './types.js'
import {
  getDefaultSocketPath,
  DEFAULT_RECONNECT_INTERVAL,
  DEFAULT_MAX_RECONNECTS,
} from './types.js'

// ============================================================
// 消息处理器类型
// ============================================================

/**
 * 消息处理器函数签名
 *
 * 客户端收到消息时，会调用所有注册的处理器。
 * 处理器可以根据消息类型和内容决定是否处理。
 */
export type MessageHandler = (msg: InboxMessage) => void

/**
 * 请求等待者
 *
 * 用于 request() 方法的请求-响应关联。
 * 当收到 replyTo 匹配的消息时，resolve 对应的 Promise。
 */
interface PendingRequest {
  messageId: string
  resolve: (msg: InboxMessage) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// ============================================================
// InboxClient 类
// ============================================================

export class InboxClient {
  private socket: Socket | null = null
  private reader: FrameReader
  private config: UDSClientConfig

  // 连接状态
  private _connected = false
  private reconnectCount = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private isManualDisconnect = false

  // 消息处理
  private handlers: Set<MessageHandler> = new Set()
  private pendingRequests: Map<string, PendingRequest> = new Map()

  // 发送队列（连接断开时缓存发送的消息）
  private outgoingQueue: InboxMessage[] = []
  private readonly maxOutgoingQueueSize = 200

  // 事件信号
  private connectedSignal = createSignal()
  private disconnectedSignal = createSignal()
  private errorSignal = createSignal<[Error]>()

  constructor(config: Partial<UDSClientConfig> & { sessionId: string; cwd: string }) {
    this.config = {
      socketPath: config.socketPath ?? getDefaultSocketPath(),
      sessionId: config.sessionId,
      cwd: config.cwd,
      reconnectInterval: config.reconnectInterval ?? DEFAULT_RECONNECT_INTERVAL,
      maxReconnects: config.maxReconnects ?? DEFAULT_MAX_RECONNECTS,
    }

    this.reader = createFrameReader()
  }

  // ========================================================
  // 连接管理
  // ========================================================

  /**
   * 连接到 Inbox 服务端
   *
   * 连接过程:
   * 1. 创建 Unix Domain Socket 连接
   * 2. 等待连接建立
   * 3. 发送 register 消息（告诉服务端"我是谁"）
   * 4. 设置数据/错误/关闭事件处理
   *
   * 返回一个 Promise:
   * - 连接成功且注册完成: resolve
   * - 连接失败: reject
   *
   * @returns Promise<void>
   */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this._connected) {
        resolve()
        return
      }

      this.isManualDisconnect = false

      // 创建 Unix Domain Socket 连接
      // connect({ path }) 创建连接到 Unix socket 文件的客户端。
      // 这和 TCP 的 connect({ host, port }) 类似，
      // 但使用文件系统路径而非网络地址。
      this.socket = connect({ path: this.config.socketPath }, () => {
        // ---- 连接成功回调 ----
        // 连接建立后的第一件事: 注册自己
        this._connected = true
        this.reconnectCount = 0 // 重连成功，重置计数器

        // 发送注册消息
        const registerMsg = createMessage(
          this.config.sessionId,
          '__server__',
          'register' as InboxMessageType,
          {
            sessionId: this.config.sessionId,
            cwd: this.config.cwd,
            pid: process.pid,
          } satisfies RegisterPayload
        )
        this.sendRaw(registerMsg)

        // 刷新发送队列
        this.flushOutgoingQueue()

        this.connectedSignal.emit()
        resolve()
      })

      // ---- 数据到达 ----
      this.socket.on('data', (chunk: Buffer) => {
        let messages: InboxMessage[]
        try {
          messages = this.reader.push(chunk)
        } catch (err) {
          console.error('[InboxClient] 帧解析错误:', err)
          return
        }

        for (const msg of messages) {
          this.handleIncomingMessage(msg)
        }
      })

      // ---- 连接错误 ----
      // 注意: 'error' 事件之后通常会紧跟 'close' 事件。
      // 所以错误处理主要是记录日志，实际清理在 'close' 中做。
      this.socket.on('error', (err: Error) => {
        console.error('[InboxClient] 连接错误:', err.message)
        this.errorSignal.emit(err)

        // 如果是首次连接失败（还没 connected），reject Promise
        if (!this._connected) {
          reject(err)
        }
      })

      // ---- 连接关闭 ----
      this.socket.on('close', () => {
        const wasConnected = this._connected
        this._connected = false
        this.socket = null
        this.reader.reset()

        if (wasConnected) {
          this.disconnectedSignal.emit()
          console.log('[InboxClient] 连接已关闭')
        }

        // 自动重连（除非是手动断开）
        if (!this.isManualDisconnect) {
          this.scheduleReconnect()
        }
      })
    })
  }

  /**
   * 断开连接
   *
   * 手动断开，不会触发自动重连。
   *
   * 步骤:
   * 1. 标记为手动断开（阻止自动重连）
   * 2. 取消任何待执行的重连定时器
   * 3. 拒绝所有待响应的请求
   * 4. 关闭 socket
   */
  disconnect(): void {
    this.isManualDisconnect = true

    // 取消重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // 拒绝所有待响应的请求
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('客户端主动断开连接'))
    }
    this.pendingRequests.clear()

    // 关闭 socket
    if (this.socket) {
      this.socket.end()
      this.socket = null
    }

    this._connected = false
    this.reader.reset()
  }

  /**
   * 调度自动重连
   *
   * 使用固定间隔重连（可以扩展为指数退避）。
   * 超过最大重连次数后放弃。
   */
  private scheduleReconnect(): void {
    if (this.reconnectCount >= this.config.maxReconnects) {
      console.error(
        `[InboxClient] 已达最大重连次数 ${this.config.maxReconnects}，放弃重连`
      )
      return
    }

    this.reconnectCount++
    console.log(
      `[InboxClient] ${this.config.reconnectInterval}ms 后尝试第 ${this.reconnectCount} 次重连...`
    )

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch((err) => {
        console.error(
          `[InboxClient] 重连失败 (${this.reconnectCount}/${this.config.maxReconnects}):`,
          err.message
        )
        // connect() 失败后会触发 'close' 事件，'close' 处理器会再次调用 scheduleReconnect
      })
    }, this.config.reconnectInterval)

    // 重连定时器不阻止进程退出
    if (this.reconnectTimer && typeof this.reconnectTimer === 'object' && 'unref' in this.reconnectTimer) {
      ;(this.reconnectTimer as NodeJS.Timeout).unref()
    }
  }

  // ========================================================
  // 消息发送
  // ========================================================

  /**
   * 发送消息到指定会话
   *
   * 这是最基本的发送方法——"发出去就不管了 (fire-and-forget)"。
   * 不等待回复，不确认对方收到。
   *
   * 如果当前未连接，消息会被缓存到发送队列，
   * 等连接恢复后自动发送。
   *
   * @param to - 目标 session ID
   * @param type - 消息类型
   * @param payload - 消息内容
   * @returns 发送的消息对象（包含自动生成的 id）
   */
  send(to: string, type: InboxMessageType, payload: any): InboxMessage {
    const msg = createMessage(this.config.sessionId, to, type, payload)

    if (this._connected) {
      this.sendRaw(msg)
    } else {
      this.enqueueOutgoing(msg)
    }

    return msg
  }

  /**
   * 广播消息到所有在线会话
   *
   * 将 to 设为 '*'，服务端会转发给除发送者外的所有人。
   *
   * @param type - 消息类型
   * @param payload - 消息内容
   * @returns 发送的消息对象
   */
  broadcast(type: InboxMessageType, payload: any): InboxMessage {
    return this.send('*', type, payload)
  }

  /**
   * 发送请求并等待回复
   *
   * 实现"请求-响应 (request-reply)"模式:
   * 1. 发送消息
   * 2. 等待 replyTo 匹配的回复
   * 3. 超时后抛出错误
   *
   * ===== 请求-响应 vs 发送即忘 =====
   *
   * 发送即忘 (fire-and-forget): 适合通知类消息，如状态更新
   * 请求-响应 (request-reply): 适合需要结果的操作，如查询信息
   *
   * 本方法返回 Promise，可以用 await 等待回复:
   *   const reply = await client.request('session-b', 'command', { cmd: 'getStatus' })
   *   console.log(reply.payload) // 对方的状态信息
   *
   * @param to - 目标 session ID
   * @param type - 消息类型
   * @param payload - 消息内容
   * @param timeout - 超时毫秒数，默认 30000ms
   * @returns Promise<InboxMessage> 回复的消息
   * @throws 如果超时未收到回复
   */
  request(
    to: string,
    type: InboxMessageType,
    payload: any,
    timeout: number = 30_000
  ): Promise<InboxMessage> {
    const msg = this.send(to, type, payload)

    return new Promise<InboxMessage>((resolve, reject) => {
      // 设置超时定时器
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msg.id)
        reject(
          new Error(
            `请求超时: 等待 ${msg.to} 回复消息 ${msg.id} 超过 ${timeout}ms`
          )
        )
      }, timeout)

      // 注册待响应请求
      this.pendingRequests.set(msg.id, {
        messageId: msg.id,
        resolve,
        reject,
        timer,
      })
    })
  }

  /**
   * 回复一条消息
   *
   * 便利方法: 自动设置 replyTo 字段，
   * 这样对方的 request() 可以正确匹配回复。
   *
   * @param originalMsg - 要回复的原始消息
   * @param type - 回复消息的类型
   * @param payload - 回复内容
   * @returns 发送的回复消息
   */
  reply(originalMsg: InboxMessage, type: InboxMessageType, payload: any): InboxMessage {
    const msg = createMessage(
      this.config.sessionId,
      originalMsg.from,
      type,
      payload,
      originalMsg.id // replyTo 指向原始消息的 id
    )

    if (this._connected) {
      this.sendRaw(msg)
    } else {
      this.enqueueOutgoing(msg)
    }

    return msg
  }

  // ========================================================
  // 底层发送
  // ========================================================

  /**
   * 直接通过 socket 发送消息（不经过队列）
   *
   * 将消息编码为帧格式，写入 socket。
   *
   * @param msg - 要发送的消息
   */
  private sendRaw(msg: InboxMessage): void {
    if (!this.socket || !this._connected) {
      throw new Error('未连接到服务端')
    }

    const frame = encodeFrame(msg)
    this.socket.write(frame)
  }

  /**
   * 缓存消息到发送队列
   *
   * 当连接断开时，消息被缓存到队列。
   * 连接恢复后，队列中的消息会按顺序发送。
   *
   * 队列有大小限制，超出时丢弃最旧的消息。
   *
   * @param msg - 要缓存的消息
   */
  private enqueueOutgoing(msg: InboxMessage): void {
    this.outgoingQueue.push(msg)

    while (this.outgoingQueue.length > this.maxOutgoingQueueSize) {
      const discarded = this.outgoingQueue.shift()
      if (discarded) {
        console.warn(
          `[InboxClient] 发送队列已满，丢弃消息 ${discarded.id}`
        )
      }
    }
  }

  /**
   * 刷新发送队列
   *
   * 连接恢复后调用，依次发送队列中的所有消息。
   */
  private flushOutgoingQueue(): void {
    if (this.outgoingQueue.length === 0) return

    console.log(
      `[InboxClient] 刷新发送队列: ${this.outgoingQueue.length} 条消息`
    )

    // 取出队列（清空后再发，避免重复处理）
    const queue = this.outgoingQueue.splice(0)
    for (const msg of queue) {
      try {
        this.sendRaw(msg)
      } catch (err) {
        console.error(
          `[InboxClient] 刷新队列消息 ${msg.id} 失败:`,
          err
        )
        // 发送失败的消息重新放回队列
        this.outgoingQueue.push(msg)
      }
    }
  }

  // ========================================================
  // 消息接收
  // ========================================================

  /**
   * 注册消息处理器
   *
   * 收到的每条消息都会传递给所有注册的处理器。
   * 返回取消注册的函数（遵循 unsubscribe 模式）。
   *
   * 使用示例:
   *   const unsubscribe = client.onMessage((msg) => {
   *     if (msg.type === 'text') {
   *       console.log(`收到文字: ${msg.payload}`)
   *     }
   *   })
   *   // 不再需要时取消订阅
   *   unsubscribe()
   *
   * @param handler - 消息处理函数
   * @returns 取消订阅函数
   */
  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /**
   * 处理收到的消息
   *
   * 消息处理的优先级:
   * 1. 心跳: ping → 自动回复 pong（不传递给用户处理器）
   * 2. 请求回复: 如果消息的 replyTo 匹配一个待响应请求，resolve 该请求
   * 3. 用户处理器: 传递给所有注册的处理器
   */
  private handleIncomingMessage(msg: InboxMessage): void {
    // ---- 心跳处理 ----
    // 收到 ping 时自动回复 pong，对用户透明
    if (msg.type === 'ping') {
      const pong = createMessage(
        this.config.sessionId,
        msg.from,
        'pong',
        {}
      )
      if (this._connected) {
        try {
          this.sendRaw(pong)
        } catch {
          // 发送 pong 失败不是致命错误
        }
      }
      return
    }

    // ---- 请求-响应匹配 ----
    // 检查此消息是否是某个 request() 的回复
    if (msg.replyTo) {
      const pending = this.pendingRequests.get(msg.replyTo)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(msg.replyTo)
        pending.resolve(msg)
        return // 已被 request() 消费，不传递给通用处理器
      }
    }

    // ---- 通用处理器 ----
    // 将消息传递给所有注册的处理器
    for (const handler of this.handlers) {
      try {
        handler(msg)
      } catch (err) {
        console.error(
          '[InboxClient] 消息处理器抛出异常:',
          err
        )
      }
    }
  }

  // ========================================================
  // 对端查询
  // ========================================================

  /**
   * 获取所有在线对端列表
   *
   * 向服务端发送 listPeers 请求，等待回复。
   * 这是一个请求-响应操作。
   *
   * @param timeout - 超时毫秒数
   * @returns 在线对端信息数组
   */
  async listPeers(timeout: number = 5_000): Promise<UDSPeerInfo[]> {
    const reply = await this.request(
      '__server__',
      'listPeers' as InboxMessageType,
      {},
      timeout
    )
    return (reply.payload as { peers: UDSPeerInfo[] }).peers
  }

  // ========================================================
  // 事件订阅
  // ========================================================

  /**
   * 订阅连接成功事件
   *
   * @param listener - 连接成功时的回调
   * @returns 取消订阅函数
   */
  onConnected(listener: () => void): () => void {
    return this.connectedSignal.subscribe(listener)
  }

  /**
   * 订阅连接断开事件
   *
   * @param listener - 连接断开时的回调
   * @returns 取消订阅函数
   */
  onDisconnected(listener: () => void): () => void {
    return this.disconnectedSignal.subscribe(listener)
  }

  /**
   * 订阅错误事件
   *
   * @param listener - 发生错误时的回调
   * @returns 取消订阅函数
   */
  onError(listener: (err: Error) => void): () => void {
    return this.errorSignal.subscribe(listener)
  }

  // ========================================================
  // 状态查询
  // ========================================================

  /** 是否已连接 */
  get connected(): boolean {
    return this._connected
  }

  /** 本客户端的 session ID */
  get sessionId(): string {
    return this.config.sessionId
  }

  /** 发送队列中的待发消息数 */
  get pendingOutgoing(): number {
    return this.outgoingQueue.length
  }

  /** 待响应的请求数 */
  get pendingRequestCount(): number {
    return this.pendingRequests.size
  }

  // ========================================================
  // 资源清理
  // ========================================================

  /**
   * 销毁客户端
   *
   * 清理所有资源: 断开连接、取消定时器、清空处理器。
   * 在 claude-code 会话结束时调用。
   */
  destroy(): void {
    this.disconnect()
    this.handlers.clear()
    this.outgoingQueue.length = 0
    this.connectedSignal.clear()
    this.disconnectedSignal.clear()
    this.errorSignal.clear()
  }
}

// ============================================================
// 便利函数: 创建并连接客户端
// ============================================================

/**
 * 创建并连接一个 Inbox 客户端
 *
 * 使用方式:
 *   const client = await connectInboxClient({
 *     sessionId: 'my-session-123',
 *     cwd: process.cwd(),
 *   })
 *
 *   client.onMessage((msg) => {
 *     console.log('收到消息:', msg)
 *   })
 *
 *   client.send('other-session', 'text', { text: '你好!' })
 *
 *   // 结束时:
 *   client.destroy()
 *
 * @param config - 客户端配置（必须提供 sessionId 和 cwd）
 * @returns 已连接的客户端实例
 */
export async function connectInboxClient(
  config: Partial<UDSClientConfig> & { sessionId: string; cwd: string }
): Promise<InboxClient> {
  const client = new InboxClient(config)
  await client.connect()
  return client
}
