# 第二章：启动链路详解

> 跟着代码走一遍从 `ccb` 到界面出现的完整路径。理解启动流程是理解任何项目的最佳起点。

## 2.1 启动链路总览

ccb 的启动链路由四个关键文件串联而成：

```
ccb 命令
  │
  ▼
entrypoints/cli.tsx (342行)  ← 入口分发器
  │
  ▼
entrypoints/init.ts          ← 一次性全局初始化
  │
  ▼
setup.ts (569行)             ← 会话级初始化
  │
  ▼
main.tsx (4680行)            ← Commander.js CLI 定义 + run() action
  │
  ▼
replLauncher.tsx (22行)      ← 组合 App + REPL 到终端
```

## 2.2 CLI 主入口：entrypoints/cli.tsx

这是整个应用的真正入口点（271行）。它的核心设计是**快速路径优先**：在加载重模块之前，先检查所有轻量级的分支。

### 环境设置（顶层副作用）

```typescript
// 文件最顶部 — 在任何函数定义之前
import { feature } from 'bun:bundle';

// 禁用 corepack 自动固定
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// 远程容器环境：增加子进程堆大小（16GB 容器分配 8GB）
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  process.env.NODE_OPTIONS = existing
    ? `${existing} --max-old-space-size=8192`
    : '--max-old-space-size=8192';
}

// 消融实验基线（L0 ablation）— 内部 feature 门控
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of [
    'CLAUDE_CODE_SIMPLE',
    'CLAUDE_CODE_DISABLE_THINKING',
    // ... 更多禁用项
  ]) {
    process.env[k] ??= '1';
  }
}
```

**设计要点**：
- `feature()` 来自 `bun:bundle`，是编译时常量，构建时被 Dead Code Elimination 移除
- 顶层副作用必须用 `eslint-disable` 注释，因为 lint 规则禁止顶层副作用

### 快速路径分发

```typescript
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // === 快速路径 1：--version（零导入） ===
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;  // ~50ms，不加载任何模块
  }

  // 后续路径需要启动性能追踪
  const { profileCheckpoint } = await import('../utils/startupProfiler.js');
  profileCheckpoint('cli_entry');

  // === 快速路径 2：--dump-system-prompt（内部调试）===
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') { ... }

  // === 快速路径 3：Chrome 集成 ===
  if (args[2] === '--claude-in-chrome-mcp') { ... }
  if (args[2] === '--chrome-native-host') { ... }

  // === 快速路径 4：Daemon Worker（性能敏感）===
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const { runDaemonWorker } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(args[1]);
    return;  // ~200ms，只加载 daemon 模块
  }

  // === 快速路径 5：Bridge 远程控制 ===
  if (feature('BRIDGE_MODE') &&
      ['remote-control', 'rc', 'remote', 'sync', 'bridge'].includes(args[0])) {
    // 认证 → GrowthBook 门控 → 版本检查 → 策略检查 → bridgeMain
    await bridgeMain(args.slice(1));
    return;
  }

  // === 快速路径 6：Daemon 子命令 ===
  if (feature('DAEMON') && args[0] === 'daemon') {
    await daemonMain(args.slice(1));
    return;
  }

  // === 快速路径 7：后台会话管理 ===
  if (feature('BG_SESSIONS') &&
      ['ps', 'logs', 'attach', 'kill'].includes(args[0])) {
    // 各命令分发到 bg.ts 模块
    return;
  }

  // === 快速路径 8：模板任务 ===
  if (feature('TEMPLATES') && ['new', 'list', 'reply'].includes(args[0])) {
    await templatesMain(args);
    process.exit(0);
  }

  // === 快速路径 9：环境运行器 & 自托管运行器 ===
  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') { ... }
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') { ... }

  // === 快速路径 10：worktree + tmux 组合 ===
  if (hasTmuxFlag && hasWorktreeFlag) {
    // 在加载完整 CLI 之前 exec 进 tmux
  }

  // === 正常路径：加载完整应用 ===
  const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
  startCapturingEarlyInput();  // 开始捕获用户的早期输入
  const { main: cliMain } = await import('../main.jsx');
  await cliMain();
}

void main();
```

**为什么有这么多快速路径？**

这是关键的性能设计：

