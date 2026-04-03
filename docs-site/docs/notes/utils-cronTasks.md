# 阅读笔记：cronTasks.ts

## 文件基本信息
- **路径**: `src/utils/cronTasks.ts`
- **行数**: 458 行
- **角色**: 定时任务（Scheduled Tasks）系统的数据层，负责定时任务的 CRUD 操作、cron 表达式解析、jitter 计算和磁盘持久化

## 核心功能

`cronTasks.ts` 管理 `.claude/scheduled_tasks.json` 文件中的定时任务数据。它是 Kairos 定时任务系统的底层数据引擎，为上层调度器（`cronScheduler.ts`）提供任务的读写、过滤、jitter 计算和生命周期管理。

任务分为两种风格：
- **一次性任务**（`recurring: false/undefined`）：触发一次后自动删除
- **循环任务**（`recurring: true`）：按计划重复触发，直到被显式删除或超过最大存活时间

此外还有两种存储模式：
- **持久任务**（durable 默认/undefined）：写入 `.claude/scheduled_tasks.json`，跨进程存活
- **会话任务**（`durable: false`）：只存在于进程内存（bootstrap/state.ts），进程退出即消失

## 关键代码解析

### CronTask 类型定义
```typescript
export type CronTask = {
  id: string               // 8位 hex UUID 短ID
  cron: string             // 5字段 cron 表达式（本地时间）
  prompt: string           // 触发时要执行的提示词
  createdAt: number        // 创建时间（epoch ms）
  lastFiredAt?: number     // 最近触发时间（仅循环任务）
  recurring?: boolean      // 是否循环
  permanent?: boolean      // 是否永久（免于 maxAge 自动过期）
  durable?: boolean        // runtime-only，false=会话级别，不写入磁盘
  agentId?: string         // runtime-only，触发时路由到指定 teammate 队列
}
```

### readCronTasks - 健壮读取
```typescript
export async function readCronTasks(dir?: string): Promise<CronTask[]> {
  // 1. 读取文件（不存在返回空数组）
  // 2. JSON 解析（格式错误返回空数组）
  // 3. 逐条验证 + 过滤：
  //    - 字段类型检查（id, cron, prompt, createdAt 必须存在且类型正确）
  //    - cron 表达式合法性检查（parseCronExpression）
  //    - 非法条目静默丢弃（记录 debug 日志）
  // 4. 只保留有效字段，剥离未知字段
}
```
设计原则：一条坏记录不阻塞整个文件。这对用户手动编辑 JSON 的场景非常友好。

### addCronTask - 添加任务
```typescript
export async function addCronTask(
  cron: string,
  prompt: string,
  recurring: boolean,
  durable: boolean,
  agentId?: string,
): Promise<string> {
  const id = randomUUID().slice(0, 8)  // 8位 hex 短ID
  const task = { id, cron, prompt, createdAt: Date.now(), ... }
  
  if (!durable) {
    // 会话任务：只加到内存
    addSessionCronTask({ ...task, ...(agentId ? { agentId } : {}) })
    return id
  }
  // 持久任务：读→追加→写
  const tasks = await readCronTasks()
  tasks.push(task)
  await writeCronTasks(tasks)
  return id
}
```
短 ID（8 hex chars）足够用于 MAX_JOBS=50 的场景，避免了长 UUID 在工具层展示和用户输入时的不便。

### removeCronTasks - 智能删除
```typescript
export async function removeCronTasks(ids: string[], dir?: string): Promise<void> {
  // 优化：先扫描会话存储，如果所有 id 都在内存中找到了，跳过文件读取
  if (dir === undefined && removeSessionCronTasks(ids) === ids.length) {
    return  // 全部是会话任务，无需碰磁盘
  }
  // 否则从文件过滤
  const tasks = await readCronTasks(dir)
  const remaining = tasks.filter(t => !idSet.has(t.id))
  if (remaining.length === tasks.length) return  // 无变化
  await writeCronTasks(remaining, dir)
}
```

### Jitter 系统 - 防雷群效应

文件实现了一套精心设计的 jitter 系统来分散定时任务的触发时间，防止大量用户在同一时刻（如整点）同时触发推理请求。

#### CronJitterConfig
```typescript
export type CronJitterConfig = {
  recurringFrac: number      // 循环任务延迟比例：0.1（间隔的10%）
  recurringCapMs: number     // 循环任务延迟上限：15分钟
  oneShotMaxMs: number       // 一次性任务提前量上限：90秒
  oneShotFloorMs: number     // 一次性任务最小提前量：0
  oneShotMinuteMod: number   // 一次性任务分钟模数：30（只对:00/:30 jitter）
  recurringMaxAgeMs: number  // 循环任务最大存活时间：7天
}
```

