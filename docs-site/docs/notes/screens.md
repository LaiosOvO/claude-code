# src/screens/ 模块阅读笔记

**文件数量**: 约 51 个（包括子目录）  
**模块定位**: 顶层屏幕组件 — REPL 主界面及辅助对话框的 React 组件

---

## 目录结构

```
src/screens/
├── REPL.tsx                   # 主 REPL 界面 (258KB — 代码库最大文件)
├── Doctor.tsx                 # 诊断工具界面 (19KB)
├── ResumeConversation.tsx     # 会话恢复界面 (16KB)
└── src/                       # 内部子模块
    ├── cli/
    │   └── structuredIO.ts    # 结构化 I/O (SDK/print 模式)
    ├── components/
    │   ├── AutoModeOptInDialog.ts
    │   ├── ClaudeCodeHint/
    │   │   └── PluginHintMenu.ts
    │   ├── DesktopUpsell/
    │   │   └── DesktopUpsellStartup.ts
    │   ├── FeedbackSurvey/
    │   │   ├── FeedbackSurvey.ts
    │   │   ├── useFeedbackSurvey.ts
    │   │   ├── useMemorySurvey.ts
    │   │   └── usePostCompactSurvey.ts
    │   ├── KeybindingWarnings.ts
    │   ├── LspRecommendation/
    │   │   └── LspRecommendationMenu.ts
    │   ├── mcp/
    │   │   └── McpParsingWarnings.ts
    │   ├── messages/
    │   │   └── UserTextMessage.ts
    │   └── permissions/
    │       └── SandboxPermissionRequest.ts
    ├── hooks/
    │   ├── notifs/            # 通知 hooks
    │   │   ├── useAutoModeUnavailableNotification.ts
    │   │   ├── useCanSwitchToExistingSubscription.ts
    │   │   ├── useDeprecationWarningNotification.ts
    │   │   ├── useFastModeNotification.ts
    │   │   ├── useIDEStatusIndicator.ts
    │   │   ├── useInstallMessages.ts
    │   │   ├── useLspInitializationNotification.ts
    │   │   ├── useMcpConnectivityStatus.ts
    │   │   ├── useModelMigrationNotifications.ts
    │   │   ├── useNpmDeprecationNotification.ts
    │   │   ├── usePluginAutoupdateNotification.ts
    │   │   ├── usePluginInstallationStatus.ts
    │   │   ├── useRateLimitWarningNotification.ts
    │   │   ├── useSettingsErrors.ts
    │   │   └── useTeammateShutdownNotification.ts
    │   ├── useAwaySummary.ts
    │   ├── useChromeExtensionNotification.ts
    │   ├── useClaudeCodeHintRecommendation.ts
    │   ├── useFileHistorySnapshotInit.ts
    │   ├── useLspPluginRecommendation.ts
    │   ├── useOfficialMarketplaceNotification.ts
    │   ├── usePromptsFromClaudeInChrome.ts
    │   └── useTerminalSize.ts
    ├── services/
    │   ├── analytics/
    │   │   ├── growthbook.ts
    │   │   └── index.ts
    │   ├── mcp/
    │   │   └── MCPConnectionManager.ts
    │   └── tips/
    │       └── tipScheduler.ts
    └── utils/
        ├── context.ts
        ├── envUtils.ts
        ├── permissions/
        │   └── bypassPermissionsKillswitch.ts
        ├── plugins/
        │   └── performStartupChecks.ts
        ├── sandbox/
        │   └── sandbox-adapter.ts
        ├── settings/
        │   └── constants.ts
        └── theme.ts
```

---

## 核心文件：REPL.tsx

**文件大小**: 258KB（约 6500+ 行）  
**这是 Claude Code 代码库中最大的单个文件。**

### Props 类型

```typescript
interface REPLProps {
  debug: boolean;
  commands: Command[];
  initialTools: Tool[];
  initialMessages: Message[];
  mcpClients: McpClient[];
  autoConnectIdeFlag: boolean;
  mainThreadAgentDefinition?: AgentDefinition;
  disableSlashCommands: boolean;
  thinkingConfig: ThinkingConfig;
  // ... 更多可选属性
  directConnectConfig?: DirectConnectConfig;
  sshSession?: SSHSession;
  remoteControl?: boolean;
}
```

### 职责分解

REPL 组件承担了极为广泛的职责，可以分为以下几个领域：

#### 1. 消息管理
- 维护完整的消息列表（用户消息、AI 响应、系统消息、Hook 消息）
- 处理消息的追加、替换、压缩后的更新
- 支持消息选择和回滚

#### 2. AI 查询循环
- 通过 `QueryGuard` 管理 AI 请求的生命周期
- 处理流式响应、token 预算、中断和重试
- 管理 turn（回合）之间的状态转换

