/**
 * UDS Inbox 对端注册表 (Peer Registry)
 *
 * ===== 注册表的作用 =====
 *
 * 在消息路由系统中，服务端需要知道:
 * 1. 谁在线？(哪些 session 已连接)
 * 2. 如何到达他们？(session ID -> socket 的映射)
 * 3. 他们的状态如何？(最后活动时间，用于检测死连接)
 *
 * 注册表就是这个"谁在哪里"的数据库。
 *
 * 类比: 就像酒店的前台登记簿——
 *   - 客人入住时登记 (register)
 *   - 退房时注销 (unregister)
 *   - 有人找某位客人时查询 (getPeer)
 *   - 定期检查是否有人"逃单" (cleanupStale)
 *
 * ===== 连接类型 =====
 *
 * 这里使用 net.Socket 类型，这是 Node.js 的 TCP/IPC socket 抽象。
 * 对于 Bun 运行时，我们同时支持 Bun 的原生 socket 类型。
 * 通过 GenericSocket 接口抽象差异。
 */

import type { UDSPeerInfo } from './types.js'
import { HEARTBEAT_TIMEOUT } from './types.js'

// ============================================================
// Socket 抽象
// ============================================================

/**
 * 通用 Socket 接口
 *
 * 抽象 Node.js net.Socket 和 Bun socket 的差异。
 * 只暴露注册表需要的最小方法集。
 *
 * 设计原则: "依赖接口而非实现 (depend on abstractions, not concretions)"
 * 这样注册表不关心底层是 Node 还是 Bun，只要能 write 和 end 就行。
 */
export interface GenericSocket {
  write(data: Buffer | Uint8Array): void
  end(): void
  readonly remoteAddress?: string
}

// ============================================================
// 注册表条目
// ============================================================

/**
 * 注册表中每个对端的完整记录
 *
 * 除了对外暴露的 UDSPeerInfo 之外，
 * 还维护一些内部状态:
 * - socket: 实际的网络连接对象，用于向此对端发送数据
 * - messageBuffer: 当对端暂时离线时，缓存待发送的消息
 */
interface RegistryEntry {
  info: UDSPeerInfo
  socket: GenericSocket
}

// ============================================================
// InboxRegistry 类
// ============================================================

/**
 * 对端注册表
 *
 * 使用 Map<sessionId, RegistryEntry> 作为核心数据结构。
 * Map 的查找、插入、删除都是 O(1) 时间复杂度，适合频繁的路由查询。
 *
 * 线程安全说明:
 *   JavaScript 是单线程的（事件循环模型），
 *   所以不需要锁 (lock/mutex)。所有操作都在同一个事件循环中执行。
 *   这是 Node.js/Bun 编程模型的一大优势——
 *   无需担心并发修改导致的数据竞争 (race condition)。
 */
export class InboxRegistry {
  // 核心映射: session ID -> 注册条目
  private peers: Map<string, RegistryEntry> = new Map()

  // 定时清理器的句柄，用于在销毁时取消定时器
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  // 清理间隔 (毫秒)
  private cleanupIntervalMs: number

  /**
   * 构造函数
   *
   * @param cleanupIntervalMs - 多久执行一次僵尸连接清理，默认 30 秒
   */
  constructor(cleanupIntervalMs: number = 30_000) {
    this.cleanupIntervalMs = cleanupIntervalMs
  }

  // ========================================================
  // 基本的 CRUD 操作
  // ========================================================