```
启动时间对比：
  --version:         ~50ms  (零导入，只读 MACRO 全局变量)
  --daemon-worker:   ~200ms (只加载 daemon 模块)
  bridge:            ~500ms (认证 + 门控检查)
  完整 TUI:          ~2-3s  (加载 React + Ink + 4680行 main.tsx + 所有模块)
```

## 2.3 一次性初始化：entrypoints/init.ts

`init()` 是一个 memoized 函数（只执行一次），负责全局基础设施：

```typescript
export const init = memoize(async (): Promise<void> => {
  // 1. 启用配置系统
  enableConfigs();
  recordFirstStartTime();

  // 2. 安全预取 — MDM 设置 / Keychain
  //    这些在 main.tsx 顶层通过 startMdmRawRead() 和
  //    startKeychainPrefetch() 已经并行启动

  // 3. 设置全局代理 & mTLS
  configureGlobalAgents();      // HTTP 代理
  configureGlobalMTLS();        // 双向 TLS

  // 4. 配置环境变量（安全的部分）
  applySafeConfigEnvironmentVariables();

  // 5. JetBrains IDE 检测
  initJetBrainsDetection();

  // 6. Windows Shell 设置
  setShellIfWindows();

  // 7. OAuth 账户信息
  populateOAuthAccountInfoIfNeeded();

  // 8. 远程管理设置（异步）
  if (isEligibleForRemoteManagedSettings()) {
    initializeRemoteManagedSettingsLoadingPromise();
  }

  // 9. 策略限制（异步）
  if (isPolicyLimitsEligible()) {
    initializePolicyLimitsLoadingPromise();
  }

  // 10. API 预连接
  preconnectAnthropicApi();

  // 11. Sentry 错误追踪
  initSentry();

  // 12. Scratchpad 目录
  if (isScratchpadEnabled()) {
    ensureScratchpadDir();
  }

  // 13. 注册清理回调
  registerCleanup(async () => {
    shutdownLspServerManager();
  });

  // 14. CA 证书配置
  applyExtraCACertsFromConfig();
});
```

**设计思考**：
- `memoize` 确保多次调用只执行一次
- 很多操作是并行启动（如 MDM 读取、Keychain 预取已在 main.tsx 顶层发起）
- 区分「安全的」配置（`applySafeConfigEnvironmentVariables`，无需等待远程设置）和「完整的」配置

## 2.4 会话级初始化：setup.ts

`setup()` 是 569 行的异步函数，每次会话启动时执行：

```typescript
export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void> {
  // === 第一步：Node.js 版本检查 ===
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
  if (!nodeVersion || parseInt(nodeVersion) < 18) {
    process.exit(1)
  }

  // === 第二步：UDS 消息服务 ===
  // 只在非 --bare 模式下启动
  if (!isBareMode() || messagingSocketPath !== undefined) {
    if (feature('UDS_INBOX')) {
      await startUdsMessaging(
        messagingSocketPath ?? getDefaultUdsSocketPath(),
        { isExplicit: messagingSocketPath !== undefined },
      )
    }
  }

  // === 第三步：Teammate 快照 ===
  if (!isBareMode() && isAgentSwarmsEnabled()) {
    captureTeammateModeSnapshot()
  }

  // === 第四步：设置工作目录 ===
  // 关键！后续所有文件操作都基于此
  setCwd(cwd)

  // === 第五步：Hooks 配置快照 ===
  // 必须在 setCwd() 之后——需要从正确目录加载 hooks
  captureHooksConfigSnapshot()

  // === 第六步：文件变更监听 ===
  initializeFileChangedWatcher(cwd)

  // === 第七步：Git Worktree（可选）===
  if (worktreeEnabled) {
    // 复杂逻辑：检测 git 环境 → 解析 canonical root →
    // 创建 worktree → 可选创建 tmux session →
    // 切换 cwd 到 worktree 路径
    worktreeSession = await createWorktreeForSession(...)
    setCwd(worktreeSession.worktreePath)
    setProjectRoot(getCwd())
    // 清除缓存、重新加载 hooks
    clearMemoryFileCaches()
    updateHooksConfigSnapshot()
  }

  // === 第八步：后台任务 ===
  if (!isBareMode()) {
    initSessionMemory()           // 会话记忆（同步注册）
    if (feature('CONTEXT_COLLAPSE')) {
      initContextCollapse()       // 上下文折叠
    }
  }
  void lockCurrentVersion()       // 防止其他进程删除当前版本

  // === 第九步：预取 ===
  if (!skipPluginPrefetch) {
    void getCommands(getProjectRoot())  // 命令列表
  }
  void loadPluginHooks()                // 插件 hooks
  setupPluginHookHotReload()            // 插件热重载
  if (!isBareMode()) {
    registerAttributionHooks()          // 提交归因（内部特性）
    registerSessionFileAccessHooks()    // 文件访问分析
    startTeamMemoryWatcher()            // 团队记忆同步
  }

  // === 第十步：遥测 ===
  initSinks()  // 连接分析 sink（Datadog/Sentry/GrowthBook）
  logEvent('tengu_started', {})

  // === 第十一步：API Key 预取 ===
  void prefetchApiKeyFromApiKeyHelperIfSafe(getIsNonInteractiveSession())

  // === 第十二步：发布日志 ===
  if (!isBareMode()) {
    const { hasReleaseNotes } = await checkForReleaseNotes(...)
    if (hasReleaseNotes) await getRecentActivity()
  }

  // === 第十三步：权限安全检查 ===
  if (permissionMode === 'bypassPermissions') {
    // root 用户检查、沙箱环境检查、网络隔离检查
  }
}
```