#### 3. 工具执行
- 权限请求对话框（`PermissionRequest` 组件）
- 工具使用确认队列
- Sandbox 权限同步

#### 4. 输入处理
- `PromptInput` 组件集成
- 命令解析（`/command` 斜杠命令）
- 粘贴处理、Vim 模式、历史导航
- Early input 消费（启动期间捕获的按键）

#### 5. 远程会话
- SSH 会话管理
- Direct Connect 连接
- Teleport 远程传送
- Bridge/Remote Control

#### 6. 团队协作（Agent Swarm）
- Leader/Worker 角色管理
- 权限同步
- 任务注入和消息路由

#### 7. 后台服务
- MCP 连接管理
- LSP 集成
- 插件更新检查
- 定时任务调度

#### 8. UI 状态
- 加载指示器（Spinner）
- 费用追踪显示
- 通知横幅
- Idle 返回对话框
- 费用阈值对话框

### 使用的 Hooks（不完全列表）

REPL.tsx 调用了 80+ 个自定义 hooks，包括但不限于：

```
useCancelRequest, useGlobalKeybindings, useCommandKeybindings,
useLogMessages, useAfterFirstRender, useDeferredHookMessages,
useApiKeyVerification, useInboxPoller, useReplBridge,
useRemoteSession, useDirectConnect, useSSHSession,
useAssistantHistory, useSwarmInitialization,
useTeammateViewAutoExit, useBackgroundTaskNavigation,
useTurnDiffs, usePasteHandler, useHistorySearch,
useVoiceIntegration, useCopyOnSelect, useVirtualScroll,
useTerminalSize, useSettings, useSettingsChange,
useManagePlugins, useMergedTools, useMergedCommands,
useMainLoopModel, ...
```

---

## Doctor.tsx

**文件大小**: 19KB  
**功能**: 系统诊断工具（`/doctor` 命令的界面）

检查内容包括：
- 系统环境（操作系统、Node.js 版本、shell）
- 认证状态
- 网络连接
- MCP 服务器状态
- 插件状态
- 配置文件验证

---

## ResumeConversation.tsx

**文件大小**: 16KB  
**功能**: 会话恢复界面（`--resume` 选项的交互式选择器）

- 列出可恢复的历史会话
- 支持搜索和筛选
- 支持自定义标题搜索
- 显示会话摘要和时间

---

## src/ 子模块

### src/components/

屏幕级别的子组件，与 REPL 紧密耦合：

- **AutoModeOptInDialog** — Auto 权限模式同意对话框
- **FeedbackSurvey/** — 各类反馈调查（通用、记忆、压缩后）
- **PluginHintMenu** — 插件提示菜单
- **SandboxPermissionRequest** — 沙箱权限请求

### src/hooks/

屏幕级别的 hooks，处理通知和状态：

- **notifs/** — 15 个通知 hooks，每个处理一种系统通知
  - 速率限制、模型迁移、NPM 弃用、插件更新等

### src/services/

屏幕级别的服务适配器：

- **analytics/** — GrowthBook 和分析事件的屏幕层封装
- **mcp/** — MCP 连接管理器
- **tips/** — 提示调度器

### src/utils/

屏幕级别的工具函数：

- **context.ts** — 上下文工具
- **permissions/** — 权限绕过紧急开关
- **plugins/** — 插件启动检查
- **sandbox/** — 沙箱适配器

---

## 与其他模块的关系

```
screens/
  |
  +-- REPL.tsx 是所有交互的汇聚点
  |       |
  |       +-- 使用 80+ hooks/ 的自定义 hooks
  |       +-- 使用 components/* 的 UI 组件
  |       +-- 使用 ink/ 的底层 UI 原语
  |       +-- 调用 services/* 的业务逻辑
  |       +-- 通过 commands.ts 执行斜杠命令
  |
  +-- 被 replLauncher.tsx 动态加载和渲染
  |
  +-- 被 main.tsx 的 launchRepl() 调用
  |
  +-- Doctor.tsx 被 /doctor 命令触发
  +-- ResumeConversation.tsx 被 --resume 选项触发
```

---

## 设计模式

1. **单一大组件**: REPL.tsx 采用"巨石组件"模式，将所有交互状态集中管理。虽然文件很大，但避免了复杂的跨组件状态同步。
2. **Hook 组合**: 通过大量自定义 hooks 将副作用逻辑外置，REPL 本身主要是 hooks 的编排层。
3. **延迟加载**: `screens/src/` 下的组件和 hooks 按需导入，减少初始加载。
4. **分层通知**: `src/hooks/notifs/` 采用统一模式处理各类系统通知，每个通知是独立的 hook。
5. **条件渲染**: REPL 内大量使用条件渲染——根据当前状态（空闲、加载、权限请求、对话框等）切换显示内容。
