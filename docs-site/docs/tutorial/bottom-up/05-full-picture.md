# 第五章：全景视角 -- 回望整个系统

> 你已经从最小的 createSignal 原语一路爬升到完整的系统集成。现在站在山顶，回望全貌。

## 5.1 从底到顶的完整层级

```
第六层 -- 独立模块 ---------------------------------------------------------
   Daemon          |  Kairos         |  Buddy        |  Voice
   -- 守护进程      |  -- 24/7 Agent  |  -- AI 伴侣   |  -- 语音 I/O
                   |                 |               |
第五层 -- 应用层 -----------------------------------------------------------
   REPL Screen     |  Headless Mode  |  Bridge Mode  |  SDK Mode
   -- 终端交互界面  |  -- 无头执行     |  -- 远程控制   |  -- 程序调用
   (5003行)        |                 |  (2999行)     |
                   |                 |               |
第四层 -- 系统集成层 -------------------------------------------------------
   QueryEngine     |  AppStateStore  |  SessionManager |  Coordinator
   -- AI Agent 循环 |  -- 全局状态管理 |  -- 会话生命周期 |  -- 多Agent协调
   (1450行)        |                 |                 |
                   |                 |                 |
第三层 -- 模块组装层 -------------------------------------------------------
   ToolPool       |  CommandSystem  |  MCP Client   |  Services
   -- 58+ 工具集合 |  -- 80+ 命令    |  -- 外部工具   |  -- 40+ 服务
                  |  + Skill + 插件 |               |
                  |                 |               |
第二层 -- 核心抽象层 -------------------------------------------------------
   Tool           |  Command        |  Skill        |  Message
   -- AI 工具定义  |  -- 用户命令     |  -- 扩展技能   |  -- 对话消息
   (buildTool)    |  (3种子类型)     |  (2种来源)    |
                  |                 |               |
第一层 -- 基础原语层 -------------------------------------------------------
   createSignal  |  Mailbox  |  Zod/v4  |  AsyncGen  |  React+Ink  |  feature()
```

## 5.2 关键设计决策回顾

### 为什么用 Bun 而不是 Node.js？
```
对比：
  Node.js  -> 需要 tsc 编译、node_modules 体积大
  Deno     -> 生态尚不成熟
  Bun      -> 原生 TypeScript/TSX、极快的启动速度、
              内置 bundler、NAPI 兼容、feature() 宏 ✓
```

### 为什么用 AsyncGenerator 驱动 query 循环？
```
对比方案：
  回调函数    -> 回调地狱，难以组合
  Promise     -> 无法流式，必须等全部完成
  Observable  -> 需要 RxJS，学习成本高
  AsyncGen    -> 原生支持，流式，可组合，可背压 ✓

query.ts 的 1865 行核心就是一个巨大的 async function*
```

### 为什么用 React 写终端 UI？
```
对比方案：
  console.log  -> 无法更新已输出的内容
  ncurses      -> C 绑定，不支持组件模型
  blessed      -> 过时，不维护
  React + Ink  -> 声明式，组件化，React Compiler 优化 ✓

REPL.tsx 5003 行就是一个巨大的 React 组件
```

### 为什么安全属性默认 false（fail-closed）？
```
Fail-Open  vs  Fail-Closed：
  Fail-Open:   忘了标记 -> 默认允许 -> 可能执行危险操作 ✗
  Fail-Closed: 忘了标记 -> 默认拒绝 -> 最多是功能降级 ✓

  安全系统永远选择 Fail-Closed
  见 TOOL_DEFAULTS: isConcurrencySafe -> false, isReadOnly -> false
```

### 为什么用 feature() 宏做特性门控？
```
对比方案：
  运行时 if/else     -> 代码全部打包，体积大
  环境变量检查        -> 同上，且无法 DCE
  feature('KAIROS')  -> 构建时求值，假分支完全移除 ✓

  内部版本 (ant) 可以包含 50+ 额外功能
  外部版本只包含核心功能
  同一份源码，不同构建配置
```

## 5.3 代码规模感知

