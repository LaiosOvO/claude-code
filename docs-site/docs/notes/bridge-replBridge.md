# 阅读笔记：replBridge.ts

## 文件基本信息
- **路径**: `src/bridge/replBridge.ts`
- **行数**: 2406 行
- **角色**: REPL（交互式会话）与远程控制之间的桥接核心，管理从环境注册到会话创建、工作轮询、传输层管理、断线重连、优雅关闭的完整生命周期

## 核心功能

`replBridge.ts` 是 REPL 模式下远程控制功能的核心实现。与 `bridgeMain.ts`（独立进程的远程控制服务器）不同，这个文件实现的是**嵌入在 REPL 进程内的桥接**——当用户在交互式 CLI 中启用远程控制（`/remote-control`）时，REPL 会话的消息会通过这个桥接同步到 claude.ai/code。

文件有三个主要层次：
1. **`initBridgeCore`**（约1400行）：Bootstrap-free 核心，处理环境注册 → 会话创建 → 工作轮询 → 入站 WebSocket → 消息同步 → 断线重连 → 优雅关闭。所有上下文通过 `BridgeCoreParams` 参数传入，不读取 bootstrap 状态。
2. **`startWorkPollLoop`**（约400行）：后台工作轮询循环，处理 pollForWork、心跳、容量管理、错误恢复、环境重建。
3. **类型定义和句柄接口**：`ReplBridgeHandle`、`BridgeCoreHandle`、`BridgeCoreParams` 等。

## 关键代码解析

### BridgeCoreParams - 显式参数化入口
```typescript
export type BridgeCoreParams = {
  dir: string
  machineName: string
  branch: string
  gitRepoUrl: string | null
  title: string
  baseUrl: string
  sessionIngressUrl: string
  workerType: string
  getAccessToken: () => string | undefined
  createSession: (opts: {...}) => Promise<string | null>
  archiveSession: (sessionId: string) => Promise<void>
  toSDKMessages?: (messages: Message[]) => SDKMessage[]
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  onInboundMessage?: (msg: SDKMessage) => void
  onPermissionResponse?: (response: SDKControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetPermissionMode?: (mode: PermissionMode) => {...}
  onStateChange?: (state: BridgeState, detail?: string) => void
  onUserMessage?: (text: string, sessionId: string) => boolean
  perpetual?: boolean           // 永续模式（daemon 用）
  initialSSESequenceNum?: number // SSE 序列号种子（daemon 恢复用）
  // ... 更多回调
}
```
关键设计：所有依赖都通过参数注入，而非 import。原因在注释中反复解释——避免拉入 `config.ts → file.ts → permissions/filesystem.ts → sessionStorage.ts → commands.ts` 这条重量级依赖链（约1300个模块），这对 Agent SDK bundle 体积至关重要。

### initBridgeCore - 核心初始化
```typescript
export async function initBridgeCore(
  params: BridgeCoreParams,
): Promise<BridgeCoreHandle | null>
```
初始化流程：
1. 读取崩溃恢复指针（perpetual 模式）
2. 创建 API 客户端（ant 用户包装故障注入层）
3. 注册环境 → 获取 environmentId + secret
4. 尝试重连（perpetual + 指针匹配时用 `tryReconnectInPlace`）
5. 创建会话或复用已有会话
6. 写崩溃恢复指针
7. 初始化 UUID 去重集合
8. 启动工作轮询循环
9. 设置传输层回调（connect/data/close）
10. 注册 graceful shutdown 清理
11. 返回 handle 对象

### 传输层选择（v1 vs v2）
```typescript
// onWorkReceived 回调内：
if (useCcrV2) {
  // v2: SSETransport + CCRClient → /v1/code/sessions/{id}/worker/*
  void createV2ReplTransport({
    sessionUrl, ingressToken, sessionId, initialSequenceNum
  }).then(t => wireTransport(t))
} else {
  // v1: HybridTransport (WS reads + POST writes) → Session-Ingress
  wireTransport(createV1ReplTransport(new HybridTransport(...)))
}
```
v2 是异步的（需要 registerWorker 注册），引入了 `v2Generation` 计数器防止过时的握手结果覆盖新的。

### wireTransport - 传输层回调绑定
```typescript
const wireTransport = (newTransport: ReplBridgeTransport): void => {
  transport = newTransport
  newTransport.setOnConnect(() => {
    // 初始消息刷新（首次连接时）
    // 历史消息上限裁剪（initialHistoryCap）
    // 刷新完成后 drain flushGate 并通知 connected
  })
  newTransport.setOnData(data => {
    handleIngressMessage(data, recentPostedUUIDs, recentInboundUUIDs, ...)
  })
  newTransport.setOnClose(closeCode => {
    handleTransportPermanentClose(closeCode)
  })
  newTransport.connect()
}
```

### reconnectEnvironmentWithSession - 断线重连
```typescript
async function doReconnect(): Promise<boolean>
```
两阶段重连策略：
1. **Strategy 1（reconnect-in-place）**：用 reuseEnvironmentId 重新注册 → 如果后端返回相同 envId，调用 reconnectSession 重新排队。会话ID 不变，移动端 URL 保持有效。
2. **Strategy 2（fresh session）**：如果后端返回不同 envId（原环境 TTL 过期），归档旧会话 → 在新环境上创建新会话。清除 previouslyFlushedUUIDs 以重发初始消息。

重连保护：最多 3 次重连尝试（`MAX_ENVIRONMENT_RECREATIONS`），成功后重置计数器。多个并发重连通过 `reconnectPromise` 合并为单次操作。