**设计思考**：
- **顺序很重要**：`setCwd()` 必须在 hooks 快照之前，hooks 快照必须在文件监听之前
- **预取优化**：用 `void` 发起异步操作但不 await，让它们在后台并行执行
- **--bare 模式**：跳过大量非必需初始化（插件、遥测、发布日志等），适合脚本化调用

## 2.5 主编排器：main.tsx

这是整个项目最大的单文件（4680行）。它用 Commander.js 定义 CLI，核心是 `run()` action handler：

### 顶层副作用（性能关键）

```typescript
// main.tsx 的前 20 行 — 在模块导入之前就启动异步操作
import { profileCheckpoint } from './utils/startupProfiler.js';
profileCheckpoint('main_tsx_entry');

// 并行启动 MDM 子进程（plutil/reg query）
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';
startMdmRawRead();

// 并行启动 macOS Keychain 预取（OAuth + legacy API key）
import { startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js';
startKeychainPrefetch();
```

### Commander.js CLI 定义

```typescript
export async function main(): Promise<void> {
  const program = new CommanderCommand('ccb')
    .version(MACRO.VERSION)
    .option('-p, --print', '非交互模式，输出到 stdout')
    .option('--model <model>', '指定模型')
    .option('-r, --resume <session>', '恢复会话')
    .option('-w, --worktree', '在 git worktree 中运行')
    .option('--tmux', '配合 worktree 创建 tmux session')
    .option('--permission-mode <mode>', '权限模式')
    .option('--bare', '最小化模式')
    // ... 40+ 选项
    .action(async (prompt, options) => {
      await run(prompt, options);
    });

  // 注册子命令
  registerSubcommands(program);
  await program.parseAsync();
}
```

### run() Action Handler 核心流程

```typescript
async function run(prompt, options) {
  // 1. init() — 一次性全局初始化
  await init();

  // 2. 模型选择
  const model = resolveModel(options.model);

  // 3. setup() — 会话级初始化
  await setup(cwd, permissionMode, ...);

  // 4. 认证
  if (needsAuth) await handleOAuth();

  // 5. GrowthBook 特性门控初始化
  await initializeGrowthBook();

  // 6. MCP 服务器连接
  const mcpResults = await getMcpToolsCommandsAndResources(mcpConfigs);

  // 7. 工具池组装
  //    内置工具放前面（prompt-cache 稳定性）
  //    MCP 工具放后面
  //    同名去重（内置优先）
  const tools = assembleToolPool(permissionContext, mcpTools);

  // 8. 权限上下文
  const permissionContext = initializeToolPermissionContext(options);

  // 9. Bundled Skills & Plugins 注册
  initBundledSkills();
  initBuiltinPlugins();

  // 10. 启动模式分发
  if (options.print) {
    // 无头模式：直接运行 query()，输出到 stdout
    await handlePrintMode(prompt, tools, ...);
  } else {
    // 交互模式：启动 Ink TUI
    await launchRepl(root, appProps, replProps, renderAndRun);
  }
}
```

