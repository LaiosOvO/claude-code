/**
 * Teleport 打包器 — 将当前会话状态打包为可传输的文件
 *
 * 打包流程：
 * ─────────
 *   1. 序列化消息历史 (messages → JSON)
 *   2. 捕获 Git 状态 (branch, diff, stash)
 *   3. 快照修改的文件
 *   4. 记录工具和权限配置
 *   5. 记录运行中的任务
 *   6. 组装 TeleportPackage 对象
 *   7. 计算 SHA-256 校验和
 *   8. Gzip 压缩
 *   9. 保存到 ~/.claude/teleport/{id}.teleport.gz
 *
 * 设计考虑：
 * ──────────
 * - 大文件处理：超过 MAX_FILE_SNAPSHOT_SIZE 的文件不打包，只记录路径
 * - 二进制文件：检测二进制文件并 base64 编码
 * - 敏感信息：排除 .env、credentials.json 等敏感文件
 * - 原子性：先写临时文件，再 rename，防止中途失败产生损坏文件
 */

import { createHash } from 'crypto'
import { randomUUID } from 'crypto'
import { hostname } from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import { gzipSync } from 'zlib'
import type {
  TeleportPackage,
  TeleportSession,
  TeleportWorkspace,
  TeleportToolState,
  TeleportTaskState,
  SerializedMessage,
  SerializedContentBlock,
  FileSnapshot,
} from './types'
import {
  TELEPORT_VERSION,
  TELEPORT_EXTENSION,
  TELEPORT_DIR,
  MAX_FILE_SNAPSHOT_SIZE,
  MAX_PACKAGE_SIZE,
} from './types'

const execAsync = promisify(exec)

// ─────────────────────────────────────────────
// 敏感文件模式（不打包）
// ─────────────────────────────────────────────
const SENSITIVE_PATTERNS = [
  '.env', '.env.local', '.env.production',
  'credentials.json', 'serviceAccountKey.json',
  '.ssh/', '.gnupg/',
  '*.pem', '*.key', '*.p12',
  '.npmrc', '.pypirc',
]

/**
 * 检查文件是否是敏感文件
 */
function isSensitiveFile(path: string): boolean {
  return SENSITIVE_PATTERNS.some(pattern => {
    if (pattern.endsWith('/')) return path.includes(pattern)
    if (pattern.startsWith('*')) return path.endsWith(pattern.slice(1))
    return path.includes(pattern)
  })
}

/**
 * 检查内容是否是二进制
 * 简单启发式：检查前 8KB 是否包含 null 字节
 */
function isBinaryContent(content: Buffer): boolean {
  const sample = content.subarray(0, 8192)
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true
  }
  return false
}

// ─────────────────────────────────────────────
// 打包选项
// ─────────────────────────────────────────────

export interface PackOptions {
  /** 工作目录 */
  cwd: string
  /** 会话 ID */
  sessionId: string
  /** 消息历史（原始格式） */
  messages: any[]
  /** 系统提示词 */
  systemPrompt: string
  /** 追加系统提示词 */
  appendSystemPrompt?: string
  /** 模型名称 */
  model: string
  /** Token 使用情况 */
  tokenUsage?: { inputTokens: number; outputTokens: number; totalCostUsd: number }
  /** 活跃的工具名列表 */
  activeTools?: string[]
  /** 权限模式 */
  permissionMode?: string
  /** 允许的工具 */
  alwaysAllow?: string[]
  /** 拒绝的工具 */
  alwaysDeny?: string[]
  /** 运行中的任务 */
  runningTasks?: any[]
  /** 待执行的任务 */
  pendingTasks?: any[]
  /** 包描述 */
  description?: string
}

// ─────────────────────────────────────────────
// 打包器
// ─────────────────────────────────────────────

/**
 * 打包当前会话上下文
 *
 * @returns 打包后的文件路径，或 null（如果打包失败）
 */
