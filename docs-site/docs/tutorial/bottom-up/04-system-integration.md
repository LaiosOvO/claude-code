# 第四章：系统集成 — 从子系统到完整应用

> 现在你已经理解了基础原语、核心抽象和模块组装。这一章把所有组件串联起来，展示一个完整的请求是如何从用户输入流经整个系统的。

## 4.1 完整的请求生命周期

让我们追踪一个真实场景：**用户输入"帮我读取 package.json 并添加一个 test script"**

```
时间轴 ──────────────────────────────────────────────────────────────►

│ 用户在终端输入文字，按下 Enter
│
▼ [REPL.tsx: useInput hook 捕获 Enter 键]
│
│ 解析输入：不是 / 开头 → 不是命令，是普通消息
│
▼ [REPL.tsx: 提交给 QueryEngine]
│
│ queryEngine.submitMessage("帮我读取 package.json 并添加一个 test script")
│
▼ [QueryEngine: 组装系统提示词]
│
│ systemPrompt = 核心提示 + 工具描述(60+工具) + CLAUDE.md + Git状态
│ messages = [...history, { role: "user", content: "帮我读取..." }]
│
▼ [QueryEngine: 调用 Claude API — 流式]
│
│ POST /v1/messages { model, system, messages, tools, stream: true }
│
│ ┌─ SSE 流 ──────────────────────────────────┐
│ │ content_block_start: { type: "text" }      │
│ │ content_block_delta: "我来帮你..."          │  → UI 实时显示文字
│ │ content_block_stop                          │
│ │ content_block_start: { type: "tool_use",   │
│ │   name: "Read", id: "tool_1" }             │
│ │ content_block_delta: { input: {             │
│ │   file_path: "package.json" } }            │
│ │ content_block_stop                          │
│ │ message_stop: { stop_reason: "tool_use" }  │
│ └────────────────────────────────────────────┘
│
▼ [QueryEngine: 检测到 stop_reason = "tool_use"]
│
│ 提取工具调用: Read({ file_path: "package.json" })
│
▼ [权限检查]
│
│ Read.checkPermissions() → { behavior: 'allow' }  (只读工具自动通过)
│ Read.isConcurrencySafe() → true  (可以并行)
│
▼ [工具执行]
│
│ Read.call({ file_path: "package.json" })
│ → Bun.file("package.json").text()
│ → 返回文件内容
│
▼ [QueryEngine: 追加 tool_result 到消息历史]
│
│ messages.push({
│   role: "user",
│   content: [{ type: "tool_result", tool_use_id: "tool_1", content: "{...}" }]
│ })
│
▼ [QueryEngine: 再次调用 Claude API — 第二轮]
│
│ Claude 看到了 package.json 的内容，决定编辑它
│
│ ┌─ SSE 流 ──────────────────────────────────┐
│ │ text: "package.json 中还没有 test script..." │
│ │ tool_use: Edit({ file_path: "package.json", │
│ │   old_string: "\"scripts\": {",              │
│ │   new_string: "\"scripts\": {\n    \"test\"..."│
│ │ })                                           │
│ │ message_stop: { stop_reason: "tool_use" }    │
│ └──────────────────────────────────────────────┘
│
▼ [权限检查 — Edit 需要用户确认]
│
│ Edit.isReadOnly() → false  (写操作)
│ 权限模式 = default → 弹出确认对话框
│
▼ [UI: 显示权限确认对话框]
│
│ ┌─────────────────────────────────────┐
│ │ Claude wants to edit package.json   │
│ │                                     │
│ │   "scripts": {                      │
│ │ +   "test": "bun test",            │
│ │     ...                             │
│ │                                     │
│ │ [Allow] [Deny] [Always Allow Edit]  │
│ └─────────────────────────────────────┘
│
│ 用户点击 [Allow]
│
▼ [工具执行]
│
│ Edit.call({ file_path, old_string, new_string })
│ → 精确替换文件内容
│ → 返回 "文件已更新"
│
▼ [QueryEngine: 追加结果，第三轮调用]
│
│ Claude 看到编辑成功，给出最终回答
│
│ ┌─ SSE 流 ──────────────────────────────────┐
│ │ text: "已经为你添加了 test script..."       │
│ │ message_stop: { stop_reason: "end_turn" }  │  ← 对话结束！
│ └──────────────────────────────────────────────┘
│
▼ [REPL.tsx: 渲染最终响应]
│
│ 用户看到完整的回答和操作记录 ✨
```