#### jitteredNextCronRunMs - 循环任务 jitter
```typescript
export function jitteredNextCronRunMs(
  cron: string, fromMs: number, taskId: string, cfg
): number | null {
  const t1 = nextCronRunMs(cron, fromMs)     // 下次触发时间
  const t2 = nextCronRunMs(cron, t1)         // 再下一次
  // jitter = frac(taskId) * recurringFrac * (t2 - t1)，上限 recurringCapMs
  // 循环任务往后延迟，延迟量与间隔成正比
}
```
关键：jitter 由 `taskId` 的前8个 hex 字符确定性计算（`parseInt(taskId.slice(0,8), 16) / 0x100000000`），所以同一个任务每次计算结果相同，但不同任务均匀分布在 [0,1) 上。

#### oneShotJitteredNextCronRunMs - 一次性任务 jitter
```typescript
export function oneShotJitteredNextCronRunMs(
  cron: string, fromMs: number, taskId: string, cfg
): number | null {
  const t1 = nextCronRunMs(cron, fromMs)
  // 只对 minute % oneShotMinuteMod === 0 的时刻做 jitter（:00 和 :30）
  // 一次性任务往前提前（不能延迟，那会违反"3点提醒我"的承诺）
  // lead = oneShotFloorMs + frac(taskId) * (oneShotMaxMs - oneShotFloorMs)
  // 不能提前到 fromMs 之前
}
```
一次性任务的 jitter 是**向前**（提前触发），因为延迟会破坏用户期望。只在整点和半点时刻施加 jitter，因为人类倾向于选择这些时间。

### markCronTasksFired - 批量时间戳更新
```typescript
export async function markCronTasksFired(
  ids: string[], firedAt: number, dir?: string
): Promise<void>
```
批量更新循环任务的 `lastFiredAt` 字段。调度器一个 tick 内可能触发多个任务，批量写入避免 N 次读-写。

## 数据流

```
用户通过 CronCreateTool 创建任务：
addCronTask("0 * * * *", "check PRs", true, true)
      ↓
readCronTasks() → 现有任务
      ↓
tasks.push(newTask) → writeCronTasks(tasks)
      ↓
.claude/scheduled_tasks.json 更新
      ↓
chokidar 监听到变化 → cronScheduler reload

调度器触发任务：
cronScheduler.check()
      ↓
nextCronRunMs / jitteredNextCronRunMs 计算触发时间
      ↓
now >= nextFireAt? → onFire(task.prompt)
      ↓
循环任务 → markCronTasksFired([id], now)
一次性任务 → removeCronTasks([id])
```

## 与其他模块的关系

**依赖**:
- `cron.ts` → `parseCronExpression`, `computeNextCronRun`（cron 表达式解析引擎）
- `bootstrap/state.ts` → 会话级任务存储（`addSessionCronTask`, `getSessionCronTasks`, `removeSessionCronTasks`）
- `fsOperations.ts` → 文件系统抽象
- `json.ts` / `slowOperations.ts` → JSON 解析/序列化

**被依赖**:
- `cronScheduler.ts` → 读取任务列表、调用 jitter 函数、删除/标记任务
- `CronCreateTool` → 调用 addCronTask
- `CronDeleteTool` → 调用 removeCronTasks
- `CronListTool` → 调用 listAllCronTasks
- `cronJitterConfig.ts` → 提供运行时 CronJitterConfig（GrowthBook 远程配置）

## 设计亮点与思考

1. **确定性 jitter**：用 taskId 的 hex 值计算 jitter 比例，确保同一任务每次重启后计算结果一致，不同任务均匀分布。这比随机 jitter 好——随机 jitter 在进程重启后会变化，导致触发时间不可预测。

2. **双向 jitter 策略**：循环任务向后延迟（对"每小时检查"场景无感知影响），一次性任务向前提前（"3点提醒我"不能延迟）。两种策略针对不同用户心智模型精确调优。

3. **分钟模数 jitter 门控**：一次性任务只在 `minute % 30 === 0` 的时刻施加 jitter。因为人类倾向于设置整点/半点提醒，这些是真正的"热门时刻"。非热门时刻无需分散。

4. **运行时可调的 jitter 配置**：`CronJitterConfig` 通过 GrowthBook 远程配置（`tengu_kairos_cron_config`），运维可以在不发布客户端的情况下调整 jitter 窗口。注释中甚至给出了应急配置示例。

5. **持久/会话双轨存储**：持久任务跨进程存活（文件），会话任务随进程消亡（内存）。deleteCronTasks 智能识别——先查内存，全命中则跳过磁盘IO。

## 要点总结

1. **`cronTasks.ts` 是定时任务系统的数据层**，管理 `.claude/scheduled_tasks.json` 的 CRUD、cron 解析和 jitter 计算。
2. **双轨存储**：持久任务（文件）和会话任务（内存），removeCronTasks 智能跨存储删除。
3. **防雷群 jitter 系统**：确定性 jitter（taskId 驱动），循环任务向后延迟，一次性任务向前提前，只在 :00/:30 热门时刻施加。
4. **健壮的数据读取**：单条坏记录不阻塞整个文件，cron 表达式无效的条目静默丢弃。
5. **`recurringMaxAgeMs`（7天）自动过期**防止循环任务无限堆积，permanent 标记的系统任务豁免。
