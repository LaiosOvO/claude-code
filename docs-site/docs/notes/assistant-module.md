# assistant 模块阅读笔记

## 文件列表

```
src/assistant/
├── index.ts                    # 模式检测与系统提示（stub）
├── gate.ts                     # Kairos 启用检测（stub）
├── sessionDiscovery.ts          # 会话发现（stub）
├── sessionHistory.ts            # 会话历史分页获取
└── AssistantSessionChooser.ts   # 会话选择器 UI（stub）
```

## 核心功能

assistant 模块实现了 Claude Code 的**助手模式（Assistant Mode）**——一种长期运行的、面向 Kairos/daemon 的会话模式。

当前大部分为 stub，唯一有完整实现的是 `sessionHistory.ts`，提供远程会话历史的**分页获取**：
- 通过 Anthropic OAuth 认证的 Sessions API 获取事件
- 支持 `anchor_to_latest`（最新页）和 `before_id`（向前翻页）
- 每页 100 条事件，返回 `hasMore` 指示是否有更早历史

## 关键代码片段

认证上下文预构建——单次准备，多次复用：

```typescript
export async function createHistoryAuthCtx(sessionId: string): Promise<HistoryAuthCtx> {
  const { accessToken, orgUUID } = await prepareApiRequest()
  return {
    baseUrl: `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/events`,
    headers: {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    },
  }
}
```

## 类型定义

```typescript
export type HistoryPage = {
  events: SDKMessage[]       // 按时间顺序排列的事件
  firstId: string | null     // ���内最旧事件 ID（向前翻页游标）
  hasMore: boolean           // 是否还有更早的事件
}
```

## 设计亮点

1. **Auth Context 模式**：将认证信息预构建为 `HistoryAuthCtx` 对象，避免每次翻页重复 OAuth 流程
2. **游标分页**：使用 `first_id` 作为向前游标，比 offset 分页更适合实时数据流
3. **stub 接口清晰**：`isAssistantMode()` / `isAssistantForced()` 等预留了完整的模式切换 API
4. **与 Kairos 联动**：`gate.ts` 的 `isKairosEnabled` 是助手模式的门控开关
5. **超时保护**：HTTP 请求设置 15s 超时，防止网络问题阻塞 UI
6. **错误静默**：`fetchPage` 内部 catch 所有错误返回 null，调用者自行处理缺��数据
7. **CCR Beta 标头**：请求携带 `anthropic-beta` 匹配 CCR 后端 API 版本

## 与其他模块的关系

- **kairos**：Kairos 引擎管理助手会话的长期运行
- **daemon**：daemon 进程承载助手模式的后台执行
- **memdir**：助手模式采用 daily-log 式记忆（append-only，nightly distill）
