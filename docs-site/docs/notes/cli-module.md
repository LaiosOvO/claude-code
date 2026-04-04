# src/cli/ 模块阅读笔记

**文件数量**: 约 127 个（包括子目录）  
**模块定位**: CLI 运行时层 — 非交互输出、SDK 通信、传输协议、后台会话管理

---

## 目录结构

```
src/cli/
├── 核心文件
│   ├── print.ts              # 非交互模式 (-p/--print) 核心 (213KB)
│   ├── structuredIO.ts       # 结构化 I/O 协议 (29KB)
│   ├── remoteIO.ts           # 远程 I/O 适配 (10KB)
│   ├── bg.ts                 # 后台会话存根 (0.7KB)
│   ├── exit.ts               # 退出处理 (1.3KB)
│   ├── ndjsonSafeStringify.ts # NDJSON 安全序列化 (1.4KB)
│   ├── rollback.ts           # 回滚操作 (0.2KB)
│   ├── up.ts                 # 上游操作 (0.1KB)
│   └── update.ts             # 自动更新 (14KB)
│
├── handlers/                  # CLI 子命令处理器 (8 文件)
│   ├── agents.ts             # Agent 管理处理器
│   ├── ant.ts                # 内部 (ant) 命令处理器
│   ├── auth.ts               # 认证处理器
│   ├── autoMode.ts           # 自动模式处理器
│   ├── mcp.tsx               # MCP 命令处理器 (React 组件)
│   ├── plugins.ts            # 插件命令处理器
│   ├── templateJobs.ts       # 模板任务处理器
│   └── util.tsx              # 工具函数 (React 组件)
│
├── transports/                # 传输层协议 (9 文件)
│   ├── Transport.ts          # 传输层抽象基类
│   ├── HybridTransport.ts    # 混合传输（SSE + WebSocket）
│   ├── SSETransport.ts       # SSE 传输
│   ├── WebSocketTransport.ts # WebSocket 传输
│   ├── ccrClient.ts          # CCR（Claude Code Remote）客户端
│   ├── SerialBatchEventUploader.ts # 串行批量事件上传
│   ├── transportUtils.ts     # 传输工具函数
│   ├── WorkerStateUploader.ts # Worker 状态上传
│   └── src/
│       └── entrypoints/
│           └── sdk/
│               └── controlTypes.ts  # SDK 控制消息类型
│
└── src/                       # 内部子模块
```

---

## 核心文件详解

### print.ts — 非交互模式核心

**文件大小**: 213KB（约 5600+ 行）  
**这是代码库中第二大文件，仅次于 REPL.tsx。**

`print.ts` 是 `-p/--print` 模式（也称 headless 模式）的完整实现，处理从标准输入接收提示到标准输出返回结果的全部逻辑。

**核心功能**:
- 文本模式输出（纯文本结果）
- JSON 模式输出（结构化单次结果）
- stream-json 模式输出（实时流式事件）
- SDK URL 模式（远程 WebSocket/SSE 连接）
- 工具执行管理
- 权限检查（通过 `--permission-prompt-tool` MCP 工具）
- Token 预算管理
- 速率限制处理
- SIGINT 优雅中断

**关键函数**:
```typescript
// print.ts 导出的主函数（推测）
export async function runPrint(options: PrintOptions): Promise<void>;
```

### structuredIO.ts — 结构化 I/O 协议

**文件大小**: 29KB

实现了 Claude Code SDK 的结构化通信协议，支持通过 stdin/stdout 交换 JSON 消息。

**核心类型**:
```typescript
interface SDKMessage { ... }
interface SDKUserMessage { ... }
interface SDKControlRequest { ... }
interface SDKControlResponse { ... }
```

**关键功能**:
- 接收 SDK 控制消息（`StdinMessage`）
- 发送事件消息（`StdoutMessage`）
- 权限请求和响应处理
- 引出（Elicitation）对话框处理
- 命令生命周期通知
- 会话状态同步

### remoteIO.ts — 远程 I/O 适配

**文件大小**: 10KB

为远程会话（CCR、Teleport 等）提供 I/O 适配层，将本地 structuredIO 协议桥接到远程传输。

---

## handlers/ — CLI 子命令处理器

