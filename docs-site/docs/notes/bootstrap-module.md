# bootstrap 模块阅读笔记

> 源码路径：`src/bootstrap/`
> 文件数量：约 2 个核心文件（`state.ts`）+ `src/` 目录

## 概述

`bootstrap/` 模块管理 Claude Code 的 **进程级全局单例状态**，与 `state/` 模块的 React 状态互补。它是整个应用的"启动状态锚点"，在 import DAG 中处于叶子位置，确保被所有模块安全引用而不产生循环依赖。

## 文件列表

| 文件 | 职责 |
|---|---|
| `state.ts` | 全局单例状态：会话信息、遥测计数器、模型配置、错误日志等 |

## State 核心类型

`state.ts` 定义了一个巨大的 `State` 对象，包含以下关键字段分组：

### 会话与路径

| 字段 | 类型 | 说明 |
|---|---|---|
| `originalCwd` | string | 原始工作目录 |
| `projectRoot` | string | 项目根目录（启动时确定，不随 worktree 变化） |
| `cwd` | string | 当前工作目录 |
| `sessionId` | SessionId | 会话唯一标识 |
| `parentSessionId` | SessionId? | 父会话 ID（用于追踪会话谱系） |

### 统计与计量

| 字段 | 类型 | 说明 |
|---|---|---|
| `totalCostUSD` | number | 总 API 费用 |
| `totalAPIDuration` | number | 总 API 调用时长 |
| `totalLinesAdded/Removed` | number | 总增删行数 |
| `modelUsage` | Record | 各模型用量统计 |
| `turnToolCount` | number | 当前轮次工具调用次数 |
| `turnHookCount` | number | 当前轮次 Hook 调用次数 |

### 遥测

| 字段 | 类型 | 说明 |
|---|---|---|
| `meter` | Meter | OpenTelemetry Meter |
| `sessionCounter` | AttributedCounter | 会话计数器 |
| `locCounter` | AttributedCounter | 代码行数计数器 |
| `costCounter` | AttributedCounter | 费用计数器 |
| `meterProvider` | MeterProvider | Meter 提供者 |
| `tracerProvider` | BasicTracerProvider | 追踪提供者 |
| `loggerProvider` | LoggerProvider | 日志提供者 |

### 模型配置

| 字段 | 类型 | 说明 |
|---|---|---|
| `mainLoopModelOverride` | ModelSetting? | 主循环模型覆盖 |
| `initialMainLoopModel` | ModelSetting | 初始主循环模型 |
| `modelStrings` | ModelStrings? | 模型显示名称映射 |

### 会话标志

| 字段 | 类型 | 说明 |
|---|---|---|
| `isInteractive` | boolean | 是否交互模式 |
| `kairosActive` | boolean | Kairos 功能是否激活 |
| `strictToolResultPairing` | boolean | 严格工具结果配对（HFI 模式） |
| `sessionBypassPermissionsMode` | boolean | 会话级绕过权限模式 |
| `hasExitedPlanMode` | boolean | 是否退出过计划模式 |
| `sessionTrustAccepted` | boolean | 会话级信任已接受 |

### 其他单例

| 字段 | 说明 |
|---|---|
| `agentColorMap` | Agent 颜色分配表 |
| `inMemoryErrorLog` | 内存中的错误日志 |
| `inlinePlugins` | 命令行指定的插件列表 |
| `sessionCronTasks` | 会话级定时任务 |
| `sessionCreatedTeams` | 会话创建的团队（关机时清理） |

## 关键导出函数

| 函数 | 说明 |
|---|---|
| `getIsNonInteractiveSession()` | 判断是否非交互式会话 |
| `getSessionCounter()` | 获取会话计数器 |
| `setMeter()` | 设置遥测 Meter |
| `setMainLoopModelOverride()` | 设置模型覆盖 |

## 设计亮点

1. **Import DAG 叶子节点** — 注释明确要求 "DO NOT ADD MORE STATE HERE"，保持最小依赖
2. **进程级 vs React 级** — 与 `state/` 的 React 状态互补：bootstrap 是进程单例，state 是 React Context
3. **会话级标志** — 多个 `session*` 标志不持久化到磁盘，仅在当前进程生命周期内有效
4. **createSignal 模式** — 使用 `createSignal` 创建可观察的状态变更信号
5. **Brand 类型集成** — 使用 `SessionId` 品牌类型确保类型安全

## 与其他模块的关系

- **entrypoints/** — `init.ts` 导入并初始化 bootstrap 状态
- **state/** — React 级 AppState 引用 bootstrap 的全局配置
- **bridge/** — 使用 `sessionId`、`projectRoot` 等全局信息
- **constants/** — `prompts.ts` 引用 `getIsNonInteractiveSession()` 决定提示词内容
- **keybindings/** — 不直接依赖 bootstrap（保持独立）
