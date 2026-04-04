# kairos 模块阅读笔记

## 文件列表

```
src/kairos/
├── index.ts           # 统一导出
├── kairosEngine.ts    # 核心调度引擎（事件总线 + 优先级队列 + Agent 池）
├── kairosWatcher.ts   # 文件系统监控（chokidar + 防抖）
└── types.ts           # 完整类型定义（任务、事件、通知、配置）
```

## 核心功能

Kairos（希腊语 "恰当的时机"）是 Claude Code 的 **24/7 主动式 Agent 系统**，构建在 daemon 之上。

四种任务类型：
- **scheduled**：cron 定时任务（如每天 9:00 汇总 Git）
- **reactive**：事件触发（如 *.test.ts 修改后跑测试）
- **proactive**：规则主动发起（如检测到长时间未提交时提醒）
- **watch**：纯监控通知（不执行 Agent）

架构：外部事件 → 事件总线 → 优先级任务队列 → Agent 池管理 → 多渠道通知分发

## 关键代码片段

Agent 池管理——fork 子进程并行执行：

```typescript
const child = spawn('bun', ['run', binPath, '-p', prompt], {
  env: { ...process.env, KAIROS_AGENT: '1', KAIROS_PARENT_ID: id },
  stdio: ['ignore', 'pipe', 'pipe'],
})
// 环形缓冲区收集输出
child.stdout?.on('data', (data) => {
  handle.output.push(...lines)
  while (handle.output.length > maxOutputLines) handle.output.shift()
})
```

五级优先级队列（稳定排序）：

```typescript
this.queue.sort((a, b) => {
  const pa = PRIORITY_VALUES[a.priority]  // critical:100, high:75, ...
  const pb = PRIORITY_VALUES[b.priority]
  if (pa !== pb) return pb - pa
  return a.createdAt - b.createdAt  // 同优先级按时间排
})
```

## 设计亮点

1. **速率限制**：每小时最多 60 个任务，防止 reactive 任务失控
2. **指数退避重试**：`delay = baseDelay * 2^(retryCount-1)`，最多重试 3 次
3. **多渠道通知**：终端、文件、macOS osascript、UDS inbox，按配置开关
4. **防抖 Watcher**：编辑器保存产生多次写入，防抖合并为一次触发
5. **依赖 DAG**：任务间通过 `dependsOn` 构建有向无环图
6. **递归 spawn 保护**：子 Agent 环境变量设置 `KAIROS_AGENT=1`，防止无限递归创建 Agent
7. **60 秒保留**：已完成的 Agent 保留 60 秒供状态查询，之后自动清理