### handleTransportPermanentClose - 传输永久关闭
```typescript
function handleTransportPermanentClose(closeCode: number | undefined): void
```
- code 1000（正常关闭）→ 会话结束，teardown
- 其他代码 → 传输重连预算耗尽或永久拒绝，触发 `reconnectEnvironmentWithSession`
- 唤醒轮询循环（`wakePollLoop`），重置 flushGate

### writeMessages - 消息发送
```typescript
writeMessages(messages) {
  // 1. 过滤：isEligibleBridgeMessage + initialMessageUUIDs + recentPostedUUIDs
  // 2. 标题派生：extractTitleText → onUserMessage
  // 3. flushGate 检查：初始刷新期间排队
  // 4. 回声标记：recentPostedUUIDs.add
  // 5. 转换：toSDKMessages
  // 6. 发送：transport.writeBatch
}
```

### teardown - 优雅关闭
```typescript
doTeardownImpl = async (): Promise<void> => {
  // 清理定时器（pointer refresh, keepAlive, SIGUSR2）
  // abort 轮询循环
  // perpetual 模式：只关闭本地，不通知服务器
  // 非 perpetual 模式：
  //   发送 result 消息 → stopWork + archiveSession（并行）
  //   → 关闭传输 → 注销环境 → 清除崩溃恢复指针
}
```
perpetual 模式的 teardown 是"只关闭本地"——不发 result、不 stopWork、不关传输。让服务器通过工作项租约超时（300秒 TTL）自动回收。下次 daemon 启动读指针即可恢复。

## 数据流

```
REPL 消息循环（useConversation hook）
      ↓ messages 数组变化
handle.writeMessages(messages)
      ↓ 过滤 → 去重 → flushGate → toSDKMessages
      ↓
transport.writeBatch(events)   // POST to Session-Ingress 或 CCR
      ↓
      ↓ 同时：
      ↓
transport.onData()             // WS 或 SSE 入站
      ↓
handleIngressMessage()
      ↓ 解析 + 回声过滤 + 重投去重
      ↓
onInboundMessage(sdkMsg)       // 触发 REPL 处理用户输入
```

```
startWorkPollLoop() 后台循环
      ↓
pollForWork() → null（无工作）→ sleep
      ↓ 或
pollForWork() → WorkResponse → decodeWorkSecret
      ↓
acknowledgeWork()
      ↓
onWorkReceived(sessionId, token, workId, useCcrV2)
      ↓
wireTransport(v1 或 v2 传输) → connect → setOnConnect → flush
```

## 与其他模块的关系

**依赖**:
- `bridgeApi.ts` → API 客户端
- `bridgeMessaging.ts` → 消息处理工具
- `replBridgeTransport.ts` → 传输层创建（v1/v2）
- `HybridTransport.ts` → v1 WebSocket+POST 混合传输
- `workSecret.ts` → JWT 解码/URL 构建/worker 注册
- `sessionIdCompat.ts` → ID 格式转换
- `bridgePointer.ts` → 崩溃恢复指针
- `capacityWake.ts` → 容量释放信号
- `flushGate.ts` → 初始刷新期间的消息排队
- `bridgeDebug.ts` → 故障注入（ant-only）
- `pollConfigDefaults.ts` → 轮询间隔默认值
- `sessionIngressAuth.ts` → 会话入口认证令牌
- `cleanupRegistry.ts` → graceful shutdown 清理注册

**被依赖**:
- `useReplBridge.ts`（React hook）→ 调用 `initBridgeCore` 并将 handle 暴露给 UI
- daemon 调用方 → 直接使用 `initBridgeCore` + `BridgeCoreParams`

## 设计亮点与思考

1. **依赖注入隔离 bundle 体积**：几乎所有重量级依赖（auth、config、commands、messages）都通过回调参数注入。注释详细说明了每个注入的原因——都是为了避免 Agent SDK bundle 拉入 REPL 的完整命令注册树。

2. **双阶段重连策略**：先尝试就地重连（保留会话ID和URL），失败再创建新会话。这对用户体验至关重要——移动端用户不希望 URL 失效。

3. **FlushGate 有序消息投递**：初始历史消息刷新期间，新到达的 writeMessages 调用被排队。刷新完成后按顺序 drain。防止新消息与历史消息在服务器端交错。

4. **SSE 序列号跨传输保持**：`lastTransportSequenceNum` 在传输切换时保存高水位标记，新传输从断点续传而非从 0 重放。特别注意了多处需要更新此值的时机（close 回调、手动关闭、teardown）。

5. **v2Generation 竞态保护**：异步的 v2 握手可能有两个并发进行。generation 计数器确保只有最新一次的结果被采纳，过时的传输被丢弃。

## 要点总结

1. **`initBridgeCore` 是 REPL 远程控制的核心**，约1400行，管理环境注册 → 会话创建 → 工作轮询 → 传输层 → 消息同步 → 断线重连 → teardown。
2. **双阶段重连**：reconnect-in-place（就地恢复，保持会话ID）→ fresh session（新会话，老会话归档）。最多3次尝试。
3. **v1/v2 传输分支**：v1 用 HybridTransport（WS+POST），v2 用 SSETransport+CCRClient。认证方式不同——v1 用 OAuth，v2 必须用 JWT。
4. **perpetual 模式** teardown 只关本地不通知服务器，工作项通过 300s TTL 自动回收，崩溃恢复指针跨进程存活。
5. **消息去重三层防线**：initialMessageUUIDs（初始消息）→ recentPostedUUIDs（回声过滤）→ recentInboundUUIDs（重投去重），加上 SSE 序列号和 flushGate 保序。
