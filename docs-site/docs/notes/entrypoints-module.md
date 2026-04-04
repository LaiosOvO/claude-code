# entrypoints 模块阅读笔记

> 源码路径：`src/entrypoints/`
> 文件数量：约 16 个（含 `sdk/` 子目录和 `src/`）

## 概述

`entrypoints/` 模块定义了 Claude Code 的 **所有启动入口**。从 CLI 命令、SDK API、MCP 服务器到沙箱运行时，每种使用方式都有独立的入口文件。核心设计理念是 **快速路径分发**：对常见命令零模块加载即返回，仅在必要时才加载完整 CLI。

## 文件列表

| 文件 | 职责 |
|---|---|
| `cli.tsx` | CLI 总入口分发器：16+ 条快速路径 + 完整 CLI 回退 |
| `init.ts` | 初始化函数：配置、遥测、OAuth、CA 证书、关机钩子 |
| `mcp.ts` | MCP 服务器入口：将 Claude Code 工具暴露为 MCP 工具 |
| `agentSdkTypes.ts` | Agent SDK 公共类型入口：re-export core/runtime/tool 类型 |
| `agentSdkTypes.js` | Agent SDK JS 入口 |
| `sandboxTypes.ts` | 沙箱运行时类型 |
| `sdk/` | SDK 子目录（11 个文件） |

### sdk/ 子目录

| 文件 | 职责 |
|---|---|
| `coreTypes.ts` | 可序列化核心类型（消息、配置） |
| `coreTypes.generated.ts` | 自动生成的核心类型 |
| `runtimeTypes.ts` | 不可序列化的运行时类型（回调、接口） |
| `runtimeTypes.js` | JS 运行时类型 |
| `controlTypes.ts` | SDK 控制协议类型 |
| `controlTypes.js` | JS 控制协议类型 |
| `controlSchemas.ts` | 控制协议 schema |
| `coreSchemas.ts` | 核心 schema |
| `toolTypes.ts` | 工具类型（标记为 @internal） |
| `sdkUtilityTypes.ts` | SDK 工具函数类型 |
| `settingsTypes.generated.ts` | 设置类型（自动生成） |

## CLI 快速路径（cli.tsx）

`cli.tsx` 按代码顺序定义了 16 条快速路径：

1. `--version / -v / -V` — 零 import 打印版本号
2. `--dump-system-prompt` — 输出渲染后的系统提示词
3. `--claude-in-chrome-mcp` — Chrome 扩展 MCP 服务器
4. `--chrome-native-host` — Chrome Native Messaging 宿主
5. `--computer-use-mcp` — 计算机使用 MCP 服务器
6. `--daemon-worker` — 守护进程工作线程
7. `remote-control / bridge` — 远程桥接环境
8. `daemon` — 守护进程 supervisor
9. `ps / logs / attach / kill` — 后台会话管理
10. `new / list / reply` — 模板任务命令
11. `environment-runner` — 无头 BYOC 运行器
12. `self-hosted-runner` — 自托管运行器
13. `--tmux + --worktree` — tmux worktree 模式
14. `--update / --upgrade` — 更新重定向
15. `--bare` — 精简模式
16. **(无匹配)** — 加载完整 CLI（main.tsx）

## 初始化流程（init.ts）

`init()` 是 `memoize` 包装的异步函数，保证只执行一次：

1. `enableConfigs()` — 验证并启用配置系统
2. `applySafeConfigEnvironmentVariables()` — 安全环境变量
3. `applyExtraCACertsFromConfig()` — TLS 证书
4. `configureGlobalAgents()` — 代理配置
5. `configureGlobalMTLS()` — mTLS 配置
6. `setupGracefulShutdown()` — 关机钩子
7. OAuth / 遥测 / Sentry 初始化

## 设计亮点

1. **延迟加载** — 快速路径使用动态 `import()` 按需加载模块，`--version` 可在毫秒级返回
2. **消融基线** — `ABLATION_BASELINE` 环境变量关闭所有高级功能，用于科学对照实验
3. **CCR 堆内存限制** — 检测容器环境自动设置 `--max-old-space-size=8192`
4. **SDK 类型分层** — core（可序列化）/ runtime（回调接口）/ control（协议）三层分离

## 与其他模块的关系

- **bridge/** — `remote-control` 快速路径直接调用 `bridgeMain`
- **bootstrap/** — `init.ts` 导入 `bootstrap/state.ts` 初始化全局单例
- **constants/** — 系统提示词构建依赖 `constants/prompts.ts`
- **state/** — MCP 入口使用 `getDefaultAppState()` 创建无头状态
