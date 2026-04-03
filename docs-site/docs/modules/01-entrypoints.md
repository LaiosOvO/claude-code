# 模块说明：入口系统 (entrypoints)

## 概述

入口系统是 Claude Code 的"大门"。它决定了用户的命令最终走哪条代码路径。设计核心是**快速路径优先**——大部分子命令不需要加载完整的 TUI 框架。

## 核心文件

| 文件 | 作用 | 行数 |
|------|------|------|
| `bin/claude-haha` | Shell 入口脚本，决定走恢复模式还是完整模式 | ~13 |
| `preload.ts` | Bun 预加载，注入 MACRO 构建元数据 | ~18 |
| `src/entrypoints/cli.tsx` | CLI 主入口，多路径分发器 | ~302 |
| `src/entrypoints/init.ts` | 应用初始化（认证、配置、MCP） | ~大 |
| `src/entrypoints/mcp.ts` | MCP 服务器入口（把 Claude Code 暴露为 MCP 工具） | ~中 |

## 架构设计

```
用户命令: ./bin/claude-haha [args]
                │
                ▼
        ┌── cli.tsx ──┐
        │ 快速路径检查  │
        │              │
        │ --version?   │──→ 输出版本号，退出
        │ --daemon?    │──→ 加载 daemon-worker，退出
        │ --bridge?    │──→ 加载 bridgeMain，退出
        │ --bg?        │──→ 后台任务管理
        │ --mcp?       │──→ MCP 服务器模式
        │              │
        │ 都不是？     │──→ 加载完整 main.tsx
        └──────────────┘
                │
                ▼
          setup() → init() → main()
```

## 关键流程

1. **Shell 脚本检查** `CLAUDE_CODE_FORCE_RECOVERY_CLI` 环境变量
2. **preload.ts** 注入 `globalThis.MACRO`（版本号等）
3. **cli.tsx** 依次检查 ~10 个快速路径
4. 快速路径命中 → 动态导入对应模块，执行后退出
5. 所有快速路径未命中 → `import('../main')` 加载完整应用
6. **init.ts** 执行认证、配置加载、MCP 连接
7. 分发到 REPL（交互）或 headless（无头）模式

## 设计模式

- **延迟加载（Lazy Loading）**：用 `await import()` 代替顶层 `import`，确保快速路径不加载不需要的模块
- **快速路径优先**：先检查简单情况，最后才走重路径
- **关注点分离**：每个入口点独立，互不影响

## 常见问题

**Q: 为什么 `--version` 不需要加载 main.tsx？**
A: `--version` 只需要读取 `MACRO.VERSION` 全局变量，这在 preload.ts 中就已设置。加载完整应用需要 2-3 秒，对于版本查询来说太慢了。

**Q: bin/claude-haha 为什么用 Shell 脚本而不是 TypeScript？**
A: 因为需要在 Bun 启动之前做条件判断（是否走降级模式）。Shell 脚本在任何环境都能立即执行。
