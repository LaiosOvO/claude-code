# remote 模块阅读笔记

## 文件列表

```
src/remote/
├── RemoteSessionManager.ts      # 远程会话管理器（WebSocket 连接）
├── remotePermissionBridge.ts    # 权限请求桥接（合成 AssistantMessage）
├── sdkMessageAdapter.ts         # SDK 消息 -> REPL Message 适配器
└── SessionsWebSocket.ts         # WebSocket 连接管理（重连、心跳）
```

## 核心功能

remote 模块实现了**远程会话连接**——本地 REPL 通过 WebSocket 连接到 CCR（Claude Code Remote）容器，接收 SDK 格式消息并转换为本地渲染格式。

核心流程：
- `SessionsWebSocket`：管理 WebSocket 生命周期，最多 5 次重连，30s ping 心跳
- `RemoteSessionManager`：封装会话级操作（发送消息、权限响应、中断）
- `sdkMessageAdapter`：SDK 消息格式 -> 内部 Message 类型的双向转换
- `remotePermissionBridge`：为远程权限请求构造合成的 AssistantMessage

## 关键代码片段

合成权限请求的 AssistantMessage（远程模式没有真实的 assistant 消息）：

```typescript
export function createSyntheticAssistantMessage(
  request: SDKControlPermissionRequest, requestId: string
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      content: [{ type: 'tool_use', id: request.tool_use_id,
                   name: request.tool_name, input: request.input }],
    }
  }
}
```

## 类型定义

```typescript
export type RemotePermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
```

## 设计亮点

1. **永久关闭码**：4003（unauthorized）立即停止重连，4001（session not found）允许 3 次重试（compaction 期间可能瞬时丢失）
2. **类型守卫分层**：`isSDKMessage()` 区分业务消息和控制消息，确保路由正确
3. **proxy 感知**：WebSocket 连接自动检测 mTLS 和代理配置
4. **适配器模式**：`sdkMessageAdapter` 桥接 CCR 后端的 SDK 格式与本地 REPL 的内部类型
5. **合成消息**：远程权限请求没有真实的 AssistantMessage，通过 `createSyntheticAssistantMessage` 构造占位
6. **重连延迟**��2 秒固定间隔，最多 5 次重连尝试
7. **心跳保活**：30 秒 ping 间隔防止空闲连接被中间件关闭

## 与 server/ssh 模块的关系

- **server 模块**：提供 HTTP 服务端，remote 模块是其 WebSocket 客户端
- **ssh 模块**：建立 SSH 隧道，remote 模块在隧道之上做 SDK 消息级通信
