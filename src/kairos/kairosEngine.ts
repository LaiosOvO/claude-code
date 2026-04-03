/**
 * Kairos 引擎 — 核心调度与执行
 *
 * 这是 Kairos 系统的大脑。它运行一个事件循环，
 * 协调调度器、监控器、通知器和 Agent 池的工作。
 *
 * 架构概览：
 * ─────────
 *
 *    外部事件                内部时钟
 *   (文件变化,               (cron tick)
 *    UDS消息,                    │
 *    Bridge消息)                 │
 *       │                       │
 *       ▼                       ▼
 *   ┌─────────────────────────────┐
 *   │        事件总线 (EventBus)   │
 *   └────────────┬────────────────┘
 *                │
 *   ┌────────────▼────────────────┐
 *   │     优先级任务队列            │
 *   │  ┌───┬───┬───┬───┬───┐    │
 *   │  │P100│P75│P50│P25│P0 │    │
 *   │  └───┴───┴───┴───┴───┘    │
 *   └────────────┬────────────────┘
 *                │
 *   ┌────────────▼────────────────┐
 *   │     Agent 池管理器           │
 *   │  ┌──────┐ ┌──────┐        │
 *   │  │Agent1│ │Agent2│ ...    │
 *   │  └──────┘ └──────┘        │
 *   └────────────┬────────────────┘
 *                │
 *   ┌────────────▼────────────────┐
 *   │        通知分发器            │
 *   │  Terminal │ File │ UDS │ …  │
 *   └─────────────────────────────┘
 */

import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import type {
  KairosConfig,
  KairosTask,
  KairosTaskStatus,
  KairosEvent,
  KairosEventType,
  KairosAgentHandle,
  KairosEngineStatus,
  KairosNotification,
  KairosSpawnOptions,
  KairosTaskHistoryEntry,
} from './types'
import { PRIORITY_VALUES, getDefaultKairosConfig, DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_AGENT_OUTPUT_LINES } from './types'

// ─────────────────────────────────────────────
// 事件总线
// ─────────────────────────────────────────────
// 最小实现的发布-订阅模式，所有组件通过它通信

type EventHandler = (event: KairosEvent) => void

class EventBus {
  /** 按事件类型分组的监听器 */
  private listeners = new Map<KairosEventType | '*', Set<EventHandler>>()

  /**
   * 订阅事件
   * @param type 事件类型，'*' 表示订阅所有事件
   * @returns 取消订阅函数
   */
  on(type: KairosEventType | '*', handler: EventHandler): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set())
    }
    this.listeners.get(type)!.add(handler)
    return () => this.listeners.get(type)?.delete(handler)
  }

  /**
   * 发射事件
   * 先通知特定类型的监听器，再通知通配符监听器
   */
  emit(event: KairosEvent): void {
    // 通知特定类型的监听器
    this.listeners.get(event.type)?.forEach(fn => {
      try { fn(event) } catch (e) { console.error('[kairos] 事件处理器异常:', e) }
    })
    // 通知通配符监听器
    this.listeners.get('*')?.forEach(fn => {
      try { fn(event) } catch (e) { console.error('[kairos] 事件处理器异常:', e) }
    })
  }

  /** 清除所有监听器 */
  clear(): void {
    this.listeners.clear()
  }
}

// ─────────────────────────────────────────────
// 优先级任务队列
// ─────────────────────────────────────────────
// 用最小堆实现优先级队列（这里简化为排序数组）

class PriorityQueue {
  private queue: KairosTask[] = []

  /** 入队，按优先级降序排列（高优先级在前） */
  enqueue(task: KairosTask): void {
    this.queue.push(task)
    // 稳定排序：同优先级按创建时间排序（先创建先执行）
    this.queue.sort((a, b) => {
      const pa = PRIORITY_VALUES[a.priority]
      const pb = PRIORITY_VALUES[b.priority]
      if (pa !== pb) return pb - pa // 高优先级在前
      return a.createdAt - b.createdAt // 同优先级按时间排
    })
  }

  /** 出队最高优先级任务 */
  dequeue(): KairosTask | undefined {
    return this.queue.shift()
  }

  /** 查看队首（不出队） */
  peek(): KairosTask | undefined {
    return this.queue[0]
  }

