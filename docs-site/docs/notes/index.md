# 阅读笔记

本节包含 Claude Code Best (ccb) 源码的逐文件阅读笔记。每篇笔记针对一个或一组相关源文件，记录关键实现细节、设计思路和值得关注的代码片段。

---

## 笔记说明

每篇阅读笔记通常包含以下内容：

!!! abstract "笔记结构"

    - **文件信息** — 文件路径、行数、主要导出
    - **功能概述** — 这个文件/模块做了什么
    - **核心逻辑** — 关键函数与数据结构的分析
    - **设计亮点** — 值得学习的设计模式或技巧
    - **关联文件** — 与哪些其他文件有依赖关系

---

## 笔记索引

### 入口与启动（已完成）

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| CLI 入口 (ccb) | [CLI 入口](bin-claude-haha.md) | :material-check-circle: 已完成 |
| `preload.ts` | [预加载脚本](preload.md) | :material-check-circle: 已完成 |
| `src/entrypoints/cli.tsx` | [CLI 分发器](entrypoints-cli.md) | :material-check-circle: 已完成 |
| `src/main.tsx` | [Commander.js CLI 定义](main.md) | :material-check-circle: 已完成 |
| `src/setup.ts` | [一次性初始化](setup.md) | :material-check-circle: 已完成 |

### 核心引擎（已完成）

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/query.ts` | [AsyncGenerator 主循环](query.md) | :material-check-circle: 已完成 |
| `src/QueryEngine.ts` | [高层编排器](QueryEngine.md) | :material-check-circle: 已完成 |
| `src/context.ts` | [系统上下文构建](context.md) | :material-check-circle: 已完成 |

### 工具系统（已完成）

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/Tool.ts` | [Tool 接口 + buildTool()](Tool.md) | :material-check-circle: 已完成 |
| `src/tools.ts` | [工具注册表](tools.md) | :material-check-circle: 已完成 |

### 桥接系统（已完成）

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/bridge/bridgeMain.ts` | [独立桥接入口](bridge-bridgeMain.md) | :material-check-circle: 已完成 |
| `src/bridge/bridgeApi.ts` | [REST API 客户端](bridge-bridgeApi.md) | :material-check-circle: 已完成 |
| `src/bridge/bridgeMessaging.ts` | [消息路由](bridge-bridgeMessaging.md) | :material-check-circle: 已完成 |
| `src/bridge/replBridge.ts` | [REPL 内嵌桥接](bridge-replBridge.md) | :material-check-circle: 已完成 |

### 工具函数（已完成）

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/utils/teammateMailbox.ts` | [团队通信邮箱](utils-teammateMailbox.md) | :material-check-circle: 已完成 |
| `src/utils/cronTasks.ts` | [定时任务定义](utils-cronTasks.md) | :material-check-circle: 已完成 |
| `src/utils/cronScheduler.ts` | [Cron 调度器](utils-cronScheduler.md) | :material-check-circle: 已完成 |

### 待编写

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/screens/REPL.tsx` | — | :material-circle-outline: 待编写 |
| `src/services/api/claude.ts` | — | :material-circle-outline: 待编写 |
| `src/coordinator/` | — | :material-circle-outline: 待编写 |
| `src/plugins/` | — | :material-circle-outline: 待编写 |
| `src/skills/` | — | :material-circle-outline: 待编写 |
| `src/voice/` | — | :material-circle-outline: 待编写 |
| `src/daemon/` | — | :material-circle-outline: 待编写 |
| `src/kairos/` | — | :material-circle-outline: 待编写 |
| `src/uds/` | — | :material-circle-outline: 待编写 |
| `packages/` | — | :material-circle-outline: 待编写 |

---

!!! tip "如何贡献笔记"
    欢迎为任何文件添加阅读笔记。请在 `docs-site/docs/notes/` 目录下创建对应的 Markdown 文件，并在上方索引表中更新链接与状态。
