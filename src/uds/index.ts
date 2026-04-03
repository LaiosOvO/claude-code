/**
 * UDS Inbox 模块 - 统一导出
 *
 * 本模块使用 Unix Domain Socket 实现跨 claude-code 会话的消息传递。
 * 替代原有的文件轮询 (file polling) 方案，提供更低延迟、更好原子性的 IPC 通信。
 *
 * ===== 模块结构 =====
 *
 * types.ts         - 类型定义（消息、配置、对端信息）
 * inboxProtocol.ts - 线路协议（帧编码/解码、消息创建）
 * inboxRegistry.ts - 对端注册表（连接追踪、僵尸清理）
 * inboxServer.ts   - 服务端（消息路由、离线缓冲、心跳检测）
 * inboxClient.ts   - 客户端（连接管理、自动重连、请求-响应）
 *
 * ===== 快速开始 =====
 *
 * 启动服务端 (通常由 daemon 或第一个 claude 实例启动):
 *
 *   import { startInboxServer } from './uds/index.js'
 *   const server = await startInboxServer()
 *
 * 连接客户端 (每个 claude 会话):
 *
 *   import { connectInboxClient } from './uds/index.js'
 *   const client = await connectInboxClient({
 *     sessionId: 'session-abc',
 *     cwd: '/path/to/project',
 *   })
 *
 *   // 接收消息
 *   client.onMessage((msg) => {
 *     console.log(`[${msg.from}] ${msg.type}:`, msg.payload)
 *   })
 *
 *   // 发送消息
 *   client.send('session-xyz', 'text', { text: '你好!' })
 *
 *   // 请求-响应
 *   const reply = await client.request('session-xyz', 'command', { cmd: 'status' })
 *
 *   // 广播
 *   client.broadcast('status', { state: 'busy' })
 *
 *   // 查看在线对端
 *   const peers = await client.listPeers()
 *
 *   // 清理
 *   client.destroy()
 *   await server.stop()
 */

// ---- 类型导出 ----
export type {
  InboxMessageType,
  InboxMessage,
  UDSPeerInfo,
  UDSServerConfig,
  UDSClientConfig,
  RegisterPayload,
  ListPeersPayload,
} from './types.js'

export {
  getDefaultSocketPath,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MESSAGE_TIMEOUT,
  DEFAULT_RECONNECT_INTERVAL,
  DEFAULT_MAX_RECONNECTS,
  OFFLINE_BUFFER_MAX,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TIMEOUT,
} from './types.js'

// ---- 协议导出 ----
export {
  encodeFrame,
  decodeFrame,
  createFrameReader,
  generateMessageId,
  createMessage,
} from './inboxProtocol.js'

export type { FrameReader } from './inboxProtocol.js'

// ---- 注册表导出 ----
export { InboxRegistry } from './inboxRegistry.js'
export type { GenericSocket } from './inboxRegistry.js'

// ---- 服务端导出 ----
export { InboxServer, startInboxServer } from './inboxServer.js'

// ---- 客户端导出 ----
export { InboxClient, connectInboxClient } from './inboxClient.js'
export type { MessageHandler } from './inboxClient.js'
