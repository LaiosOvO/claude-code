# 模块说明：远程桥接 (Bridge)

## 概述

Bridge 模块实现了 Claude Code 的远程控制能力——让用户可以从手机、网页或其他设备操控本地运行的 Claude Code。它支持双向消息传递、权限管理和多会话管理。

## 核心文件

| 文件 | 作用 |
|------|------|
| `src/bridge/bridgeMain.ts` | 独立桥接入口（`claude remote-control`命令）~2800行 |
| `src/bridge/replBridge.ts` | REPL 内嵌桥接（与 TUI 集成）~1700行 |
| `src/bridge/bridgeApi.ts` | REST API 客户端（环境注册、轮询、心跳） |
| `src/bridge/bridgeMessaging.ts` | 消息路由 + 控制请求处理 |
| `src/bridge/bridgeConfig.ts` | 认证和配置管理 |
| `src/cli/transports/` | WebSocket/SSE/Hybrid 传输层 |

## 架构设计

```
手机/网页                    云端/Server                  本地 Claude Code
┌─────────┐              ┌──────────────┐              ┌──────────────┐
│ 用户界面 │──WebSocket──│ 消息中继     │──WebSocket──│ Bridge 客户端│
│         │              │              │              │              │
│ 发消息   │──HTTP POST──│ /v1/sessions │──轮询────────│ bridgeMain   │
│ 看结果   │◄─SSE/WS────│ /events      │◄─事件推送───│ replBridge   │
│ 审权限   │              │              │              │              │
└─────────┘              └──────────────┘              └──────────────┘
```

## 两种桥接模式

### 模式 1：独立桥接 (bridgeMain.ts)
- 用 `claude remote-control` 启动
- 运行轮询循环，从服务器获取工作
- 为每个工作项 spawn 子进程
- 支持多并发会话

### 模式 2：REPL 内嵌桥接 (replBridge.ts)
- 在交互 TUI 中激活
- 不 spawn 子进程，直接在当前会话中处理
- 适合 daemon 调用

## 关键流程

1. **注册环境** → POST `/v1/environments/bridge`
2. **轮询工作** → GET `/v1/environments/{id}/work/poll` (长轮询)
3. **获取工作** → 解码 WorkSecret (含 session token, API URL)
4. **建立连接** → WebSocket 连接到会话
5. **消息路由** → 用户消息 ↔ Claude Code 双向传递
6. **权限处理** → 工具调用权限请求转发给远程用户
7. **心跳维持** → 定期 heartbeat 延长 lease
8. **完成清理** → 归档会话，确认工作

## 设计模式

- **传输抽象**：`ReplBridgeTransport` 统一 v1(WebSocket) 和 v2(SSE+HTTP)
- **回声去重**：`BoundedUUIDSet` 环形缓冲区去除消息回声
- **指数退避**：连接失败后指数退避重试
- **序列号续传**：传输切换时通过 sequence number 避免历史重放