### auth.ts — 认证处理器

处理 `claude auth login`、`claude auth status`、`claude auth logout` 子命令的逻辑。

### mcp.tsx — MCP 命令处理器

处理 `claude mcp serve`、`claude mcp add`、`claude mcp remove`、`claude mcp list` 等子命令。注意这是一个 `.tsx` 文件——部分 MCP 操作（如服务器健康检查展示）使用了 React/Ink 渲染。

### plugins.ts — 插件命令处理器

处理 `claude plugin install`、`claude plugin uninstall`、`claude plugin list`、`claude plugin enable`、`claude plugin disable` 等子命令。

### templateJobs.ts — 模板任务处理器

处理 `claude new`、`claude list`、`claude reply` 子命令，用于模板化任务管理。

### agents.ts — Agent 管理处理器

处理 agent 相关的 CLI 操作。

### autoMode.ts — 自动模式处理器

处理自动权限模式的 CLI 逻辑。

---

## transports/ — 传输层协议

传输层为远程会话提供底层通信能力。

### Transport.ts — 抽象基类

```typescript
// 推测的接口
interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}
```

### SSETransport.ts — Server-Sent Events

通过 HTTP SSE 协议实现单向服务器推送。适用于防火墙限制 WebSocket 的环境。

### WebSocketTransport.ts — WebSocket

全双工 WebSocket 连接，用于 SDK URL 模式和远程会话。

### HybridTransport.ts — 混合传输

结合 SSE（下行）和 HTTP POST（上行）的混合策略，在 WebSocket 不可用时降级使用。

### ccrClient.ts — CCR 客户端

Claude Code Remote 专用客户端，管理与远程容器的通信。

### SerialBatchEventUploader.ts — 批量事件上传

串行批量上传事件到远程端点，避免并发导致的事件乱序。

### WorkerStateUploader.ts — Worker 状态上传

用于 Agent Swarm 中 worker 向 leader 上报状态。

---

## 与其他模块的关系

```
cli/
  |
  +-- print.ts <-- main.tsx 的非交互路径调用
  |       |
  |       +-- 使用 services/tools/* (工具执行)
  |       +-- 使用 services/compact/* (上下文压缩)
  |       +-- 使用 services/api/* (API 调用)
  |
  +-- structuredIO.ts <-- 被 print.ts 和 SDK 模式使用
  |       |
  |       +-- 使用 transports/* (传输层)
  |
  +-- handlers/ <-- 被 main.tsx 的子命令注册使用
  |       |
  |       +-- auth.ts <-- 被 program.command('auth') 调用
  |       +-- mcp.tsx <-- 被 program.command('mcp') 调用
  |       +-- plugins.ts <-- 被 program.command('plugin') 调用
  |
  +-- transports/ <-- 被 remoteIO 和 structuredIO 使用
  |
  +-- bg.ts <-- 被 cli.tsx 的后台会话快速路径使用
  +-- update.ts <-- 被 cli.tsx 的 --update 路径使用
```

---

## 核心类型

```typescript
// structuredIO.ts
interface StdinMessage {
  type: 'user_message' | 'control' | 'permission_response' | ...;
  // ...
}

interface StdoutMessage {
  type: 'assistant_message' | 'tool_use' | 'tool_result' | 'system' | ...;
  // ...
}

// transports/controlTypes.ts
interface SDKControlRequest { ... }
interface SDKControlResponse { ... }

// handlers/templateJobs.ts
// 处理 new/list/reply 子命令
```

---

## 设计模式

1. **双模式架构**: `print.ts` (非交互) 和 `REPL.tsx` (交互) 是两条并行的执行路径，共享 services 层但有不同的 I/O 策略
2. **传输层抽象**: `Transport.ts` 提供统一接口，具体传输（SSE、WebSocket、Hybrid）可互换
3. **协议版本化**: structuredIO 的消息格式支持向后兼容
4. **优雅降级**: HybridTransport 在 WebSocket 不可用时自动降级到 SSE + POST
5. **存根模式**: `bg.ts` 是自动生成的存根，实际实现通过 feature flag 按需加载
6. **NDJSON**: 使用换行分隔的 JSON 格式进行流式通信，每行一个完整 JSON 对象
