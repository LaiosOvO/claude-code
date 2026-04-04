# uds 模块阅读笔记

## 文件列表

```
src/uds/
├── index.ts           # 统一导出
├── types.ts           # 消息类型、配置、对端信息
├── inboxProtocol.ts   # 线路协议（帧编码/解码）
├── inboxRegistry.ts   # 对端注册表（连接追踪、僵尸清理）
├── inboxServer.ts     # 服务端（消息路由、离线缓冲、心跳）
└── inboxClient.ts     # 客户端（连接管理、自动重连、请求-响应）
```

## 核心功能

UDS Inbox 模块用 **Unix Domain Socket** 实现跨 Claude Code 会话的实时消息传递，替代文件轮询方案。

架构采用**星型拓扑**——所有客户端只与中心服务端通信：
- 单播/广播消息路由
- 离线消息缓冲（FIFO 淘汰，上限 100 条）
- 心跳检测 + 僵尸连接清理
- 请求-响应模式（基于 replyTo 关联）

## 关键代码片段

帧协议——4 字节大端序长度前缀解决粘包拆包：

```typescript
export function encodeFrame(msg: InboxMessage): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(msg), 'utf-8')
  const frame = Buffer.alloc(4 + jsonBytes.length)
  frame.writeUInt32BE(jsonBytes.length, 0)  // 网络字节序
  jsonBytes.copy(frame, 4)
  return frame
}
```

有状态帧读取器——缓冲区累积 + 逐帧提取：

```typescript
export function createFrameReader(): FrameReader {
  let buffer = Buffer.alloc(0)
  return {
    push(chunk: Buffer): InboxMessage[] {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        const result = decodeFrame(buffer)
        if (result === null) break
        messages.push(result.message)
        buffer = buffer.subarray(result.bytesConsumed)
      }
    }
  }
}
```

## 设计亮点

1. **协议教科书**：`inboxProtocol.ts` 逐行注释 length-prefix framing 的每个细节
2. **GenericSocket 抽象**：兼容 Node.js 和 Bun 的 socket 实现
3. **控制平面分离**：register/ping/listPeers 由服务端内部处理，不转发给客户端
4. **全中文注释**：类比酒店登记簿解释注册表，适合网络编程入门学习
