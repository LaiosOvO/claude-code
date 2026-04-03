/**
 * 守护进程管理器 — 从 CLI 管理 daemon 的生命周期
 *
 * 本模块是 daemon 的"外部管理层"，供 CLI 命令（如 `claude-haha daemon start`）调用。
 * 它负责：
 * 1. 启动守护进程（fork 后台子进程）
 * 2. 停止守护进程（通过 UDS 或信号）
 * 3. 检查守护进程是否存活
 * 4. 获取守护进程信息
 *
 * 与 daemonProcess 的分工：
 * ──────────────────────────
 *   daemonManager:  在用户的终端中运行，是"操控者"
 *   daemonProcess:  在后台运行，是"工作者"
 *
 * 类比：
 *   daemonManager 像 `systemctl start/stop/status`
 *   daemonProcess 像被 systemd 管理的服务进程
 *
 * 进程关系：
 *   用户终端 → CLI → daemonManager.startDaemon()
 *                         │
 *                         ├─ fork ──> daemonProcess（后台运行，与终端脱离）
 *                         │              ├── Session 1
 *                         │              └── Session 2
 *                         │
 *                         └─ 返回（CLI 退出，daemon 继续运行）
 */

import { type ChildProcess, spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { readFile, unlink } from 'fs/promises'
import { dirname, join } from 'path'
import {
  type DaemonConfig,
  type DaemonInfo,
  getDefaultDaemonConfig,
} from './types.js'
import { DaemonClient, DaemonConnectionError } from './daemonClient.js'

// ─────────────────────────────────────────────
// 管理器配置
// ─────────────────────────────────────────────

/** 等待守护进程启动就绪的最大时间（毫秒） */
const STARTUP_TIMEOUT_MS = 15_000

/** 等待守护进程停止的最大时间（毫秒） */
const STOP_TIMEOUT_MS = 10_000

// ═══════════════════════════════════════════════
// startDaemon — 启动守护进程
// ═══════════════════════════════════════════════

/**
 * 在后台启动守护进程。
 *
 * 脱离终端的实现：
 * ────────────────
 * Node.js/Bun 中创建脱离终端的后台进程需要两个关键步骤：
 *
 * 1. spawn() 的 `detached: true` 选项
 *    创建新的会话（session），子进程成为新会话的领导者。
 *    这等同于 POSIX 的 setsid()。脱离终端后：
 *    - 关闭终端不会杀死子进程
 *    - 子进程不会收到 SIGHUP
 *
 * 2. childProcess.unref()
 *    告诉父进程的事件循环"不要等待这个子进程"。
 *    没有 unref()，父进程会一直等到子进程退出才退出。
 *
 * stdio 配置：
 * - stdin: 'ignore'   — 后台进程不需要读取输入
 * - stdout: 打开日志文件（子进程的 stdout 重定向到日志文件）
 * - stderr: 同上
 *
 * 环境变量传递：
 * 通过 DAEMON_CONFIG 环境变量把配置传给子进程。
 * 也可以通过命令行参数或配置文件，但环境变量最简单。
 *
 * @param userConfig - 用户自定义配置（覆盖默认值）
 * @returns 守护进程信息
 */
export async function startDaemon(
  userConfig: Partial<DaemonConfig> = {},
): Promise<DaemonInfo> {
  const config = { ...getDefaultDaemonConfig(), ...userConfig }

  // 检查是否已有守护进程在运行
  if (await isDaemonRunning(config)) {
    // 已经在运行，返回当前信息
    const info = await getDaemonInfo(config)
    if (info) return info
    // 如果获取信息失败但 PID 存在，可能是过期的 PID 文件
    // 继续启动流程（新进程会处理旧 PID 文件）
  }

  // 确保日志目录存在
  const { mkdirSync, openSync } = await import('fs')
  mkdirSync(dirname(config.logFile), { recursive: true })

  // 打开日志文件描述符
  // 用于重定向子进程的 stdout/stderr
  const logFd = openSync(config.logFile, 'a')

  /**
   * 找到 daemonProcess.ts 的路径。
   *
   * 这里有个微妙的问题：我们需要让子进程运行 daemonProcess.ts，
   * 但打包后文件路径可能不同。
   *
   * 策略：
   * 1. 优先使用 __filename（打包后的路径）计算相对位置
   * 2. 降级使用 import.meta.url（开发时的路径）
   */
  const daemonProcessPath = join(dirname(import.meta.dir), 'daemon', 'daemonProcess.ts')

  // 准备子进程的环境变量
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    // 将配置序列化为 JSON 传给子进程
    DAEMON_CONFIG: JSON.stringify(config),
  }

  /**
   * spawn 创建后台子进程。
   *
   * 参数解析：
   * - process.execPath: Bun 运行时的路径（如 /usr/local/bin/bun）
   * - ['run', daemonProcessPath]: 让 Bun 运行 daemonProcess.ts
   * - detached: true: 创建新的进程组，脱离父进程的终端
   * - stdio: ['ignore', logFd, logFd]: stdin 忽略，stdout/stderr 写日志文件
   */
  const child: ChildProcess = spawn(
    process.execPath,
    ['run', daemonProcessPath],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: config.workDir,
      env: childEnv,
    },
  )

  /**
   * unref() — 让父进程不等待子进程。
   *
   * 正常情况下，父进程的事件循环会因为子进程的存在而保持活跃。
   * unref() 把子进程从父进程的引用计数中移除。
   * 这样父进程可以正常退出，而子进程继续在后台运行。
   *
   * 这是 Node.js/Bun 中创建守护进程的关键一步。
   */
  child.unref()

  // 关闭父进程对日志文件的引用
  // 子进程已经继承了文件描述符，父进程不再需要它
  const { closeSync } = await import('fs')
  closeSync(logFd)

  // 等待守护进程就绪
  // 子进程需要时间完成初始化（写 PID 文件、创建 UDS 服务器等）
  const client = new DaemonClient({ socketPath: config.socketPath })
  const ready = await client.waitForReady(STARTUP_TIMEOUT_MS)

  if (!ready) {
    throw new Error(
      `守护进程启动超时（${STARTUP_TIMEOUT_MS}ms）。` +
      `请检查日志文件: ${config.logFile}`,
    )
  }

  // 获取并返回守护进程信息
  const info = await client.getStatus()
  return info
}

