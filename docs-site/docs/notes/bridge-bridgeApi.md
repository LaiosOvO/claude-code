# 阅读笔记：bridgeApi.ts

## 文件基本信息
- **路径**: `src/bridge/bridgeApi.ts`
- **行数**: 539 行
- **角色**: Bridge 系统的 HTTP API 客户端封装层，提供与 Anthropic 后端通信的所有 REST 接口

## 核心功能

`bridgeApi.ts` 封装了 Bridge 系统与 Anthropic 服务器之间的所有 HTTP 交互。它通过工厂函数 `createBridgeApiClient` 创建一个实现了 `BridgeApiClient` 接口的对象，提供环境注册、工作轮询、心跳、停止工作等操作。

文件的设计原则是"安全第一"：所有路径参数都经过 `validateBridgeId` 安全校验防止路径遍历注入；所有认证失败（401）都有一次自动刷新重试机会；所有错误都被分类为致命（不可重试）和非致命（可重试）两类。

## 关键代码解析

### validateBridgeId - 路径安全验证
```typescript
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

export function validateBridgeId(id: string, label: string): string {
  if (!id || !SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${label}: contains unsafe characters`)
  }
  return id
}
```
防止服务器返回的 ID 包含 `../` 等路径遍历字符，被直接拼入 URL 后造成注入攻击。所有 API 方法在使用 ID 前都调用此函数。

### BridgeFatalError - 致命错误分类
```typescript
export class BridgeFatalError extends Error {
  readonly status: number
  readonly errorType: string | undefined
  constructor(message: string, status: number, errorType?: string) { ... }
}
```
封装了不应重试的 HTTP 错误（401/403/404/410）。上层 `runBridgeLoop` 捕获此错误后直接退出轮询循环。

### withOAuthRetry - OAuth 令牌自动刷新
```typescript
async function withOAuthRetry<T>(
  fn: (accessToken: string) => Promise<{ status: number; data: T }>,
  context: string,
): Promise<{ status: number; data: T }>
```
核心模式：执行请求 → 401? → 调用 `onAuth401` 刷新令牌 → 用新令牌重试一次。这是一个通用包装器，被 `registerBridgeEnvironment`、`stopWork`、`deregisterEnvironment`、`archiveSession`、`reconnectSession` 使用。`pollForWork` 和 `acknowledgeWork` 不使用（它们用 environmentSecret/sessionToken 认证，不是 OAuth）。

### 核心 API 方法

| 方法 | HTTP | 路径 | 认证 | 用途 |
|------|------|------|------|------|
| `registerBridgeEnvironment` | POST | `/v1/environments/bridge` | OAuth | 注册环境，获取 ID 和 secret |
| `pollForWork` | GET | `.../work/poll` | envSecret | 轮询待处理工作项 |
| `acknowledgeWork` | POST | `.../work/{id}/ack` | sessionToken | 确认接收工作项 |
| `stopWork` | POST | `.../work/{id}/stop` | OAuth | 通知服务器工作完成 |
| `deregisterEnvironment` | DELETE | `.../bridge/{id}` | OAuth | 注销环境（下线） |
| `archiveSession` | POST | `/v1/sessions/{id}/archive` | OAuth | 归档会话 |
| `reconnectSession` | POST | `.../bridge/reconnect` | OAuth | 重新排队断开的会话 |
| `heartbeatWork` | POST | `.../work/{id}/heartbeat` | sessionToken | 延长工作项租约 |
| `sendPermissionResponseEvent` | POST | `/v1/sessions/{id}/events` | sessionToken | 发送权限响应事件 |

### handleErrorStatus - 统一错误处理
```typescript
function handleErrorStatus(status: number, data: unknown, context: string): void
```
将 HTTP 状态码映射为语义化错误：
- 200/204 → 正常
- 401 → `BridgeFatalError`（认证失败）
- 403 → `BridgeFatalError`（过期或权限不足）
- 404 → `BridgeFatalError`（未找到）
- 410 → `BridgeFatalError`（环境已过期）
- 429 → 普通 `Error`（限流，可重试）
- 其他 → 普通 `Error`

### isSuppressible403 - 可抑制的 403 错误
```typescript
export function isSuppressible403(err: BridgeFatalError): boolean {
  return err.message.includes('external_poll_sessions') ||
         err.message.includes('environments:manage')
}
```
某些 403 错误（如 `external_poll_sessions` 权限范围、`environments:manage` 操作权限）不影响核心功能，不应展示给用户。

## 数据流

```
调用方（bridgeMain / replBridge）
      ↓
createBridgeApiClient({ baseUrl, getAccessToken, ... })
      ↓ 返回 BridgeApiClient 对象
api.registerBridgeEnvironment(config)
      ↓ POST /v1/environments/bridge
      ↓ → withOAuthRetry → getHeaders(token) → axios.post
      ↓ → handleErrorStatus 检查响应
      ↓ 返回 { environment_id, environment_secret }
      ↓
api.pollForWork(envId, envSecret)
      ↓ GET .../work/poll（不走 withOAuthRetry，用 envSecret）
      ↓ → 返回 WorkResponse | null
      ↓
api.heartbeatWork(envId, workId, sessionToken)
      ↓ POST .../work/{id}/heartbeat（用 sessionToken）
      ↓ → 返回 { lease_extended, state }
```

## 与其他模块的关系

**依赖**:
- `axios` → HTTP 客户端
- `debugUtils.ts` → 调试日志格式化
- `types.ts` → `BridgeApiClient` 接口、`BridgeConfig` 类型、`WorkResponse`

**被依赖**:
- `bridgeMain.ts` → 创建 API 客户端用于主循环
- `replBridge.ts` → 创建 API 客户端用于 REPL 桥接
- 上层代码通过 `BridgeFatalError` 做错误分类决策

## 设计亮点与思考

1. **工厂模式 + 闭包**：`createBridgeApiClient` 通过闭包封装了认证状态、调试回调和连续空轮询计数器。调用方拿到的是一个纯方法对象，不需要关心内部状态。

2. **空轮询日志抑制**：`consecutiveEmptyPolls` 计数器只在第1次和每100次空轮询时打印日志，避免调试日志被无意义的 "no work" 消息淹没。

3. **认证分层设计**：不同 API 使用不同认证方式——注册/停止/归档用 OAuth（长期令牌），轮询/确认/心跳用 environmentSecret 或 sessionToken（短期 JWT）。这反映了后端的安全架构。

4. **路径遍历防护**：`validateBridgeId` 是一个轻量但关键的安全措施。即使服务器返回恶意 ID，客户端也不会将其拼入危险的 URL 路径。

5. **409 幂等处理**：`archiveSession` 将 409（已归档）视为成功而非错误。这是幂等 API 设计的客户端对应实现，确保重复归档不会引起不必要的错误日志。

## 要点总结

1. **`createBridgeApiClient` 是整个 Bridge HTTP 通信的唯一出口**，封装了 9 个 REST 方法，统一处理认证、错误分类和调试日志。
2. **OAuth 自动刷新（`withOAuthRetry`）** 让需要长期令牌的操作（注册/停止/归档）自动处理 401 重试。
3. **`BridgeFatalError` 区分了可重试和不可重试的错误**，401/403/404/410 直接中断轮询循环，429 和其他错误走退避重试。
4. **路径安全（`validateBridgeId`）** 防止服务器返回的 ID 被用于路径遍历攻击。
5. **空轮询日志抑制**（每100次打印一次）和可抑制的 403 错误避免了日志噪音。