### replLauncher.tsx — 极简组合层

```typescript
// 只有 22 行！职责单一：组合 App + REPL 到终端
export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>,
): Promise<void> {
  const { App } = await import('./components/App.js');
  const { REPL } = await import('./screens/REPL.js');
  await renderAndRun(root, <App {...appProps}>
    <REPL {...replProps} />
  </App>);
}
```

## 2.6 启动时序图

```
时间轴 ──────────────────────────────────────────────────────►

entrypoints/cli.tsx
  │ polyfill + 环境设置
  │ 快速路径检查 (--version? --daemon? bridge? bg? ...)
  │
  │ await import('../main.jsx')
  └──► main.tsx 模块加载
        │ profileCheckpoint('main_tsx_entry')
        │ startMdmRawRead()        ← 并行 IO
        │ startKeychainPrefetch()  ← 并行 IO
        │ 135ms 的 imports 加载
        │
        └──► init() [一次性]
              │ ├─ enableConfigs()
              │ ├─ configureGlobalAgents() / mTLS
              │ ├─ applySafeConfigEnvironmentVariables()
              │ ├─ OAuth / GrowthBook / Sentry
              │ └─ preconnectAnthropicApi()
              │
              └──► setup()
                    │ ├─ startUdsMessaging()
                    │ ├─ setCwd()
                    │ ├─ captureHooksConfigSnapshot()
                    │ ├─ initializeFileChangedWatcher()
                    │ ├─ [可选] createWorktreeForSession()
                    │ ├─ initSessionMemory()
                    │ ├─ initContextCollapse()
                    │ └─ 预取 (Commands, Plugins, API Keys)
                    │
                    └──► run()
                          │ ├─ 认证 / MCP 连接 / 工具组装
                          │ ├─ initBundledSkills()
                          │ ├─ initBuiltinPlugins()
                          │ └─ 权限上下文初始化
                          │
                          └──► launchRepl() / handlePrintMode()
                                │
                                └──► 用户开始交互
```

## 2.7 关键设计模式

### 模式 1：延迟加载（Lazy Loading）
```typescript
// 所有重模块都是动态导入，不在文件顶部 import
const { main: cliMain } = await import('../main.jsx');
// 快速路径不会加载 React、Ink、4680行的 main.tsx
```

### 模式 2：编译时特性门控
```typescript
// feature() 来自 bun:bundle，在编译时被替换为 true/false
// Dead Code Elimination 会移除 false 分支的代码
if (feature('DAEMON') && args[0] === 'daemon') { ... }
// 外部构建中，如果 DAEMON = false，整个分支被移除
```

### 模式 3：分层初始化
```
cli.tsx → init.ts → setup.ts → main.tsx → replLauncher.tsx
```
每一层只做自己该做的事，失败时可以在对应层处理。

### 模式 4：并行预取
```typescript
// 在 main.tsx 顶层，模块导入之前就启动 IO 操作
startMdmRawRead();        // 启动 plutil 子进程
startKeychainPrefetch();  // 启动 keychain 读取
// 当 135ms 后导入完成时，这些 IO 操作已经完成或接近完成
```

### 模式 5：profileCheckpoint 性能追踪
```typescript
// 关键点都有打点，可以精确测量每个阶段耗时
profileCheckpoint('cli_entry');
profileCheckpoint('cli_before_main_import');
profileCheckpoint('main_tsx_entry');
profileCheckpoint('main_tsx_imports_loaded');
profileCheckpoint('setup_before_prefetch');
profileCheckpoint('setup_after_prefetch');
```

## 2.8 动手实验

试试这些命令，观察不同的启动路径：

```bash
# 快速路径 — 几乎瞬间返回
ccb --version

# 无头模式 — 不启动 TUI
ccb -p "hello"

# 完整 TUI — 完整初始化流程
ccb

# 最小化模式 — 跳过大量初始化
ccb --bare -p "hello"

# 后台会话列表
ccb ps

# Daemon 守护进程
ccb daemon

# 远程控制
ccb remote-control
```

## 2.9 下一章预告

你已经知道了启动过程。下一章我们深入 **QueryEngine** — 这是 ccb 的心脏，理解了它就理解了整个对话系统是如何工作的。

[第三章：对话引擎 QueryEngine](03-query-engine.md)
