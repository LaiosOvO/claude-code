/**
 * 守护进程日志系统
 *
 * 守护进程与普通程序的关键区别之一：它没有终端。
 * 所有的 console.log 都不会被看到，因此需要一个可靠的日志系统。
 *
 * 设计要点：
 * ─────────
 * 1. 日志轮转（Log Rotation）
 *    日志文件不能无限增长，否则会耗尽磁盘空间。
 *    我们实现了简单的大小轮转：当文件超过 maxSize 时，
 *    旧文件被重命名为 .1、.2 等，最老的文件被删除。
 *
 *    例如：daemon.log 超过 10MB 后：
 *      daemon.log.2 → 删除
 *      daemon.log.1 → daemon.log.2
 *      daemon.log   → daemon.log.1
 *      (新建空的 daemon.log)
 *
 * 2. 时间戳格式
 *    使用 ISO 8601 格式（如 2024-01-15T10:30:00.000Z），
 *    因为它：
 *    - 人类可读
 *    - 可以按字典序排序
 *    - 是国际标准，工具链支持好
 *
 * 3. 双输出
 *    当有终端附加时（如前台启动调试），同时写入文件和 stderr。
 *    stderr 而非 stdout，是 Unix 惯例 —— stdout 留给正常输出，
 *    stderr 用于诊断信息。
 *
 * 4. 缓冲写入
 *    使用 Bun 的 file writer 进行高效的缓冲写入，
 *    避免每条日志都触发一次系统调用。
 */

import { existsSync, renameSync, statSync, unlinkSync } from 'fs'
import { appendFile, rename, stat, unlink, writeFile } from 'fs/promises'

// ─────────────────────────────────────────────
// 日志级别
// ─────────────────────────────────────────────
//
// 遵循标准的 syslog 级别子集：
// - debug: 调试信息，生产环境通常不开启
// - info:  常规运行信息（启动、停止、会话创建等）
// - warn:  警告（非致命错误，如连接重试）
// - error: 错误（需要关注的问题）

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * 日志级别优先级映射。
 * 数值越大，级别越高。
 * 日志过滤时，只输出 >= 当前级别的日志。
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

/**
 * 日志级别标签，用于格式化输出。
 * 统一为 5 个字符宽度，保证日志对齐。
 */
const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
}

// ─────────────────────────────────────────────
// 日志轮转配置
// ─────────────────────────────────────────────

export interface DaemonLoggerOptions {
  /** 日志文件路径 */
  filePath: string

  /**
   * 最小日志级别。低于此级别的日志不会被写入。
   * 默认: 'info'
   */
  minLevel?: LogLevel

  /**
   * 单个日志文件的最大大小（字节）。
   * 超过此大小时触发轮转。
   * 默认: 10MB (10 * 1024 * 1024)
   */
  maxSize?: number

  /**
   * 保留的轮转文件数量。
   * 例如 maxFiles=3 表示保留 daemon.log, daemon.log.1, daemon.log.2, daemon.log.3
   * 默认: 3
   */
  maxFiles?: number

  /**
   * 是否同时输出到 stderr。
   * 在前台调试模式下开启。
   * 默认: false
   */
  writeToStderr?: boolean
}

// ─────────────────────────────────────────────
// DaemonLogger 实现
// ─────────────────────────────────────────────

export class DaemonLogger {
  private filePath: string
  private minLevel: LogLevel
  private maxSize: number
  private maxFiles: number
  private writeToStderr: boolean

  /**
   * 轮转锁。
   * 日志轮转涉及文件重命名，是异步操作。
   * 如果在轮转进行中又触发轮转，会导致文件名混乱。
   * 用一个 Promise 链来保证串行执行。
   */
  private rotatePromise: Promise<void> = Promise.resolve()

  /**
   * 写入缓冲区。
   * 将多条日志聚合后一次性写入，减少 I/O 操作。
   * 每 100ms 或缓冲区达到 8KB 时刷新。
   */
  private buffer: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly FLUSH_INTERVAL_MS = 100
  private readonly FLUSH_BUFFER_SIZE = 8192

  constructor(options: DaemonLoggerOptions) {
    this.filePath = options.filePath
    this.minLevel = options.minLevel ?? 'info'
    this.maxSize = options.maxSize ?? 10 * 1024 * 1024 // 10MB
    this.maxFiles = options.maxFiles ?? 3
    this.writeToStderr = options.writeToStderr ?? false
  }

