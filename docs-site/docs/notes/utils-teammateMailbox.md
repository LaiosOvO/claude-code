# 阅读笔记：teammateMailbox.ts

## 文件基本信息
- **路径**: `src/utils/teammateMailbox.ts`
- **行数**: 1183 行
- **角色**: Agent Swarm（多智能体协作）系统的基于文件的消息传递中间件，实现了 teammate 之间的邮箱通信机制

## 核心功能

`teammateMailbox.ts` 实现了一个基于文件系统的消息传递系统，用于 Claude Code 的多智能体（agent swarm）协作场景。每个 teammate（队友/智能体）有一个独立的 JSON 文件作为收件箱，位于 `.claude/teams/{team_name}/inboxes/{agent_name}.json`。其他 teammate 可以向其中写入消息，接收方将消息作为附件读取。

文件的功能可以分为三层：
1. **基础邮箱操作**：readMailbox、writeToMailbox、markMessagesAsRead、clearMailbox——CRUD 操作加文件锁并发控制
2. **消息类型定义**：定义了十多种结构化消息类型（空闲通知、权限请求/响应、沙盒权限、任务分配、关闭请求、计划审批、模式设置等）
3. **消息类型检测**：为每种消息类型提供 `is*` 类型守卫函数，以及一个统一的 `isStructuredProtocolMessage` 分类器

## 关键代码解析

### 文件锁并发控制
```typescript
const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
  },
}
```
使用 `proper-lockfile` 库（通过 `lockfile.ts` 包装），异步锁 + 指数退避重试。这是因为 swarm 模式下多个 Claude 进程会并发写入同一个收件箱文件。

### writeToMailbox - 带锁写入
```typescript
export async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName?: string,
): Promise<void> {
  await ensureInboxDir(teamName)
  const inboxPath = getInboxPath(recipientName, teamName)
  const lockFilePath = `${inboxPath}.lock`
  
  // 先创建文件（'wx' flag = 不存在才创建）
  try {
    await writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') { ... }
  }
  
  // 获取锁 → 重新读取 → 追加 → 写回 → 释放锁
  release = await lockfile.lock(inboxPath, { lockfilePath, ...LOCK_OPTIONS })
  const messages = await readMailbox(recipientName, teamName)
  messages.push({ ...message, read: false })
  await writeFile(inboxPath, jsonStringify(messages, null, 2), 'utf-8')
}
```
关键点：获取锁后**重新读取**文件以获取最新状态，而非使用锁前读取的旧数据。这是标准的"读-改-写"并发模式。

### 结构化消息类型体系

文件定义了一个丰富的消息协议体系：

| 消息类型 | 方向 | 用途 |
|---------|------|------|
| `TeammateMessage` | 任意→任意 | 基础文本消息 |
| `IdleNotificationMessage` | Worker→Leader | 通知空闲状态 |
| `PermissionRequestMessage` | Worker→Leader | 工具使用权限请求 |
| `PermissionResponseMessage` | Leader→Worker | 权限批准/拒绝 |
| `SandboxPermissionRequestMessage` | Worker→Leader | 沙盒网络访问权限 |
| `SandboxPermissionResponseMessage` | Leader→Worker | 沙盒权限批准/拒绝 |
| `TaskAssignmentMessage` | Leader→Worker | 任务分配 |
| `PlanApprovalRequestMessage` | Worker→Leader | 计划审批请求 |
| `PlanApprovalResponseMessage` | Leader→Worker | 计划审批结果 |
| `ShutdownRequestMessage` | Leader→Worker | 关闭请求 |
| `ShutdownApprovedMessage` | Worker→Leader | 同意关闭 |
| `ShutdownRejectedMessage` | Worker→Leader | 拒绝关闭 |
| `TeamPermissionUpdateMessage` | Leader→All | 团队权限更新广播 |
| `ModeSetRequestMessage` | Leader→Worker | 权限模式设置 |

### isStructuredProtocolMessage - 协议消息分类器
```typescript
export function isStructuredProtocolMessage(messageText: string): boolean {
  const type = (parsed as { type: unknown }).type
  return (
    type === 'permission_request' ||
    type === 'permission_response' ||
    type === 'sandbox_permission_request' ||
    type === 'sandbox_permission_response' ||
    type === 'shutdown_request' ||
    type === 'shutdown_approved' ||
    type === 'team_permission_update' ||
    type === 'mode_set_request' ||
    type === 'plan_approval_request' ||
    type === 'plan_approval_response'
  )
}
```
这个函数非常关键——它决定了哪些消息应该被 `useInboxPoller` 路由到专用处理队列，而不是作为普通文本附件被 LLM 消费。如果结构化消息被当作普通文本消费，它们永远不会到达预期的处理器。

### getLastPeerDmSummary - 最后一条 DM 摘要
```typescript
export function getLastPeerDmSummary(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    // 在 user prompt 边界处停止（string content，非 tool results）
    // 查找 SendMessage tool_use → 提取 to + summary
    // 排除发给 team_lead 和 * 的消息
  }
}
```
从消息历史中倒序查找最近的 peer DM（发给其他 worker 而非 leader 的消息），提取 `[to {name}] {summary}` 格式的摘要。用于空闲通知中附带最后一条 DM 信息。

