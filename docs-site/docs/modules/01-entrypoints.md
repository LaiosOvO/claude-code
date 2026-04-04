# 模块说明：入口系统 (entrypoints)

## 概述

入口系统是 claude-code-best（CLI：`ccb`）的"大门"。它决定了用户的命令最终走哪条代码路径。设计核心是**快速路径优先** -- 大部分子命令不需要加载完整的 TUI 框架，通过动态 `import()` 实现极致懒加载。

---

## 核心文件

| 文件 | 作用 | 行数 |
|------|------|------|
| `src/entrypoints/cli.tsx` | CLI 主入口，12+ 快速路径分发器 | 271 |
| `src/main.tsx` | Commander.js 完整 CLI 主程序 + `run()` | 4680 |
| `src/entrypoints/init.ts` | 应用初始化（认证、配置、MCP、GrowthBook） | 大 |
| `src/entrypoints/mcp.ts` | MCP 服务器入口（把 ccb 暴露为 MCP 工具） | 中 |
| `src/entrypoints/sdk/` | Agent SDK 入口（TypeScript SDK 集成） | 目录 |
| `scripts/dev.ts` | 开发脚本 -- 注入 MACRO defines + feature flags | 40 |
| `scripts/defines.ts` | MACRO 定义生成（VERSION、COMMIT 等） | 小 |
| `build.ts` | 生产构建 -- `Bun.build()` with splitting + feature DCE | 50 |

---

## 架构设计

```
用户命令: ccb [args]
              |
              v
      +--- cli.tsx ---+
      | 快速路径检查    |
      |                |
      | --version/-v   |---> 输出 MACRO.VERSION，退出（零 import）
      | --daemon-worker|---> 加载 daemon/workerRegistry，退出
      | remote-control |---> 认证 + bridgeMain()，退出
      | daemon         |---> enableConfigs + daemonMain()，退出
      | ps/logs/attach |---> bg 后台会话管理，退出
      | new/list/reply |---> 模板任务 templatesMain()，退出
      | env-runner     |---> environmentRunnerMain()，退出
      | self-hosted-   |---> selfHostedRunnerMain()，退出
      |   runner       |
      | --chrome-mcp   |---> Claude-in-Chrome MCP，退出
      | --computer-use |---> Computer Use MCP，退出
      | --worktree     |---> tmux worktree 快速路径，退出
      |   --tmux       |
      |                |
      | 都不是？       |---> import('../main') 加载完整应用
      +----------------+
              |
              v
        main.tsx (Commander.js)
              |
              v
     init() -> launchRepl() 或 headless print
```

---

## cli.tsx 快速路径详解

`cli.tsx` 共 342 行，是整个应用的真正入口。它通过 `process.argv` 检查参数，按优先级匹配以下路径：

| 优先级 | 条件 | 目标模块 | Feature Gate |
|--------|------|----------|-------------|
| 1 | `--version` / `-v` / `-V` | 直接输出 `MACRO.VERSION` | 无 |
| 2 | `--dump-system-prompt` | 输出渲染后的系统提示词 | `DUMP_SYSTEM_PROMPT` |
| 3 | `--claude-in-chrome-mcp` | Chrome MCP 服务器 | 无 |
| 4 | `--computer-use-mcp` | Computer Use MCP | `CHICAGO_MCP` |
| 5 | `--daemon-worker` | Daemon Worker 进程 | `DAEMON` |
| 6 | `remote-control` / `rc` / `bridge` | Bridge 远程控制 | `BRIDGE_MODE` |
| 7 | `daemon` | Daemon Supervisor | `DAEMON` |
| 8 | `ps` / `logs` / `attach` / `kill` / `--bg` | 后台会话管理 | `BG_SESSIONS` |
| 9 | `new` / `list` / `reply` | 模板任务 | `TEMPLATES` |
| 10 | `environment-runner` | BYOC 环境执行器 | `BYOC_ENVIRONMENT_RUNNER` |
| 11 | `self-hosted-runner` | 自托管执行器 | `SELF_HOSTED_RUNNER` |
| 12 | `--worktree --tmux` | Tmux Worktree 快速路径 | 无 |
| 末 | 其他 | 加载完整 `main.tsx` | 无 |

