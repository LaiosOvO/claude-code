# 第四章：系统集成 -- 从子系统到完整应用

> 现在你已经理解了基础原语、核心抽象和模块组装。这一章把所有组件串联起来，展示一个完整的请求是如何从用户输入流经整个系统的。

## 4.1 启动流程

ccb 的启动从 `src/entrypoints/cli.tsx` 开始：

```
$ ccb
    |
    v
src/entrypoints/cli.tsx      <- CLI 入口
    |
    v
src/entrypoints/init.ts      <- 初始化（配置、认证、MCP 连接）
    |
    v
src/setup.ts (569行)         <- 环境准备（Git、CLAUDE.md、权限）
    |
    v
src/main.tsx (4680行)        <- 主逻辑分发
    |
    +--- REPL 模式 ---------> src/screens/REPL.tsx (5003行)
    |                          完整的终端交互界面
    |
    +--- Headless 模式 -----> QueryEngine 直接调用
    |                          无 UI，适合 CI/CD
    |
    +--- Bridge 模式 -------> src/bridge/bridgeMain.ts (2999行)
    |                          远程控制
    |
    +--- SDK 模式 ----------> src/entrypoints/sdk/
                               程序化调用
```

### 构建系统

```
bun run build.ts
    |
    v
入口:      src/entrypoints/cli.tsx
Bundler:   Bun.build({ splitting: true, target: 'bun' })
定义注入:  getMacroDefines() -> MACRO.VERSION, MACRO.BUILD_TIME 等
Feature:   FEATURE_* 环境变量 -> feature() 宏求值
    |
    v
输出:      dist/cli.js + ~450 chunks
```

开发模式则直接用 Bun 运行源码：
```
bun run scripts/dev.ts
    |-> bun -d 'MACRO.VERSION:"2.1.888"' ... src/entrypoints/cli.tsx
```

## 4.2 完整的请求生命周期

追踪真实场景：**用户输入"帮我读取 package.json 并添加一个 test script"**

```
时间轴 ---------------------------------------------------------------->

| 用户在终端输入文字，按下 Enter
|
v [REPL.tsx: useInput hook 捕获 Enter 键]
|
| 解析输入：不是 / 开头 -> 不是命令，是普通消息
|
v [REPL.tsx: 提交给 QueryEngine]
|
| queryEngine.submitMessage("帮我读取 package.json 并添加一个 test script")
|
v [QueryEngine.ts (1450行): 组装系统提示词]
|
| systemPrompt = fetchSystemPromptParts()
|   = 核心提示 + 工具描述(58+ 工具) + CLAUDE.md + Git状态 + 日期
|   + memdir 记忆文件 + 插件上下文
| messages = [...history, { role: "user", content: "帮我读取..." }]
|
v [query.ts (1865行): 调用 Claude API -- 流式]
|
| POST /v1/messages { model, system, messages, tools, stream: true }
|
| +-- SSE 流 ------------------------------------------+
| | content_block_start: { type: "text" }              |
| | content_block_delta: "我来帮你..."                  |  -> UI 实时显示文字
| | content_block_stop                                  |
| | content_block_start: { type: "tool_use",           |
| |   name: "Read", id: "tool_1" }                     |
| | content_block_delta: { input: {                     |
| |   file_path: "package.json" } }                    |
| | content_block_stop                                  |
| | message_stop: { stop_reason: "tool_use" }          |
| +----------------------------------------------------+
|
v [query.ts: 检测到 stop_reason = "tool_use"]
|
| 提取工具调用: Read({ file_path: "package.json" })
|
v [权限检查]
|
| Read.isReadOnly() -> true  (只读工具自动通过)
| Read.isConcurrencySafe() -> true  (可以并行)
|
v [工具执行]
|
| Read.call({ file_path: "package.json" })
| -> Bun.file("package.json").text()
| -> 返回文件内容
|
v [query.ts: 追加 tool_result 到消息历史]
|
| messages.push({
|   role: "user",
|   content: [{ type: "tool_result", tool_use_id: "tool_1", content: "{...}" }]
| })
|
v [query.ts: 再次调用 Claude API -- 第二轮]
|
| Claude 看到了 package.json 的内容，决定编辑它
| tool_use: Edit({ file_path: "package.json",
|   old_string: "\"scripts\": {",
|   new_string: "\"scripts\": {\n    \"test\": \"bun test\"," })
|
v [权限检查 -- Edit 需要用户确认]
|
| Edit.isReadOnly() -> false  (写操作)
| 权限模式 = default -> 弹出确认对话框
|
v [UI: 显示权限确认对话框]
|
| +-------------------------------------+
| | Claude wants to edit package.json   |
| |                                     |
| |   "scripts": {                      |
| | +   "test": "bun test",            |
| |     ...                             |
| |                                     |
| | [Allow] [Deny] [Always Allow Edit]  |
| +-------------------------------------+
|
| 用户点击 [Allow]
|
v [工具执行 -> 结果返回 -> 第三轮 API 调用]
|
| Claude 看到编辑成功，给出最终回答
| message_stop: { stop_reason: "end_turn" }  <- 对话结束
|
v [REPL.tsx: 渲染最终响应]
```