export async function packSession(options: PackOptions): Promise<{
  filePath: string
  package: TeleportPackage
} | null> {
  const id = randomUUID()
  console.log(`[teleport] 开始打包会话 ${options.sessionId.slice(0, 8)} → 包 ID: ${id.slice(0, 8)}`)

  try {
    // ===== 第一步：序列化消息 =====
    const messages = serializeMessages(options.messages)
    console.log(`[teleport]   消息: ${messages.length} 条`)

    // ===== 第二步：捕获 Git 状态 =====
    const workspace = await captureWorkspace(options.cwd)
    console.log(`[teleport]   Git: ${workspace.gitBranch || 'N/A'} | 修改文件: ${workspace.modifiedFiles.length}`)

    // ===== 第三步：组装工具状态 =====
    const tools: TeleportToolState = {
      activeTools: options.activeTools || [],
      mcpServers: [], // MCP 配置需要在目标机器重新配置
      permissions: {
        mode: options.permissionMode || 'default',
        alwaysAllow: options.alwaysAllow || [],
        alwaysDeny: options.alwaysDeny || [],
      },
    }

    // ===== 第四步：组装任务状态 =====
    const tasks: TeleportTaskState = {
      running: (options.runningTasks || []).map(t => ({
        id: t.id,
        type: t.type,
        description: t.description,
        status: t.status,
        prompt: t.prompt,
      })),
      pending: (options.pendingTasks || []).map(t => ({
        id: t.id,
        type: t.type,
        description: t.description,
        status: t.status,
        prompt: t.prompt,
      })),
    }

    // ===== 第五步：组装会话 =====
    const session: TeleportSession = {
      id: options.sessionId,
      messages,
      systemPrompt: options.systemPrompt,
      appendSystemPrompt: options.appendSystemPrompt,
      model: options.model,
      tokenUsage: options.tokenUsage || { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 },
      sessionStartTime: Date.now(),
      turnCount: messages.filter(m => m.role === 'user').length,
    }

    // ===== 第六步：组装完整包 =====
    const pkg: TeleportPackage = {
      id,
      version: TELEPORT_VERSION,
      createdAt: Date.now(),
      sourceHost: hostname(),
      sourcePid: process.pid,
      description: options.description,
      session,
      workspace,
      tools,
      tasks,
      compressed: true,
      checksum: '', // 后面计算
      size: 0,      // 后面计算
    }

    // ===== 第七步：JSON 序列化 + 校验和 =====
    const json = JSON.stringify(pkg)
    pkg.checksum = createHash('sha256').update(json).digest('hex')
    // 更新校验和后重新序列化
    const finalJson = JSON.stringify({ ...pkg, checksum: pkg.checksum })

    // 大小检查
    if (Buffer.byteLength(finalJson) > MAX_PACKAGE_SIZE) {
      console.error(`[teleport] 包大小超过限制 (${MAX_PACKAGE_SIZE / 1024 / 1024}MB)`)
      return null
    }

    // ===== 第八步：Gzip 压缩 =====
    const compressed = gzipSync(Buffer.from(finalJson))
    pkg.size = compressed.length

    // ===== 第九步：保存到文件 =====
    const dir = `${process.env.HOME}/.claude/${TELEPORT_DIR}`
    await Bun.write(`${dir}/.gitkeep`, '') // 确保目录存在
    const filePath = `${dir}/${id}${TELEPORT_EXTENSION}`
    const tmpPath = `${filePath}.tmp`

    // 原子写入：先写临时文件，再 rename
    await Bun.write(tmpPath, compressed)
    const { rename } = await import('fs/promises')
    await rename(tmpPath, filePath)

    console.log(`[teleport] 打包完成: ${filePath}`)
    console.log(`[teleport]   大小: ${(compressed.length / 1024).toFixed(1)} KB`)
    console.log(`[teleport]   校验和: ${pkg.checksum.slice(0, 16)}...`)

    return { filePath, package: pkg }

  } catch (error) {
    console.error('[teleport] 打包失败:', error)
    return null
  }
}

// ─────────────────────────────────────────────
// 消息序列化
// ─────────────────────────────────────────────

/**
 * 序列化消息历史
 *
 * 处理各种内容块类型：
 * - 文本 → 直接保存
 * - 工具调用 → 保存 name + input
 * - 工具结果 → 保存内容（可能是大文本，截断处理）
 * - 图片 → base64 编码（可能很大，需要限制）
 */
