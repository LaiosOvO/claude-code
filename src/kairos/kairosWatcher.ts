/**
 * Kairos 文件监控器 — 响应式任务触发
 *
 * 使用 chokidar 监控文件系统变化，根据配置的规则
 * 将匹配的变化事件转化为 Kairos 任务触发。
 *
 * 为什么需要文件监控？
 * ────────────────────
 * reactive 任务的核心触发机制。例如：
 * - *.test.ts 文件修改后自动运行测试
 * - package.json 变更后自动安装依赖
 * - .env 文件修改后提醒重启服务
 *
 * 关键设计：防抖
 * ──────────────
 * 编辑器保存文件时通常产生多次写入事件。
 * 防抖将短时间内的多次变化合并为一次触发，
 * 避免重复执行任务浪费资源。
 *
 *   事件:  ─┤──┤─┤──────┤──┤─┤──────────────
 *   防抖:  ─────────┤──────────┤─────────────
 *                   触发       触发
 */

import { watch, type FSWatcher } from 'chokidar'
import type { KairosWatchRule, KairosWatchEventType, KairosEvent } from './types'

/**
 * 文件变化事件
 * 封装了 chokidar 原始事件的标准化表示
 */
export interface FileChangeEvent {
  /** 文件路径（相对于监控目录） */
  path: string
  /** 事件类型 */
  event: KairosWatchEventType
  /** 事件时间戳 */
  timestamp: number
}

/**
 * Watcher 回调——当规则匹配时触发
 */
export type WatcherCallback = (rule: KairosWatchRule, event: FileChangeEvent) => void

/**
 * KairosWatcher — 文件变化监控与规则匹配引擎
 */
export class KairosWatcher {
  /** chokidar 实例 */
  private watcher: FSWatcher | null = null

  /** 监控规则列表 */
  private rules: KairosWatchRule[] = []

  /** 规则匹配时的回调 */
  private callback: WatcherCallback | null = null

  /** 监控根目录 */
  private cwd: string

  /**
   * 防抖定时器 Map
   * key: 规则 pattern + 文件路径的组合
   * value: 定时器引用
   *
   * 为什么用 pattern+path 作为 key？
   * 因为同一个文件可能匹配多个规则，每个规则的防抖是独立的。
   * 但同一个规则对同一文件的连续变化应该被合并。
   */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** 是否正在运行 */
  private running = false

  constructor(cwd: string) {
    this.cwd = cwd
  }

  /**
   * 启动文件监控
   *
   * @param rules 监控规则列表
   * @param callback 规则匹配时的回调函数
   */
  start(rules: KairosWatchRule[], callback: WatcherCallback): void {
    if (this.running) {
      console.warn('[kairos:watcher] 已在运行中，先停止再启动')
      this.stop()
    }

    this.rules = rules.filter(r => r.enabled)
    this.callback = callback

    if (this.rules.length === 0) {
      console.log('[kairos:watcher] 没有启用的监控规则，跳过启动')
      return
    }

    // 收集所有需要监控的 glob 模式
    const patterns = this.rules.map(r => r.pattern)

    console.log(`[kairos:watcher] 启动文件监控 | 规则数: ${this.rules.length} | 目录: ${this.cwd}`)

    // 创建 chokidar 实例
    this.watcher = watch(patterns, {
      cwd: this.cwd,
      // 忽略 node_modules 和 .git（性能优化）
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/.claude/**',
      ],
      // 使用轮询而非 native FS events（更可靠但 CPU 开销稍高）
      // 在大型项目中可以设为 false 使用原生事件
      usePolling: false,
      // 文件系统事件的稳定性等待时间
      awaitWriteFinish: {
        stabilityThreshold: 300, // 文件大小稳定 300ms 后才触发
        pollInterval: 100,       // 检查间隔
      },
      // 忽略初始扫描事件（只关心启动后的变化）
      ignoreInitial: true,
    })

    // 绑定事件处理
    this.watcher.on('add', (path) => this.handleEvent(path, 'create'))
    this.watcher.on('change', (path) => this.handleEvent(path, 'modify'))
    this.watcher.on('unlink', (path) => this.handleEvent(path, 'delete'))

    this.watcher.on('error', (error) => {
      console.error('[kairos:watcher] 文件监控错误:', error)
    })

    this.watcher.on('ready', () => {
      console.log('[kairos:watcher] 文件监控就绪')
    })

    this.running = true
  }

  /**
   * 停止文件监控
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }

    // 清除所有防抖定时器
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()

    this.running = false
    console.log('[kairos:watcher] 文件监控已停止')
  }

  /**
   * 动态添加规则（运行时）
   */
  addRule(rule: KairosWatchRule): void {
    this.rules.push(rule)
    // 如果 watcher 正在运行，添加新的监控模式
    if (this.watcher && rule.enabled) {
      this.watcher.add(rule.pattern)
    }
  }

  /**
   * 动态移除规则
   */
  removeRule(pattern: string): void {
    this.rules = this.rules.filter(r => r.pattern !== pattern)
    // 注意：chokidar 的 unwatch 可能不完全可靠
    if (this.watcher) {
      this.watcher.unwatch(pattern)
    }
  }

  /**
   * 处理文件系统事件
   *
   * 工作流程：
   * 1. 遍历所有规则，找到匹配的规则
   * 2. 对匹配的规则应用防抖
   * 3. 防抖结束后调用回调
   */
  private handleEvent(filePath: string, eventType: KairosWatchEventType): void {
    const event: FileChangeEvent = {
      path: filePath,
      event: eventType,
      timestamp: Date.now(),
    }

    // 遍历规则寻找匹配
    for (const rule of this.rules) {
      if (!rule.enabled) continue
      if (!rule.events.includes(eventType)) continue

      // 使用 picomatch 或简单的 glob 匹配
      // chokidar 已经做了 glob 匹配（它只会触发匹配 pattern 的文件）
      // 所以这里我们信任 chokidar 的过滤结果

      // 应用防抖
      const debounceKey = `${rule.pattern}:${filePath}`
      const existing = this.debounceTimers.get(debounceKey)
      if (existing) {
        clearTimeout(existing)
      }

      const timer = setTimeout(() => {
        this.debounceTimers.delete(debounceKey)
        // 替换 prompt 中的模板变量
        console.log(`[kairos:watcher] 规则触发: ${rule.pattern} | 文件: ${filePath} | 事件: ${eventType}`)
        this.callback?.(rule, event)
      }, rule.debounceMs)

      this.debounceTimers.set(debounceKey, timer)
    }
  }

  /** 获取运行状态 */
  isRunning(): boolean {
    return this.running
  }

  /** 获取当前规则数 */
  getRuleCount(): number {
    return this.rules.length
  }
}