## 4.3 消息压缩：compact 子系统

当对话变长，Token 超出模型上下文窗口时，compact 系统介入：

**文件**: `src/services/compact/`

```
src/services/compact/
+-- compact.ts           <- 核心压缩逻辑
+-- autoCompact.ts       <- 自动压缩策略
+-- microCompact.ts      <- 微压缩（单条消息级别）
+-- reactiveCompact.ts   <- 响应式压缩 (feature-gated)
+-- contextCollapse/     <- 上下文折叠 (feature-gated)
+-- grouping.ts          <- 消息分组
```

压缩策略层级：

```
Token 用量 < 50%     -> 不压缩
Token 用量 50%-80%   -> microCompact（压缩工具结果）
Token 用量 > 80%     -> autoCompact（压缩整个历史）
Token 用量逼近上限    -> reactiveCompact（激进压缩）
                        contextCollapse（上下文折叠）
```

## 4.4 并发模型

```
单个 query() 循环内的并发：

  API 调用（串行，一次只有一个）
      |
      v
  响应解析 -> 提取 N 个工具调用
      |
      +-- Read("file1.ts")  -----+
      +-- Read("file2.ts")  -----+  并行执行!
      +-- Grep("pattern")   -----+  (都是 concurrencySafe)
      |                          |
      |   等待全部完成...         |
      | <------------------------+
      |
      +-- Bash("bun test")  ----+  串行执行!
      |   等待完成...            |  (Bash 不是 concurrencySafe)
      | <------------------------+
      |
      +-- Edit("file1.ts")  ----+  串行执行!
      |   等待完成...            |  (写操作)
      | <------------------------+
      |
      v
  收集所有 tool_result，继续下一轮 API 调用
```

## 4.5 Coordinator 模式的请求流

当启用 COORDINATOR_MODE 时，请求流变为多 Agent 模式：

```
用户请求
    |
    v
+-- Coordinator Agent (主线程) ---------------------+
|   拥有工具: Agent, TaskStop, SendMessage           |
|   职责: 分解任务、分派、监控                       |
|                                                    |
|   "我需要两个 worker 分别处理前端和后端"           |
|   -> Agent({ prompt: "重构前端路由" })             |
|   -> Agent({ prompt: "优化后端 API" })             |
+---------+-------------------+---------------------+
          |                   |
          v                   v
+-- Worker 1 ------+   +-- Worker 2 ------+
|  Bash, Read, Edit|   |  Bash, Read, Edit|
|  处理前端任务     |   |  处理后端任务     |
+------- |----------+   +-------|----------+
         |                      |
         v                      v
    SendMessage             SendMessage
    ("前端重构完成")         ("后端优化完成")
         |                      |
         +----------+-----------+
                    |
                    v
            Coordinator 汇总结果
```

## 4.6 Bridge 系统

Bridge 让 ccb 支持远程控制。有两个变体：

### 远程 Bridge（Anthropic 云端）

**文件**: `src/bridge/bridgeMain.ts` (2999行) + `src/bridge/replBridge.ts` (2406行)

```
手机浏览器          Anthropic 云端           本地 ccb
+----------+    +----------------+    +----------------+
| Web UI   |<-->| WebSocket 服务 |<-->| replBridge.ts  |
| 发消息    |    | 消息路由       |    | bridgeMain.ts  |
| 看结果    |    | 状态同步       |    | REPL.tsx       |
+----------+    +----------------+    +----------------+
```

### 本地 Bridge（自建服务器）

**文件**: `src/bridge/localBridge.ts` (344行)

```
手机浏览器                 自建 Server              本地 ccb
+---------+          +------------------+       +----------------+
| Web UI  |<--WS---->| /ws/bridge/      |<--WS->| LocalBridge    |
|         |          | {sessionId}      |       |                |
| 发消息   |--POST-->| /api/bridge/     |--转发->| 处理消息       |
| 看结果   |<--WS---| sessions/msg     |<--推送-| 返回结果       |
| 传文件   |--POST-->| /file            |--保存->| 接收文件       |
+---------+          +------------------+       +----------------+
```

