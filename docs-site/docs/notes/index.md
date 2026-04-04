# 阅读笔记

本节包含 Claude Code Best (ccb) 全部 43 个 src/ 模块的逐模块阅读笔记，以及核心源文件的逐行级分析。

---

## 覆盖统计

| 类别 | 已完成 | 说明 |
|------|--------|------|
| 核心文件笔记 | 18 篇 | 入口、引擎、工具、桥接、工具函数 |
| 模块笔记 | 28 篇 | 覆盖全部 43 个 src/ 子目录 |
| **总计** | **46 篇** | |

---

## 入口与启动

| 模块 | 笔记 |
|------|------|
| CLI 入口 (ccb) | [CLI 入口](bin-claude-haha.md) |
| preload.ts | [预加载脚本](preload.md) |
| entrypoints/cli.tsx | [CLI 分发器](entrypoints-cli.md) |
| entrypoints/ 模块 | [入口点模块](entrypoints-module.md) |
| bootstrap/ 模块 | [全局单例状态](bootstrap-module.md) |

## 核心引擎

| 模块 | 笔记 |
|------|------|
| main.tsx | [Commander.js CLI 定义](main.md) |
| setup.ts | [一次性初始化](setup.md) |
| query.ts | [AsyncGenerator 主循环](query.md) |
| query/ 子目录 | [查询基础设施](query-dir.md) |
| QueryEngine.ts | [高层编排器](QueryEngine.md) |
| context.ts | [系统上下文构建](context.md) |
| context/ 子目录 | [React UI 全局状态](context-dir.md) |

## 工具系统

| 模块 | 笔记 |
|------|------|
| Tool.ts | [Tool 接口 + buildTool()](Tool.md) |
| tools.ts | [工具注册表](tools.md) |
| commands/ | [100+ 斜杠命令](commands.md) |
| skills/ | [Skill 扩展系统](skills-module.md) |

## UI 层

| 模块 | 笔记 |
|------|------|
| screens/ | [REPL.tsx 深入分析](screens.md) |
| ink/ | [自定义 Ink 渲染框架](ink.md) |
| components/ | [React 组件库](components.md) |
| hooks/ | [80+ 自定义 Hooks](hooks.md) |
| keybindings/ | [键盘绑定系统](keybindings-module.md) |
| vim/ | [Vim 模式状态机](vim-module.md) |

## 状态与类型

| 模块 | 笔记 |
|------|------|
| state/ | [AppState 状态管理](state-module.md) |
| types/ | [核心类型定义](types-module.md) |
| constants/ | [全局常量](constants-module.md) |
| schemas/ | [共享 Zod Schema](schemas-module.md) |

## 服务层

| 模块 | 笔记 |
|------|------|
| services/ | [40+ 服务模块](services.md) |
| cli/ | [CLI 工具与传输层](cli-module.md) |
| server/ | [远程服务模式](server-module.md) |
| tasks/ | [后台任务管理](tasks-module.md) |
| migrations/ | [数据迁移](migrations-module.md) |

## 桥接与远程

| 模块 | 笔记 |
|------|------|
| bridge/ 模块 | [桥接架构总览](bridge-module.md) |
| bridgeMain.ts | [独立桥接入口](bridge-bridgeMain.md) |
| bridgeApi.ts | [REST API 客户端](bridge-bridgeApi.md) |
| bridgeMessaging.ts | [消息路由](bridge-bridgeMessaging.md) |
| replBridge.ts | [REPL 内嵌桥接](bridge-replBridge.md) |
| remote/ | [远程 CCR 会话](remote-module.md) |
| ssh/ | [SSH 会话管理](ssh-module.md) |

## 新增模块

| 模块 | 笔记 |
|------|------|
| daemon/ | [守护进程](daemon-module.md) |
| kairos/ | [24/7 Agent 引擎](kairos-module.md) |
| uds/ | [UDS 跨会话通信](uds-module.md) |
| teleport-local/ | [上下文迁移](teleport-module.md) |
| coordinator/ | [多 Agent 协调](coordinator-module.md) |
| assistant/ | [助手模式](assistant-module.md) |

## 其他

| 模块 | 笔记 |
|------|------|
| buddy/ | [伴侣宠物系统](buddy-module.md) |
| memdir/ | [持久化文件记忆](memdir.md) |
| plugins/ | [插件系统](plugins-module.md) |
| stub 合集 | [Stub 模块](stub-modules.md) |

## 工具函数

| 模块 | 笔记 |
|------|------|
| teammateMailbox.ts | [团队通信邮箱](utils-teammateMailbox.md) |
| cronTasks.ts | [定时任务定义](utils-cronTasks.md) |
| cronScheduler.ts | [Cron 调度器](utils-cronScheduler.md) |
