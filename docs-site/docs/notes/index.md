# 阅读笔记

本节包含 Claude Code 源码的逐文件阅读笔记。每篇笔记针对一个或一组相关源文件，记录关键实现细节、设计思路、个人理解以及值得关注的代码片段。

---

## 笔记说明

每篇阅读笔记通常包含以下内容：

!!! abstract "笔记结构"

    - **文件信息** — 文件路径、行数、主要导出
    - **功能概述** — 这个文件/模块做了什么
    - **核心逻辑** — 关键函数与数据结构的分析
    - **设计亮点** — 值得学习的设计模式或技巧
    - **关联文件** — 与哪些其他文件有依赖关系
    - **疑问与思考** — 阅读过程中产生的问题与思考

---

## 笔记索引

按源码目录结构组织，方便根据文件路径快速查找对应笔记。

### 入口与启动

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/main.tsx` | — | :material-circle-outline: 待编写 |
| `src/entrypoints/` | — | :material-circle-outline: 待编写 |
| `src/setup.ts` | — | :material-circle-outline: 待编写 |

### 命令与工具

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/commands.ts` | — | :material-circle-outline: 待编写 |
| `src/tools.ts` | — | :material-circle-outline: 待编写 |
| `src/Tool.ts` | — | :material-circle-outline: 待编写 |
| `src/tools/` | — | :material-circle-outline: 待编写 |

### 查询与服务

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/query.ts` | — | :material-circle-outline: 待编写 |
| `src/QueryEngine.ts` | — | :material-circle-outline: 待编写 |
| `src/services/` | — | :material-circle-outline: 待编写 |

### UI 与状态

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/ink.ts` | — | :material-circle-outline: 待编写 |
| `src/components/` | — | :material-circle-outline: 待编写 |
| `src/hooks/` | — | :material-circle-outline: 待编写 |
| `src/state/` | — | :material-circle-outline: 待编写 |

### 上下文与协作

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/context.ts` | — | :material-circle-outline: 待编写 |
| `src/context/` | — | :material-circle-outline: 待编写 |
| `src/coordinator/` | — | :material-circle-outline: 待编写 |

### 扩展机制

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/plugins/` | — | :material-circle-outline: 待编写 |
| `src/skills/` | — | :material-circle-outline: 待编写 |
| `src/Task.ts` | — | :material-circle-outline: 待编写 |

### 其他

| 文件 | 笔记 | 状态 |
| --- | --- | --- |
| `src/utils/` | — | :material-circle-outline: 待编写 |
| `src/types/` | — | :material-circle-outline: 待编写 |
| `src/schemas/` | — | :material-circle-outline: 待编写 |
| `src/cost-tracker.ts` | — | :material-circle-outline: 待编写 |

---

!!! tip "如何贡献笔记"
    欢迎为任何文件添加阅读笔记。请在 `docs-site/docs/notes/` 目录下创建对应的 Markdown 文件，并在上方索引表中更新链接与状态。
