# 第二章：启动链路详解

> 跟着代码走一遍从 `./bin/claude-haha` 到界面出现的完整路径。理解启动流程是理解任何项目的最佳起点。

## 2.1 入口脚本：bin/claude-haha

```bash
#!/usr/bin/env bash
# 这个脚本只做一件事：决定用哪个入口启动

if [ "$CLAUDE_CODE_FORCE_RECOVERY_CLI" = "1" ]; then
    # 降级模式：不启动完整 TUI，只用简单的 readline 交互
    exec bun --env-file=.env ./src/localRecoveryCli.ts "$@"
else
    # 正常模式：启动完整的 Ink TUI
    exec bun --env-file=.env --preload ./preload.ts ./src/entrypoints/cli.tsx "$@"
fi
```

**设计思考**：
- 为什么用 Shell 脚本而不是直接 `bun cli.tsx`？因为需要在 Bun 启动前就做条件判断
- `--preload` 让 `preload.ts` 在主代码之前执行
- `--env-file=.env` 自动加载环境变量

## 2.2 预加载：preload.ts

```typescript
// preload.ts 在主入口之前执行
// 它的任务是设置全局变量，让后续代码可以读取构建信息

declare global {
  var MACRO: {
    VERSION: string        // 版本号
    PACKAGE_URL: string    // 包地址
    BUILD_TIME: string     // 构建时间
  }
}

globalThis.MACRO = {
  VERSION: "999.0.0-local",    // 本地版本标记
  PACKAGE_URL: "",
  BUILD_TIME: new Date().toISOString(),
}
```

**设计思考**：
- 为什么用全局变量？因为 `MACRO` 在官方构建中由 bundler 注入（编译时常量），本地版本用 preload 模拟
- 这是个「桩」（stub）— 替代官方构建系统中编译时注入的值

## 2.3 CLI 主入口：entrypoints/cli.tsx

这个文件是最重要的分发器。它有 ~300 行，但核心逻辑是一系列**快速路径**（fast paths）：

```typescript
// 伪代码展示核心逻辑

// ===== 快速路径 1：版本号 =====
if (args.includes('--version') || args.includes('-v')) {
  console.log(MACRO.VERSION)
  process.exit(0)  // 不加载任何模块！
}

// ===== 快速路径 2：Daemon Worker =====
if (args.includes('--daemon-worker')) {
  // 内部 daemon 工作进程，快速分发
  await import('./daemon-worker')
  process.exit(0)
}

// ===== 快速路径 3：远程控制命令 =====
if (['remote-control', 'rc', 'bridge'].includes(args[0])) {
  await import('../bridge/bridgeMain')
  process.exit(0)
}

// ===== 快速路径 4：后台任务 =====
if (args.includes('--bg')) {
  // 后台模式处理
}

// ===== 正常路径：加载完整应用 =====
const { main } = await import('../main')
await main()
```

**为什么有这么多快速路径？**

这是一个重要的性能设计：
- 完整的 TUI 应用需要加载 React、Ink、数十个组件——**启动慢**
- 很多子命令（版本查询、daemon worker）不需要这些
- 快速路径在加载重模块之前就返回，保证响应速度

```
启动时间对比：
  --version:     ~50ms  (只读全局变量)
  --daemon-worker: ~200ms (只加载 daemon 模块)
  完整 TUI:      ~2-3s   (加载 React + Ink + 所有组件)
```

## 2.4 初始化：setup.ts

`setup()` 是一个 ~500 行的异步函数，按顺序初始化整个应用环境：

```typescript
export async function setup(
  cwd: string,              // 工作目录
  permissionMode: string,   // 权限模式
  // ... 更多参数
) {
  // ===== 第一步：版本检查 =====
  // 确保 Node.js >= 18（Bun 兼容层）
  
  // ===== 第二步：UDS 消息服务 =====
  // 启动 Unix Domain Socket，让多个 claude 实例互相通信
  startMessagingServer()
  
  // ===== 第三步：工作目录设置 =====
  // 这是最关键的一步！后续所有文件操作都基于此
  setCwd(cwd)
  setProjectRoot(findProjectRoot(cwd))
  
  // ===== 第四步：Hooks 快照 =====
  // 在任何文件操作之前，记录当前的 hook 配置
  // 防止后续操作触发的文件变更影响 hook 状态
  captureHooksSnapshot()
  
  // ===== 第五步：文件变更监听 =====
  // 监控工作目录中的文件变化
  initFileChangedWatcher()
  
  // ===== 第六步：Git Worktree（可选）=====
  // 如果用了 --worktree 参数，创建隔离的 git 工作树
  if (worktreeEnabled) {
    await createWorktree()
  }
  
  // ===== 第七步：后台任务初始化 =====
  // SessionMemory（会话记忆）、ContextCollapse（上下文压缩）
  initBackgroundJobs()
  
  // ===== 第八步：预取 =====
  // 并行预加载：命令列表、插件、API Key、发布日志
  await Promise.all([
    prefetchCommands(),
    prefetchPluginHooks(),
    prefetchApiKeys(),
    prefetchReleaseNotes(),
  ])
}
```

