/**
 * 本地 Bridge — 通过 claude-code-haha-server 实现手机远程操控
 *
 * 原始 Bridge 系统（bridgeMain.ts, replBridge.ts）依赖 Anthropic 云端。
 * 本地 Bridge 通过自建的 claude-code-haha-server 实现相同功能，
 * 无需 Anthropic 账号，支持纯本地部署。
 *
 * 工作原理：
 * ──────────
 *   手机浏览器                 Server                    本地 Claude Code
 *   ┌─────────┐          ┌──────────────┐           ┌──────────────┐
 *   │ Web UI  │◄─WS────►│ /ws/bridge/  │◄────WS───►│ LocalBridge  │
 *   │         │          │ {sessionId}  │           │              │
 *   │ 发消息   │──POST──►│ /api/bridge/ │───转发───►│ 处理消息     │
 *   │ 看结果   │◄─WS────│ sessions/msg │◄──推送───│ 返回结果     │
 *   │ 传文件   │──POST──►│ /file        │───保存───►│ 接收文件     │
 *   └─────────┘          └──────────────┘           └──────────────┘
 *
 * 使用流程：
 * ──────────
 *   1. 启动 claude-code-haha-server (bun run server/src/index.ts)
 *   2. 在 Claude Code 中执行 /bridge 或 localBridge.connect()
 *   3. 生成 QR 码（包含 session URL）
 *   4. 手机扫描 QR 码，打开 Web UI
 *   5. 开始远程交互
 */

import { randomUUID } from 'crypto'

// ─────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────

export interface LocalBridgeConfig {
  /** claude-code-haha-server 的地址 */
  serverUrl: string
  /** 工作目录 */
  cwd: string
  /** 会话标题 */
  title?: string
}

export interface LocalBridgeSession {
  /** 会话 ID */
  sessionId: string
  /** 用于手机端连接的 token */
  accessToken: string
  /** 手机端访问 URL */
  url: string
  /** QR 码内容（URL） */
  qrContent: string
}

export type LocalBridgeMessageHandler = (message: {
  type: 'user_message' | 'file_upload' | 'control'
  content: string
  metadata?: Record<string, unknown>
}) => void

// ─────────────────────────────────────────────
// 本地 Bridge 客户端
// ─────────────────────────────────────────────

/**
 * LocalBridge — 连接到 claude-code-haha-server 的 Bridge 客户端
 *
 * 每个 Claude Code 实例创建一个 LocalBridge，
 * 注册到 server 后等待手机端连接。
 */
export class LocalBridge {
  private config: LocalBridgeConfig
  private ws: WebSocket | null = null
  private session: LocalBridgeSession | null = null
  private messageHandler: LocalBridgeMessageHandler | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private connected = false

  constructor(config: LocalBridgeConfig) {
    this.config = config
  }

