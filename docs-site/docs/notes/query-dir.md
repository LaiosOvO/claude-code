# query 目录阅读笔记

## 文件列表

```
src/query/
├── config.ts       # 不可变查询配置（快照一次，贯穿整个 query）
├── deps.ts         # I/O 依赖注入（callModel/autocompact/uuid）
├── stopHooks.ts    # 轮次结束后的钩子执行（Stop/TeammateIdle/TaskCompleted）
├── tokenBudget.ts  # Token 预算追踪与继续/停止决策
└── transitions.ts  # 状态转换类型（stub）
```

## 核心功能

query 目录是 `query()` 函数的**内部基础设施**，将配置、依赖、预算和钩子从主循环中解耦。

核心职责：
- **QueryConfig**：在 query 入口一次性快照所有运行时门控（statsig/env），避免中途变化
- **QueryDeps**：依赖注入 4 个核心 I/O 函数，测试可直接替换而无需 spyOn
- **Token Budget**：追踪 token 消耗占预算比例，90% 阈值自动继续、diminishing returns 检测
- **Stop Hooks**：轮次结束后执行用户配置的 Shell 钩子，支持阻断继续

## 关键代码片段

Token 预算的"收益递减"检测：

```typescript
const isDiminishing =
  tracker.continuationCount >= 3 &&
  deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
  tracker.lastDeltaTokens < DIMINISHING_THRESHOLD
// 连续 3+ 次 continuation 但每次产出 <500 token → 停止浪费
```

依赖注入模式——`typeof fn` 自动跟踪签名：

```typescript
export type QueryDeps = {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: () => string
}
```

## 设计亮点

1. **配置快照**：`buildQueryConfig()` 在 query 入口调用一次，后续 step 是纯 reducer `(state, event, config)`
2. **feature() 排除**：配置有意排除 `feature()` 门控——那些是 tree-shaking 边界，必须内联使用
3. **fire-and-forget 策略**：extractMemories/autoDream 在 stopHooks 中异步触发但不等待
4. **Teammate 钩子链**：先执行 Stop hooks → TaskCompleted hooks → TeammateIdle hooks，层级递进
5. **bare 模式跳过**：`--bare` / SIMPLE 模式跳过所有后台记账（memory/dream/prompt suggestion）
6. **中断感知**：钩子执行期间检查 `abortController.signal.aborted`，中断时立即返回
7. **hookInfo 时序追踪**：通过 `durationMs` 字段让每个钩子的耗时可观测
8. **CacheSafeParams**：为 /btw 命令和 side_question SDK 请求保存最近一次查询的上下文快照
9. **Chicago MCP 清理**：轮次结束时自动释放 Computer Use 锁和取消隐藏，仅主线程执行
10. **Job 分类器**：模板任务模式下，轮次结束后同步等待分类器写入 state.json（60s 超时）