```
文件数量：
  src/ 目录总计 500+ 文件

  按大小排序的关键文件：
  +-------------------------+--------+
  | screens/REPL.tsx        | 5003行 | <- 最大的单文件
  | main.tsx                | 4680行 |
  | bridge/bridgeMain.ts    | 2999行 |
  | bridge/replBridge.ts    | 2406行 |
  | query.ts (1865行) |
  | QueryEngine.ts          | 1450行 |
  | Tool.ts (978行) |
  | services/voice.ts       |  525行 |
  | setup.ts                |  569行 |
  | tools.ts                |  469行 |
  | bridge/localBridge.ts   |  344行 |
  | context.ts              |  260行 |
  +-------------------------+--------+

  目录规模：
  +---------------------+-------+
  | tools/              |  55+  | (每个工具一个子目录)
  | commands/           |  70+  | (每个命令一个子目录/文件)
  | hooks/              | 100+  |
  | components/         | 150+  |
  | utils/              | 100+  |
  | services/           |  40+  |
  | bridge/             |  30+  |
  | ink/                |  40+  |
  | state/              |  10+  |
  | entrypoints/        |  10+  |
  +---------------------+-------+

  独有模块：
  +---------------------+-------+
  | coordinator/        |   2   |
  | assistant/          |   5   |
  | buddy/              |   6   |
  | kairos/             |   4   |
  | daemon/             |   8   |
  | uds/                |   6   |
  | teleport-local/     |   5   |
  | skills/             |   5   |
  | plugins/            |   2+  |
  +---------------------+-------+

  packages/ workspace：
  +---------------------------+
  | audio-capture-napi        |
  | color-diff-napi           |
  | image-processor-napi      |
  | modifiers-napi            |
  | url-handler-napi          |
  | @ant/claude-for-chrome-mcp|
  | @ant/computer-use-input   |
  | @ant/computer-use-mcp     |
  | @ant/computer-use-swift   |
  +---------------------------+
```

## 5.4 六大独有模块的架构位置

```
                        +-- 应用层 ---------------------+
                        | REPL   Bridge  Headless  SDK   |
                        +--------------+----------------+
                                       |
          +----------------------------+----------------------------+
          |                            |                            |
  +-------v------+            +--------v------+           +--------v-------+
  | QueryEngine  |            |   Daemon      |           |   Bridge       |
  | (对话引擎)    |            |  (���护进程)    |           |  (远程控制)     |
  | 1450行       |            |  8个文件       |           |  30+文件       |
  +--------------+            +-------+-------+           |  +localBridge  |
                                      |                   +----------------+
                              +-------v-------+
                              |   Kairos      |
                              |  (24/7 Agent)  |
                              |  4个文件       |
                              |  +----------+ |
                              |  |EventBus  | |
                              |  |AgentPool | |
                              |  |Watcher   | |
                              |  |Scheduler | |
                              |  +----------+ |
                              +------+--------+
                                     |
                  +------------------+------------------+
                  |                  |                   |
          +-------v------+  +-------v------+  +---------v--------+
          |  UDS Inbox   |  |  Teleport    |  |   Coordinator    |
          | (跨会话通信)  |  | (上下文迁移)  |  |  (多Agent协调)   |
          |  6个文件      |  |  5个文件      |  |  2个文件         |
          +--------------+  +--------------+  +------------------+

  独立模块：
          +-------+------+  +-------+------+
          |   Buddy      |  |   Voice      |
          |  (AI 伴侣)   |  |  (语音 I/O)   |
          |  6个文件      |  |  525行        |
          +--------------+  +--------------+

          +-------+------+  +-------+------+
          |  Assistant   |  |   Plugins    |
          | (KAIROS辅助)  |  |  (插件系统)   |
          |  5个文件      |  |  bundled/    |
          +--------------+  +--------------+
```

### 各模块职责

| 模块 | 文件 | 核心职责 |
|------|------|---------|
| **Daemon** | `src/daemon/` (8文件) | 后台守护进程：PID管理、UDS服务、心跳、会话spawn |
| **Kairos** | `src/kairos/` (4文件) | 24/7 Agent：EventBus、AgentPool、定时/响应/主动任务 |
| **UDS Inbox** | `src/uds/` (6文件) | 跨会话通信：星型拓扑、单播/广播、离线缓冲 |
| **Teleport** | `src/teleport-local/` (5文件) | 上下文迁移：打包/解包会话、Git状态快照 |
| **Coordinator** | `src/coordinator/` (2文件) | 多Agent协调：coordinator/worker角色分工 |
| **Bridge** | `src/bridge/` (30+文件) | 远程控制：WebSocket双向通信、本地/云端两种模式 |
| **Buddy** | `src/buddy/` (6文件) | AI伴侣：CompanionSprite、通知、对话 |
| **Voice** | `src/services/voice.ts` (525行) | 语音I/O：STT/TTS集成 |
| **Assistant** | `src/assistant/` (5文件) | 助手模式：会话发现、历史恢复 |
| **Plugins** | `src/plugins/` + `src/services/plugins/` | 插件系统：内置插件、第三方插件加载 |
| **Skills** | `src/skills/` (5文件) | Skill系统：磁盘加载、内置注册、MCP Skill |

## 5.5 从 ccb 学到的架构模式

### 模式 1：Fail-Closed 默认值
所有安全相关的可选标记默认选择最安全的选项。`TOOL_DEFAULTS` 中 `isConcurrencySafe: false`、`isReadOnly: false` 就是典型。

