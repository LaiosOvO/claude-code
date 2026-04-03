# 模块说明：远程桥接 (Bridge)

## 概述

Bridge 模块实现了 claude-code-best 的远程控制能力 -- 让用户可以从手机、网页（claude.ai）或其他设备操控本地运行的 `ccb`。它是整个代码库中规模最大的子系统之一，共 34 个文件、约 13000 行代码，支持独立桥接、REPL 内嵌桥接和本地桥接三种模式。

---

## 核心文件

| 文件 | 作用 | 行数 |
|------|------|------|
| `src/bridge/bridgeMain.ts` | 独立桥接入口（`ccb remote-control`） | 2999 |
| `src/bridge/replBridge.ts` | REPL 内嵌桥接（与 TUI 集成） | 2406 |
| `src/bridge/localBridge.ts` | 本地桥接（无需云端中继） | 344 |
| `src/bridge/remoteBridgeCore.ts` | 远程桥接核心逻辑（轮询 + 会话管理） | 1008 |
| `src/bridge/sessionRunner.ts` | 会话执行器（spawn 子进程处理工作） | 550 |
| `src/bridge/bridgeApi.ts` | REST API 客户端（环境注册、轮询、心跳） | 539 |
| `src/bridge/initReplBridge.ts` | REPL 桥接初始化 + 激活逻辑 | 569 |
| `src/bridge/bridgeUI.ts` | 桥接 UI 组件（状态显示、连接信息） | 530 |
| `src/bridge/bridgeMessaging.ts` | 消息路由 + 控制请求处理 | 462 |
| `src/bridge/replBridgeTransport.ts` | 传输层抽象（统一 v1/v2 协议） | 370 |
| `src/bridge/createSession.ts` | 会话创建逻辑 | 384 |
| `src/bridge/jwtUtils.ts` | JWT Token 工具 | 256 |
| `src/bridge/bridgePointer.ts` | Bridge 指针（环境 ID 解析） | 210 |
| `src/bridge/trustedDevice.ts` | 可信设备管理 | 210 |
| `src/bridge/bridgeEnabled.ts` | Feature gate + 最低版本检查 | 202 |
| `src/bridge/inboundAttachments.ts` | 入站附件处理 | 175 |
| `src/bridge/envLessBridgeConfig.ts` | 无环境变量的桥接配置 | 165 |
| `src/bridge/bridgeStatusUtil.ts` | 状态工具函数 | 163 |
| `src/bridge/codeSessionApi.ts` | Code Session API 客户端 | 168 |
| `src/bridge/bridgeDebug.ts` | 调试工具 | 135 |
| `src/bridge/debugUtils.ts` | 调试辅助函数 | 141 |
| `src/bridge/pollConfig.ts` | 轮询配置 | 110 |
| `src/bridge/pollConfigDefaults.ts` | 轮询默认值 | 82 |
| `src/bridge/inboundMessages.ts` | 入站消息处理 | 80 |
| `src/bridge/flushGate.ts` | 刷新门控（消息批量发送） | 71 |
| `src/bridge/workSecret.ts` | WorkSecret 解码 | 127 |
| `src/bridge/types.ts` | 类型定义 | 262 |
| `src/bridge/bridgeConfig.ts` | 基础配置 | 48 |
| `src/bridge/capacityWake.ts` | 容量唤醒 | 56 |
| `src/bridge/sessionIdCompat.ts` | Session ID 兼容层 | 57 |
| `src/bridge/bridgePermissionCallbacks.ts` | 权限回调接口 | 43 |
| `src/bridge/replBridgeHandle.ts` | REPL 桥接句柄 | 36 |
| `src/cli/transports/` | WebSocket / SSE / Hybrid 传输层 | 目录 |

---

## 架构设计

```
手机 / claude.ai / 其他设备        云端 Server            本地 ccb
+----------+                  +--------------+        +----------------+
| 用户界面  |---WebSocket----->|  消息中继    |--WS--->| bridgeMain.ts  |
|          |                  |              |        |   (独立桥接)    |
| 发消息    |---HTTP POST----->| /v1/sessions |--轮询->| replBridge.ts  |
| 看结果    |<--SSE/WS---------|  /events     |<-推送--| (REPL 内嵌)    |
| 审权限    |                  |              |        |                |
+----------+                  +--------------+        | localBridge.ts |
                                                      |  (本地直连)    |
                                                      +----------------+
```

---

## 三种桥接模式

### 模式 1：独立桥接 (bridgeMain.ts -- 2999 行)

- 用 `ccb remote-control`（别名 `ccb rc` / `ccb bridge`）启动
- 运行 `remoteBridgeCore` 轮询循环，从服务器获取工作
- 收到工作后由 `sessionRunner` 为每个工作项 spawn 独立子进程
- 支持多并发会话，每个会话独立生命周期
- 启动前需通过 OAuth 认证 + GrowthBook gate + 策略限制检查

### 模式 2：REPL 内嵌桥接 (replBridge.ts -- 2406 行)