  /** 移除指定任务 */
  remove(taskId: string): boolean {
    const idx = this.queue.findIndex(t => t.id === taskId)
    if (idx >= 0) {
      this.queue.splice(idx, 1)
      return true
    }
    return false
  }

  get size(): number { return this.queue.length }
  get items(): readonly KairosTask[] { return this.queue }
}

// ─────────────────────────────────────────────
// Kairos 引擎
// ─────────────────────────────────────────────

export class KairosEngine {
  /** 引擎配置 */
  private config: KairosConfig

  /** 事件总线 */
  private eventBus = new EventBus()

  /** 已注册的任务 (id → task) */
  private tasks = new Map<string, KairosTask>()

  /** 等待执行的任务队列 */
  private taskQueue = new PriorityQueue()

  /** 活跃的 Agent 句柄 (id → handle) */
  private agents = new Map<string, KairosAgentHandle>()

  /** 任务执行历史 */
  private history: KairosTaskHistoryEntry[] = []

  /** 速率限制：过去一小时的执行时间戳 */
  private recentExecutions: number[] = []

  /** 主循环定时器 */
  private loopTimer: ReturnType<typeof setInterval> | null = null

  /** 引擎是否正在运行 */
  private running = false

  /** 引擎启动时间 */
  private startTime: number | null = null

  /** 最近一次错误 */
  private lastError: string | null = null

  constructor(config?: Partial<KairosConfig>) {
    this.config = { ...getDefaultKairosConfig(), ...config }
  }

  // ═══════════════════════════════════════════
  // 生命周期管理
  // ═══════════════════════════════════════════

  /**
   * 启动 Kairos 引擎
   *
   * 启动后引擎进入主循环：
   * 1. 检查 scheduled 任务是否到期
   * 2. 从队列中取出任务分配给 Agent
   * 3. 清理已完成的 Agent
   * 4. 发射 tick 事件
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn('[kairos] 引擎已在运行中')
      return
    }

    this.running = true
    this.startTime = Date.now()

    this.emitEvent('engine:start', 'engine', {
      config: {
        maxConcurrentAgents: this.config.maxConcurrentAgents,
        schedulerIntervalMs: this.config.schedulerIntervalMs,
      },
    })

    console.log(`[kairos] 引擎启动 | 最大并发 Agent: ${this.config.maxConcurrentAgents} | 调度间隔: ${this.config.schedulerIntervalMs}ms`)

    // 启动主循环
    this.loopTimer = setInterval(() => this.tick(), this.config.schedulerIntervalMs)

    // 立即执行一次 tick
    await this.tick()
  }

  /**
   * 停止 Kairos 引擎
   *
   * 优雅关闭：
   * 1. 停止主循环
   * 2. 等待所有 Agent 完成（带超时）
   * 3. 超时后强制终止残留 Agent
   * 4. 清理资源
   */
  async stop(): Promise<void> {
    if (!this.running) return

    this.running = false
    console.log('[kairos] 引擎正在停止...')

    // 停止调度循环
    if (this.loopTimer) {
      clearInterval(this.loopTimer)
      this.loopTimer = null
    }

    // 给正在运行的 Agent 10 秒优雅退出时间
    const SHUTDOWN_TIMEOUT = 10_000
    const shutdownStart = Date.now()

    // 发送 SIGTERM 给所有 Agent
    for (const [id, agent] of this.agents) {
      if (agent.process && agent.status === 'running') {
        console.log(`[kairos] 发送 SIGTERM 给 Agent ${id.slice(0, 8)}`)
        agent.process.kill('SIGTERM')
      }
    }

    // 等待 Agent 退出
    while (this.agents.size > 0 && Date.now() - shutdownStart < SHUTDOWN_TIMEOUT) {
      await new Promise(r => setTimeout(r, 500))
      // 清理已退出的
      for (const [id, agent] of this.agents) {
        if (agent.status !== 'running' && agent.status !== 'spawning') {
          this.agents.delete(id)
        }
      }
    }

    // 超时后强制终止
    for (const [id, agent] of this.agents) {
      if (agent.process) {
        console.warn(`[kairos] 强制终止 Agent ${id.slice(0, 8)}`)
        agent.process.kill('SIGKILL')
      }
    }
    this.agents.clear()

    this.emitEvent('engine:stop', 'engine', { uptime: Date.now() - (this.startTime ?? 0) })
    this.eventBus.clear()
    this.startTime = null

    console.log('[kairos] 引擎已停止')
  }