## 4.2 模块间的数据流

```
┌──────────┐     ┌───────────┐     ┌──────────┐     ┌──────────┐
│  REPL    │────►│ QueryEngine│────►│ Claude   │────►│ Tool     │
│ (UI层)   │◄────│ (引擎层)   │◄────│  API     │     │ 执行     │
└──────────┘     └───────────┘     └──────────┘     └──────────┘
     │                │                                    │
     │                │                                    │
     ▼                ▼                                    ▼
┌──────────┐     ┌───────────┐                      ┌──────────┐
│ AppState │     │ 消息历史   │                      │ 文件系统 │
│ (状态)   │     │ (持久化)   │                      │ (副作用) │
└──────────┘     └───────────┘                      └──────────┘
```

## 4.3 错误处理策略

每一层都有自己的错误处理：

```
层级              错误类型              处理方式
────              ────────              ────────
UI 层             渲染异常              ErrorBoundary 捕获，显示错误信息
                  输入解析失败          提示用户重新输入

引擎层            API 调用失败          重试 + 降级模型
                  Token 超出限制        触发对话压缩 (compact)
                  预算超出              停止对话，通知用户

工具层            权限被拒绝            返回拒绝信息给 Claude
                  执行超时              终止进程，返回超时错误
                  工具抛异常            捕获异常，返回错误信息

服务层            MCP 服务器断线        自动重连 + 工具降级
                  网络错误              指数退避重试
                  认证过期              刷新 Token
```

## 4.4 并发模型

```
单个 QueryEngine 循环内的并发：

  API 调用（串行，一次只有一个）
      │
      ▼
  响应解析 → 提取 N 个工具调用
      │
      ├── Read("file1.ts")  ─────┐
      ├── Read("file2.ts")  ─────┤  并行执行！
      ├── Grep("pattern")   ─────┤  (都是 concurrencySafe)
      │                          │
      │   等待全部完成...         │
      │ ◄────────────────────────┘
      │
      ├── Bash("npm test")  ─────┐  串行执行！
      │   等待完成...             │  (Bash 不是 concurrencySafe)
      │ ◄────────────────────────┘
      │
      ├── Edit("file1.ts")  ─────┐  串行执行！
      │   等待完成...             │
      │ ◄────────────────────────┘
      │
      ▼
  收集所有 tool_result，继续下一轮
```

## 4.5 会话持久化

```
每次对话都会被持久化到磁盘：

~/.claude/sessions/
├── session_abc123.json     ← 完整的消息历史
├── session_def456.json
└── ...

持久化时机：
1. 每个 API 调用完成后
2. 每个工具执行完成后
3. 用户 Ctrl+C 中断时
4. 对话压缩后

恢复时机：
1. /resume 命令
2. --continue 参数
3. Teleport 解包后
```

## 4.6 本章总结

完整的系统集成涉及以下层面：

| 集成层面 | 参与模块 | 协作方式 |
|----------|----------|----------|
| 请求处理 | REPL → QueryEngine → API → Tool | 同步管线 |
| 状态同步 | AppState → React Context → Components | 不可变更新 |
| 错误恢复 | 每层独立处理，向上冒泡 | try/catch + 降级 |
| 并发控制 | concurrencySafe 标记 | Promise.all / 串行 |
| 持久化 | 消息历史 → 磁盘 JSON | 关键点写入 |

下一章是最后一章——站在最高处，回望整个系统。

→ [第五章：全景视角 — 回望整个系统](05-full-picture.md)
