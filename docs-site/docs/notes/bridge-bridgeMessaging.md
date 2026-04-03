# 阅读笔记：bridgeMessaging.ts

## 文件基本信息
- **路径**: `src/bridge/bridgeMessaging.ts`
- **行数**: 461 行
- **角色**: Bridge 传输层的共享消息处理工具库，从 `replBridge.ts` 提取出来供多种桥接核心复用

## 核心功能

`bridgeMessaging.ts` 是一个纯函数工具库，提供了 Bridge 系统中消息解析、路由、去重和控制请求处理的核心逻辑。文件注释强调"Everything here is pure"——所有函数都不持有桥接状态，而是通过参数接收协作对象。

文件分为五个功能区块：
1. **类型守卫**（Type guards）：判断 WebSocket 消息是否为 SDK 消息、控制响应或控制请求
2. **消息过滤**（`isEligibleBridgeMessage`）：决定哪些内部消息应该转发到桥接传输层
3. **标题提取**（`extractTitleText`）：从用户消息中提取会话标题
4. **入站路由**（`handleIngressMessage`）：解析入站 WebSocket 消息并路由到对应处理器
5. **控制请求处理**（`handleServerControlRequest`）：响应服务器发来的控制指令
6. **去重数据结构**（`BoundedUUIDSet`）：环形缓冲区实现的有界 UUID 集合

## 关键代码解析

### isEligibleBridgeMessage - 消息过滤
```typescript
export function isEligibleBridgeMessage(m: Message): boolean {
  // 虚拟消息（REPL内部调用）是仅显示用的——桥接/SDK消费者看到的是
  // REPL的tool_use/result（总结了工作内容）
  if ((m.type === 'user' || m.type === 'assistant') && m.isVirtual) {
    return false
  }
  return (
    m.type === 'user' ||
    m.type === 'assistant' ||
    (m.type === 'system' && m.subtype === 'local_command')
  )
}
```
只有用户消息、助手消息和斜杠命令系统消息才转发到桥接传输层。tool_result、progress 等内部消息不转发。

### extractTitleText - 标题提取
```typescript
export function extractTitleText(m: Message): string | undefined {
  if (m.type !== 'user' || m.isMeta || m.toolUseResult || m.isCompactSummary)
    return undefined
  if (m.origin && m.origin.kind !== 'human') return undefined
  // ... 提取文本内容并清除 display tags
}
```
过滤条件非常严格：只从真正的用户输入（非 meta、非工具结果、非压缩摘要、非机器来源）中提取标题。清除 `<ide_opened_file>` 等 display tags 后的空内容返回 undefined。

### handleIngressMessage - 入站消息路由
```typescript
export function handleIngressMessage(
  data: string,
  recentPostedUUIDs: BoundedUUIDSet,   // 我们发出的消息 UUID（回声过滤）
  recentInboundUUIDs: BoundedUUIDSet,  // 已处理的入站 UUID（防重投）
  onInboundMessage,
  onPermissionResponse?,
  onControlRequest?,
): void
```
路由逻辑按优先级：
1. `control_response` → `onPermissionResponse`（不是 SDKMessage，先检查）
2. `control_request` → `onControlRequest`（必须及时响应，否则服务器10-14秒后断连）
3. SDKMessage + UUID 回声过滤 → 忽略自己发出的消息
4. SDKMessage + UUID 重投去重 → 忽略已处理的入站消息
5. `user` 类型 → `onInboundMessage`（fire-and-forget，handler 可能是异步的）
6. 其他类型 → 忽略并记录日志

### handleServerControlRequest - 控制请求处理
```typescript
export function handleServerControlRequest(
  request: SDKControlRequest,
  handlers: ServerControlRequestHandlers,
): void
```
处理服务器发来的控制指令：

| 子类型 | 行为 |
|--------|------|
| `initialize` | 返回最小化的 capabilities（空命令列表、normal 输出样式） |
| `set_model` | 调用 `onSetModel` 回调 |
| `set_max_thinking_tokens` | 调用 `onSetMaxThinkingTokens` 回调 |
| `set_permission_mode` | 调用 `onSetPermissionMode`，根据返回值决定 success/error |
| `interrupt` | 调用 `onInterrupt` 回调 |
| 未知 | 返回 error 响应（防止服务器挂起） |

**outbound-only 模式**：当 `outboundOnly` 为 true 时，除 `initialize` 外所有请求返回错误（"This session is outbound-only"）。initialize 仍然成功——否则服务器会杀掉连接。