// ═══════════════════════════════════════════════
// stopDaemon — 停止守护进程
// ═══════════════════════════════════════════════

/**
 * 停止正在运行的守护进程。
 *
 * 停止策略（三级降级）：
 * ─────────────────────
 * 1. 优先通过 UDS 发送 stop 命令（最优雅）
 *    让守护进程自己做清理：终止子进程、删除文件、关闭连接
 *
 * 2. 如果 UDS 不可用，通过 SIGTERM 信号通知（次优雅）
 *    读取 PID 文件，直接发送信号。
 *    守护进程的信号处理器会执行优雅关闭。
 *
 * 3. 如果 SIGTERM 超时，发送 SIGKILL（最后手段）
 *    内核直接杀死进程，不执行任何清理。
 *    之后手动清理 PID 文件和 socket 文件。
 *
 * 为什么需要三级策略？
 * - UDS 可能因为文件系统问题不可用
 * - SIGTERM 可能因为进程卡死而不响应
 * - SIGKILL 总是成功的，但会跳过清理
 */
export async function stopDaemon(
  userConfig: Partial<DaemonConfig> = {},
): Promise<void> {
  const config = { ...getDefaultDaemonConfig(), ...userConfig }

  // 策略 1: 通过 UDS 发送 stop 命令
  try {
    const client = new DaemonClient({ socketPath: config.socketPath })
    await client.stop()

    // 等待守护进程退出
    const stopped = await waitForDaemonStop(config, STOP_TIMEOUT_MS)
    if (stopped) return
    // 没有在预期时间内停止，降级到策略 2
  } catch (err) {
    // UDS 不可用（守护进程可能已经半死不活），降级到策略 2
    if (!(err instanceof DaemonConnectionError)) {
      throw err
    }
  }

  // 策略 2: 读取 PID 文件，发送 SIGTERM
  const pid = readPidFile(config.pidFile)
  if (pid === null) {
    // 没有 PID 文件，可能守护进程已经停了
    await cleanupStaleFiles(config)
    return
  }

  try {
    // 检查进程是否存活
    process.kill(pid, 0)
    // 发送 SIGTERM
    process.kill(pid, 'SIGTERM')

    // 等待进程退出
    const stopped = await waitForProcessExit(pid, STOP_TIMEOUT_MS)
    if (stopped) {
      await cleanupStaleFiles(config)
      return
    }

    // 策略 3: SIGTERM 超时，发送 SIGKILL
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 进程可能在发 SIGKILL 之前已经退出了
    }
    await cleanupStaleFiles(config)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      // 进程已不存在，清理残留文件即可
      await cleanupStaleFiles(config)
      return
    }
    throw err
  }
}