### markMessagesAsReadByPredicate - 条件标记已读
```typescript
export async function markMessagesAsReadByPredicate(
  agentName: string,
  predicate: (msg: TeammateMessage) => boolean,
  teamName?: string,
): Promise<void>
```
选择性标记消息为已读——只标记满足 predicate 条件的未读消息。带文件锁。用于例如"只标记权限响应为已读，其他消息保持未读"的场景。

### formatTeammateMessages - XML 格式化
```typescript
export function formatTeammateMessages(messages): string {
  return messages
    .map(m => `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`)
    .join('\n\n')
}
```
将消息格式化为 XML 标签包裹的文本，用于作为 LLM 上下文附件。包含 teammate_id、color、summary 属性。

## 数据流

```
Worker A 发送消息给 Worker B：
writeToMailbox("workerB", { from: "workerA", text: "...", timestamp: "..." })
      ↓ ensureInboxDir → 创建目录
      ↓ 创建文件（如不存在）
      ↓ lockfile.lock → 获取文件锁
      ↓ readMailbox → 读取当前所有消息
      ↓ 追加新消息
      ↓ writeFile → 写回 JSON
      ↓ release → 释放锁

Worker B 读取未读消息：
readUnreadMessages("workerB")
      ↓ readMailbox → 读取 JSON 文件
      ↓ filter(m => !m.read)
      ↓ 返回未读消息数组

useInboxPoller 轮询处理：
readMailbox() → messages
      ↓
for each message:
  isStructuredProtocolMessage? → 路由到专用队列
  else → 作为 LLM 上下文附件
      ↓
markMessagesAsRead() → 标记已处理
```

## 与其他模块的关系

**依赖**:
- `lockfile.ts` → 文件锁（proper-lockfile 包装）
- `envUtils.ts` → `getTeamsDir()` 获取 teams 目录路径
- `teammate.ts` → `getAgentName()`, `getTeammateColor()`, `getTeamName()`
- `agentId.ts` → `generateRequestId()` 生成确定性请求ID
- `swarm/constants.ts` → `TEAM_LEAD_NAME` 常量
- `tasks.ts` → `sanitizePathComponent()` 路径安全化
- `xml.ts` → `TEAMMATE_MESSAGE_TAG` XML 标签名
- `SendMessageTool/constants.ts` → `SEND_MESSAGE_TOOL_NAME` 工具名
- `sdk/coreSchemas.ts` → `PermissionModeSchema` zod 验证

**被依赖**:
- `useInboxPoller.ts` → 轮询收件箱，路由结构化消息
- `SendMessageTool` → 调用 writeToMailbox 发送消息
- `ShutdownTool` → 调用 sendShutdownRequestToMailbox
- Stop hook → 调用 createIdleNotification
- `getTeammateMailboxAttachments` → 读取消息作为 LLM 附件

## 设计亮点与思考

1. **文件系统作为消息队列**：选择 JSON 文件而非 IPC/socket 作为通信机制，使得 swarm 中的多个独立进程可以在没有中心化 broker 的情况下通信。每个 agent 有独立收件箱，写操作通过文件锁序列化。

2. **结构化协议消息 vs 自由文本消息**：`isStructuredProtocolMessage` 是关键的分类器。协议消息（权限、关闭、计划审批等）有明确的请求-响应模式，必须路由到专用处理器；自由文本消息直接作为 LLM 上下文。这种区分避免了 LLM 误解机器间的协议消息。

3. **Zod schema 验证 + lazySchema**：`ShutdownRequestMessageSchema`、`PlanApprovalResponseMessageSchema` 等使用 `lazySchema` 延迟初始化，避免模块加载时的循环依赖。`safeParse` 模式确保格式错误的消息被静默忽略而非抛出异常。

4. **消息不可变设计**：`writeToMailbox` 始终追加（读全部 → 追加 → 写全部），不修改已有消息。`markMessagesAsRead` 是唯一修改现有消息的操作，且通过独立的锁操作保证原子性。

5. **sendShutdownRequestToMailbox** 使用 `generateRequestId('shutdown', targetName)` 生成确定性请求ID，意味着对同一目标的重复关闭请求会生成相同的 ID——天然的幂等设计。

## 要点总结

1. **基于文件系统的 agent 间消息传递系统**，每个 agent 有独立的 JSON 收件箱文件，通过 proper-lockfile 实现并发写入安全。
2. **十多种结构化消息类型**，覆盖空闲通知、权限请求/响应、沙盒权限、任务分配、计划审批、关闭管理、模式设置等完整的 swarm 协作协议。
3. **`isStructuredProtocolMessage` 是消息路由的关键**，将协议消息路由到专用处理器，防止被 LLM 当作普通文本消费。
4. **读-锁-读-改-写-释放**的并发安全模式，锁后重新读取确保不丢失并发写入。
5. **Leader-Worker 架构**：大部分消息类型遵循 Leader→Worker（指令/响应）或 Worker→Leader（请求/通知）的单向模式，team_lead 是特殊角色。
