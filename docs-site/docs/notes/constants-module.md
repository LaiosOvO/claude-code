# constants 模块阅读笔记

> 源码路径：`src/constants/`
> 文件数量：约 23 个（含 `src/`）

## 概述

`constants/` 模块集中管理 Claude Code 的 **全局常量和配置值**，包括工具列表、系统提示词模板、API 限制、产品 URL、错误 ID 等。它是连接业务逻辑和配置的枢纽。

## 文件列表

| 文件 | 职责 |
|---|---|
| `tools.ts` | 工具允许/禁止列表：Agent 可用工具、异步 Agent 工具集 |
| `prompts.ts` | 系统提示词构建：模型能力描述、工具使用指引、上下文注入 |
| `common.ts` | 通用常量：日期工具函数 `getLocalISODate()`、`getSessionStartDate()` |
| `product.ts` | 产品 URL：claude.ai 地址、staging/local 环境判断 |
| `keys.ts` | GrowthBook 客户端密钥 |
| `messages.ts` | 消息常量（如 `NO_CONTENT_MESSAGE`） |
| `errorIds.ts` | 错误 ID 分配（递增数字标识符用于生产追踪） |
| `apiLimits.ts` | API 调用限制 |
| `betas.ts` | Beta 功能标志 |
| `figures.ts` | Unicode 图形字符（钻石、箭头等） |
| `files.ts` | 文件相关常量 |
| `oauth.ts` | OAuth 配置 |
| `outputStyles.ts` | 输出样式配置 |
| `system.ts` | 系统级常量 |
| `systemPromptSections.ts` | 系统提示词分段管理 |
| `toolLimits.ts` | 工具调用限制 |
| `xml.ts` | XML 标签常量 |
| `spinnerVerbs.ts` | 加载动画动词表 |
| `turnCompletionVerbs.ts` | 轮次完成动词表 |
| `querySource.ts` | 查询来源标识 |
| `github-app.ts` | GitHub App 常量 |
| `cyberRiskInstruction.ts` | 网络安全风险指令 |

## 核心内容详解

### 工具常量（tools.ts）

定义了三组关键工具集合：

- `ALL_AGENT_DISALLOWED_TOOLS` — 所有 Agent 禁用的工具（TaskOutput、ExitPlanMode、AskUserQuestion 等）
- `ASYNC_AGENT_ALLOWED_TOOLS` — 异步 Agent 允许的工具（FileRead、WebSearch、Shell、FileEdit 等）
- `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` — 进程内队友专用工具（TaskCreate、TaskGet、TaskList 等）

### 系统提示词（prompts.ts）

动态组装系统提示词，涉及：
- 模型能力描述与限制
- 工具使用指引
- CLAUDE.md 内容注入
- Feature flag 条件段落
- 日期/环境上下文

### 错误 ID（errorIds.ts）

```typescript
// Next ID: 346
export const E_TOOL_USE_SUMMARY_GENERATION_FAILED = 344
```

使用递增数字标识，便于生产环境中追踪 `logError()` 调用来源。

### 产品常量（product.ts）

```typescript
export const PRODUCT_URL = 'https://claude.com/claude-code'
export const CLAUDE_AI_BASE_URL = 'https://claude.ai'
export const CLAUDE_AI_STAGING_BASE_URL = 'https://claude-ai.staging.ant.dev'
```

支持 staging / local 环境检测，通过 session ID 和 ingress URL 中的关键字判断。

### GrowthBook 密钥（keys.ts）

支持三种环境的 SDK key：
- ant 开发环境 (`ENABLE_GROWTHBOOK_DEV`)
- ant 生产环境
- 外部用户环境
- 自定义适配器 (`CLAUDE_GB_ADAPTER_KEY`)

## 设计亮点

1. **Feature Flag 门控** — `tools.ts` 中大量使用 `feature()` 宏，编译时消除内部功能
2. **缓存友好的日期** — `getSessionStartDate()` 使用 `memoize` 确保会话内日期不变，避免系统提示词缓存击穿
3. **工具集合分层** — Agent/AsyncAgent/Teammate 三层工具授权，实现最小权限原则
4. **提示词分段化** — `systemPromptSections.ts` 将大提示词拆分为可缓存的独立段落
5. **三环境 GrowthBook** — 通过环境变量自动切换 dev/prod/external SDK key

## 与其他模块的关系

- **tools/** — 每个工具的 `TOOL_NAME` 常量被 `tools.ts` 引用组装成集合
- **bridge/** — `product.ts` 提供远程会话 URL
- **state/** — 工具权限集合影响 `AppState.toolPermissionContext`
- **entrypoints/** — `prompts.ts` 被 `init.ts` 和 main loop 调用构建系统提示词