### makeResultMessage - 会话归档信号
```typescript
export function makeResultMessage(sessionId: string): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 0,
    // ... 最小化字段
    session_id: sessionId,
    uuid: randomUUID(),
  }
}
```
构建一个最小化的 result 消息，在 WebSocket 关闭前发送给服务器以触发会话归档。

### BoundedUUIDSet - 有界 UUID 集合
```typescript
export class BoundedUUIDSet {
  private readonly ring: (string | undefined)[]
  private readonly set = new Set<string>()
  private writeIdx = 0

  add(uuid: string): void {
    if (this.set.has(uuid)) return
    const evicted = this.ring[this.writeIdx]
    if (evicted !== undefined) this.set.delete(evicted)
    this.ring[this.writeIdx] = uuid
    this.set.add(uuid)
    this.writeIdx = (this.writeIdx + 1) % this.capacity
  }
}
```
FIFO 环形缓冲区实现。容量固定后内存使用恒定 O(capacity)。按时间顺序驱逐最旧的条目。用于两个场景：
1. 回声过滤（`recentPostedUUIDs`）：识别服务器回弹的我们发出的消息
2. 重投去重（`recentInboundUUIDs`）：识别服务器重新投递的已处理消息

## 数据流

```
WebSocket 入站数据（JSON 字符串）
      ↓
handleIngressMessage()
      ↓ normalizeControlMessageKeys + jsonParse
      ↓
  ┌─── isSDKControlResponse? → onPermissionResponse
  ├─── isSDKControlRequest?  → handleServerControlRequest
  │         ↓                      ↓
  │    switch(subtype)        transport.write(response)
  │
  └─── isSDKMessage?
        ↓ UUID 回声检查（recentPostedUUIDs）
        ↓ UUID 重投检查（recentInboundUUIDs）
        ↓ 类型检查（只处理 'user'）
        ↓
   onInboundMessage(parsed)
```

```
内部 Message 对象
      ↓
isEligibleBridgeMessage() → 过滤虚拟消息和非转发类型
      ↓
extractTitleText() → 从 user 消息中提取标题文本
      ↓
传输层发送到服务器
```

## 与其他模块的关系

**依赖**:
- `agentSdkTypes.ts` → SDKMessage 类型定义
- `sdk/controlTypes.ts` → SDKControlRequest / SDKControlResponse
- `sdk/coreTypes.ts` → SDKResultSuccess
- `emptyUsage.ts` → EMPTY_USAGE 常量
- `controlMessageCompat.ts` → 控制消息字段名归一化
- `displayTags.ts` → 清除 display 标签
- `replBridgeTransport.ts` → ReplBridgeTransport 类型
- `PermissionMode.ts` → 权限模式类型

**被依赖**:
- `replBridge.ts` → 导入所有核心函数用于 REPL 桥接
- `bridgeMain.ts` → 间接使用（通过 replBridge）

## 设计亮点与思考

1. **纯函数设计**：所有函数都不持有状态，通过参数接收所有协作对象。这使得同一套逻辑可以被 env-based core（`initBridgeCore`）和 env-less core（`initEnvLessBridgeCore`）共享。

2. **双层去重机制**：
   - 主要去重：hook 的 `lastWrittenIndexRef`（基于索引的跟踪）
   - 安全网去重：`BoundedUUIDSet`（回声过滤 + 重投去重）
   - SSE 序列号：`lastTransportSequenceNum`（传输层主要修复）
   这种多层防御确保了在各种边缘情况下消息不会重复。

3. **outbound-only 模式**：一个简洁的设计，让只能发送不能接收的桥接模式也能正确响应控制请求——initialize 必须成功（否则被杀），其他操作返回明确的错误消息。

4. **环形缓冲区（BoundedUUIDSet）**：相比简单的 Set + 定期清理，环形缓冲区提供了 O(1) 的 add/has/evict 操作，内存使用完全可预测，非常适合长期运行的桥接进程。

## 要点总结

1. **纯函数工具库**，从 replBridge.ts 提取出来供多种桥接核心复用，不持有任何状态。
2. **三类消息路由**：control_response → 权限处理器，control_request → 控制请求处理器（必须及时回复），user → REPL 入站处理器。
3. **双层去重**：`recentPostedUUIDs` 过滤回声，`recentInboundUUIDs` 防止重投。`BoundedUUIDSet` 用环形缓冲区实现 O(capacity) 固定内存。
4. **handleServerControlRequest** 响应 5 种控制指令，outbound-only 模式下只允许 initialize 成功。
5. **isEligibleBridgeMessage** 严格过滤，只转发 user/assistant/local_command，排除虚拟消息和工具结果。
