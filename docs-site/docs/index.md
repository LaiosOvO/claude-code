---
hide:
  - navigation
---

# Claude Code Best 源码学习站

<div style="text-align: center; margin: 2em 0;">
  <p style="font-size: 1.4em; color: var(--md-primary-fg-color);">
    <strong>深入理解 Claude Code 的每一行代码</strong>
  </p>
  <p style="font-size: 1.1em; opacity: 0.8;">
    从架构设计到实现细节，系统化拆解 Anthropic 官方 AI 编程助手的完整源码
  </p>
</div>

---

## 关于本站

本站是 [claude-code-best](https://github.com/anthropics/claude-code) 项目（CLI 命令：`ccb`）的源码学习与文档站点。该项目基于 Claude Code 上游源码构建，保留了完整的功能体系，包括多 Provider 支持、Bridge 远程控制、Daemon 后台守护、Kairos 助手模式、UDS Inbox 进程间通信、Teleport 本地传输等子系统。

通过系统化阅读和拆解源码，我们希望深入理解以下内容：

- Claude Code 的整体架构设计思路
- Ink TUI 终端交互界面的实现方式
- 工具系统（Tool System）的插件化设计（58+ 内建工具）
- 多 Agent 协作机制（Coordinator / Agent Swarms）
- MCP 协议的集成与扩展
- 权限模型与安全策略
- Bridge 远程控制与 Daemon 后台任务系统
- Voice 语音输入、Proactive 主动提示等前沿特性

---

## 站点导航

<div class="grid cards" markdown>

-   :material-arrow-down-bold-circle:{ .lg .middle } **自顶向下教程**

    ---

    从整体架构出发，逐层深入到具体实现。适合希望先建立全局认知再深入细节的读者。

    [:octicons-arrow-right-24: 开始阅读](tutorial/top-down/index.md)

-   :material-arrow-up-bold-circle:{ .lg .middle } **自底向上教程**

    ---

    从基础工具函数出发，逐步构建对系统全貌的理解。适合喜欢从代码入手的读者。

    [:octicons-arrow-right-24: 开始阅读](tutorial/bottom-up/index.md)

-   :material-view-module:{ .lg .middle } **模块说明**

    ---

    按模块分类的详细说明文档，可作为查阅参考手册使用。

    [:octicons-arrow-right-24: 查看模块](modules/index.md)

-   :material-sitemap:{ .lg .middle } **架构文档**

    ---

    系统架构图、数据流图、组件关系图等架构层面的分析文档。

    [:octicons-arrow-right-24: 查看架构](architecture/index.md)

-   :material-notebook-edit:{ .lg .middle } **阅读笔记**

    ---

    逐文件的源码阅读笔记，记录关键实现细节与个人理解。

    [:octicons-arrow-right-24: 查看笔记](notes/index.md)

</div>

---

## 项目技术栈

| 技术 | 用途 |
| --- | --- |
| **TypeScript** | 主要开发语言 |
| **Bun** | JavaScript 运行时 + 构建工具（`Bun.build()` with splitting） |
| **Ink / React** | 终端 TUI 界面框架 |
| **Commander.js** | CLI 命令解析（`src/main.tsx`，4680 行） |
| **MCP** | Model Context Protocol，工具扩展协议 |
| **Zod v4** | 运行时类型校验 |
| **GrowthBook** | Feature Flag 网关（控制 Bridge / Daemon / Kairos 等特性开关） |
| **OAuth 2.0** | Claude.ai 账户认证 |

---

## 源码目录概览

```text
src/
├── entrypoints/        # 入口文件（cli.tsx、init.ts、mcp.ts、SDK）
├── main.tsx            # Commander.js CLI 主程序（4680 行）
├── query.ts            # AsyncGenerator 查询主循环（1865 行）
├── QueryEngine.ts      # 会话管理编排器（1450 行）
├── Tool.ts             # 工具接口 + buildTool()（978 行）
├── tools.ts            # 工具注册表 + assembleToolPool()（469 行）
├── tools/              # 58+ 工具实现目录
├── bridge/             # 远程桥接系统（34 文件，约 13000 行）
├── daemon/             # 后台守护进程（supervisor + workers）
├── kairos/             # Kairos 引擎（助手模式 watcher）
├── uds/                # Unix Domain Socket Inbox（进程间通信）
├── teleport-local/     # 本地文件快速传输（pack / unpack）
├── assistant/          # 助手模式会话管理
├── coordinator/        # 多 Agent 协调器（coordinatorMode + workerAgent）
├── commands/           # 斜杠命令处理
├── components/         # Ink UI 组件
├── hooks/              # React Hooks
├── state/              # 全局状态管理（类 Zustand）
├── context/            # 系统提示词 + 项目上下文
├── plugins/            # 插件机制（builtinPlugins + bundled）
├── skills/             # Skills 系统（bundled + MCP skills）
├── services/           # 服务层（API、OAuth、MCP、Voice、analytics 等）
├── tasks/              # 后台任务类型（Dream / Teammate / Workflow / Monitor 等）
├── buddy/              # Companion 小宠物系统
├── proactive/          # 主动提示引擎
├── remote/             # 远程会话管理
├── cli/                # CLI 传输层（WebSocket / SSE / Hybrid）+ bg 后台会话
├── jobs/               # 模板任务分类器
├── schemas/            # Zod 校验模式定义
├── types/              # TypeScript 类型定义
└── utils/              # 通用辅助函数
```

---

## 构建与运行

```bash
# 开发模式（自动注入 MACRO defines + feature flags）
bun run scripts/dev.ts

# 生产构建（Bun.build() with splitting + feature 死代码消除）
bun run build.ts

# 运行 CLI
ccb                     # 交互式 REPL
ccb -p "your prompt"    # 非交互式（headless / print 模式）
ccb remote-control      # 启动远程桥接
ccb daemon              # 启动后台守护进程
ccb ps / logs / attach  # 后台会话管理
```

---

<div style="text-align: center; margin-top: 3em; opacity: 0.6;">
  <p>持续更新中 -- 欢迎贡献</p>
</div>