所有路径都使用 `await import()` 动态导入，确保快速路径的模块加载量最小化。

---

## main.tsx 核心结构

`main.tsx` 是完整 CLI 的核心，4680 行，基于 Commander.js 构建。主要职责：

1. **启动优化**：顶层执行 `profileCheckpoint`、`startMdmRawRead`、`startKeychainPrefetch`，在 import 阶段并行预热
2. **Commander 命令定义**：定义所有 CLI 选项（`-p`、`--model`、`--agent`、`--resume`、`--remote` 等）
3. **认证与初始化**：调用 `init()` 完成 OAuth、GrowthBook、MCP 连接
4. **模式分发**：
    - 交互式 REPL：`launchRepl()` 渲染 Ink TUI
    - 非交互 print：`headless` 模式直接输出
    - Remote 模式：连接远程 Daemon 会话
    - Coordinator 模式：多 Agent 协调（feature gate `COORDINATOR_MODE`）
    - Assistant 模式：Kairos 助手（feature gate `KAIROS`）

---

## 构建系统

### build.ts（生产构建）

```typescript
// Bun.build() with splitting -- 代码拆分减小首屏加载
const result = await Bun.build({
  entrypoints: ["src/entrypoints/cli.tsx"],
  outdir: "dist",
  target: "bun",
  splitting: true,
  define: getMacroDefines(),   // MACRO.VERSION 等编译期常量
  features,                    // FEATURE_* 环境变量 -> feature() 门控
});
```

构建后处理：将 Bun 独有的 `import.meta.require` 替换为 Node.js 兼容的 `createRequire`。

### scripts/dev.ts（开发模式）

```bash
bun run -d "MACRO.VERSION:\"dev\"" --feature BUDDY --feature TRANSCRIPT_CLASSIFIER \
  src/entrypoints/cli.tsx [args]
```

通过 `-d` 注入 MACRO 定义，`--feature` 启用运行时 feature gates。支持 `FEATURE_*` 环境变量动态开启更多特性。

---

## Ablation Baseline

cli.tsx 顶层包含一段 ablation baseline 逻辑：当 `CLAUDE_CODE_ABLATION_BASELINE` 环境变量设置时，自动禁用思考、自动压缩、自动记忆、后台任务等高级特性，用于 A/B 实验中的 L0 基线对照。

---

## 设计模式

- **延迟加载（Lazy Loading）**：所有快速路径用 `await import()` 代替顶层 `import`，确保 `--version` 等命令的模块加载量趋近于零
- **快速路径优先**：先检查简单情况，最后才走重路径（加载 4680 行的 main.tsx）
- **Feature Gate DCE**：`feature()` 调用在构建时通过 `bun:bundle` 消除死代码，未启用的特性代码不会出现在产物中
- **关注点分离**：每个入口点（CLI / Bridge / Daemon / MCP / SDK）独立，互不影响
- **启动并行化**：main.tsx 顶层并行启动 MDM 读取、Keychain 预取，与后续 import 重叠

---

## 常见问题

**Q: 为什么 `--version` 不需要加载 main.tsx？**
A: `--version` 只需要读取 `MACRO.VERSION`，这是构建时内联的常量。加载完整应用需要数百毫秒的模块求值，对于版本查询来说太慢了。

**Q: feature() 和 process.env 环境变量检查有什么区别？**
A: `feature()` 来自 `bun:bundle`，在构建时求值；`process.env` 在运行时求值。feature gate 的优势是可以进行死代码消除（DCE），未启用的特性代码不会打包进产物。

**Q: Bridge 快速路径为什么需要先认证？**
A: Bridge 需要 OAuth token 才能注册环境、与服务器通信。认证检查在 GrowthBook gate 之前执行，因为没有用户上下文的 GrowthBook 会返回过期的默认值。
