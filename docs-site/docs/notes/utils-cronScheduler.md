# 阅读笔记：cronScheduler.ts

## 文件基本信息
- **路径**: `src/utils/cronScheduler.ts`
- **行数**: 565 行
- **角色**: 定时任务系统的调度引擎，负责 cron 任务的定时检测、触发、文件监听和进程间协调

## 核心功能

`cronScheduler.ts` 是 Kairos 定时任务系统的运行时调度核心。它在非 React 环境下运行（可以被 REPL 的 `useScheduledTasks` hook 和 SDK/-p 模式的 `print.ts` 共同使用），负责：

1. 按1秒间隔检查任务是否到了触发时间
2. 通过 chokidar 监听 `scheduled_tasks.json` 文件变化实现热重载
3. 通过文件锁实现跨进程调度互斥——同一目录下只有一个 Claude 进程负责触发磁盘任务
4. 处理"错过的任务"（Claude 不运行时应该触发的一次性任务）
5. 管理循环任务的生命周期（重新调度、自动过期）

## 关键代码解析

### CronSchedulerOptions - 调度器配置
```typescript
type CronSchedulerOptions = {
  onFire: (prompt: string) => void      // 任务触发回调
  isLoading: () => boolean               // 加载中标记（延迟触发）
  assistantMode?: boolean                // 助手模式（跳过 isLoading 检查）
  onFireTask?: (task: CronTask) => void  // 完整任务触发回调（daemon 用）
  onMissed?: (tasks: CronTask[]) => void // 错过任务回调（daemon 用）
  dir?: string                           // 任务文件目录（daemon 用）
  lockIdentity?: string                  // 锁标识（daemon 用）
  getJitterConfig?: () => CronJitterConfig // jitter 配置获取器
  isKilled?: () => boolean               // 全局开关（GrowthBook）
  filter?: (t: CronTask) => boolean      // 任务过滤器
}
```

### createCronScheduler - 工厂函数
```typescript
export function createCronScheduler(options): CronScheduler {
  // 返回 { start(), stop(), getNextFireTime() }
}
```

### start() - 启动流程
```typescript
start() {
  // Daemon 路径（dir 给定）：直接 enable()
  // REPL 路径：
  //   如果已启用 → enable()
  //   如果有任务文件 → 自动启用 → enable()
  //   否则 → 每秒轮询 getScheduledTasksEnabled()
}
```
REPL 路径下有一个轮询等待机制：如果启动时没有任何定时任务，调度器不会立即启用（避免不必要的 chokidar 和文件锁开销）。当用户通过 CronCreateTool 创建第一个任务时，`setScheduledTasksEnabled(true)` 被调用，下一个轮询周期调度器启用。

### enable() - 核心启用逻辑
```typescript
async function enable() {
  // 1. 加载 chokidar
  // 2. 尝试获取调度锁（tryAcquireSchedulerLock）
  //    - 获得 → isOwner = true
  //    - 未获得 → 启动5秒周期的锁探测定时器
  // 3. load(true) → 读取任务 + 处理"错过的任务"
  // 4. 设置 chokidar 监听（add/change/unlink）
  // 5. 启动1秒间隔的 check() 定时器
}
```

### 调度锁（Scheduler Lock）
```typescript
isOwner = await tryAcquireSchedulerLock(lockOpts)

// 未获得锁时：
lockProbeTimer = setInterval(() => {
  tryAcquireSchedulerLock(lockOpts).then(owned => {
    if (owned) {
      isOwner = true
      clearInterval(lockProbeTimer)
    }
  })
}, LOCK_PROBE_INTERVAL_MS)  // 5秒
```
同一个 `.claude/scheduled_tasks.json` 可能被多个 Claude 进程共享（用户在同一目录打开多个终端）。调度锁确保只有一个进程触发磁盘任务，防止双重触发。锁不影响会话任务——会话任务是进程私有的，不存在竞争。

非持有者每5秒探测一次锁，当持有者崩溃后接管。

