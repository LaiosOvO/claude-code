/**
 * Daemon 模块 — 统一导出
 *
 * Daemon（守护进程）让 claude-haha 像系统服务一样挂在后台运行。
 * 它是 Kairos（24/7 Agent）和 Bridge（远程操控）的基础设施。
 *
 * 使用示例：
 * ```typescript
 * import { DaemonManager } from './daemon'
 *
 * const manager = new DaemonManager()
 *
 * // 启动守护进程
 * await manager.startDaemon({ workDir: process.cwd() })
 *
 * // 检查状态
 * const info = await manager.getDaemonInfo()
 * console.log(info) // { pid, status, uptime, sessions: [...] }
 *
 * // 停止守护进程
 * await manager.stopDaemon()
 * ```
 */

export { DaemonProcess } from './daemonProcess'
export { DaemonClient } from './daemonClient'
export { DaemonManager } from './daemonManager'
export { DaemonLogger } from './daemonLogger'
export type {
  DaemonConfig,
  DaemonInfo,
  DaemonSession,
  DaemonStatus,
  DaemonCommand,
  DaemonResponse,
} from './types'
