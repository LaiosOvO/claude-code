# src/services/ 模块阅读笔记

**文件数量**: 约 243 个  
**模块定位**: 应用服务层 — 封装与外部系统交互的业务逻辑（API、分析、MCP、策略等）

---

## 目录结构

```
src/services/
├── AgentSummary/          # Agent 总结服务
│   └── agentSummary.ts
├── analytics/             # 分析与遥测 (10 文件)
│   ├── config.ts          # 分析配置（是否禁用等）
│   ├── datadog.ts         # Datadog 上报
│   ├── firstPartyEventLogger.ts      # 1P 事件日志
│   ├── firstPartyEventLoggingExporter.ts # 1P 事件导出器
│   ├── growthbook.ts      # GrowthBook 功能开关
│   ├── index.ts           # 公共 API — logEvent() 入口
│   ├── metadata.ts        # 事件元数据
│   ├── sink.ts            # 事件分发 sink
│   └── sinkKillswitch.ts  # sink 紧急关闭
├── api/                   # HTTP API 客户端 (21 文件)
│   ├── bootstrap.ts       # 启动数据预取
│   ├── claude.ts          # Claude API 核心调用
│   ├── client.ts          # HTTP 客户端封装
│   ├── errors.ts          # API 错误类型
│   ├── filesApi.ts        # 文件上传/下载 API
│   ├── grove.ts           # Grove 策略 API
│   ├── referral.ts        # 推荐/Pass 资格检查
│   ├── usage.ts           # 用量查询
│   └── withRetry.ts       # 重试逻辑
├── autoDream/             # 自动"做梦"（后台推理）(4 文件)
├── compact/               # 上下文压缩 (18 文件)
│   ├── autoCompact.ts     # 自动压缩触发
│   ├── compact.ts         # 核心压缩逻辑
│   ├── microCompact.ts    # 微压缩（轻量级）
│   ├── reactiveCompact.ts # 响应式压缩
│   ├── sessionMemoryCompact.ts # 会话记忆压缩
│   ├── snipCompact.ts     # 片段压缩
│   └── prompt.ts          # 压缩提示词
├── contextCollapse/       # 上下文折叠 (3 文件)
├── extractMemories/       # 记忆提取 (2 文件)
├── lsp/                   # LSP 语言服务器协议 (8 文件)
│   ├── LSPClient.ts       # LSP 客户端
│   ├── LSPDiagnosticRegistry.ts # 诊断注册
│   ├── LSPServerInstance.ts     # 服务器实例管理
│   ├── LSPServerManager.ts      # 服务器管理器
│   └── manager.ts         # 管理器初始化入口
├── MagicDocs/             # 智能文档（自动生成上下文）(2 文件)
├── mcp/                   # Model Context Protocol (25 文件)
│   ├── auth.ts            # MCP 认证
│   ├── client.ts          # MCP 客户端（工具/命令/资源获取）
│   ├── config.ts          # MCP 配置解析
│   ├── MCPConnectionManager.tsx # 连接管理器（React 组件）
│   ├── officialRegistry.ts     # 官方 MCP 注册中心
│   ├── types.ts           # MCP 类型定义
│   ├── xaa.ts             # XAA 集成
│   └── xaaIdpLogin.ts     # XAA IdP 登录
├── oauth/                 # OAuth 认证 (3 文件)
├── plugins/               # 插件服务 (3 文件)
├── policyLimits/          # 策略限制 (2 文件)
├── PromptSuggestion/      # 提示建议 (2 文件)
├── remoteManagedSettings/  # 远程托管设置 (6 文件)
├── SessionMemory/         # 会话记忆 (3 文件)
├── sessionTranscript/     # 会话转录 (1 文件)
├── settingsSync/          # 设置同步 (2 文件)
├── skillSearch/           # 技能搜索 (7 文件)
│   ├── localSearch.ts     # 本地技能搜索
│   ├── remoteSkillLoader.ts # 远程技能加载
│   └── prefetch.ts        # 技能预取
├── teamMemorySync/        # 团队记忆同步 (5 文件)
├── tips/                  # 使用提示 (5 文件)
├── tools/                 # 工具执行服务 (4 文件)
│   ├── StreamingToolExecutor.ts # 流式工具执行器
│   ├── toolExecution.ts   # 工具执行核心
│   ├── toolHooks.ts       # 工具钩子
│   └── toolOrchestration.ts    # 工具编排
├── toolUseSummary/        # 工具使用总结 (1 文件)
├── src/                   # 内部子模块 (2 文件)
├── awaySummary.ts         # 离开总结（长时间不活跃时）
├── claudeAiLimits.ts      # Claude.ai 配额限制
├── diagnosticTracking.ts  # 诊断追踪
├── internalLogging.ts     # 内部日志
├── mockRateLimits.ts      # 模拟速率限制（测试）
├── notifier.ts            # 系统通知
├── preventSleep.ts        # 防止系统休眠
├── rateLimitMessages.ts   # 速率限制消息展示
├── rateLimitMocking.ts    # 速率限制模拟
├── tokenEstimation.ts     # Token 估算
├── vcr.ts                 # 请求录制/回放
├── voice.ts               # 语音服务
├── voiceKeyterms.ts       # 语音关键词
└── voiceStreamSTT.ts      # 语音流式转文字
```