### check() - 核心调度检查
```typescript
function check() {
  if (isKilled?.()) return        // 全局开关
  if (isLoading() && !assistantMode) return  // 加载中

  function process(t: CronTask, isSession: boolean) {
    if (filter && !filter(t)) return   // 任务过滤
    if (inFlight.has(t.id)) return     // 防双重触发

    let next = nextFireAt.get(t.id)
    if (next === undefined) {
      // 首次遇到：从 lastFiredAt（循环）或 createdAt（一次性）锚定
      next = t.recurring
        ? jitteredNextCronRunMs(t.cron, t.lastFiredAt ?? t.createdAt, t.id, cfg)
        : oneShotJitteredNextCronRunMs(t.cron, t.createdAt, t.id, cfg)
      nextFireAt.set(t.id, next)
    }

    if (now < next) return  // 未到触发时间

    // 触发！
    onFireTask ? onFireTask(t) : onFire(t.prompt)

    // 生命周期管理：
    if (t.recurring && !aged) {
      // 循环：从 now（非 next）重新计算下次触发时间
      const newNext = jitteredNextCronRunMs(t.cron, now, t.id, cfg)
      nextFireAt.set(t.id, newNext)
      if (!isSession) firedFileRecurring.push(t.id)  // 批量写 lastFiredAt
    } else if (isSession) {
      // 一次性会话任务：同步内存删除
      removeSessionCronTasks([t.id])
    } else {
      // 一次性文件任务：异步文件删除 + inFlight 保护
      inFlight.add(t.id)
      void removeCronTasks([t.id], dir).finally(() => inFlight.delete(t.id))
    }
  }

  // 文件任务：只有 owner 才触发
  if (isOwner) {
    for (const t of tasks) process(t, false)
    // 批量写 lastFiredAt
    if (firedFileRecurring.length > 0) {
      void markCronTasksFired(firedFileRecurring, now, dir)
    }
  }
  // 会话任务：每个进程独立，不受锁限制
  if (dir === undefined) {
    for (const t of getSessionCronTasks()) process(t, true)
  }

  // 清理不再存在的任务的调度条目
  for (const id of nextFireAt.keys()) {
    if (!seen.has(id)) nextFireAt.delete(id)
  }
}
```

### isRecurringTaskAged - 自动过期检测
```typescript
export function isRecurringTaskAged(
  t: CronTask, nowMs: number, maxAgeMs: number
): boolean {
  if (maxAgeMs === 0) return false  // 0 = 无限
  return Boolean(t.recurring && !t.permanent && nowMs - t.createdAt >= maxAgeMs)
}
```
循环任务在创建后超过 `recurringMaxAgeMs`（默认7天）自动过期。`permanent` 标记的任务豁免（助手模式的内置任务如 catch-up/morning-checkin/dream）。过期任务最后触发一次后删除。

### load(initial) - 任务加载
```typescript
async function load(initial: boolean) {
  tasks = await readCronTasks(dir)
  if (!initial) return  // 非首次加载不处理错过的任务

  // 首次加载：检测错过的一次性任务
  const missed = findMissedTasks(next, now)
    .filter(t => !t.recurring && !missedAsked.has(t.id) && (!filter || filter(t)))
  
  if (missed.length > 0) {
    // 防止 check() 在异步删除期间重复触发
    for (const t of missed) nextFireAt.set(t.id, Infinity)
    
    onMissed ? onMissed(missed) : onFire(buildMissedTaskNotification(missed))
    void removeCronTasks(missed.map(t => t.id), dir)
  }
}
```
只在首次加载时检测错过的任务。chokidar 触发的重载不检测——让 check() 正常处理过期任务即可。

### buildMissedTaskNotification - 安全的提示构建
```typescript
export function buildMissedTaskNotification(missed: CronTask[]): string {
  // 使用代码围栏包裹任务 prompt，围栏长度比 prompt 中最长的反引号序列多1
  // 防止 prompt 内容的反引号关闭围栏导致文本注入
  const longestRun = (t.prompt.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length), 0
  )
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
}
```
安全措施：提示词可能包含反引号，如果不处理，恶意 prompt 可以关闭围栏并注入指令。通过动态计算围栏长度（比 prompt 中最长的 `` ` `` 序列多1）来防御。

### getNextFireTime() - 下次触发时间
```typescript
getNextFireTime() {
  let min = Infinity
  for (const t of nextFireAt.values()) {
    if (t < min) min = t
  }
  return min === Infinity ? null : min
}
```
返回所有已调度任务中最早的触发时间。Daemon 用这个决定是否拆掉空闲的 agent 子进程还是保持运行等待即将到来的触发。

## 数据流

```
start()
  ↓