### 模式 2：编译时特性门控
`feature('FLAG')` 宏让同一份源码为不同用户群构建不同二进制。`tools.ts` 和 `commands.ts` 中大量使用。

### 模式 3：三层关注点分离
每个 Tool 的 逻辑/提示词/UI 各自独立文件。不同受众（引擎/AI/用户）各取所需。

### 模式 4：AsyncGenerator 驱动
`query.ts (1865行)) 的核心就是一个 `async function*`。整个查询循环天���支持流式和背压。

### 模式 5：传输抽象
Bridge 系统不管底层是 WebSocket、SSE 还是 HTTP，上层用统一的 `ReplBridgeTransport` 接口。LocalBridge 和远程 Bridge 共享 `bridgeMessaging.ts` 的消息处理逻辑。

### 模�� 6：星型拓扑通信
UDS Inbox 选择了星型拓扑而非 mesh。所有客户端只与 InboxServer 通信，简化了连接管理。

### 模式 7：有界数据结构
`BoundedUUIDSet` (环形缓冲区)、LRU Cache、Token 预算等，防止内存泄漏。

### 模式 8：惰性加载打破循环依赖
```typescript
// 延迟 require 避免循环依赖
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
```

### 模式 9：Provider 嵌套组合
```
AppStoreContext -> MailboxProvider -> VoiceProvider -> children
```
每层 Provider 贡献一个 Context，组件按需消费。

## 5.6 学习路径建议

如果你想**修改或扩展** ccb，建议的切入路径：

```
初级：理解启动流程
  -> 读 src/entrypoints/cli.tsx -> init.ts -> setup.ts -> main.tsx
  -> 大约 2 小时

中级：理解对话引擎
  -> 读 query.ts -> QueryEngine.ts -> Tool.ts -> tools.ts
  -> 试着添加一个简单的 Tool
  -> 大约 4 小时

高级：理解远程控制
  -> 读 bridge/ 目录的核心文件 (bridgeMain.ts, replBridge.ts, localBridge.ts)
  -> 理解 WebSocket transport 和 BoundedUUIDSet
  -> 大约 6 小时

高级：理解 24/7 Agent
  -> 读 daemon/ + kairos/ + uds/ 模块
  -> 理解 EventBus、AgentPool、InboxServer
  -> 大约 6 小时

专家：理解完整 REPL
  -> 读 screens/REPL.tsx (5003行)
  -> 理解 hooks/ 的组合模式（100+ hooks）
  -> 大约 8 小时

专家：理解构建系统
  -> 读 build.ts + scripts/dev.ts + scripts/defines.ts
  -> 理解 feature() 宏、DCE、chunk splitting
  -> 大约 4 小时
```

## 5.7 关键文件速查表

| 要做什么 | 看哪个文件 |
|---------|-----------|
| 添加新工具 | `src/tools/` 下新建目录 + `src/tools.ts` 注册 |
| 添加新命令 | `src/commands/` 下新建 + `src/commands.ts` 注册 |
| 添加新 Skill | `.claude/skills/` 下写 .md 或 `registerBundledSkill()` |
| 修改系统提示词 | `src/context.ts` + `src/utils/queryContext.ts` |
| 修改 UI | `src/screens/REPL.tsx` + `src/components/` |
| 修改权限逻辑 | `src/utils/permissions/` + 工具的 `checkPermissions` |
| 修改 API 调用 | `src/services/api/` |
| 修改构建 | `build.ts` + `scripts/defines.ts` |
| 添加 MCP 服务器 | settings.json 的 `mcpServers` 配置 |
| 修改 Bridge | `src/bridge/` (远程) 或 `localBridge.ts` (本地) |
| 修改 Daemon | `src/daemon/` |
| 修改 Kairos | `src/kairos/` |
| 修改 UDS 通信 | `src/uds/` |
| 修改 Teleport | `src/teleport-local/` |

## 5.8 结语

你现在已经从最底层的 createSignal 原语，一路理解到了完整的系统架构。

**ccb 的核心可以用一句话概括：**

> 用 React 在终端中构建 UI，用 AsyncGenerator 驱动 AI Agent 循环，用 Tool 系统赋予 AI 执行能力，用 Bridge/UDS/Daemon 实现远程协作与 24/7 运行，用 feature() 宏实现同源码多版本构建。

一切复杂性都围绕这个核心展开。当你遇到不理解的代码时，问自己：**它在为这五件事中的哪一件服务？**

1. **终端 UI** (React + Ink + REPL.tsx)
2. **Agent 循环** (AsyncGenerator + query.ts + QueryEngine.ts)
3. **AI 能力** (Tool + buildTool + 58+ 工具)
4. **远程与持久** (Bridge + Daemon + Kairos + UDS + Teleport)
5. **编译与门控** (Bun + feature() + DCE + NAPI)

祝你学习愉快！
