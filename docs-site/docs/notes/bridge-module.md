# bridge 模块阅读笔记

> 源码路径：`src/bridge/`
> 文件数量：35 个（含 `src/`）

## 概述

`bridge/` 模块实现了 Claude Code 的 **远程控制 (Remote Control)** 架构，使本地 CLI 可以作为远程环境被 claude.ai 网页端驱动。它支持会话轮询、消息桥接、JWT 认证、工作目录隔离（worktree）等功能。

## 文件列表

| 文件 | 职责 |
|---|---|
| `bridgeMain.ts` | 主入口：环境注册、轮询循环、会话生命周期管理 |
| `bridgeApi.ts` | HTTP API 客户端：工作领取、状态上报、权限响应 |
| `bridgeConfig.ts` | 认证/URL 解析：OAuth token 和 base URL 获取 |
| `bridgeMessaging.ts` | 消息协议：入站消息处理、服务端控制请求 |
| `bridgePermissionCallbacks.ts` | 权限回调：远程用户审批工具使用请求 |
| `bridgeUI.ts` | UI 日志器：终端输出桥接状态信息 |
| `bridgeStatusUtil.ts` | 状态格式化工具（时长格式化等） |
| `bridgeDebug.ts` | 调试工具 |
| `bridgeEnabled.ts` | 特性开关判断 |
| `bridgePointer.ts` | 桥接指针管理 |
| `types.ts` | 所有桥接相关类型定义 |
| `replBridge.ts` | REPL 桥接核心：将运行中的 CLI 会话暴露给远程 |
| `replBridgeHandle.ts` | REPL 桥接句柄 |
| `replBridgeTransport.ts` | REPL 桥接传输层（v1/v2 协议） |
| `initReplBridge.ts` | REPL 桥接初始化 |
| `remoteBridgeCore.ts` | 远程桥接核心逻辑 |
| `localBridge.ts` | 本地桥接 |
| `sessionRunner.ts` | 会话运行器：spawn Claude Code 子进程 |
| `createSession.ts` | 会话创建 |
| `peerSessions.ts` | 对等会话管理 |
| `jwtUtils.ts` | JWT token 刷新调度器 |
| `trustedDevice.ts` | 可信设备 token 管理 |
| `workSecret.ts` | Work secret 解码/SDK URL 构建 |
| `sessionIdCompat.ts` | 会话 ID 格式兼容层 |
| `capacityWake.ts` | 容量唤醒信号 |
| `flushGate.ts` | 刷新门控 |
| `pollConfig.ts` / `pollConfigDefaults.ts` | 轮询间隔配置 |
| `inboundAttachments.ts` | 入站附件处理 |
| `inboundMessages.ts` | 入站消息处理 |
| `webhookSanitizer.ts` | Webhook 数据清洗 |
| `debugUtils.ts` | Axios 错误描述等调试工具 |
| `envLessBridgeConfig.ts` | 无环境变量的桥接配置 |
| `codeSessionApi.ts` | Code Session API 客户端 |

## 核心类型（types.ts）

| 类型 | 说明 |
|---|---|
| `WorkResponse` | 服务端下发的工作单元 |
| `WorkSecret` | Base64 编码的会话密钥（含 ingress token、API URL 等） |
| `SpawnMode` | 会话目录策略：`single-session` / `worktree` / `same-dir` |
| `SessionDoneStatus` | 会话结束状态：`completed` / `failed` / `interrupted` |
| `BridgeConfig` | 桥接配置 |
| `BridgeApiClient` | API 客户端接口 |
| `BridgeWorkerType` | Worker 类型：`claude_code` / `claude_code_assistant` |
| `BridgeFatalError` | 不可重试的致命错误 |

## 关键设计

1. **长轮询 + 退避** — `bridgeMain.ts` 使用指数退避轮询 environments API，`DEFAULT_BACKOFF` 定义从 2s 到 2min 的退避策略
2. **安全 ID 验证** — `validateBridgeId()` 使用正则白名单 `/^[a-zA-Z0-9_-]+$/` 防止路径遍历注入
3. **双协议传输** — `replBridgeTransport.ts` 支持 v1（直连）和 v2（CCR）两种传输协议
4. **Worktree 隔离** — 每个远程会话可以获得独立的 git worktree，避免相互踩踏
5. **可信设备认证** — `trustedDevice.ts` 提供 X-Trusted-Device-Token 头部，服务端 SecurityTier=ELEVATED 会话要求
6. **401 自动刷新** — `bridgeApi.ts` 的 `onAuth401` 回调支持透明 OAuth token 刷新后重试

## 关键流程

### bridgeMain 主循环

```
启动 → 注册环境 → 进入轮询循环
     → 领取工作 (pollForWork)
     → 解码 WorkSecret
     → spawn 会话子进程
     → 转发消息 ←→ claude.ai
     → 会话结束 → 上报状态 → 继续轮询
```

### REPL 桥接（replBridge.ts）

将运行中的交互式 CLI 会话暴露给远程，不需要 spawn 新进程：
- 使用 `HybridTransport` 在同一进程中桥接
- 通过 `updateSessionBridgeId` 关联会话
- 支持 `FlushGate` 控制消息刷新时机

## 与其他模块的关系

- **entrypoints/** — `cli.tsx` 中 `remote-control` / `bridge` 命令直接调用 `bridgeMain`
- **state/** — `onChangeAppState` 将权限模式变更推送到桥接层
- **bootstrap/** — 使用 `bootstrap/state.ts` 中的全局会话信息
- **types/** — 消息类型 `Message`、权限类型 `PermissionMode` 均来自 types 模块
