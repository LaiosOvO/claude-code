# 阅读笔记：bridgeMain.ts

## 文件基本信息
- **路径**: `src/bridge/bridgeMain.ts`
- **行数**: 2999 行
- **角色**: Bridge（远程控制）系统的主入口和核心控制循环，负责协调 `claude remote-control` 命令的全生命周期

## 核心功能

`bridgeMain.ts` 是 Claude Code 远程控制（Remote Control）功能的主引擎。它允许用户通过 `claude remote-control` 命令将本地 CLI 连接到 claude.ai/code 网页端，实现跨设备控制。文件包含三大核心能力：

1. **桥接主循环（`runBridgeLoop`）**：注册环境（environment）后，进入持久轮询循环，从服务器拉取工作项（work items）。收到会话请求后，生成子进程处理会话，管理会话的完整生命周期（创建 → 活跃 → 完成/失败 → 清理）。支持单会话和多会话模式（same-dir / worktree）。

2. **命令行入口（`bridgeMain`）**：解析命令行参数，处理认证（OAuth）、信任对话框、spawn 模式选择、会话恢复（`--session-id` / `--continue`），最终调用 `runBridgeLoop` 启动服务。

3. **无头模式（`runBridgeHeadless`）**：为 daemon worker 提供的非交互式入口，没有 readline 对话框、没有 stdin 按键处理、没有 TUI，日志输出到 worker 的 stdout 管道。

## 关键代码解析

### BackoffConfig - 退避策略配置
```typescript
export type BackoffConfig = {
  connInitialMs: number      // 连接错误初始退避：2秒
  connCapMs: number          // 连接错误退避上限：2分钟
  connGiveUpMs: number       // 连接错误放弃时间：10分钟
  generalInitialMs: number   // 一般错误初始退避：500毫秒
  generalCapMs: number       // 一般错误退避上限：30秒
  generalGiveUpMs: number    // 一般错误放弃时间：10分钟
  shutdownGraceMs?: number   // 关闭宽限期：30秒
  stopWorkBaseDelayMs?: number // stopWork 重试基础延迟
}
```
采用双轨退避策略：连接错误和一般错误分开追踪，互相重置，避免一种错误类型的退避污染另一种。

### runBridgeLoop - 核心轮询循环
```typescript
export async function runBridgeLoop(
  config: BridgeConfig,
  environmentId: string,
  environmentSecret: string,
  api: BridgeApiClient,
  spawner: SessionSpawner,
  logger: BridgeLogger,
  signal: AbortSignal,
  ...
): Promise<void>
```
此函数维护了大量的 Map 来追踪活跃会话状态：
- `activeSessions`: 会话ID → SessionHandle
- `sessionStartTimes`: 会话开始时间
- `sessionWorkIds`: 会话 → 工作项ID映射
- `sessionCompatIds`: 基础设施层ID（cse_*） → 兼容层ID（session_*）
- `sessionIngressTokens`: 会话 JWT 令牌
- `sessionWorktrees`: 会话的 git worktree 信息
- `timedOutSessions`: 被超时看门狗杀掉的会话
- `titledSessions`: 已有标题的会话

### heartbeatActiveWorkItems - 心跳机制
```typescript
async function heartbeatActiveWorkItems(): Promise<
  'ok' | 'auth_failed' | 'fatal' | 'failed'
>
```
为所有活跃工作项发送心跳。JWT 过期时触发 `reconnectSession` 重新排队，而非直接失败。返回值驱动上层循环的决策：auth_failed 触发令牌刷新，fatal 触发环境重建。

### 工作分发逻辑（switch 块）
```typescript
switch (work.data.type) {
  case 'healthcheck': // 健康检查
  case 'session':     // 会话请求 - 核心路径
  default:            // 未知类型 - 优雅忽略
}
```
`session` 分支是最复杂的部分（约300行），处理：
- 现有会话的令牌刷新（existingHandle 路径）
- 容量检查
- CCR v2 worker 注册（registerWorker）
- Worktree 创建（隔离并发会话）
- 子进程 spawn
- 会话标题派生和获取
- 超时看门狗设置
- 令牌主动刷新调度

### 优雅关闭序列
```typescript
// 1. 快照所有需要归档的会话
// 2. 向活跃会话发送 SIGTERM
// 3. 等待宽限期（30秒）
// 4. 对未响应的进程发送 SIGKILL
// 5. 清理 worktrees
// 6. 通知服务器 stopWork
// 7. 等待所有待处理的清理操作
// 8. 归档会话
// 9. 注销环境
// 10. 清除崩溃恢复指针
```

