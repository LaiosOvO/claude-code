# coordinator 模块阅读笔记

## 文件列表

```
src/coordinator/
├── coordinatorMode.ts   # 协调者模式逻辑
└── workerAgent.ts       # Worker Agent 定义（stub）
```

## 核心功能

coordinator 模块实现了 Claude Code 的**协调者模式（Coordinator Mode）**——一种多 Agent 协作架构，由一个协调者 Agent 管理多个 Worker Agent 并行工作。

通过 `CLAUDE_CODE_COORDINATOR_MODE` 环境变量和 `feature('COORDINATOR_MODE')` 门控启用。

协调者可以使用的特殊工具：
- `TeamCreateTool`：创建团队
- `TeamDeleteTool`：删除团队
- `SendMessageTool`：向 Worker 发送消息
- `SyntheticOutputTool`：合成��出
- `TaskStopTool`：停止任务

## 关键代码片段

模式检测——双重门控：

```typescript
export function isCoordinatorMode(): boolean {
  if (feature('COORDINATOR_MODE')) {
    return isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)
  }
  return false
}
```

Scratchpad 门控（避免循环依赖的重复检查）：

```typescript
// 与 filesystem.ts 的 isScratchpadEnabled() 检查同一个门
// 但为避免引入 filesystem.ts 的重量级依赖图，这里内联检查
function isScratchpadGateEnabled(): boolean {
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_scratch')
}
```

## 设计亮点

1. **内部工具隔离**：`INTERNAL_WORKER_TOOLS` 集合明确区分协调者专用工具和通用工具
2. **异步 Agent 工具集**：`ASYNC_AGENT_ALLOWED_TOOLS` 限制 Worker Agent 可用的工具范围
3. **循环依赖规避**：注释明确说明为什么不 import filesystem.ts，而是内联 statsig 门控检查
4. **Worker 可扩展**：`workerAgent.ts` 的 `getCoordinatorAgents()` 返回 `AgentDefinition[]`，预留动态 Agent 注册能力
5. **双重门控**���`feature('COORDINATOR_MODE')` 编译时消除 + 环境变量��行时检查

## 工具清单

协调者专用工具（`INTERNAL_WORKER_TOOLS`）：
- `TeamCreateTool` / `TeamDeleteTool`：团队生命周期管理
- `SendMessageTool`：向 Worker 发送指令
- `SyntheticOutputTool`：构造合成输出

通用工具（Worker 也可使用）：
- `AgentTool` / `BashTool` / `FileReadTool` / `FileEditTool`