LocalBridge 无需 Anthropic 账号，支持纯本地部署。

## 4.7 错误处理策略

每一层都有自己的错误处理：

```
层级              错误类型              处理方式
----              --------              --------
UI 层             渲染异常              ErrorBoundary 捕获，显示错误信息
                  输入解析失败          提示用户重新输入

引擎层            API 调用失败          重试 + FallbackTriggeredError + 降级模型
                  Token 超出限制        触发对话压缩 (compact/microCompact)
                  Prompt Too Long      PROMPT_TOO_LONG_ERROR_MESSAGE 特殊处理
                  预算超出              停止对话，通知用户

工具层            权限被拒绝            返回拒绝信息给 Claude
                  执行超时              终止进程，返回超时错误
                  工具抛异常            捕获异常，返回错误信息
                  大结果溢出            buildLargeToolResultMessage 写磁盘

服务层            MCP 服务器断线        自动重连 + 工具降级
                  网络错误              指数退避重试 (withRetry.ts)
                  认证过期              OAuth 刷新 Token
                  图片过大              ImageSizeError / ImageResizeError
```

## 4.8 会话持久化与恢复

```
每次对话都会被持久化到磁盘：

~/.claude/sessions/
+-- session_abc123.json     <- 完整的消息历史
+-- session_def456.json
+-- ...

持久化时机（recordTranscript + flushSessionStorage）:
1. 每个 API 调用完成后
2. 每个工具执行完成后
3. 用户 Ctrl+C 中断时
4. 对话压缩后

恢复时机：
1. /resume 命令
2. --continue 参数
3. Teleport 解包后
4. Assistant 模式恢复历史会话
```

## 4.9 Teleport：跨机器上下文迁移

**文件**: `src/teleport-local/`

```
src/teleport-local/
+-- packer.ts    <- 打包当前会话状态
+-- unpacker.ts  <- 解包并恢复会话
+-- transfer.ts  <- 传输层
+-- types.ts     <- TeleportPackage 类型定义

打包流程：
  1. 序列化消息历史 (messages -> JSON)
  2. 捕获 Git 状态 (branch, diff, stash)
  3. 快照修改的文件
  4. 记录工具和权限配置
  5. 记录运行中的任务
  6. 组装 TeleportPackage 对象
  7. 计算 SHA-256 校验和
  8. Gzip 压缩
  9. 保存到 ~/.claude/teleport/{id}.teleport.gz

安全措施：
  - 排除 .env, credentials.json, .ssh/ 等敏感文件
  - 大文件只记录路径不打包
  - 二进制文件 base64 编码
  - 原子写入（先写临时文件再 rename）
```

## 4.10 Assistant 模式

**文件**: `src/assistant/`

```
src/assistant/
+-- index.ts                  <- 入口
+-- gate.ts                   <- 功能门控
+-- sessionDiscovery.ts       <- 会话发现
+-- sessionHistory.ts         <- 会话历史
+-- AssistantSessionChooser.ts <- 会话选择器
```

Assistant 模式（/assistant 命令）提供类 KAIROS 的辅助体验，包括会话发现和历史恢复。

## 4.11 本章总结

完整的系统集成涉及以下层面：

| 集成层面 | 参与模块 | 协作方式 |
|----------|----------|----------|
| 启动流程 | cli.tsx -> init.ts -> setup.ts -> main.tsx | 串行管线 |
| 请求处理 | REPL -> QueryEngine -> query.ts -> Tool | 同步管线 + 流式 |
| 状态同步 | AppState -> React Context -> Components | 单向数据流 |
| 错误恢复 | 每层独立处理，向上冒泡 | try/catch + 降级 |
| 并发控制 | concurrencySafe 标记 | Promise.all / 串行 |
| 消息压缩 | compact / microCompact / contextCollapse | Token 阈值触发 |
| Coordinator | coordinator -> workerAgent | 多 Agent 分发 |
| Bridge | bridgeMain + replBridge / localBridge | WebSocket 双向通信 |
| 持久化 | sessionStorage + teleport | 关键点写入 + Gzip 包 |
| 构建 | build.ts + Bun bundler | feature-gated DCE |

下一章是最后一章——站在最高处，回望整个系统。

-> [第五章：全景视角 -- 回望整个系统](05-full-picture.md)
