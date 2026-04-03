# 从全局到细节 — 自顶向下理解 Claude Code Best

!!! info "阅读建议"
    本教程适合希望**先建立全局认知，再逐步深入细节**的读者。如果你更喜欢从具体代码入手，可以参考 [自底向上教程](../bottom-up/index.md)。

## 阅读路径

本教程基于 **Claude Code Best (ccb)** 的完整源码（2800+ 个 TS/TSX 文件，46 个 src/ 子目录），从最宏观的架构视角逐层深入。

```
第一章 → 第二章 → 第三章 → 第四章 → 第五章
全局架构   启动链路   对话引擎   工具系统   终端UI
(鸟瞰)    (入口)    (核心)    (能力)    (界面)
```

## 章节概览

| 章节 | 标题 | 核心问题 |
|------|------|----------|
| [第一章](01-architecture-overview.md) | 全局架构鸟瞰 | 项目有哪些层级？各层如何协作？ |
| [第二章](02-bootstrap-chain.md) | 启动链路详解 | 从 `ccb` 到 REPL 界面经过哪些步骤？ |
| [第三章](03-query-engine.md) | 对话引擎 | AI Agent 循环是怎么工作的？ |
| [第四章](04-tool-system.md) | 工具系统 | 58+ 工具如何定义、注册、执行？ |
| [第五章](05-terminal-ui.md) | 终端 UI 系统 | React 如何在终端中渲染 UI？ |

## 关键数据

- **CLI 命令**: `ccb`
- **构建**: `bun run build.ts` → `dist/cli.js`
- **核心入口**: `src/entrypoints/cli.tsx` → `src/main.tsx` → `src/screens/REPL.tsx`
- **工具数量**: 58+
- **多 Provider**: Anthropic / AWS Bedrock / Google Vertex / Azure
- **Monorepo**: 5 NAPI + 4 @ant 子包