  /**
   * 创建 Bridge 会话并连接到 Server
   *
   * 返回会话信息（包含 QR 码内容），供用户扫码连接。
   */
  async connect(): Promise<LocalBridgeSession | null> {
    try {
      // 第一步：在 server 上创建 bridge 会话
      const response = await fetch(`${this.config.serverUrl}/api/bridge/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: this.config.cwd,
          title: this.config.title || `Claude Code @ ${this.config.cwd}`,
        }),
      })

      if (!response.ok) {
        console.error(`[bridge] 创建会话失败: ${response.status}`)
        return null
      }

      const data = await response.json() as any

      this.session = {
        sessionId: data.sessionId || data.id,
        accessToken: data.token || data.accessToken,
        url: `${this.config.serverUrl}/bridge/${data.sessionId || data.id}`,
        qrContent: `${this.config.serverUrl}/bridge/${data.sessionId || data.id}?token=${data.token || data.accessToken}`,
      }

      // 第二步：建立 WebSocket 连接
      this.connectWebSocket()

      console.log(`[bridge] 会话已创建: ${this.session.sessionId}`)
      console.log(`[bridge] 手机访问: ${this.session.url}`)

      return this.session

    } catch (error) {
      console.error('[bridge] 连接失败:', error)
      return null
    }
  }

  /**
   * 建立 WebSocket 连接到 server
   */
  private connectWebSocket(): void {
    if (!this.session) return

    const wsUrl = this.config.serverUrl
      .replace('http://', 'ws://')
      .replace('https://', 'wss://')

    const url = `${wsUrl}/ws/bridge/${this.session.sessionId}?role=cli&token=${this.session.accessToken}`

    try {
      this.ws = new WebSocket(url)

      this.ws.onopen = () => {
        this.connected = true
        this.reconnectAttempts = 0
        console.log('[bridge] WebSocket 已连接')
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data))
          this.handleIncoming(data)
        } catch (e) {
          console.error('[bridge] 消息解析失败:', e)
        }
      }

      this.ws.onclose = (event) => {
        this.connected = false
        console.log(`[bridge] WebSocket 断开: ${event.code} ${event.reason}`)

        // 自动重连
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
          this.reconnectTimer = setTimeout(() => {
            this.reconnectAttempts++
            this.connectWebSocket()
          }, delay)
        }
      }

      this.ws.onerror = (error) => {
        console.error('[bridge] WebSocket 错误:', error)
      }

    } catch (error) {
      console.error('[bridge] WebSocket 连接失败:', error)
    }
  }

  /**
   * 处理从 server 收到的消息
   */
  private handleIncoming(data: any): void {
    switch (data.type) {
      case 'user_message':
        // 手机端发来的用户消息
        this.messageHandler?.({
          type: 'user_message',
          content: data.content || data.message,
          metadata: data.metadata,
        })
        break

      case 'file_upload':
        // 手机端上传的文件
        this.messageHandler?.({
          type: 'file_upload',
          content: data.filePath || data.content,
          metadata: { fileName: data.fileName, fileSize: data.fileSize },
        })
        break

      case 'control':
        // 控制命令（中断、模式切换等）
        this.messageHandler?.({
          type: 'control',
          content: data.action || data.content,
          metadata: data.metadata,
        })
        break

      case 'ping':
        // 心跳响应
        this.send({ type: 'pong' })
        break
    }
  }

  /**
   * 发送消息到手机端（通过 server 中转）
   */
  send(data: any): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(data))
    }
  }

  /**
   * 发送 Claude 的响应到手机端
   */
  sendResponse(content: string, metadata?: Record<string, unknown>): void {
    this.send({
      type: 'assistant_message',
      content,
      metadata,
      timestamp: Date.now(),
    })
  }

  /**
   * 发送工具调用信息到手机端（让用户看到执行过程）
   */
  sendToolUse(toolName: string, input: any, result?: string): void {
    this.send({
      type: 'tool_use',
      toolName,
      input,
      result,
      timestamp: Date.now(),
    })
  }

  /**
   * 发送权限请求到手机端
   */
  sendPermissionRequest(toolName: string, input: any): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = randomUUID()
      this.send({
        type: 'permission_request',
        requestId,
        toolName,
        input,
        timestamp: Date.now(),
      })

      // 等待手机端回复（超时 60 秒自动拒绝）
      const timeout = setTimeout(() => {
        resolve(false)
      }, 60_000)

      // 临时监听器等待回复
      const originalHandler = this.messageHandler
      this.messageHandler = (msg) => {
        if (msg.type === 'control' && msg.metadata?.requestId === requestId) {
          clearTimeout(timeout)
          this.messageHandler = originalHandler
          resolve(msg.content === 'allow')
        } else {
          originalHandler?.(msg)
        }
      }
    })
  }

  /**
   * 注册消息处理器
   */
  onMessage(handler: LocalBridgeMessageHandler): void {
    this.messageHandler = handler
  }

  /**
   * 生成 QR 码（用于终端显示）
   *
   * 使用 qrcode 库生成 ASCII QR 码，
   * 用户用手机扫描后即可连接。
   */
  async getQRCode(): Promise<string> {
    if (!this.session) return 'No session'

    try {
      const qrcode = await import('qrcode')
      const qr = await qrcode.toString(this.session.qrContent, {
        type: 'terminal',
        small: true,
      })
      return qr
    } catch {
      return `手机访问: ${this.session.qrContent}`
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting')
      this.ws = null
    }

    this.connected = false
    this.session = null
    console.log('[bridge] 已断开连接')
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.connected
  }

  /** 获取当前会话信息 */
  getSession(): LocalBridgeSession | null {
    return this.session
  }
}
