/**
 * UDS Inbox 类型定义
 *
 * Unix Domain Socket (UDS) 是一种进程间通信 (IPC) 机制，
 * 它使用文件系统路径作为地址，而非 TCP/IP 的 host:port。
 *
 * 相比文件轮询 (file polling) 方案:
 *   - 延迟更低: 消息通过内核缓冲区直接传递，无需写盘再读取
 *   - 原子性更好: 不会出现读到"写了一半的文件"的情况
 *   - 流式传输: 支持持续双向数据流，而非"写-读-删"的离散操作
 *   - 实时投递: 消息到达即通知，无需轮询间隔
 *
 * 本模块定义了 UDS 消息系统的核心类型。
 */

// ============================================================
// 消息类型枚举
// ============================================================

/**
 * UDS 消息类型
 *
 * 设计说明: 使用字符串联合类型而非 enum，
 * 这样在 JSON 序列化时更友好，也便于调试时阅读。
 *
 * 消息类型分为三类:
 * 1. 业务消息: text, command, file, context
 * 2. 协调消息: permission, status, broadcast
 * 3. 基础设施消息: ping, pong (心跳检测)
 */
export type InboxMessageType =
  | 'text'       // 普通文本消息 - 最常见的消息类型，用于会话间传递文字信息
  | 'command'    // 命令消息 - 请求另一个会话执行特定操作（如"运行测试"、"重新加载配置"）
  | 'file'       // 文件传输 - 在会话间传递文件内容（内联编码，非文件路径引用）
  | 'context'    // 上下文共享 - 共享当前工作上下文（如当前文件、光标位置、诊断信息）
  | 'permission' // 权限请求/响应 - 一个会话请求另一个会话授权某项操作
  | 'status'     // 状态更新 - 通知其他会话当前的工作状态（空闲、忙碌、等待输入等）
  | 'broadcast'  // 广播消息 - 发送给所有已连接会话的通知
  | 'ping'       // 心跳探测 - 检查对端是否仍然存活。服务端定期发送以清理死连接
  | 'pong'       // 心跳响应 - 收到 ping 后必须回复 pong，否则被视为断开连接
  | 'register'   // 内部协议: 客户端连接后的注册握手消息
  | 'listPeers'  // 内部协议: 请求服务端返回在线对端列表

// ============================================================
// 核心消息结构
// ============================================================

/**
 * UDS 消息
 *
 * 这是通过 Unix Domain Socket 传输的消息的统一结构。
 * 设计遵循"信封模式 (envelope pattern)"——消息元数据（from, to, type）
 * 与消息内容（payload）分离，便于路由和过滤。
 *
 * 字段说明:
 * - id: UUID v4，全局唯一标识。用于去重、确认、日志追踪
 * - from: 发送者的 session ID。每个 claude-code 实例有唯一的 session ID
 * - to: 接收者的 session ID，或 '*' 表示广播给所有会话
 * - type: 消息类型，决定 payload 的结构和处理逻辑
 * - payload: 消息内容，类型由 type 字段隐含。使用 any 以保持灵活性
 * - timestamp: Unix 时间戳 (毫秒)，用于消息排序和过期检测
 * - replyTo: 可选，表示此消息是对某条消息的回复。
 *   这实现了"请求-响应"模式: 发送者发出消息后可以等待 replyTo === 自己消息 id 的回复
 */
export interface InboxMessage {
  id: string
  from: string
  to: string | '*'
  type: InboxMessageType
  payload: any
  timestamp: number
  replyTo?: string
}

// ============================================================
// 连接/节点信息
// ============================================================

/**
 * UDS 对端信息 (Peer Info)
 *
 * 每个连接到 Inbox 服务端的 claude-code 会话都是一个"对端"。
 * 服务端维护一个注册表 (registry) 记录所有活跃对端的信息。
 *
 * 这些信息用于:
 * - sessionId: 消息路由的唯一标识
 * - cwd: 让用户知道各个会话在哪个目录工作（可用于"发送给同目录的会话"）
 * - pid: 进程 ID，可用于检测进程是否仍存活 (kill -0 pid)
 * - connectedAt: 连接建立时间，用于 UI 显示
 * - lastActivity: 最后活动时间，用于检测和清理"僵尸连接"
 */