function serializeMessages(messages: any[]): SerializedMessage[] {
  return messages.map(msg => {
    const serialized: SerializedMessage = {
      role: msg.role || 'user',
      content: [],
      timestamp: msg.timestamp || Date.now(),
    }

    const content = msg.content
    if (typeof content === 'string') {
      serialized.content = [{ type: 'text', text: content }]
    } else if (Array.isArray(content)) {
      serialized.content = content.map((block: any): SerializedContentBlock => {
        switch (block.type) {
          case 'text':
            return { type: 'text', text: block.text }
          case 'tool_use':
            return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
          case 'tool_result':
            return {
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: typeof block.content === 'string'
                ? block.content.slice(0, 50000) // 截断大结果
                : JSON.stringify(block.content).slice(0, 50000),
              is_error: block.is_error,
            }
          case 'image':
            return {
              type: 'image',
              media_type: block.source?.media_type || 'image/png',
              data: block.source?.data || '',
            }
          default:
            return { type: 'text', text: JSON.stringify(block) }
        }
      })
    }

    return serialized
  })
}

// ─────────────────────────────────────────────
// 工作区状态捕获
// ─────────────────────────────────────────────

/**
 * 捕获当前工作区的 Git 状态和修改文件
 */
async function captureWorkspace(cwd: string): Promise<TeleportWorkspace> {
  const workspace: TeleportWorkspace = {
    cwd,
    modifiedFiles: [],
  }

  try {
    // Git 分支
    const { stdout: branch } = await execAsync('git branch --show-current', { cwd })
    workspace.gitBranch = branch.trim()

    // Git 远程
    try {
      const { stdout: remote } = await execAsync('git remote get-url origin', { cwd })
      workspace.gitRemote = remote.trim()
    } catch { /* 可能没有远程 */ }

    // Git HEAD
    const { stdout: head } = await execAsync('git rev-parse HEAD', { cwd })
    workspace.gitHead = head.trim()

    // Git diff（staged + unstaged）
    const { stdout: diff } = await execAsync('git diff HEAD', { cwd })
    if (diff.trim()) {
      workspace.gitDiff = diff
    }

    // Git stash list
    try {
      const { stdout: stashList } = await execAsync('git stash list', { cwd })
      if (stashList.trim()) {
        // 保存第一个 stash 的内容
        const { stdout: stashDiff } = await execAsync('git stash show -p stash@{0}', { cwd })
        workspace.gitStash = stashDiff
      }
    } catch { /* 没有 stash */ }

    // 未跟踪的新文件（git diff 不包含这些）
    const { stdout: untrackedRaw } = await execAsync('git ls-files --others --exclude-standard', { cwd })
    const untrackedFiles = untrackedRaw.trim().split('\n').filter(Boolean)

    for (const filePath of untrackedFiles) {
      if (isSensitiveFile(filePath)) continue

      try {
        const fullPath = `${cwd}/${filePath}`
        const file = Bun.file(fullPath)
        const size = file.size

        if (size > MAX_FILE_SNAPSHOT_SIZE) {
          // 大文件只记录路径
          workspace.modifiedFiles.push({
            path: filePath, content: '', isBinary: true, size, status: 'added',
          })
          continue
        }

        const buffer = Buffer.from(await file.arrayBuffer())
        const binary = isBinaryContent(buffer)

        workspace.modifiedFiles.push({
          path: filePath,
          content: binary ? buffer.toString('base64') : buffer.toString('utf-8'),
          isBinary: binary,
          size,
          status: 'added',
        })
      } catch { /* 文件读取失败跳过 */ }
    }

    // CLAUDE.md
    try {
      const claudeMd = await Bun.file(`${cwd}/.claude/CLAUDE.md`).text()
      workspace.claudeMd = claudeMd
    } catch { /* 可能不存在 */ }

  } catch (error) {
    // 不在 Git 仓库中也不影响打包
    console.warn('[teleport] Git 状态捕获失败（可能不在 Git 仓库中）:', error)
  }

  return workspace
}

/**
 * 列出已打包的 Teleport 文件
 */
export async function listPackages(): Promise<{ id: string; path: string; size: number; createdAt: number }[]> {
  const dir = `${process.env.HOME}/.claude/${TELEPORT_DIR}`
  const results: { id: string; path: string; size: number; createdAt: number }[] = []

  try {
    const { readdir, stat } = await import('fs/promises')
    const files = await readdir(dir)

    for (const file of files) {
      if (!file.endsWith(TELEPORT_EXTENSION)) continue
      const filePath = `${dir}/${file}`
      const fileStat = await stat(filePath)
      const id = file.replace(TELEPORT_EXTENSION, '')
      results.push({
        id,
        path: filePath,
        size: fileStat.size,
        createdAt: fileStat.mtimeMs,
      })
    }

    // 按时间降序排列
    results.sort((a, b) => b.createdAt - a.createdAt)
  } catch { /* 目录不存在 */ }

  return results
}