- 在交互 TUI 中通过 `/remote-control` 命令或配置自动激活
- 不 spawn 子进程，直接在当前会话中处理远程请求
- 通过 `initReplBridge.ts` 初始化，与 AppState 深度集成
- 状态在 footer 中实时显示（连接中 / 已连接 / 重连中）
- 支持 Outbound-only 模式（只推送事件，不接收控制）

### 模式 3：本地桥接 (localBridge.ts -- 344 行)

- 无需云端中继，通过本地通道直接连接
- 适用于同一台机器上的进程间通信
- 轻量级实现，无网络依赖

---

## 传输层

`src/cli/transports/` 目录实现了三种传输协议：

| 传输 | 文件 | 说明 |
|------|------|------|
| WebSocket | `WebSocketTransport.ts` | 全双工，v1 协议 |
| SSE | `SSETransport.ts` | Server-Sent Events，v2 协议下行 |
| Hybrid | `HybridTransport.ts` | SSE（下行）+ HTTP（上行），v2 协议 |
| Base | `Transport.ts` | 传输基类接口 |

`replBridgeTransport.ts` 统一封装 v1（WebSocket）和 v2（SSE+HTTP）协议，对上层透明。

---

## 关键流程

### 独立桥接启动流程

```
ccb remote-control
    |
    v
1. cli.tsx 快速路径命中 (feature BRIDGE_MODE)
2. enableConfigs() -- 加载配置
3. getClaudeAIOAuthTokens() -- OAuth 认证检查
4. getBridgeDisabledReason() -- GrowthBook gate 检查
5. checkBridgeMinVersion() -- 最低版本检查
6. isPolicyAllowed('allow_remote_control') -- 策略限制检查
7. bridgeMain(args) -- 进入主循环
```

### 工作处理流程

```
1. 注册环境    --> POST /v1/environments/bridge
2. 轮询工作    --> GET /v1/environments/{id}/work/poll (长轮询)
3. 获取工作    --> 解码 WorkSecret (含 session token, API URL)
4. 建立连接    --> WebSocket / SSE 连接到会话
5. 消息路由    --> 用户消息 <-> ccb 双向传递
6. 权限处理    --> 工具调用权限请求转发给远程用户
7. 心跳维持    --> 定期 heartbeat 延长 lease
8. 完成清理    --> 归档会话，确认工作
```

### REPL 内嵌桥接状态机

```
disabled --> enabled --> connecting --> connected --> session_active
    ^           |            |             |              |
    |           v            v             v              v
    +-------<---+---<--- reconnecting <----+----<---------+
```

AppState 中的桥接相关字段：

- `replBridgeEnabled` -- 是否启用
- `replBridgeExplicit` -- 是否通过命令显式激活
- `replBridgeOutboundOnly` -- 是否只推送不接收
- `replBridgeConnected` -- 环境已注册 + 会话已创建
- `replBridgeSessionActive` -- 用户已连接（WebSocket 打开）
- `replBridgeReconnecting` -- 轮询在错误退避中
- `replBridgeConnectUrl` -- 连接 URL
- `replBridgeSessionUrl` -- claude.ai 会话 URL

---

## 安全机制

| 机制 | 说明 |
|------|------|
| OAuth 认证 | 必须有有效的 Claude.ai OAuth Token |
| GrowthBook Gate | `getBridgeDisabledReason()` 检查 feature gate |
| 策略限制 | `isPolicyAllowed('allow_remote_control')` 组织级策略 |
| 最低版本 | `checkBridgeMinVersion()` 确保客户端版本足够新 |
| 可信设备 | `trustedDevice.ts` 管理设备信任列表 |
| JWT 校验 | `jwtUtils.ts` 验证服务器下发的 Token |
| 权限转发 | 工具调用的权限审批转发给远程用户确认 |

---

## 设计模式

- **传输抽象**：`ReplBridgeTransport` 统一 v1（WebSocket）和 v2（SSE+HTTP），对上层透明
- **回声去重**：`BoundedUUIDSet` 环形缓冲区去除消息回声
- **指数退避**：连接失败后指数退避重试，避免雪崩
- **序列号续传**：传输切换时通过 sequence number 避免历史重放
- **会话隔离**：独立桥接模式下每个工作项在独立子进程中执行
- **刷新门控**：`flushGate.ts` 批量发送消息，减少网络开销
- **容量唤醒**：`capacityWake.ts` 在资源可用时唤醒等待的工作

---

## 常见问题

**Q: 独立桥接和 REPL 内嵌桥接有什么区别？**
A: 独立桥接（`ccb remote-control`）是一个独立进程，为每个远程会话 spawn 子进程，适合无人值守场景。REPL 内嵌桥接在现有的交互式 TUI 中激活，共用当前会话，适合边工作边接受远程协助。

**Q: 本地桥接的使用场景是什么？**
A: 本地桥接用于同一台机器上的进程间通信，例如 Daemon Worker 与主进程之间的消息传递，无需经过云端中继。

**Q: Bridge 支持哪些传输协议？**
A: v1 使用纯 WebSocket（全双工），v2 使用 Hybrid 模式（SSE 下行 + HTTP POST 上行）。`replBridgeTransport.ts` 自动选择和切换。