export interface UDSPeerInfo {
  sessionId: string
  cwd: string
  pid: number
  connectedAt: number
  lastActivity: number
}

// ============================================================
// 配置类型
// ============================================================

/**
 * UDS 服务端配置
 *
 * Unix Domain Socket 服务端是整个消息系统的中心枢纽 (hub)。
 * 它监听一个 socket 文件，接受客户端连接，并负责消息路由。
 *
 * 关于 socketPath:
 *   UDS 使用文件系统路径作为地址。默认路径 ~/.claude/inbox.sock
 *   是一个特殊文件（类型为 socket），不是普通文件。
 *   注意: Unix 系统对 socket 路径有长度限制（通常 104-108 字节），
 *   所以路径不宜太深。
 */
export interface UDSServerConfig {
  socketPath: string       // Socket 文件路径，默认 ~/.claude/inbox.sock
  maxConnections: number   // 最大并发连接数，默认 50
  messageTimeout: number   // 消息超时时间 (毫秒)，默认 30000ms
}

/**
 * UDS 客户端配置
 *
 * 每个 claude-code 会话创建一个客户端连接到服务端。
 * 客户端负责:
 * 1. 与服务端建立连接
 * 2. 发送/接收消息
 * 3. 在连接断开时自动重连
 *
 * 关于自动重连:
 *   网络编程中，连接随时可能断开（服务端重启、系统资源不足等）。
 *   健壮的客户端应该自动重连，但要有退避策略 (backoff)，
 *   避免在服务端不可用时疯狂重试浪费资源。
 *   maxReconnects 设置上限，超过后放弃并通知上层。
 */
export interface UDSClientConfig {
  socketPath: string          // 要连接的 Socket 文件路径
  sessionId: string           // 本会话的唯一标识
  cwd: string                 // 本会话的工作目录
  reconnectInterval: number   // 重连间隔 (毫秒)，默认 5000ms
  maxReconnects: number       // 最大重连次数，默认 10
}

// ============================================================
// 内部协议消息
// ============================================================

/**
 * 注册消息 payload
 *
 * 当客户端连接到服务端后，第一条消息必须是 "register" 类型。
 * 这相当于"握手 (handshake)"——告诉服务端"我是谁"。
 *
 * 类比: 就像进入一个聊天室，先要告诉服务器你的昵称。
 */
export interface RegisterPayload {
  sessionId: string
  cwd: string
  pid: number
}

/**
 * 列出对端的响应 payload
 *
 * 客户端可以请求服务端返回所有已连接的对端列表。
 * 这用于 UI 展示"当前有哪些会话在线"。
 */
export interface ListPeersPayload {
  peers: UDSPeerInfo[]
}

// ============================================================
// 默认配置常量
// ============================================================

/**
 * 获取默认的 socket 路径
 *
 * 放在 ~/.claude/ 目录下，与项目的其他配置文件一致。
 * 使用 HOME 环境变量确保跨用户兼容。
 */
export function getDefaultSocketPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  return `${home}/.claude/inbox.sock`
}

/** 默认最大连接数 */
export const DEFAULT_MAX_CONNECTIONS = 50

/** 默认消息超时 (30 秒) */
export const DEFAULT_MESSAGE_TIMEOUT = 30_000

/** 默认重连间隔 (5 秒) */
export const DEFAULT_RECONNECT_INTERVAL = 5_000

/** 默认最大重连次数 */
export const DEFAULT_MAX_RECONNECTS = 10

/**
 * 离线消息缓冲区大小
 *
 * 当目标会话暂时离线时，服务端会将消息存入缓冲区。
 * 但缓冲区不能无限增长（会耗尽内存），所以设置上限。
 * 超过上限时，丢弃最旧的消息 (FIFO eviction)。
 */
export const OFFLINE_BUFFER_MAX = 100

/**
 * 心跳间隔 (15 秒)
 *
 * 服务端每 15 秒向所有客户端发送 ping。
 * 如果客户端在两个心跳周期内没有回复 pong，
 * 则认为连接已断开，清理该连接。
 */
export const HEARTBEAT_INTERVAL = 15_000

/**
 * 心跳超时 (30 秒 = 2 个心跳周期)
 *
 * 超过此时间未收到 pong，则判定连接死亡。
 */
export const HEARTBEAT_TIMEOUT = 30_000
