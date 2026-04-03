# 第一章：全局架构鸟瞰

> 本章从最高层视角理解 claude-code-best（ccb）的整体设计，让你在脑中建立一张完整的地图。

## 1.1 claude-code-best 是什么？

claude-code-best（CLI 命令 `ccb`，包名 `claude-code-best`）是一个全功能的 **CLI AI 编程助手**。它不是简单的命令行工具——它是一个完整的：

- **终端 UI 应用**（用 React + 自定义 Ink 实现终端界面）
- **AI Agent 框架**（支持 58+ 工具调用、子 Agent、协调器模式、多轮对话）
- **远程协作平台**（Bridge 远程控制、SSH 会话、Teleport 上下文迁移）
- **24/7 自动化引擎**（Daemon 守护进程、Kairos 引擎、Cron 调度）

## 1.2 技术栈一览

```
┌───────────────────────────────────────────────────┐
│                 用户交互层                          │
│  React + 自定义 Ink (终端 UI) / Commander.js (CLI)  │
│  Voice (语音) / Vim 模式 / Buddy AI 助手            │
├───────────────────────────────────────────────────┤
│                 业务逻辑层                          │
│  QueryEngine (对话引擎) + Tool System (58+ 工具)    │
│  Coordinator (协调器) + Skills (技能) + Plugins     │
├───────────────────────────────────────────────────┤
│                 服务层                              │
│  API (Anthropic SDK / Bedrock / Vertex / Azure)    │
│  MCP / Analytics (GrowthBook/Datadog/Sentry)       │
│  Compact / Voice / OAuth / LSP / Policy            │
├───────────────────────────────────────────────────┤
│                 基础设施层                          │
│  Daemon / Kairos / UDS Inbox / Teleport / Bridge   │
│  Bun Runtime / WebSocket / File I/O / Git          │
├───────────────────────────────────────────────────┤
│                 NAPI & 包 (packages/)               │
│  audio-capture / color-diff / image-processor      │
│  modifiers / url-handler / @ant (4个内部包)         │
└───────────────────────────────────────────────────┘
```

| 类别 | 技术 | 为什么选它 |
|------|------|-----------|
| 运行时 | Bun | 比 Node.js 更快的启动、原生 TS 支持、内置 bundler |
| 语言 | TypeScript | 类型安全，大型项目必备 |
| 终端 UI | React + 自定义 Ink | 用 React 组件模型构建终端界面，声明式 UI |
| CLI 解析 | Commander.js | 成熟的 CLI 参数解析库（`@commander-js/extra-typings`） |
| API 客户端 | Anthropic SDK | 官方 SDK，类型完整，多 Provider 支持 |
| 协议 | MCP (Model Context Protocol) | AI 工具标准协议 |
| 构建 | `bun run build.ts` | 输出到 `dist/cli.js` |
| 开发 | `bun run scripts/dev.ts` | 热重载开发环境 |
| 原生模块 | NAPI (Rust/C++) | 高性能音频、图像处理、颜色差异等 |

## 1.3 启动流程总览

这是理解整个项目的**第一把钥匙** — 从用户敲下命令到界面出现，经历了什么？

```
用户输入: ccb
        │
        ▼
┌─── src/entrypoints/cli.tsx (271行) ───┐
│ 真正的入口点                            │
│ 1. Polyfill + 环境变量设置              │
│ 2. 快速路径检查:                        │
│    --version → 直接输出                 │
│    --daemon-worker → daemon 模块        │
│    remote-control/bridge → bridgeMain   │
│    daemon → daemonMain                  │
│    ps/logs/attach/kill → bg sessions    │
│    new/list/reply → templates           │
│    environment-runner → BYOC runner     │
│ 3. 默认: 加载 main.tsx                  │
└────────┬──────────────────────────────┘
         │
         ▼
┌─── src/entrypoints/init.ts ───────────┐
│ 一次性初始化                            │
│ 1. enableConfigs() 配置系统             │
│ 2. MDM / Keychain 预取                 │
│ 3. OAuth / GrowthBook 初始化           │
│ 4. Sentry 错误追踪                     │
│ 5. Proxy / mTLS 配置                   │
│ 6. OpenTelemetry 遥测                  │
└────────┬──────────────────────────────┘
         │
         ▼
┌─── src/setup.ts (477行) ──────────────┐
│ 会话级初始化                            │
│ 1. UDS 消息服务（Unix Domain Socket）   │
│ 2. 工作目录 setCwd()                   │
│ 3. Hooks 配置快照                      │
│ 4. 文件变更监听                        │
│ 5. Git worktree（可选）                │
│ 6. SessionMemory / ContextCollapse     │
│ 7. 预取 (Commands, Plugins, API Keys)  │
└────────┬──────────────────────────────┘
         │
         ▼
┌─── src/main.tsx (4680行) ─────────────┐
│ 核心编排器 — Commander.js CLI 定义      │
│ 1. 认证 & 配置 & 模型选择              │
│ 2. MCP 服务器连接                      │
│ 3. 工具池组装（内置 + MCP）             │
│ 4. 权限上下文初始化                     │
│ 5. 启动 REPL 或无头模式                │
└────────┬──────────────────────────────┘
         │
    ┌────┴────┐
    ▼         ▼
 交互 TUI    无头模式
(Ink REPL)  (--print / SDK)
```

