# server 模块阅读笔记

## 文件列表

```
src/server/
├── backends/              # 后端实现（子目录）
├── server.ts              # 服务端入口（stub）
├── types.ts               # 核心类型定义
├── sessionManager.ts      # 会话管理器（stub）
├── directConnectManager.ts # 直连会话管理器（WebSocket）
├── createDirectConnectSession.ts # 创建直连会话
├── connectHeadless.ts     # 无头连接（stub）
├── lockfile.ts            # 服务锁文件管理
├── parseConnectUrl.ts     # 连接 URL 解析
├── serverBanner.ts        # 服务启动横幅
└── serverLog.ts           # 服务日志
```

## 核心功能

server 模块实现了 Claude Code 的**远程服务模式**——通过 HTTP/WebSocket 协议在本地或远程暴露 Claude 会话，允许其他客户端连接和控制。

主要能力：
- 启动 HTTP 服务器并管理多个并发会话
- 通过 WebSocket 进行实时双向通信（SDK 消息格式）
- 权限请求的远程代理和响应
- 会话持久化索引，支持跨重启恢复（`SessionIndexEntry`）
- 锁文件机制防止多实例冲突

## 关键代码片段

`DirectConnectSessionManager` 是唯一有完整实现的核心类，负责 WebSocket 通信：

```typescript
// 消息过滤：只转发业务消息，跳过控制帧和内部类型
if (parsed.type === 'control_request') {
  if (parsed.request.subtype === 'can_use_tool') {
    this.callbacks.onPermissionRequest(parsed.request, parsed.request_id)
  }
  continue
}
```

会话创建通过 HTTP POST 创建，使用 Zod 校验响应：

```typescript
const result = connectResponseSchema().safeParse(await resp.json())
```

## 类型体系

- `ServerConfig`：服务配置（port/host/authToken/unix/idleTimeoutMs/maxSessions/workspace）
- `SessionState`：五态状态机（starting -> running -> detached -> stopping -> stopped）
- `SessionInfo`：会话运行时信息（id/status/createdAt/workDir/process）
- `SessionIndexEntry`：持久化索引条目（sessionId/transcriptSessionId/cwd/permissionMode）
- `DirectConnectConfig`：WebSocket 连接配置（serverUrl/sessionId/wsUrl/authToken）

## 设计亮点

1. **类型驱动**：`ServerConfig` 支持 TCP/Unix socket 双模式监听，`SessionState` 用状态机管理会话生命周期
2. **安全设计**：Bearer Token 认证、idle 超时、最大会话数限制
3. **容错处理**：`DirectConnectSessionManager` 对未知控制请求子类型自动回复 error，防止服务端挂起等待
4. **索引持久化**：`SessionIndex` 通过 `~/.claude/server-sessions.json` 实现会话跨重启恢复
5. **中断支持**：`sendInterrupt()` 通过 WebSocket 发送 control_request 中断正在执行的请求