### parseArgs - 参数解析
```typescript
export function parseArgs(args: string[]): ParsedArgs
```
支持的参数包括：`--verbose`, `--sandbox`, `--debug-file`, `--session-timeout`, `--permission-mode`, `--name`, `--spawn`, `--capacity`, `--create-session-in-dir`, `--session-id`, `--continue`。参数之间有复杂的互斥关系验证。

### bridgeMain - 完整初始化流程
大约 800 行的初始化逻辑，按顺序执行：
1. 参数解析和验证
2. 权限模式验证
3. 信任对话框检查
4. OAuth 认证
5. 首次远程对话框
6. `--continue` 会话恢复
7. 多会话 gate 检查
8. Spawn 模式确定（resume > flag > saved > gate_default）
9. Worktree 可用性预检
10. 环境注册
11. 会话恢复（--session-id）或创建
12. stdin 按键监听（空格切换 QR 码，w 切换 spawn 模式）
13. 启动 runBridgeLoop

## 数据流

```
用户执行 `claude remote-control`
      ↓
bridgeMain() 初始化 → 认证/配置/gate检查
      ↓
registerBridgeEnvironment() → 获取 environmentId + secret
      ↓
createBridgeSession() → 预创建初始会话
      ↓
runBridgeLoop() 进入轮询
      ↓
pollForWork() ←→ 服务器
      ↓ (收到 session 类型 work)
decodeWorkSecret() → 解密 JWT
      ↓
acknowledgeWork() → 确认工作
      ↓
spawner.spawn() → 创建子进程
      ↓
子进程连接 WebSocket 或 SSE → 与 claude.ai 双向通信
      ↓
onSessionDone() → 清理/停止工作/归档
      ↓
[循环继续或关闭]
```

## 与其他模块的关系

**依赖**:
- `bridgeApi.ts` → API 客户端（注册/轮询/心跳/停止）
- `bridgeUI.ts` → TUI 日志渲染器
- `sessionRunner.ts` → 子进程 spawner
- `workSecret.ts` → JWT 解码和 SDK URL 构建
- `jwtUtils.ts` → 令牌刷新调度
- `capacityWake.ts` → 容量释放信号
- `pollConfig.ts` → 轮询间隔配置（GrowthBook）
- `sessionIdCompat.ts` → cse_* ↔ session_* ID 转换
- `worktree.ts` → git worktree 创建/删除
- `bridgePointer.ts` → 崩溃恢复指针
- `createSession.ts` → 会话创建/标题更新
- `trustedDevice.ts` → 可信设备令牌

**被依赖**:
- CLI 入口（`cli.ts`）直接调用 `bridgeMain`
- daemon worker 调用 `runBridgeHeadless`

## 设计亮点与思考

1. **双轨退避策略**：连接错误和一般错误分开追踪，避免互相干扰。检测系统休眠/唤醒后重置错误预算，非常实用。

2. **容量唤醒信号（capacityWake）**：会话完成时立即唤醒轮询循环，而非等待超时。在多会话模式下显著降低响应延迟。

3. **心跳 + 轮询组合**：at-capacity 时心跳保持工作项存活（300秒 TTL），同时定期轮询作为 liveness 信号（4小时 BRIDGE_LAST_POLL_TTL）。两者独立调度，GrowthBook 可实时调整。

4. **崩溃恢复指针**：写入磁盘的 JSON 指针，kill -9 后下次启动可恢复。hourly 刷新 mtime 防止过期。perpetual 模式保留指针跨进程存活。

5. **completedWorkIds 去重**：服务器可能在处理 stop 请求前重新分发已完成的工作项，通过记住已完成的 workId 避免重复 spawn。

6. **headless 模式的优雅降级**：`runBridgeHeadless` 通过 `createHeadlessBridgeLogger`（一个将所有 UI 方法映射到 `log(string)` 的适配器）实现了与交互式模式相同的核心逻辑。

## 要点总结

1. **bridgeMain.ts 是 Remote Control 的主控制器**，包含轮询循环、多会话管理、graceful shutdown、命令行解析和 headless daemon 入口。
2. **轮询循环是核心**：pollForWork → decodeWorkSecret → acknowledgeWork → spawn → onSessionDone，配合双轨指数退避和休眠检测。
3. **多会话模式**支持 same-dir（共享目录）和 worktree（隔离 git worktree），通过 `w` 键实时切换，spawn 模式偏好持久化到 ProjectConfig。
4. **心跳机制**在 at-capacity 时保持工作项存活，JWT 过期时通过 reconnectSession 重新排队而非直接放弃。
5. **`--continue` / `--session-id` 恢复流程**：读取崩溃恢复指针或指定会话 ID，通过 reconnectSession 重新排队并用 reuseEnvironmentId 做幂等注册。