**设计思考**：
- **顺序很重要**：工作目录必须最先设置，因为后续所有操作依赖它
- **预取优化**：用 `Promise.all` 并行加载不相互依赖的数据
- **快照模式**：先记录状态再操作，防止副作用污染

## 2.5 主编排器：main.tsx

这是整个项目最大的文件（~4700行），它做三件事：

### 2.5.1 认证与配置
```typescript
// 1. 加载配置（settings.json, .env）
// 2. OAuth 认证（如果需要）
// 3. 信任对话框（首次使用时）
// 4. 遥测初始化
```

### 2.5.2 工具池组装
```typescript
// 1. 获取内置工具（Bash, Read, Edit, Write, Glob, Grep, ...）
const baseTools = getAllBaseTools()

// 2. 连接 MCP 服务器，获取 MCP 工具
const mcpTools = await connectMcpServers()

// 3. 合并工具池
const toolPool = assembleToolPool(baseTools, mcpTools)
// 内置工具放前面（prompt-cache 稳定性），MCP 工具放后面
```

### 2.5.3 启动模式分发
```typescript
if (options.print) {
  // 无头模式：直接运行 query()，输出结果到 stdout
  for await (const msg of query({ prompt, tools, ... })) {
    process.stdout.write(formatMessage(msg))
  }
} else {
  // 交互模式：启动 Ink TUI
  await launchRepl({
    tools: toolPool,
    commands: allCommands,
    initialState: appState,
    // ...
  })
}
```

## 2.6 启动时序图

```
时间轴 ──────────────────────────────────────────────►

bin/claude-haha
  │ exec bun
  └──► preload.ts
        │ 设置 MACRO 全局变量
        └──► cli.tsx
              │ 快速路径检查
              │ (--version? --daemon? --bridge?)
              │
              │ 动态导入 main.tsx
              └──► setup()
                    │ ├─ startMessaging()
                    │ ├─ setCwd()
                    │ ├─ captureHooks()
                    │ ├─ initWatcher()
                    │ └─ prefetch (并行)
                    │
                    └──► main()
                          │ ├─ 认证
                          │ ├─ MCP 连接
                          │ ├─ 工具组装
                          │ └─ 权限设置
                          │
                          └──► launchRepl() / headless query()
                                │
                                └──► 用户开始交互 ✨
```

## 2.7 关键设计模式

### 模式 1：延迟加载（Lazy Loading）
```typescript
// 不在文件顶部 import 重模块
// 而是在需要时动态导入
const { main } = await import('../main')
```
**好处**：快速路径不会加载不需要的代码

### 模式 2：分层初始化
```
preload → cli → setup → init → main → repl
```
每一层只做自己该做的事，失败时可以在对应层处理

### 模式 3：快速路径优先
```typescript
// 先检查所有快速路径
if (simpleCase1) return handleSimple1()
if (simpleCase2) return handleSimple2()
// 最后才进入重路径
return handleComplex()
```
**好处**：90% 的子命令不需要加载完整应用

## 2.8 动手实验

试试这些命令，观察不同的启动路径：

```bash
# 快速路径 - 几乎瞬间返回
./bin/claude-haha --version

# 无头模式 - 不启动 TUI
./bin/claude-haha -p "hello"

# 完整 TUI - 完整初始化流程
./bin/claude-haha

# 降级模式 - 简化界面
CLAUDE_CODE_FORCE_RECOVERY_CLI=1 ./bin/claude-haha
```

## 2.9 下一章预告

你已经知道了启动过程。下一章我们深入 **QueryEngine** — 这是 Claude Code 的心脏，理解了它就理解了整个对话系统是如何工作的。

→ [第三章：对话引擎 QueryEngine](03-query-engine.md)
