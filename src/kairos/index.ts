/**
 * Kairos 模块 — 统一导出
 *
 * Kairos (καιρός) = 24/7 主动式 Agent 系统
 *
 * 使用示例：
 * ```typescript
 * import { KairosEngine } from './kairos'
 *
 * const engine = new KairosEngine({
 *   maxConcurrentAgents: 3,
 *   defaultCwd: process.cwd(),
 * })
 *
 * // 注册定时任务
 * engine.addTask({
 *   id: 'daily-status',
 *   type: 'scheduled',
 *   name: '每日 Git 状态汇总',
 *   trigger: '0 9 * * *',
 *   prompt: '请汇总今天的 Git 提交、分支状态和待处理的 PR',
 *   status: 'pending',
 *   priority: 'normal',
 *   createdAt: Date.now(),
 *   recurring: true,
 *   runCount: 0,
 *   failCount: 0,
 *   nextRun: Date.now() + 60000,
 * })
 *
 * // 监听事件
 * engine.onEvent('task:completed', (event) => {
 *   console.log('任务完成:', event.data)
 * })
 *
 * // 启动引擎
 * await engine.start()
 * ```
 */

// 核心引擎
export { KairosEngine } from './kairosEngine'

// 文件监控器
export { KairosWatcher, type FileChangeEvent, type WatcherCallback } from './kairosWatcher'

// 类型定义
export type {
  KairosConfig,
  KairosTask,
  KairosTaskType,
  KairosTaskStatus,
  KairosTaskPriority,
  KairosNotification,
  KairosNotificationType,
  KairosNotificationConfig,
  KairosNotificationPayload,
  KairosAgentHandle,
  KairosAgentStatus,
  KairosEvent,
  KairosEventType,
  KairosWatchRule,
  KairosWatchAction,
  KairosWatchEventType,
  KairosTaskHistoryEntry,
  KairosEngineStatus,
  KairosSpawnOptions,
} from './types'

export { PRIORITY_VALUES, getDefaultKairosConfig } from './types'