## 1.4 核心概念地图

在深入代码之前，先理解这些核心概念：

### Tool（工具）
Claude 调用的能力。如 Bash 执行命令、FileRead 读文件、FileEdit 编辑文件。每个 Tool 都有：
- **名称** + **输入 Schema（Zod）** + **执行函数 `call()`**
- **权限检查** — `checkPermissions()` 决定 allow/deny/ask
- **并发安全标记** — `isConcurrencySafe()` 控制能否与其他 Tool 并行
- **UI 渲染** — `renderToolUseMessage()` / `renderToolResultMessage()` 控制终端显示
- **模型提示** — `prompt()` 告诉 Claude 这个工具怎么用

### QueryEngine（查询引擎）
对话的核心。它：
1. 收集系统提示词 + 用户消息 + 上下文
2. 调用 Claude API（流式）
3. 解析响应中的工具调用（tool_use 块）
4. 执行工具，收集结果（tool_result）
5. 把结果反馈给 Claude，循环直到 `stop_reason = "end_turn"`

### Coordinator（协调器）
多 Agent 协作模式。Coordinator 主线程编排任务，通过 `AgentTool` 派发子 Agent（workerAgent）分头执行。启用方式：`CLAUDE_CODE_COORDINATOR_MODE=1`。

### Daemon（守护进程）
后台持续运行的进程管理器。通过 `ccb daemon` 启动，管理多个 worker 进程，用于 Kairos 引擎和后台任务。

### Kairos（24/7 引擎）
事件驱动的自动化引擎。监听文件变化、UDS 消息、cron 触发等事件，自动调度 Agent 执行任务。

### Bridge（桥接）
远程控制系统。让外部（手机、网页、其他机器）能控制本地的 ccb 实例。通过 `ccb remote-control` 启动。

### Skill（技能）
可扩展的命令系统。可以在 `.claude/skills/` 放 Markdown 文件来定义新技能，也有 bundled skills 内置技能。

### Command（命令）
用户用 `/xxx` 调用的功能。如 `/commit`、`/help`、`/compact`。项目有 108+ 命令文件。

### Plugin（插件）
外部扩展系统。支持 bundled 内置插件和用户安装的插件，可以注册 hooks、工具、命令。

## 1.5 目录结构导航