---

## 核心服务详解

### 1. analytics/ — 分析与功能开关

**核心类型**:
- `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` — 标记类型，强制验证事件数据不含敏感信息

**关键函数**:
- `logEvent(name, metadata)` — 事件日志入口（零依赖，事件入队直到 sink 挂载）
- `initializeGrowthBook()` — GrowthBook 功能开关初始化
- `checkGate_CACHED_OR_BLOCKING(gate)` — 检查功能开关门控

**架构设计**: 采用"发布-订阅"模式，`logEvent()` 将事件推入队列，`attachAnalyticsSink()` 在初始化完成后挂载 sink 消费队列。这避免了循环依赖——任何模块都可以调用 `logEvent()` 而无需导入 sink 的依赖树。

### 2. api/ — HTTP API 交互

**关键函数**:
- `fetchBootstrapData()` — 预取启动数据
- `withRetry()` — 通用重试包装器
- `checkQuotaStatus()` — 配额状态检查

### 3. compact/ — 上下文压缩

**核心类型**: 压缩方向 `PartialCompactDirection`

**关键函数**:
- `compact()` — 核心压缩，将过长的对话上下文浓缩
- `autoCompact()` — 自动触发压缩（基于 token 阈值）
- `microCompact()` — 微压缩，更轻量的压缩策略
- `reactiveCompact()` — 响应式压缩（用户操作触发）
- `snipCompact()` — 按片段裁剪

**架构设计**: 多层压缩策略，从轻到重：micro → snip → reactive → full compact。每种策略适用于不同场景（token 接近上限、用户主动触发、系统自动维护等）。

### 4. mcp/ — Model Context Protocol

**核心类型**:
- `McpServerConfig` / `McpSdkServerConfig` — MCP 服务器配置
- `ScopedMcpServerConfig` — 带作用域的配置（local/user/project）

**关键函数**:
- `getMcpToolsCommandsAndResources()` — 获取 MCP 工具、命令和资源
- `parseMcpConfig()` — 解析 MCP 配置
- `getClaudeCodeMcpConfigs()` — 获取所有 MCP 配置
- `filterMcpServersByPolicy()` — 按策略过滤 MCP 服务器

### 5. tools/ — 工具执行服务

**关键函数**:
- `StreamingToolExecutor` — 流式执行工具调用
- `toolExecution()` — 工具执行核心逻辑
- `toolHooks()` — 工具执行前后的钩子
- `toolOrchestration()` — 多工具调用编排

---

## 与其他模块的关系

```
services/analytics  <-- 被所有模块使用（logEvent 是全局 API）
services/api        <-- 被 screens/REPL、cli/print 调用
services/compact    <-- 被 QueryEngine 在 token 超限时调用
services/mcp        <-- 被 commands/mcp、hooks/useMergedTools 使用
services/tools      <-- 被 QueryEngine 的工具执行循环调用
services/lsp        <-- 被 hooks/useLspPluginRecommendation 使用
services/policyLimits <-- 被 init.ts preAction 钩子加载
services/tips       <-- 被 REPL 显示使用提示
```

---

## 设计模式

1. **零依赖公共 API**: `analytics/index.ts` 无任何依赖，避免循环引用
2. **延迟加载**: 大部分服务通过动态 import 按需加载
3. **失败开放**: 远程设置、策略限制等网络依赖采用 fail-open 策略
4. **分层压缩**: compact 模块提供多种粒度的压缩策略
5. **配置驱动**: MCP 服务器通过 JSON 配置文件声明式定义
