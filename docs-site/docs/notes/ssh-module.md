# ssh 模块阅读笔记

## 文件列表

```
src/ssh/
├── createSSHSession.ts    # SSH 会话创建
└── SSHSessionManager.ts   # SSH 会话管理器接口
```

## 核心功能

ssh 模块定义了**通过 SSH 连接远程 Claude Code 实例**的接口。当前为 stub 实现，抛出 "not supported in this build" 错误。

接口设计包含：
- `SSHSession`：远程 cwd、子进程、认证代理、stderr 日志
- `SSHSessionManager`：连接管理、消息发送、中断、权限响应
- `SSHAuthProxy`：SSH 认证代理（端口转发）
- `SSHPermissionRequest`：远程权限请求（工具名、输入、建议的权限更新）

## 关键代码片段

SSH 会话接口：

```typescript
export interface SSHSession {
  remoteCwd: string
  proc: Subprocess
  proxy: SSHAuthProxy
  createManager(options: SSHSessionManagerOptions): SSHSessionManager
  getStderrTail(): string
}
```

会话管理器回调契约：

```typescript
export interface SSHSessionManagerOptions {
  onMessage: (sdkMessage: SDKMessage) => void
  onPermissionRequest: (request: SSHPermissionRequest, requestId: string) => void
  onConnected: () => void
  onReconnecting: (attempt: number, max: number) => void
  onDisconnected: () => void
  onError: (error: Error) => void
}
```

## 与 remote 模块的关系

```
ssh 模块: SSH 隧道层 → 建立安全连接
remote 模块: WebSocket 通信层 → 在连接上传输 SDK 消息
server 模块: HTTP 服务层 → 管理远程会话
```

SSH 模块负责最底层的传输通道建立，remote 模块在此之上做消息级通信。

## 设计亮点

1. **自定义错误类**：`SSHSessionError` 继承 Error，便于调用者区分 SSH 特有错误
2. **双入口**：`createSSHSession`（远程）和 `createLocalSSHSession`（本地）两种创建方式
3. **权限建议**：`SSHPermissionRequest` 包含 `permission_suggestions` 字段，远程端可建议权限更新
4. **渐进式重连**：`onReconnecting(attempt, max)` 回调让 UI 展示重连进度
5. **stderr 尾部**：`getStderrTail()` 方法保留 SSH 进程的最后几行错误输出，便于调试
6. **Bun Subprocess**：使用 Bun 的 `Subprocess` 类型管理 SSH 子进程
