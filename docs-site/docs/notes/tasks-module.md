# tasks 模块阅读笔记

> 源码路径：`src/tasks/`
> 文件数量：约 14 个（含子目录）

## 概述

`tasks/` 模块实现了 Claude Code 的 **后台任务管理系统**。它定义了 7 种任务类型，涵盖本地 Shell 命令、本地/远程 Agent、进程内队友、工作流、MCP 监控和 Dream 任务。任务可以在前台运行或后台执行，UI 通过 pill 标签展示任务状态。

## 文件/目录结构

| 文件/目录 | 职责 |
|---|---|
| `types.ts` | 任务状态联合类型 `TaskState`、`BackgroundTaskState`、`isBackgroundTask()` |
| `stopTask.ts` | 任务停止逻辑：查找、验证、终止、标记 |
| `pillLabel.ts` | 底部 pill 标签文本生成（如 "1 shell"、"2 local agents"） |
| `DreamTask/` | Dream 任务（实验性） |
| `InProcessTeammateTask/` | 进程内队友任务（含 types.ts） |
| `LocalAgentTask/` | 本地 Agent 任务 |
| `LocalShellTask/` | 本地 Shell 任务（含 guards.ts、killShellTasks.ts） |
| `LocalWorkflowTask/` | 本地工作流任务 |
| `MonitorMcpTask/` | MCP 监控任务 |
| `RemoteAgentTask/` | 远程 Agent 任务 |

## 核心类型（types.ts）

```typescript
type TaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState
```

### 后台任务判定

```typescript
function isBackgroundTask(task: TaskState): task is BackgroundTaskState {
  // 必须是 running 或 pending 状态
  // 且不是前台任务（isBackgrounded !== false）
}
```

## 7 种任务类型

| 类型 | type 值 | 说明 |
|---|---|---|
| LocalShellTask | `local_bash` | 本地 Shell 命令（含 `kind: 'monitor'` 变体） |
| LocalAgentTask | `local_agent` | 本地 Agent 子任务 |
| RemoteAgentTask | `remote_agent` | 远程 Agent（含 ultraplan 阶段） |
| InProcessTeammateTask | `in_process_teammate` | 进程内队友（含 team identity） |
| LocalWorkflowTask | `local_workflow` | 本地工作流脚本 |
| MonitorMcpTask | `monitor_mcp` | MCP 服务器监控 |
| DreamTask | `dream` | 实验性 Dream 任务 |

## 关键函数

| 函数 | 位置 | 说明 |
|---|---|---|
| `isBackgroundTask()` | types.ts | 判断任务是否应显示在后台指示器 |
| `stopTask()` | stopTask.ts | 按 ID 查找并终止任务，抛出 `StopTaskError` |
| `getPillLabel()` | pillLabel.ts | 生成底部任务计数标签 |
| `killShellTasks()` | LocalShellTask/ | 批量终止 Shell 任务 |

### stopTask 流程

1. 从 `appState.tasks` 查找任务
2. 验证 `status === 'running'`
3. 调用 `getTaskByType(task.type)` 获取实现
4. 执行终止并标记为已通知
5. 发射 SDK 事件 `emitTaskTerminatedSdk()`

## Pill 标签逻辑（pillLabel.ts）

根据任务类型和数量生成紧凑文本：
- Shell: "1 shell, 2 monitors"
- Teammate: 按 teamName 去重 "1 team" / "3 teams"
- Remote Agent + ultraplan: 使用钻石符号 `◇ ultraplan` / `◆ ultraplan ready`
- 混合类型: "3 tasks"

## 设计亮点

1. **判别联合** — 7 种任务类型通过 `type` 字段判别，TypeScript 自动推断子类型
2. **前台/后台双模** — 任务默认后台运行，`isBackgrounded: false` 标记前台任务
3. **StopTaskError 错误码** — `not_found` / `not_running` / `unsupported_type` 三种错误码便于调用方分类处理
4. **Ultraplan 阶段** — RemoteAgentTask 支持 plan_ready / needs_input 等阶段状态

## 与其他模块的关系

- **state/** — `AppState.tasks: Record<string, TaskState>` 存储所有任务
- **components/** — `components/tasks/` 渲染任务列表，使用 `getPillLabel()` 展示
- **bridge/** — 远程 Agent 任务通过桥接层通信
- **constants/** — 工具常量决定各任务类型可使用的工具集
