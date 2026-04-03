---
hide:
  - navigation
---

# Claude Code 源码学习站

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

本站是 [claude-code-haha](https://github.com/anthropics/claude-code) 项目的源码学习与文档站点。该项目基于 Claude Code 泄露源码修复而成，是目前唯一可本地运行的完整版本，支持接入任意 Anthropic 兼容 API。

通过系统化阅读和拆解源码，我们希望深入理解以下内容：

- Claude Code 的整体架构设计思路
- Ink TUI 终端交互界面的实现方式
- 工具系统（Tool System）的插件化设计
- 多 Agent 协作机制
- MCP 协议的集成与扩展
- 权限模型与安全策略

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
| **Bun** | JavaScript 运行时 |
| **Ink / React** | 终端 TUI 界面框架 |
| **MCP** | Model Context Protocol，工具扩展协议 |
| **Zod** | 运行时类型校验 |

---

## 源码目录概览

```text
src/
├── entrypoints/      # 入口文件（CLI、print 模式等）
├── commands/          # 用户命令处理
├── tools/             # 工具系统（核心）
├── services/          # 服务层（API 调用、认证等）
├── components/        # Ink UI 组件
├── hooks/             # React Hooks
├── state/             # 状态管理
├── context/           # 上下文系统
├── plugins/           # 插件机制
├── skills/            # Skills 系统
├── coordinator/       # 多 Agent 协调器
├── query/             # 查询引擎
├── utils/             # 工具函数
└── ...
```

---

<div style="text-align: center; margin-top: 3em; opacity: 0.6;">
  <p>持续更新中 · 欢迎贡献</p>
</div>
