/**
 * Teleport 传输层 — 多种传输方式
 *
 * 支持三种传输方式：
 * 1. file   — 导出为文件，手动复制（USB/SCP/AirDrop）
 * 2. http   — 通过 claude-code-haha-server 中转
 * 3. direct — 同网络内两台机器直接 TCP 传输
 *
 * 选择建议：
 * ──────────
 *   - 同一台机器的不同目录 → file（最简单）
 *   - 有 server 部署 → http（最方便）
 *   - 同一局域网 → direct（最快）
 *   - 跨网络无 server → file + scp（最可靠）
 */

import { createReadStream, createWriteStream } from 'fs'
import { stat } from 'fs/promises'
import type { TransferProgress, TransferConfig } from './types'
import { TELEPORT_DIR, TELEPORT_EXTENSION } from './types'

// ─────────────────────────────────────────────
// 进度追踪
// ─────────────────────────────────────────────

export type ProgressCallback = (progress: TransferProgress) => void

function createProgressTracker(total: number): {
  update: (transferred: number) => TransferProgress
} {
  const startTime = Date.now()
  return {
    update(transferred: number): TransferProgress {
      const elapsed = (Date.now() - startTime) / 1000 || 1
      const speed = transferred / elapsed
      const remaining = total - transferred
      const eta = speed > 0 ? remaining / speed : Infinity
      return { transferred, total, speed, eta }
    },
  }
}

// ─────────────────────────────────────────────
// 方式 1：文件传输
// ─────────────────────────────────────────────

/**
 * 导出 Teleport 包到指定路径
 * 简单的文件复制。用户自行通过 SCP/USB/AirDrop 传输。
 */
export async function exportToFile(
  sourcePackagePath: string,
  targetPath: string,
  onProgress?: ProgressCallback,
): Promise<boolean> {
  try {
    const fileInfo = await stat(sourcePackagePath)
    const total = fileInfo.size
    const tracker = createProgressTracker(total)

    // 使用流式复制（大文件友好）
    return new Promise((resolve) => {
      const reader = createReadStream(sourcePackagePath)
      const writer = createWriteStream(targetPath)
      let transferred = 0

      reader.on('data', (chunk: Buffer) => {
        transferred += chunk.length
        onProgress?.(tracker.update(transferred))
      })

      reader.pipe(writer)

      writer.on('finish', () => {
        console.log(`[teleport] 已导出到: ${targetPath}`)
        resolve(true)
      })

      writer.on('error', (err) => {
        console.error(`[teleport] 文件导出失败:`, err)
        resolve(false)
      })
    })
  } catch (error) {
    console.error('[teleport] 导出失败:', error)
    return false
  }
}

/**
 * 从文件导入 Teleport 包到本地存储
 */
export async function importFromFile(sourcePath: string): Promise<string | null> {
  try {
    // 验证文件
    const file = Bun.file(sourcePath)
    if (!await file.exists()) {
      console.error(`[teleport] 文件不存在: ${sourcePath}`)
      return null
    }

    // 复制到本地 teleport 目录
    const fileName = sourcePath.split('/').pop()!
    const dir = `${process.env.HOME}/.claude/${TELEPORT_DIR}`
    const targetPath = `${dir}/${fileName}`

    const content = await file.arrayBuffer()
    await Bun.write(targetPath, content)

    console.log(`[teleport] 已导入: ${targetPath}`)
    return targetPath
  } catch (error) {
    console.error('[teleport] 导入失败:', error)
    return null
  }
}

// ─────────────────────────────────────────────
// 方式 2：HTTP 传输（通过 claude-code-haha-server）
// ─────────────────────────────────────────────

/**
 * 上传 Teleport 包到服务器
 */