```
claude-code-best/
├── src/
│   ├── entrypoints/              # 各种入口点
│   │   ├── cli.tsx               #   CLI 主入口 (271行)
│   │   ├── init.ts               #   一次性初始化
│   │   ├── mcp.ts                #   MCP 服务器入口
│   │   └── sdk/                  #   SDK 入口
│   │
│   ├── main.tsx                  # 核心编排器 (4680行) — Commander.js CLI 定义
│   ├── setup.ts                  # 会话级初始化 (477行)
│   ├── replLauncher.tsx          # 组合 App + REPL 到终端 (22行)
│   │
│   ├── query.ts                  # 高层查询接口 — AsyncGenerator 主循环 (1732行)
│   ├── QueryEngine.ts            # 对话引擎核心 — 高层编排器 (1320行)
│   ├── context.ts                # 上下文构建 — Git 状态、CLAUDE.md (189行)
│   │
│   ├── Tool.ts                   # 工具类型定义 — ToolUseContext 等 (792行)
│   ├── tools.ts                  # 工具注册表 — getAllBaseTools() (387行)
│   ├── tools/                    # 56+ 工具实现目录
│   │   ├── BashTool/             #   三文件模式: BashTool.ts / prompt.ts / UI.tsx
│   │   ├── FileReadTool/
│   │   ├── FileEditTool/
│   │   ├── AgentTool/
│   │   ├── SkillTool/
│   │   ├── WebSearchTool/
│   │   ├── TaskCreateTool/
│   │   ├── ScheduleCronTool/
│   │   └── ...
│   │
│   ├── commands.ts               # 命令注册
│   ├── commands/                  # 108+ 命令实现
│   │
│   ├── screens/                   # 全屏视图
│   │   ├── REPL.tsx              #   主交互界面 (5003行)
│   │   ├── Doctor.tsx            #   诊断界面
│   │   └── ResumeConversation.tsx
│   │
│   ├── components/               # UI 组件 (147+ 文件)
│   │   ├── App.tsx               #   顶层包装器
│   │   ├── PromptInput/          #   输入框
│   │   ├── VirtualMessageList    #   虚拟消息列表
│   │   ├── permissions/          #   权限对话框
│   │   ├── diff/                 #   差异显示
│   │   ├── design-system/        #   设计系统
│   │   └── ...
│   │
│   ├── hooks/                    # React Hooks (86+ 文件)
│   │   ├── useCanUseTool.tsx     #   权限检查
│   │   ├── useReplBridge.ts      #   Bridge 集成
│   │   ├── useSSHSession.ts      #   SSH 会话
│   │   ├── useAssistantHistory.ts#   助手历史
│   │   └── ...
│   │
│   ├── ink/                      # 自定义 Ink 实现 (48+ 文件)
│   │   ├── ink.tsx               #   Ink 实例创建
│   │   ├── dom.ts                #   虚拟 DOM
│   │   ├── reconciler.ts         #   React Reconciler
│   │   ├── layout/               #   Yoga 布局引擎
│   │   ├── components/           #   基础组件 (Box/Text/ScrollBox...)
│   │   ├── hooks/                #   终端专用 hooks (12个)
│   │   └── termio/               #   终端 I/O
│   │
│   ├── coordinator/              # 协调器模式
│   │   ├── coordinatorMode.ts    #   协调器逻辑
│   │   └── workerAgent.ts        #   Worker Agent
│   │
│   ├── assistant/                # KAIROS 助手模式
│   │   ├── index.ts
│   │   ├── gate.ts               #   特性门控
│   │   ├── sessionDiscovery.ts   #   会话发现
│   │   └── sessionHistory.ts     #   会话历史
│   │
│   ├── buddy/                    # Buddy AI 助手
│   │   ├── companion.ts
│   │   ├── CompanionSprite.tsx
│   │   └── prompt.ts
│   │
│   ├── daemon/                   # 守护进程 (8个文件)
│   │   ├── main.ts               #   守护进程入口
│   │   ├── daemonManager.ts      #   进程管理
│   │   ├── daemonProcess.ts      #   子进程
│   │   ├── daemonClient.ts       #   客户端
│   │   ├── workerRegistry.ts     #   Worker 注册
│   │   └── types.ts
│   │
│   ├── kairos/                   # 24/7 Agent 引擎
│   │   ├── kairosEngine.ts       #   核心引擎
│   │   ├── kairosWatcher.ts      #   事件监听器
│   │   └── types.ts
│   │
│   ├── uds/                      # Unix Domain Socket 通信
│   │   ├── inboxServer.ts        #   收件箱服务器
│   │   ├── inboxClient.ts        #   收件箱客户端
│   │   ├── inboxProtocol.ts      #   协议定义
│   │   └── inboxRegistry.ts      #   注册表
│   │
│   ├── teleport-local/           # 上下文迁移
│   │   ├── packer.ts             #   打包器
│   │   ├── unpacker.ts           #   解包器
│   │   └── transfer.ts           #   传输
│   │
│   ├── bridge/                   # 远程桥接 (35+ 文件)
│   │   ├── bridgeMain.ts         #   桥接入口
│   │   ├── localBridge.ts        #   本地桥接
│   │   ├── remoteBridgeCore.ts   #   远程核心
│   │   └── ...
│   │
│   ├── voice/                    # 语音模式
│   ├── ssh/                      # SSH 会话管理
│   │   ├── createSSHSession.ts
│   │   └── SSHSessionManager.ts
│   ├── vim/                      # Vim 模式
│   │   ├── motions.ts
│   │   ├── operators.ts
│   │   ├── textObjects.ts
│   │   └── transitions.ts
│   │
│   ├── plugins/                  # 插件系统
│   │   ├── builtinPlugins.ts
│   │   └── bundled/
│   ├── skills/                   # 技能系统
│   │   ├── bundledSkills.ts
│   │   ├── loadSkillsDir.ts
│   │   └── bundled/
│   │
│   ├── services/                 # 服务层 (40+ 模块)
│   │   ├── api/                  #   API 客户端（多 Provider）
│   │   ├── mcp/                  #   MCP 协议
│   │   ├── analytics/            #   GrowthBook / Datadog / Sentry
│   │   ├── compact/              #   对话压缩
│   │   ├── contextCollapse/      #   上下文折叠
│   │   ├── oauth/                #   OAuth 认证
│   │   ├── voice.ts              #   语音服务
│   │   ├── lsp/                  #   LSP 支持
│   │   ├── policyLimits/         #   策略限制
│   │   ├── remoteManagedSettings/#   远程管理设置
│   │   ├── SessionMemory/        #   会话记忆
│   │   └── ...
│   │
│   ├── state/                    # 状态管理（类 Zustand）
│   │   ├── AppState.tsx          #   全局状态
│   │   ├── AppStateStore.ts      #   Store 定义
│   │   ├── store.ts              #   Store 创建
│   │   └── onChangeAppState.ts   #   状态变更监听
│   │
│   └── types/                    # 类型定义
│
├── packages/                     # Monorepo workspace
│   ├── audio-capture-napi/       #   音频捕获 (Rust NAPI)
│   ├── color-diff-napi/          #   颜色差异 (Rust NAPI)
│   ├── image-processor-napi/     #   图像处理 (Rust NAPI)
│   ├── modifiers-napi/           #   修饰键检测 (Rust NAPI)
│   ├── url-handler-napi/         #   URL 处理 (Rust NAPI)
│   └── @ant/                     #   内部包
│       ├── claude-for-chrome-mcp/
│       ├── computer-use-input/
│       ├── computer-use-mcp/
│       └── computer-use-swift/
│
└── dist/cli.js                   # 构建产物
```