  // ═══════════════════════════════════════════
  // 任务管理
  // ═══════════════════════════════════════════

  /** 添加任务 */
  addTask(task: KairosTask): void {
    this.tasks.set(task.id, task)
    this.emitEvent('task:added', 'engine', { taskId: task.id, taskName: task.name, type: task.type })
    console.log(`[kairos] 任务已注册: ${task.name} (${task.type}, ${task.priority})`)
  }

  /** 移除任务 */
  removeTask(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    this.tasks.delete(taskId)
    this.taskQueue.remove(taskId)
    this.emitEvent('task:removed', 'engine', { taskId, taskName: task.name })
    return true
  }

  /** 获取任务 */
  getTask(taskId: string): KairosTask | undefined {
    return this.tasks.get(taskId)
  }

  /** 列出所有任务 */
  listTasks(): KairosTask[] {
    return Array.from(this.tasks.values())
  }

  /**
   * 触发任务（将任务放入执行队列）
   *
   * 这是任务从 pending → queued 的关键转换。
   * 由 scheduler tick 或外部事件调用。
   */
  triggerTask(taskId: string, context?: Record<string, unknown>): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    // 速率限制检查
    if (!this.checkRateLimit()) {
      console.warn(`[kairos] 速率限制: 过去一小时已执行 ${this.recentExecutions.length} 个任务`)
      return false
    }

    // 依赖检查
    if (task.dependsOn?.length) {
      const allDepsCompleted = task.dependsOn.every(depId => {
        const dep = this.tasks.get(depId)
        return dep && dep.status === 'completed'
      })
      if (!allDepsCompleted) {
        console.log(`[kairos] 任务 ${task.name} 的依赖尚未完成，跳过`)
        return false
      }
    }

    // 更新状态
    task.status = 'queued'
    this.taskQueue.enqueue(task)
    this.emitEvent('task:triggered', 'engine', { taskId, context })