export async function uploadToServer(
  packagePath: string,
  serverUrl: string,
  onProgress?: ProgressCallback,
): Promise<string | null> {
  try {
    const file = Bun.file(packagePath)
    const fileInfo = await stat(packagePath)
    const content = await file.arrayBuffer()

    console.log(`[teleport] 上传到服务器: ${serverUrl}`)

    const response = await fetch(`${serverUrl}/api/teleport/pack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Package-Size': String(fileInfo.size),
        'X-Package-Name': packagePath.split('/').pop()!,
      },
      body: content,
    })

    if (!response.ok) {
      const error = await response.text()
      console.error(`[teleport] 上传失败: ${response.status} - ${error}`)
      return null
    }

    const result = await response.json() as { id: string }
    console.log(`[teleport] 上传成功，包 ID: ${result.id}`)
    return result.id
  } catch (error) {
    console.error('[teleport] 上传失败:', error)
    return null
  }
}

/**
 * 从服务器下载 Teleport 包
 */
export async function downloadFromServer(
  packageId: string,
  serverUrl: string,
  onProgress?: ProgressCallback,
): Promise<string | null> {
  try {
    console.log(`[teleport] 从服务器下载: ${packageId}`)

    const response = await fetch(`${serverUrl}/api/teleport/packages/${packageId}`)
    if (!response.ok) {
      console.error(`[teleport] 下载失败: ${response.status}`)
      return null
    }

    const content = await response.arrayBuffer()
    const dir = `${process.env.HOME}/.claude/${TELEPORT_DIR}`
    const filePath = `${dir}/${packageId}${TELEPORT_EXTENSION}`

    await Bun.write(filePath, content)
    console.log(`[teleport] 下载完成: ${filePath}`)
    return filePath
  } catch (error) {
    console.error('[teleport] 下载失败:', error)
    return null
  }
}

/**
 * 列出服务器上的 Teleport 包
 */
export async function listServerPackages(serverUrl: string): Promise<any[]> {
  try {
    const response = await fetch(`${serverUrl}/api/teleport/packages`)
    if (!response.ok) return []
    const data = await response.json() as { packages: any[] }
    return data.packages || []
  } catch {
    return []
  }
}

// ─────────────────────────────────────────────
// 方式 3：直连传输（同局域网 TCP）
// ─────────────────────────────────────────────

/**
 * 启动直连传输服务器
 *
 * 在发送方启动一个临时 TCP 服务器，
 * 接收方连接后直接传输文件。
 *
 * 安全注意：仅限局域网使用！
 */
export async function startDirectServer(
  packagePath: string,
  port: number = 0, // 0 = 随机端口
): Promise<{ port: number; close: () => void } | null> {
  try {
    const file = Bun.file(packagePath)
    const content = await file.arrayBuffer()

    const server = Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/teleport' && req.method === 'GET') {
          return new Response(content, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(content.byteLength),
              'X-Package-Name': packagePath.split('/').pop()!,
            },
          })
        }
        return new Response('Teleport Direct Transfer Server', { status: 200 })
      },
    })

    const actualPort = server.port
    console.log(`[teleport] 直连服务器启动: http://0.0.0.0:${actualPort}/teleport`)
    console.log(`[teleport] 接收方执行: teleport pull <你的IP>:${actualPort}`)

    return {
      port: actualPort,
      close: () => server.stop(),
    }
  } catch (error) {
    console.error('[teleport] 直连服务器启动失败:', error)
    return null
  }
}

/**
 * 从直连服务器下载 Teleport 包
 */
export async function pullFromDirect(
  host: string,
  port: number,
  onProgress?: ProgressCallback,
): Promise<string | null> {
  try {
    const url = `http://${host}:${port}/teleport`
    console.log(`[teleport] 直连下载: ${url}`)

    const response = await fetch(url)
    if (!response.ok) {
      console.error(`[teleport] 直连下载失败: ${response.status}`)
      return null
    }

    const packageName = response.headers.get('X-Package-Name') || `direct-${Date.now()}${TELEPORT_EXTENSION}`
    const content = await response.arrayBuffer()

    const dir = `${process.env.HOME}/.claude/${TELEPORT_DIR}`
    const filePath = `${dir}/${packageName}`
    await Bun.write(filePath, content)

    console.log(`[teleport] 直连下载完成: ${filePath}`)
    return filePath
  } catch (error) {
    console.error('[teleport] 直连下载失败:', error)
    return null
  }
}