## 1.6 数据流总览

```
用户输入 "帮我写一个函数"
    │
    ▼
┌─ REPL Screen (5003行) ──────────────────────────┐
│  解析输入 → 检查是否是命令 (/xxx)                  │
│  如果是普通消息 → 提交给 QueryEngine               │
└────────────┬────────────────────────────────────┘
             │
             ▼
┌─ QueryEngine (1320行) ─────────────────────────┐
│  1. 组装系统提示词                                │
│     - 默认系统提示                                │
│     - CLAUDE.md 文件内容                          │
│     - 工具描述（58+ 工具的 prompt()）              │
│     - Git 状态（分支、最近提交、修改文件）          │
│  2. 构建消息数组 [system, ...history, user]       │
│  3. 调用 Claude API (流式)                        │
│  4. 解析响应                                      │
│     - 文本块 → 直接显示                            │
│     - 工具调用块 → 进入工具执行                    │
└────────────┬────────────────────────────────────┘
             │
        ┌────┴────────────┐
        ▼                 ▼
   文本响应            工具调用
   (直接显示)      ┌────┴────┐
                   ▼         ▼
              权限检查    多个工具
              (allow?     并行执行
               deny?     (如果 isConcurrencySafe)
               ask?)
                   │
                   ▼
              工具结果
              收集完毕
                   │
                   ▼
            追加到消息历史
            继续循环 → API
```

## 1.7 多 Provider 架构

ccb 支持多个 AI Provider，不仅限于 Anthropic：

```
┌─ QueryEngine ─┐
│ API 请求       │
└───────┬───────┘
        │
        ▼
┌─ services/api/ ────────────────┐
│  Provider 路由                  │
│  ├── Anthropic (默认)           │
│  ├── AWS Bedrock               │
│  ├── Google Vertex             │
│  └── Azure                     │
│                                │
│  共享逻辑:                      │
│  ├── withRetry (重试)           │
│  ├── dumpPrompts (调试)         │
│  ├── logging (使用量追踪)       │
│  └── errors (错误分类)          │
└────────────────────────────────┘
```

## 1.8 packages/ Monorepo 工作区

项目采用 monorepo 架构，`packages/` 下有 5 个 Rust NAPI 原生模块和 4 个 `@ant` 内部包：

| 包 | 用途 | 语言 |
|------|------|------|
| `audio-capture-napi` | 麦克风音频捕获（语音模式） | Rust |
| `color-diff-napi` | 终端颜色差异计算 | Rust |
| `image-processor-napi` | 图像压缩/转换（发送给 API） | Rust |
| `modifiers-napi` | 检测修饰键状态（Ctrl/Alt/Shift） | Rust |
| `url-handler-napi` | URL 协议处理 | Rust |
| `@ant/claude-for-chrome-mcp` | Chrome 浏览器集成 MCP | TS |
| `@ant/computer-use-input` | 计算机使用输入 | TS |
| `@ant/computer-use-mcp` | 计算机使用 MCP 服务器 | TS |
| `@ant/computer-use-swift` | macOS 计算机使用 | Swift |

## 1.9 下一步

现在你已经有了全局视角。接下来我们将按照以下顺序深入每个层：

1. **[第二章：启动链路详解](02-bootstrap-chain.md)** — 逐行理解从 `ccb` 到界面出现的完整路径
2. **[第三章：对话引擎 QueryEngine](03-query-engine.md)** — 核心中的核心：Agent Loop
3. **[第四章：工具系统](04-tool-system.md)** — 58+ 工具的注册、执行与权限
4. **[第五章：终端 UI 系统](05-terminal-ui.md)** — React in Terminal 的完整实现