  /**
   * 注册一个新的对端
   *
   * 当客户端连接并发送 register 消息后，服务端调用此方法
   * 将其加入注册表。
   *
   * 如果同一个 sessionId 已存在（可能是断开后重连），
   * 先关闭旧连接，再注册新连接。
   * 这确保每个 sessionId 同时只有一个活跃连接。
   *
   * @param sessionId - 会话唯一标识
   * @param socket - 网络连接对象
   * @param info - 对端信息
   */
  register(sessionId: string, socket: GenericSocket, info: UDSPeerInfo): void {
    // 如果已存在同名连接，先清理旧连接
    const existing = this.peers.get(sessionId)
    if (existing) {
      console.warn(
        `[InboxRegistry] 会话 ${sessionId} 重复注册，关闭旧连接`
      )
      try {
        existing.socket.end()
      } catch {
        // 旧连接可能已经断开，忽略错误
      }
    }

    this.peers.set(sessionId, {
      info,
      socket,
    })

    console.log(
      `[InboxRegistry] 注册对端: ${sessionId} (pid=${info.pid}, cwd=${info.cwd})`
    )
  }

  /**
   * 注销一个对端
   *
   * 当连接断开时调用。从注册表中移除该对端。
   * 不尝试关闭 socket（因为通常是 socket 断开才触发注销）。
   *
   * @param sessionId - 要注销的会话 ID
   * @returns 是否成功注销（返回 false 表示该 ID 本就不存在）
   */
  unregister(sessionId: string): boolean {
    const existed = this.peers.delete(sessionId)
    if (existed) {
      console.log(`[InboxRegistry] 注销对端: ${sessionId}`)
    }
    return existed
  }

  /**
   * 查找指定的对端
   *
   * @param sessionId - 要查找的会话 ID
   * @returns 对端信息和 socket，如果不存在则返回 undefined
   */
  getPeer(sessionId: string): { info: UDSPeerInfo; socket: GenericSocket } | undefined {
    const entry = this.peers.get(sessionId)
    if (!entry) return undefined
    return { info: entry.info, socket: entry.socket }
  }

  /**
   * 获取所有已注册对端的信息列表
   *
   * 只返回 UDSPeerInfo，不暴露内部的 socket 对象。
   * 这是信息隐藏原则——外部代码不需要也不应该接触 socket。
   *
   * @returns 所有对端信息的数组
   */
  getAllPeers(): UDSPeerInfo[] {
    return Array.from(this.peers.values()).map(entry => entry.info)
  }

  /**
   * 获取所有对端的 ID 和 socket
   *
   * 内部方法，供服务端在广播和路由时使用。
   *
   * @returns 所有 [sessionId, socket] 的数组
   */
  getAllEntries(): Array<{ sessionId: string; socket: GenericSocket; info: UDSPeerInfo }> {
    return Array.from(this.peers.entries()).map(([sessionId, entry]) => ({
      sessionId,
      socket: entry.socket,
      info: entry.info,
    }))
  }

  // ========================================================
  // 查询方法
  // ========================================================

  /**
   * 查找在同一工作目录下工作的对端
   *
   * 使用场景: 当用户在某个项目目录打开了多个 claude-code 会话时，
   * 可以方便地找到"同事"——在同一个项目上工作的其他会话。
   *
   * @param cwd - 工作目录路径
   * @returns 匹配的对端信息数组
   */
  findByWorkDir(cwd: string): UDSPeerInfo[] {
    const results: UDSPeerInfo[] = []
    for (const entry of this.peers.values()) {
      if (entry.info.cwd === cwd) {
        results.push(entry.info)
      }
    }
    return results
  }

  /**
   * 获取当前注册的对端数量
   */
  get size(): number {
    return this.peers.size
  }

  /**
   * 检查指定 session 是否在线
   */
  has(sessionId: string): boolean {
    return this.peers.has(sessionId)
  }

  // ========================================================
  // 活动追踪
  // ========================================================

  /**
   * 更新对端的最后活动时间
   *
   * 每次收到某个对端的消息时调用。
   * 这个时间戳用于僵尸连接检测:
   * 如果一个对端长时间没有任何活动（包括 pong 响应），
   * 说明它可能已经死掉但没有正常关闭连接。
   *
   * @param sessionId - 要更新的会话 ID
   */
  touch(sessionId: string): void {
    const entry = this.peers.get(sessionId)
    if (entry) {
      entry.info.lastActivity = Date.now()
    }
  }