[REPL路径] 轮询 getScheduledTasksEnabled()
  ↓ CronCreateTool 触发 setScheduledTasksEnabled(true)
  ↓
enable()
  ↓
tryAcquireSchedulerLock()
  ↓ 获得锁
load(true) → readCronTasks() → 检测 missed tasks
  ↓
chokidar.watch(scheduled_tasks.json)
  ↓ add/change → load(false)
  ↓ unlink → tasks = [], nextFireAt.clear()
  ↓
setInterval(check, 1000)
  ↓ 每秒执行
  ↓
check():
  文件任务（isOwner=true 时）
    ↓ jitteredNextCronRunMs → now >= next? → onFire
    ↓ 循环 → markCronTasksFired + 重新调度
    ↓ 一次性 → removeCronTasks
  
  会话任务（dir=undefined 时）
    ↓ getSessionCronTasks() → 同上逻辑
    ↓ 一次性 → removeSessionCronTasks（同步内存删除）
```

## 与其他模块的关系

**依赖**:
- `cronTasks.ts` → 数据层（readCronTasks, removeCronTasks, markCronTasksFired, jitteredNextCronRunMs 等）
- `cronTasksLock.ts` → 跨进程调度锁（tryAcquireSchedulerLock, releaseSchedulerLock）
- `bootstrap/state.ts` → 会话级任务和启用状态
- `chokidar` → 文件变化监听
- `analytics/index.ts` → 触发事件遥测

**被依赖**:
- `useScheduledTasks.ts`（React hook）→ 在 REPL 中启动调度器
- `print.ts` → 在 `-p` 模式下启动调度器
- Daemon 模块 → 在 Agent SDK 中启动调度器

## 设计亮点与思考

1. **文件锁跨进程协调**：同一目录下多个 Claude 进程时，只有一个触发磁盘任务。非持有者每5秒探测一次接管。会话任务不受锁影响（进程私有）。

2. **首次遇到锚点（first-sight anchor）**：循环任务首次遇到时从 `lastFiredAt ?? createdAt` 锚定，而非 `now`。这确保了：进程重启后计算的触发时间与上次进程中的一致（`lastFiredAt` 在触发时被写回磁盘）；使用 `createdAt` 避免了 `isLoading` 延迟导致 `now` 超过触发时间后，锚定到 `now` 会将固定日期 cron（`30 14 27 2 *`）推到明年。

3. **循环任务从 `now` 重新调度而非从 `next`**：`next` 可能是过去的时间（isLoading 阻塞了 check），从 `next` 重新调度会导致快速连续触发（catch-up）。从 `now` 开始避免了这个问题。

4. **inFlight 双重触发保护**：异步的 `removeCronTasks` + chokidar 重载有时间窗口。`inFlight` Set 确保在删除完成前不会重复触发。对 `markCronTasksFired` 也有同样的保护。

5. **killswitch + 实时配置**：`isKilled` 回调连接到 GrowthBook gate，可以在不重启客户端的情况下停止所有调度。`getJitterConfig` 也是实时读取，运维可以在负载高峰时动态加大 jitter 窗口。

6. **`checkTimer.unref()`**：定时器不会阻止进程退出。在 `-p text` 模式下，即使创建了 cron 任务，进程仍然在单轮结束后正常退出。

## 要点总结

1. **`cronScheduler.ts` 是定时任务的运行时调度引擎**，每秒检查触发条件，通过文件锁协调跨进程，通过 chokidar 实现热重载。
2. **调度锁**确保同一目录下只有一个 Claude 进程触发磁盘任务。非持有者每5秒探测接管。会话任务不受锁限制。
3. **首次遇到锚点**从 `lastFiredAt`（持久化）或 `createdAt` 计算，确保进程重启后一致。循环任务从 `now` 重新调度防止 catch-up 连续触发。
4. **错过任务检测**只在首次加载时执行。一次性错过的任务给用户确认后执行，循环任务由 check() 正常处理。
5. **实时可调**：GrowthBook 提供 killswitch 和 jitter 配置，运维可以不发版本地控制调度行为。