  // ─────────────────────────────────────────
  // 公共 API — 按级别输出日志
  // ─────────────────────────────────────────

  /** 调试级别日志。开发时使用，生产环境默认不输出。 */
  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context)
  }

  /** 信息级别日志。记录正常运行事件。 */
  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context)
  }

  /** 警告级别日志。记录可恢复的异常情况。 */
  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context)
  }

  /** 错误级别日志。记录需要关注的错误。 */
  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context)
  }

  // ─────────────────────────────────────────
  // 核心日志写入逻辑
  // ─────────────────────────────────────────

  /**
   * 写入一条日志。
   *
   * 日志格式：
   *   [2024-01-15T10:30:00.000Z] INFO  message {context}
   *
   * 设计决策：
   * - 先检查级别再格式化，避免无意义的字符串拼接开销
   * - 上下文信息（context）以 JSON 追加在消息后面
   * - 写入是异步的，不阻塞调用者
   */
  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    // 级别过滤：如果当前日志级别低于最小级别，直接跳过
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return
    }

    // 格式化日志行
    const timestamp = new Date().toISOString()
    const label = LOG_LEVEL_LABEL[level]
    let line = `[${timestamp}] ${label} ${message}`

    // 追加上下文信息（如果有）
    if (context && Object.keys(context).length > 0) {
      try {
        line += ` ${JSON.stringify(context)}`
      } catch {
        // JSON.stringify 可能对循环引用抛出异常，忽略
        line += ' [context serialization failed]'
      }
    }

    line += '\n'

    // 双输出：同时写到 stderr（如果启用）
    if (this.writeToStderr) {
      try {
        process.stderr.write(line)
      } catch {
        // stderr 可能已关闭（如终端断开），忽略写入错误
      }
    }

    // 加入缓冲区
    this.buffer.push(line)

    // 检查是否需要立即刷新（缓冲区超过阈值）
    const bufferSize = this.buffer.reduce((sum, s) => sum + s.length, 0)
    if (bufferSize >= this.FLUSH_BUFFER_SIZE) {
      void this.flush()
    } else if (!this.flushTimer) {
      // 设置延迟刷新定时器
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        void this.flush()
      }, this.FLUSH_INTERVAL_MS)
      // unref() 让这个定时器不阻止进程退出
      // 这是守护进程的重要细节：如果没有 unref，
      // 进程在关闭时会等待这个定时器触发才退出
      this.flushTimer.unref()
    }
  }

  /**
   * 将缓冲区内容刷新到文件。
   *
   * 实现细节：
   * - 先取出缓冲区内容再写入（防止写入期间新日志丢失）
   * - 写入后检查文件大小，必要时触发轮转
   * - 所有错误静默处理（日志系统本身不应导致程序崩溃）
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return

    // 原子性地取出缓冲区
    const lines = this.buffer.splice(0)
    const content = lines.join('')

    try {
      await appendFile(this.filePath, content, 'utf-8')
    } catch (err) {
      // 文件可能不存在（首次写入），尝试创建
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await writeFile(this.filePath, content, 'utf-8')
        } catch {
          // 创建也失败（目录不存在等），静默放弃
          return
        }
      } else {
        return
      }
    }

    // 检查是否需要轮转
    await this.checkRotation()
  }

  // ─────────────────────────────────────────
  // 日志轮转
  // ─────────────────────────────────────────

  /**
   * 检查日志文件大小，超过阈值时触发轮转。
   *
   * 使用 Promise 链保证同一时间只有一个轮转操作在执行。
   * 这是一个常见的"串行队列"模式：
   *   this.rotatePromise = this.rotatePromise.then(() => doWork())
   * 每次追加到 Promise 链的末尾，确保前一个完成后才开始下一个。
   */
  private async checkRotation(): Promise<void> {
    try {
      const fileStat = await stat(this.filePath)
      if (fileStat.size >= this.maxSize) {
        // 串入轮转队列
        this.rotatePromise = this.rotatePromise
          .then(() => this.rotate())
          .catch(() => {
            // 轮转失败不应影响日志写入
          })
        await this.rotatePromise
      }
    } catch {
      // 文件不存在或无法 stat，跳过轮转
    }
  }

  /**
   * 执行日志轮转。
   *
   * 轮转过程（假设 maxFiles=3）：
   *   1. 删除 daemon.log.3（如果存在）
   *   2. daemon.log.2 → daemon.log.3
   *   3. daemon.log.1 → daemon.log.2
   *   4. daemon.log   → daemon.log.1
   *   5. 创建新的空 daemon.log
   *
   * 为什么不用 copytruncate？
   * copytruncate（复制后截断）在高并发写入时可能丢失日志。
   * rename 是原子操作（在同一文件系统上），更安全。
   *
   * 注意：轮转期间的日志会暂时写入新文件，不会丢失。
   */
  private async rotate(): Promise<void> {
    // 从最旧的文件开始处理
    for (let i = this.maxFiles; i >= 1; i--) {
      const source = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`
      const target = `${this.filePath}.${i}`

      try {
        // 如果是最老的轮转文件，直接删除
        if (i === this.maxFiles) {
          try {
            await unlink(target)
          } catch {
            // 文件不存在是正常的
          }
        }
        // 重命名
        await rename(source, target)
      } catch {
        // 源文件不存在是正常的（还没有那么多轮转文件）
      }
    }

    // 创建新的空日志文件
    try {
      await writeFile(this.filePath, '', 'utf-8')
    } catch {
      // 忽略
    }
  }

  // ─────────────────────────────────────────
  // 同步轮转（仅在启动时使用）
  // ─────────────────────────────────────────

  /**
   * 同步版本的轮转，在守护进程启动前调用。
   * 确保日志文件在启动时就是干净的。
   *
   * 为什么需要同步版本？
   * 在守护进程初始化阶段，异步操作可能导致竞争条件。
   * 例如，PID 文件还没写入就已经开始记录日志。
   * 同步操作保证启动序列的确定性。
   */
  rotateSync(): void {
    try {
      const fileStat = statSync(this.filePath)
      if (fileStat.size < this.maxSize) return
    } catch {
      return // 文件不存在
    }

    for (let i = this.maxFiles; i >= 1; i--) {
      const source = i === 1 ? this.filePath : `${this.filePath}.${i - 1}`
      const target = `${this.filePath}.${i}`

      try {
        if (i === this.maxFiles) {
          try {
            unlinkSync(target)
          } catch { /* 文件不存在 */ }
        }
        renameSync(source, target)
      } catch { /* 源不存在 */ }
    }

    try {
      // 使用 Bun.write 同步创建空文件
      Bun.writeSync(Bun.openSync(this.filePath, 'w'), '')
    } catch { /* 忽略 */ }
  }

  // ─────────────────────────────────────────
  // 生命周期管理
  // ─────────────────────────────────────────

  /**
   * 关闭日志系统。
   * 确保所有缓冲的日志都被写入文件后再返回。
   *
   * 在守护进程关闭时必须调用此方法，否则最后的日志可能丢失。
   * 这就像是 "flush + close" 模式。
   */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.flush()
  }

  /**
   * 更改最小日志级别。
   * 可以在运行时动态调整，例如通过 SIGHUP 信号切换调试模式。
   */
  setLevel(level: LogLevel): void {
    this.minLevel = level
  }
}

// ─────────────────────────────────────────────
// 全局日志实例
// ─────────────────────────────────────────────
//
// 守护进程全局共享一个日志实例。
// 使用惰性初始化（lazy init），在第一次使用时创建。

let globalLogger: DaemonLogger | null = null

/**
 * 初始化全局守护进程日志。
 * 必须在守护进程启动时调用一次。
 */
export function initDaemonLogger(options: DaemonLoggerOptions): DaemonLogger {
  globalLogger = new DaemonLogger(options)
  return globalLogger
}

/**
 * 获取全局守护进程日志实例。
 * 如果尚未初始化，返回一个写入 stderr 的临时实例。
 */
export function getDaemonLogger(): DaemonLogger {
  if (!globalLogger) {
    // 降级处理：未初始化时使用临时日志
    globalLogger = new DaemonLogger({
      filePath: '/dev/null',
      writeToStderr: true,
      minLevel: 'debug',
    })
  }
  return globalLogger
}