// ═══════════════════════════════════════════════
// restartDaemon — 重启守护进程
// ═══════════════════════════════════════════════

/**
 * 重启守护进程。
 *
 * 实现很直接：先停后起。
 * 保留原有配置（除非调用者提供了新配置）。
 *
 * 为什么不让 daemon 自己重启？
 * 因为 daemon 进程退出后就无法执行任何代码了。
 * 自重启需要一个"supervisor"进程（如 systemd），
 * 而 daemonManager 就扮演了这个角色。
 */
export async function restartDaemon(
  userConfig: Partial<DaemonConfig> = {},
): Promise<DaemonInfo> {
  await stopDaemon(userConfig)
  return startDaemon(userConfig)
}

// ═══════════════════════════════════════════════
// isDaemonRunning — 检查守护进程是否存活
// ═══════════════════════════════════════════════

/**
 * 检查守护进程是否正在运行。
 *
 * 判断流程：
 * ──────────
 * 1. 读取 PID 文件 → 如果不存在，肯定没在运行
 * 2. 检查 PID 对应的进程是否存活 → process.kill(pid, 0)
 * 3. （可选）通过 UDS 发送 status 命令 → 确认是我们的 daemon
 *
 * 为什么不只检查 socket 文件？
 * socket 文件可能是上次崩溃残留的，不能证明进程在运行。
 *
 * 为什么不只用 process.kill(pid, 0)？
 * PID 可能被操作系统回收给了其他进程。
 * 例如：daemon 崩溃 → PID 释放 → 新进程（可能是 Chrome）获得同一 PID。
 * 但在实践中，PID 回收在短时间内发生的概率很低，
 * 对于本地开发工具来说够用了。
 */
export async function isDaemonRunning(
  userConfig: Partial<DaemonConfig> = {},
): Promise<boolean> {
  const config = { ...getDefaultDaemonConfig(), ...userConfig }

  // 步骤 1: 读取 PID 文件
  const pid = readPidFile(config.pidFile)
  if (pid === null) return false

  // 步骤 2: 检查进程是否存活
  if (!isProcessAlive(pid)) {
    // 进程已死，但 PID 文件还在（上次崩溃没清理）
    return false
  }

  // 步骤 3: 通过 UDS 确认是我们的 daemon
  try {
    const client = new DaemonClient({ socketPath: config.socketPath, timeout: 3_000 })
    await client.getStatus()
    return true
  } catch {
    // UDS 不可用。进程存在但 socket 不响应，
    // 可能是其他程序使用了同一 PID，或 daemon 还在启动中。
    // 保守判断为"不在运行"，让调用者可以重新启动。
    return false
  }
}

// ═══════════════════════════════════════════════
// getDaemonInfo — 获取守护进程信息
// ═══════════════════════════════════════════════