    return true
  }

  // ═══════════════════════════════════════════
  // Agent 管理
  // ═══════════════════════════════════════════

  /**
   * 生成子 Agent
   *
   * 这是 Kairos 的核心能力——自拆子 Agent 并行干活。
   * 每个 Agent 是一个独立的 claude-haha 进程，执行指定的 prompt。
   *
   * 工作流程：
   * 1. 检查 Agent 池是否有空位
   * 2. 创建子进程 (bun run claude-haha -p "prompt")
   * 3. 收集输出到环形缓冲区
   * 4. 监控进程退出
   * 5. 回调通知引擎
   */
  async spawnAgent(prompt: string, options?: KairosSpawnOptions): Promise<KairosAgentHandle | null> {
    // 检查并发限制
    const activeCount = this.getActiveAgentCount()
    if (activeCount >= this.config.maxConcurrentAgents) {
      console.warn(`[kairos] Agent 池已满 (${activeCount}/${this.config.maxConcurrentAgents})`)
      return null
    }

    const id = randomUUID()
    const cwd = options?.cwd || options?.task?.cwd || this.config.defaultCwd
    const timeout = options?.timeoutMs || DEFAULT_AGENT_TIMEOUT_MS
    const maxOutputLines = options?.maxOutputLines || DEFAULT_AGENT_OUTPUT_LINES

    // 创建 Agent 句柄
    const handle: KairosAgentHandle = {
      id,
      status: 'spawning',
      task: options?.task || {
        id: `adhoc-${id.slice(0, 8)}`,
        type: 'proactive',
        name: `Ad-hoc: ${prompt.slice(0, 50)}`,
        trigger: 'manual',
        prompt,
        status: 'running',
        priority: options?.priority || 'normal',
        createdAt: Date.now(),
        recurring: false,
        runCount: 0,
        failCount: 0,
      },
      startTime: Date.now(),
      cwd,
      output: [],
      prompt,
    }

    this.agents.set(id, handle)

    try {
      // 构建子进程命令
      // 使用 claude-haha 的 --print 模式（无头执行）
      const binPath = new URL('../../bin/claude-haha', import.meta.url).pathname
      const child = spawn('bun', ['run', binPath, '-p', prompt], {
        cwd,
        env: {
          ...process.env,
          ...options?.env,
          // 标记为 Kairos 子 Agent，防止递归 spawn
          KAIROS_AGENT: '1',
          KAIROS_PARENT_ID: id,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // 分离子进程，让它在父进程退出后仍能运行一段时间完成清理
        detached: false,
      })

      handle.process = child
      handle.pid = child.pid
      handle.status = 'running'

      // 收集 stdout 到环形缓冲区
      child.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean)
        handle.output.push(...lines)
        // 保持缓冲区大小
        while (handle.output.length > maxOutputLines) {
          handle.output.shift()
        }
      })

      // 收集 stderr
      child.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean)
        handle.output.push(...lines.map(l => `[stderr] ${l}`))
        while (handle.output.length > maxOutputLines) {
          handle.output.shift()
        }
      })

      // 监控进程退出
      child.on('exit', (code, signal) => {
        handle.endTime = Date.now()
        handle.exitCode = code
        handle.process = undefined // 清除进程引用

        if (code === 0) {
          handle.status = 'completed'
          this.emitEvent('agent:completed', 'agent-pool', {
            agentId: id,
            exitCode: code,
            duration: handle.endTime - handle.startTime,
          })
        } else if (signal === 'SIGKILL' || signal === 'SIGTERM') {
          handle.status = 'killed'
          this.emitEvent('agent:killed', 'agent-pool', { agentId: id, signal })
        } else {
          handle.status = 'failed'
          this.emitEvent('agent:failed', 'agent-pool', {
            agentId: id,
            exitCode: code,
            signal,
            lastOutput: handle.output.slice(-5),
          })
        }

        // 如果关联了任务，更新任务状态
        if (options?.task) {
          this.onAgentFinished(options.task, handle)
        }
      })

      // 设置超时
      setTimeout(() => {
        if (handle.status === 'running' && handle.process) {
          console.warn(`[kairos] Agent ${id.slice(0, 8)} 超时 (${timeout}ms)，正在终止`)
          handle.process.kill('SIGTERM')
          // 给 5 秒优雅退出
          setTimeout(() => {
            if (handle.process) handle.process.kill('SIGKILL')
          }, 5000)
        }
      }, timeout)

      this.emitEvent('agent:spawned', 'agent-pool', {
        agentId: id,
        pid: child.pid,
        prompt: prompt.slice(0, 100),
        cwd,
      })

      console.log(`[kairos] Agent 已启动: ${id.slice(0, 8)} (PID: ${child.pid})`)
      return handle

    } catch (error) {
      handle.status = 'failed'
      handle.endTime = Date.now()
      this.lastError = String(error)
      console.error(`[kairos] Agent 启动失败:`, error)
      return null
    }
  }

  /** 终止指定 Agent */
  killAgent(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent || !agent.process) return false

    agent.process.kill('SIGTERM')
    setTimeout(() => {
      if (agent.process) agent.process.kill('SIGKILL')
    }, 5000)
    return true
  }

  /** 获取活跃 Agent 数量 */
  getActiveAgentCount(): number {
    let count = 0
    for (const agent of this.agents.values()) {
      if (agent.status === 'running' || agent.status === 'spawning') count++
    }
    return count
  }

  // ═══════════════════════════════════════════
  // 通知
  // ═══════════════════════════════════════════

  /**
   * 发送通知
   *
   * Kairos 的通知系统支持多渠道投递。
   * 根据配置和通知类型，选择合适的渠道发送。
   */
  async notify(notification: KairosNotification): Promise<void> {
    const { type, target, payload } = notification

    // 终端通知
    if (this.config.notification.terminal) {
      const prefix = type === 'alert' ? '🚨' : type === 'push' ? '📱' : type === 'file' ? '📎' : '💬'
      console.log(`[kairos] ${prefix} ${payload.title || ''}: ${payload.body}`)
    }

    // 文件通知（写入 ~/.claude/notifications/）
    if (this.config.notification.file) {
      try {
        const notifDir = `${process.env.HOME}/.claude/notifications`
        await Bun.write(`${notifDir}/${Date.now()}-${type}.json`, JSON.stringify(notification, null, 2))
      } catch { /* 文件通知失败不阻塞 */ }
    }

    // macOS 系统通知
    if (this.config.notification.system && process.platform === 'darwin') {
      try {
        const title = payload.title || 'Kairos'
        const body = payload.body.replace(/"/g, '\\"')
        spawn('osascript', ['-e', `display notification "${body}" with title "${title}"`], {
          stdio: 'ignore',
          detached: true,
        })
      } catch { /* 系统通知失败不阻塞 */ }
    }

    this.emitEvent('notification:sent', 'notifier', {
      type: notification.type,
      target: notification.target,
    })
  }

  // ═══════════════════════════════════════════
  // 状态查询
  // ═══════════════════════════════════════════

  /** 获取引擎当前状态快照 */
  getStatus(): KairosEngineStatus {
    const now = Date.now()

    // 按状态统计任务数
    const tasksByStatus: Record<KairosTaskStatus, number> = {
      pending: 0, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0,
    }
    for (const task of this.tasks.values()) {
      tasksByStatus[task.status]++
    }

    return {
      running: this.running,
      startTime: this.startTime,
      uptime: this.startTime ? now - this.startTime : 0,
      totalTasks: this.tasks.size,
      tasksByStatus,
      activeAgents: this.getActiveAgentCount(),
      maxAgents: this.config.maxConcurrentAgents,
      queuedTasks: this.taskQueue.size,
      tasksLastHour: this.recentExecutions.filter(t => now - t < 3600_000).length,
      watchPatterns: this.config.watchPatterns.length,
      lastTaskTime: this.history.length > 0 ? this.history[this.history.length - 1].endTime : null,
      lastError: this.lastError,
    }
  }

  /** 获取执行历史 */
  getHistory(): readonly KairosTaskHistoryEntry[] {
    return this.history
  }

  /** 获取所有 Agent 句柄 */
  getAgents(): KairosAgentHandle[] {
    return Array.from(this.agents.values())
  }

  // ═══════════════════════════════════════════
  // 事件订阅
  // ═══════════════════════════════════════════

  /** 订阅 Kairos 事件 */
  onEvent(type: KairosEventType | '*', handler: EventHandler): () => void {
    return this.eventBus.on(type, handler)
  }

  // ═══════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════

  /**
   * 主循环 tick
   *
   * 每个调度间隔执行一次：
   * 1. 检查 scheduled 任务是否到期
   * 2. 清理已完成的 Agent
   * 3. 从队列中取出任务分配给空闲 Agent
   * 4. 清理过期的速率限制记录
   */
  private async tick(): Promise<void> {
    if (!this.running) return

    const now = Date.now()

    // 第一步：检查定时任务
    for (const task of this.tasks.values()) {
      if (task.type === 'scheduled' && task.status === 'pending' && task.nextRun && task.nextRun <= now) {
        this.triggerTask(task.id)
      }
    }

    // 第二步：清理已完成的 Agent
    for (const [id, agent] of this.agents) {
      if (agent.status !== 'running' && agent.status !== 'spawning') {
        // 保留 60 秒用于查询，然后清理
        if (agent.endTime && now - agent.endTime > 60_000) {
          this.agents.delete(id)
        }
      }
    }

    // 第三步：从队列中取出任务执行
    while (this.taskQueue.size > 0 && this.getActiveAgentCount() < this.config.maxConcurrentAgents) {
      const task = this.taskQueue.dequeue()
      if (!task) break

      task.status = 'running'
      task.lastRun = now
      task.runCount++

      // 处理 prompt 模板变量
      const resolvedPrompt = task.prompt
        .replace(/\{\{timestamp\}\}/g, new Date().toISOString())

      // 记录执行
      this.recentExecutions.push(now)

      // spawn Agent
      await this.spawnAgent(resolvedPrompt, {
        cwd: task.cwd,
        task,
        priority: task.priority,
      })

      this.emitEvent('task:started', 'engine', { taskId: task.id, taskName: task.name })
    }

    // 第四步：清理过期的速率限制记录（只保留一小时内的）
    this.recentExecutions = this.recentExecutions.filter(t => now - t < 3600_000)

    this.emitEvent('scheduler:tick', 'scheduler', {
      queueSize: this.taskQueue.size,
      activeAgents: this.getActiveAgentCount(),
    })
  }

  /** Agent 完成回调——更新任务状态、记录历史、处理重试 */
  private onAgentFinished(task: KairosTask, agent: KairosAgentHandle): void {
    const historyEntry: KairosTaskHistoryEntry = {
      id: randomUUID().slice(0, 8),
      taskId: task.id,
      taskName: task.name,
      startTime: agent.startTime,
      endTime: agent.endTime || Date.now(),
      durationMs: (agent.endTime || Date.now()) - agent.startTime,
      result: agent.status === 'completed' ? 'success' : agent.status === 'killed' ? 'cancelled' : 'failure',
      outputSummary: agent.output.slice(-10).join('\n').slice(0, 500),
      exitCode: agent.exitCode,
      error: agent.status === 'failed' ? agent.output.slice(-3).join('\n') : undefined,
    }

    // 记录历史
    this.history.push(historyEntry)
    if (this.history.length > this.config.maxHistorySize) {
      this.history.shift()
    }

    if (agent.status === 'completed') {
      task.status = 'completed'
      task.failCount = 0

      // 如果是循环任务，重新计划
      if (task.recurring && task.type === 'scheduled') {
        task.status = 'pending'
        task.nextRun = this.calculateNextRun(task.trigger)
      }

      this.emitEvent('task:completed', 'engine', { taskId: task.id })
    } else if (agent.status === 'failed') {
      task.failCount++
      const maxRetries = task.maxRetries ?? this.config.maxRetries

      if (task.failCount <= maxRetries) {
        // 指数退避重试
        const delay = this.config.retryBaseDelayMs * Math.pow(2, task.failCount - 1)
        task.status = 'pending'
        task.nextRun = Date.now() + delay
        console.log(`[kairos] 任务 ${task.name} 失败 (${task.failCount}/${maxRetries})，${delay}ms 后重试`)
        this.emitEvent('task:retrying', 'engine', { taskId: task.id, retryIn: delay })
      } else {
        task.status = 'failed'
        console.error(`[kairos] 任务 ${task.name} 已达最大重试次数，标记为失败`)
        this.emitEvent('task:failed', 'engine', { taskId: task.id, failCount: task.failCount })

        // 发送失败通知
        this.notify({
          type: 'alert',
          target: '*',
          payload: {
            title: `任务失败: ${task.name}`,
            body: `已重试 ${maxRetries} 次仍然失败。\n最后错误: ${historyEntry.error || '未知'}`,
            severity: 'error',
          },
          timestamp: Date.now(),
          taskId: task.id,
        })
      }
    }
  }

  /** 发射事件的便捷方法 */
  private emitEvent(type: KairosEventType, source: string, data: Record<string, unknown>): void {
    this.eventBus.emit({ type, source, data, timestamp: Date.now() })
  }

  /** 速率限制检查 */
  private checkRateLimit(): boolean {
    const now = Date.now()
    const recentCount = this.recentExecutions.filter(t => now - t < 3600_000).length
    return recentCount < this.config.maxTasksPerHour
  }

  /**
   * 计算下次执行时间（简化版 cron 解析）
   *
   * 完整的 cron 解析较复杂，这里实现常用场景：
   * - "* * * * *" → 每分钟
   * - "0 * * * *" → 每小时
   * - "0 9 * * *" → 每天 9 点
   * - "0 9 * * 1" → 每周一 9 点
   */
  private calculateNextRun(cronExpr: string): number {
    const parts = cronExpr.split(' ')
    if (parts.length !== 5) return Date.now() + 60_000 // 解析失败默认 1 分钟后

    const [min, hour, _dom, _mon, _dow] = parts
    const now = new Date()

    // 简化处理：计算下一个匹配时间
    const next = new Date(now)

    if (min === '*' && hour === '*') {
      // 每分钟
      next.setMinutes(next.getMinutes() + 1)
      next.setSeconds(0)
    } else if (hour === '*') {
      // 每小时的第 N 分钟
      const targetMin = parseInt(min)
      if (now.getMinutes() >= targetMin) {
        next.setHours(next.getHours() + 1)
      }
      next.setMinutes(targetMin)
      next.setSeconds(0)
    } else {
      // 每天的 H:M
      const targetHour = parseInt(hour)
      const targetMin = parseInt(min)
      if (now.getHours() > targetHour || (now.getHours() === targetHour && now.getMinutes() >= targetMin)) {
        next.setDate(next.getDate() + 1)
      }
      next.setHours(targetHour)
      next.setMinutes(targetMin)
      next.setSeconds(0)
    }

    return next.getTime()
  }
}
