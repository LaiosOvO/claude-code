/**
 * Teleport 本地模块 — 类型定义
 *
 * Teleport 实现了"把跑了一半的任务连同上下文打包传输到另一台机器继续执行"。
 *
 * 与云端 Teleport 的区别：
 * ──────────────────────
 * 云端 Teleport (src/utils/teleport.tsx): 通过 Anthropic 后端中转，需要登录
 * 本地 Teleport (这个模块): 直接打包为文件，通过 HTTP/SCP/USB 传输，无需云端
 *
 * 打包内容：
 * ─────────
 *   TeleportPackage = {
 *     session:   对话历史 + 系统提示词 + 模型配置
 *     workspace: 工作目录状态 (git diff, 修改文件快照)
 *     tools:     工具配置 + 权限
 *     tasks:     运行中的任务状态
 *   }
 *
 *   打包 → 压缩 → 校验和 → .teleport.gz 文件
 */

// ─────────────────────────────────────────────
// 核心包类型
// ─────────────────────────────────────────────

/** Teleport 包的完整数据结构 */
export interface TeleportPackage {
  /** 包唯一标识 (UUID) */
  id: string

  /** 协议版本。用于向后兼容检查。 */
  version: string

  /** 创建时间 (Unix ms) */
  createdAt: number

  /** 源机器主机名 */
  sourceHost: string

  /** 源进程 PID */
  sourcePid: number

  /** 包描述（可选，用户备注） */
  description?: string

  /** 会话上下文 */
  session: TeleportSession

  /** 工作区状态 */
  workspace: TeleportWorkspace

  /** 工具配置 */
  tools: TeleportToolState

  /** 任务状态 */
  tasks: TeleportTaskState

  /** 是否已压缩 */
  compressed: boolean

  /** SHA-256 校验和（对压缩前的 JSON 计算） */
  checksum: string

  /** 包大小（字节） */
  size: number
}

// ─────────────────────────────────────────────
// 会话上下文
// ─────────────────────────────────────────────

export interface TeleportSession {
  /** 会话 ID */
  id: string

  /** 完整消息历史（序列化后） */
  messages: SerializedMessage[]

  /** 系统提示词 */
  systemPrompt: string

  /** 追加系统提示词 */
  appendSystemPrompt?: string

  /** 使用的模型 */
  model: string

  /** Token 使用统计 */
  tokenUsage: TeleportTokenUsage

  /** 会话创建时间 */
  sessionStartTime: number

  /** 对话轮次数 */
  turnCount: number
}

/**
 * 序列化消息
 *
 * 消息包含多种内容块类型（文本、工具调用、工具结果、图片等），
 * 序列化时需要特殊处理：
 * - 文本块：直接 JSON 序列化
 * - 图片块：base64 编码后内联或引用外部文件
 * - 工具调用块：保留完整的 input/output
 * - 大内容（>1MB）：存储为外部文件引用
 */
export interface SerializedMessage {
  /** 消息角色 */
  role: 'user' | 'assistant' | 'system'

  /** 序列化后的内容 */
  content: SerializedContentBlock[]

  /** 消息元数据 */
  metadata?: Record<string, unknown>

  /** 消息时间戳 */
  timestamp?: number
}

export type SerializedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; media_type: string; data: string } // base64
  | { type: 'file_ref'; path: string; size: number } // 大文件引用

export interface TeleportTokenUsage {
  inputTokens: number
  outputTokens: number
  totalCostUsd: number
}

// ─────────────────────────────────────────────
// 工作区状态
// ─────────────────────────────────────────────

export interface TeleportWorkspace {
  /** 工作目录路径（源机器上的） */
  cwd: string

  /** Git 分支名 */
  gitBranch?: string

  /** Git 远程仓库 URL */
  gitRemote?: string

  /** 最新 commit hash */
  gitHead?: string

  /**
   * Git diff（未提交的更改）
   * 包含 staged 和 unstaged 的变更。
   * 这是恢复工作区状态的关键。
   */
  gitDiff?: string

  /** Git stash 内容（如果有的话） */
  gitStash?: string

  /**
   * 修改过的文件快照
   * 对于无法通过 git diff 恢复的文件（如新建的未跟踪文件），
   * 直接保存文件内容的快照。
   */
  modifiedFiles: FileSnapshot[]

  /**
   * .claude/CLAUDE.md 内容
   * 项目级别的 AI 配置，需要随 teleport 迁移。
   */
  claudeMd?: string
}

/** 文件快照 */
export interface FileSnapshot {
  /** 相对路径（相对于 cwd） */
  path: string
  /** 文件内容 */
  content: string
  /** 文件是否是二进制 */
  isBinary: boolean
  /** 文件大小（字节） */
  size: number
  /** 文件状态 */
  status: 'added' | 'modified' | 'deleted'
}

// ─────────────────────────────────────────────
// 工具与权限状态
// ─────────────────────────────────────────────

export interface TeleportToolState {
  /** 活跃的工具名列表 */
  activeTools: string[]

  /** MCP 服务器配置 */
  mcpServers: TeleportMcpConfig[]

  /** 权限快照 */
  permissions: TeleportPermissionSnapshot
}

export interface TeleportMcpConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface TeleportPermissionSnapshot {
  mode: string // 'default' | 'auto' | 'bypass'
  alwaysAllow: string[]
  alwaysDeny: string[]
}

// ─────────────────────────────────────────────
// 任务状态
// ─────────────────────────────────────────────

export interface TeleportTaskState {
  /** 正在运行的任务（将被暂停/恢复） */
  running: TeleportTaskSnapshot[]
  /** 等待中的任务 */
  pending: TeleportTaskSnapshot[]
}

export interface TeleportTaskSnapshot {
  id: string
  type: string
  description: string
  status: string
  prompt?: string
}

// ─────────────────────────────────────────────
// 传输相关
// ─────────────────────────────────────────────

/** 传输方式 */
export type TransferMethod = 'file' | 'http' | 'direct'

/** 传输进度 */
export interface TransferProgress {
  /** 已传输字节数 */
  transferred: number
  /** 总字节数 */
  total: number
  /** 传输速率 (bytes/sec) */
  speed: number
  /** 预估剩余时间 (秒) */
  eta: number
}

/** 传输配置 */
export interface TransferConfig {
  method: TransferMethod
  /** HTTP 传输的服务器地址 */
  serverUrl?: string
  /** 直连传输的目标地址 */
  targetHost?: string
  /** 直连传输的端口 */
  targetPort?: number
}

// ─────────────────────────────────────────────
// Unpack 结果
// ─────────────────────────────────────────────

export interface UnpackResult {
  success: boolean
  /** 恢复的会话 ID（可能是新的） */
  sessionId: string
  /** 恢复的消息数 */
  messageCount: number
  /** 恢复的文件数 */
  fileCount: number
  /** 警告信息 */
  warnings: string[]
  /** 错误信息 */
  errors: string[]
}

// ─────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────

/** 协议版本 */
export const TELEPORT_VERSION = '1.0.0'

/** 文件扩展名 */
export const TELEPORT_EXTENSION = '.teleport.gz'

/** 存储目录（相对于 ~/.claude/） */
export const TELEPORT_DIR = 'teleport'

/** 单个文件快照的最大大小 (5MB) */
export const MAX_FILE_SNAPSHOT_SIZE = 5 * 1024 * 1024

/** 整个包的最大大小 (100MB) */
export const MAX_PACKAGE_SIZE = 100 * 1024 * 1024