/**
 * 获取守护进程的详细运行信息。
 *
 * 如果守护进程未在运行，返回 null。
 * 不抛出异常 —— 这是一个安全的"查询"操作。
 */
export async function getDaemonInfo(
  userConfig: Partial<DaemonConfig> = {},
): Promise<DaemonInfo | null> {
  const config = { ...getDefaultDaemonConfig(), ...userConfig }

  try {
    const client = new DaemonClient({ socketPath: config.socketPath, timeout: 5_000 })
    return await client.getStatus()
  } catch {
    return null
  }
}

// ═══════════════════════════════════════════════
// ensureDaemon — 确保守护进程运行
// ═══════════════════════════════════════════════

/**
 * 确保守护进程正在运行。
 * 如果未运行，自动启动。如果已运行，什么都不做。
 *
 * 这是最常用的 API —— 大多数功能只需要"确保 daemon 存在"，
 * 不关心它是刚启动的还是之前就在运行的。
 *
 * 幂等性保证：多次调用结果一样。
 */
export async function ensureDaemon(
  userConfig: Partial<DaemonConfig> = {},
): Promise<DaemonInfo> {
  // 尝试获取现有 daemon 的信息
  const info = await getDaemonInfo(userConfig)
  if (info) return info

  // 没有运行，启动一个
  return startDaemon(userConfig)
}

// ═══════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════

/**
 * 读取 PID 文件并返回 PID。
 *
 * PID 文件格式非常简单：文件内容就是一个数字字符串。
 * 例如文件内容为 "12345\n"，解析出 PID = 12345。
 *
 * @returns PID 数字，或 null（文件不存在/内容无效）
 */
function readPidFile(pidFilePath: string): number | null {
  try {
    if (!existsSync(pidFilePath)) return null
    const content = readFileSync(pidFilePath, 'utf-8').trim()
    const pid = parseInt(content, 10)
    return isNaN(pid) || pid <= 0 ? null : pid
  } catch {
    return null
  }
}

/**
 * 检查指定 PID 的进程是否存活。
 *
 * process.kill(pid, 0) 是 POSIX 系统中检查进程存活的标准方法：
 * - 信号 0 不会实际杀死进程
 * - 如果进程存在，调用成功（不抛异常）
 * - 如果进程不存在，抛出 ESRCH (No such process)
 * - 如果没有权限，抛出 EPERM (Permission denied) —— 但进程确实存在
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = 没有权限发信号，但进程存在
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true
    // ESRCH = 进程不存在
    return false
  }
}

/**
 * 等待守护进程停止（通过轮询 UDS 连接性）。
 *
 * 轮询间隔从短到长：开始时 100ms，逐渐增加到 500ms。
 * 这叫"退避"（backoff），避免在等待过程中频繁检查。
 */
async function waitForDaemonStop(
  config: DaemonConfig,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let pollMs = 100

  while (Date.now() < deadline) {
    const pid = readPidFile(config.pidFile)
    if (pid === null || !isProcessAlive(pid)) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
    // 指数退避，但不超过 500ms
    pollMs = Math.min(pollMs * 1.5, 500)
  }

  return false
}

/**
 * 等待指定进程退出（通过轮询 kill(pid, 0)）。
 */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let pollMs = 100

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, pollMs))
    pollMs = Math.min(pollMs * 1.5, 500)
  }

  return false
}

/**
 * 清理守护进程残留的文件。
 *
 * 当守护进程异常退出（SIGKILL、段错误等）时，
 * PID 文件和 socket 文件可能不会被清理。
 * 这些"僵尸文件"会阻止下次启动。
 *
 * 此函数安全地删除这些文件。
 * "安全"意味着：如果文件不存在也不报错。
 */
async function cleanupStaleFiles(config: DaemonConfig): Promise<void> {
  // 删除 PID 文件
  try {
    await unlink(config.pidFile)
  } catch {
    // 文件不存在是正常的
  }

  // 删除 socket 文件
  try {
    await unlink(config.socketPath)
  } catch {
    // 文件不存在是正常的
  }
}