  // ========================================================
  // 僵尸连接清理
  // ========================================================

  /**
   * 清理过期的僵尸连接
   *
   * ===== 什么是僵尸连接？=====
   *
   * 在网络编程中，连接可能因为各种原因"悄悄死掉":
   * - 客户端进程被 kill -9 杀死（没有机会发送 FIN 包）
   * - 系统突然断电
   * - 网络中间件（虽然 UDS 不经过网络，但内核也可能出问题）
   *
   * 这些"死而不倒"的连接会占用资源，也会导致消息路由失败。
   * 所以需要定期检查并清理。
   *
   * 检测方式:
   * 1. 时间戳检测: 如果 lastActivity 超过阈值，认为已死
   * 2. 进程存活检测: 用 kill(pid, 0) 检查进程是否仍在运行
   *    kill(pid, 0) 不会真的杀死进程，只是检查进程是否存在
   *    如果进程不存在，会抛出 ESRCH 错误
   *
   * @returns 被清理的 session ID 数组
   */
  cleanupStale(): string[] {
    const now = Date.now()
    const staleIds: string[] = []

    for (const [sessionId, entry] of this.peers.entries()) {
      let isStale = false

      // 检查 1: 最后活动时间是否超过心跳超时阈值
      if (now - entry.info.lastActivity > HEARTBEAT_TIMEOUT) {
        isStale = true
      }

      // 检查 2: 进程是否仍在运行
      // process.kill(pid, 0) 是 Unix 的经典技巧:
      //   - 信号 0 不会真的发送信号
      //   - 但如果进程不存在，会抛出异常
      //   - 这是检查进程存活的最轻量方式
      if (!isStale) {
        try {
          process.kill(entry.info.pid, 0)
        } catch {
          // 进程不存在 (ESRCH) 或无权限 (EPERM)
          // EPERM 说明进程存在但我们无权发送信号——不算死亡
          // 但对于同用户的进程，通常不会遇到 EPERM
          isStale = true
        }
      }

      if (isStale) {
        staleIds.push(sessionId)
      }
    }

    // 清理所有僵尸连接
    for (const sessionId of staleIds) {
      const entry = this.peers.get(sessionId)
      if (entry) {
        try {
          entry.socket.end()
        } catch {
          // 忽略关闭错误
        }
        this.peers.delete(sessionId)
        console.log(
          `[InboxRegistry] 清理僵尸连接: ${sessionId}`
        )
      }
    }

    return staleIds
  }

  /**
   * 启动定期清理
   *
   * 使用 setInterval 定期调用 cleanupStale。
   * 间隔不宜太短（浪费 CPU）也不宜太长（僵尸连接积累）。
   * 默认 30 秒是一个合理的折中。
   *
   * 注意: 使用 unref() 使定时器不阻止进程退出。
   * 如果所有其他工作都完成了，不应该因为这个定时器而让进程挂着。
   */
  startCleanup(): void {
    if (this.cleanupTimer) {
      return // 已经在运行
    }
    this.cleanupTimer = setInterval(() => {
      this.cleanupStale()
    }, this.cleanupIntervalMs)

    // unref() 告诉 Node/Bun: 这个定时器不应该阻止进程退出
    // 如果事件循环中只剩这个定时器，进程可以正常退出
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      ;(this.cleanupTimer as NodeJS.Timeout).unref()
    }
  }

  /**
   * 停止定期清理
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /**
   * 销毁注册表
   *
   * 关闭所有连接，停止清理定时器，清空数据。
   * 在服务端关闭时调用。
   */
  destroy(): void {
    this.stopCleanup()

    // 关闭所有活跃连接
    for (const [sessionId, entry] of this.peers.entries()) {
      try {
        entry.socket.end()
      } catch {
        // 忽略关闭错误
      }
      console.log(`[InboxRegistry] 销毁时关闭连接: ${sessionId}`)
    }

    this.peers.clear()
  }
}
