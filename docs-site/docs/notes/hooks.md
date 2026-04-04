# src/hooks/ 模块阅读笔记

**文件数量**: 约 147 个（包括子目录）  
**模块定位**: React 自定义 Hooks 层 — 封装 REPL 界面所需的各类副作用和状态逻辑

---

## 目录结构

```
src/hooks/
├── 核心 hooks (顶层文件)
│   ├── useAfterFirstRender.ts      # 首次渲染后执行回调
│   ├── useApiKeyVerification.ts    # API Key 验证
│   ├── useArrowKeyHistory.tsx      # 方向键历史导航
│   ├── useAssistantHistory.ts      # 助手会话历史
│   ├── useAwaySummary.ts           # 离开总结
│   ├── useBackgroundTaskNavigation.ts # 后台任务导航
│   ├── useBlink.ts                 # 闪烁动画效果
│   ├── useCancelRequest.ts         # 取消请求处理 (Ctrl+C)
│   ├── useCanUseTool.tsx           # 工具权限检查
│   ├── useChromeExtensionNotification.tsx # Chrome 扩展通知
│   ├── useClaudeCodeHintRecommendation.tsx # 提示推荐
│   ├── useClipboardImageHint.ts    # 剪贴板图片提示
│   ├── useCommandKeybindings.tsx   # 命令键绑定
│   ├── useCommandQueue.ts          # 命令队列
│   ├── useCopyOnSelect.ts          # 选择复制
│   ├── useDeferredHookMessages.ts  # 延迟 Hook 消息
│   ├── useDiffData.ts              # Diff 数据
│   ├── useDiffInIDE.ts             # IDE 中打开 Diff
│   ├── useDirectConnect.ts         # Direct Connect 会话
│   ├── useDoublePress.ts           # 双击检测
│   ├── useDynamicConfig.ts         # 动态配置
│   ├── useElapsedTime.ts           # 已用时间计时器
│   ├── useExitOnCtrlCD.ts          # Ctrl+C/D 退出
│   ├── useExitOnCtrlCDWithKeybindings.ts # 带键绑定的退出
│   ├── useFileHistorySnapshotInit.ts    # 文件历史快照初始化
│   ├── useGlobalKeybindings.tsx    # 全局键绑定
│   ├── useHistorySearch.ts         # 历史搜索 (Ctrl+R)
│   ├── useIdeAtMentioned.ts        # IDE @提及
│   ├── useIdeConnectionStatus.ts   # IDE 连接状态
│   ├── useIDEIntegration.tsx       # IDE 集成
│   ├── useIdeLogging.ts            # IDE 日志
│   ├── useIdeSelection.ts          # IDE 选区
│   ├── useInboxPoller.ts           # UDS 收件箱轮询 (34KB)
│   ├── useInputBuffer.ts           # 输入缓冲
│   ├── useIssueFlagBanner.ts       # Issue Flag 横幅
│   ├── useLogMessages.ts           # 日志消息
│   ├── useLspPluginRecommendation.tsx # LSP 插件推荐
│   ├── useMailboxBridge.ts         # 邮箱桥接
│   ├── useMainLoopModel.ts         # 主循环模型
│   ├── useManagePlugins.ts         # 插件管理
│   ├── useMemoryUsage.ts           # 内存使用监控
│   ├── useMergedClients.ts         # 合并客户端
│   ├── useMergedCommands.ts        # 合并命令
│   ├── useMergedTools.ts           # 合并工具
│   ├── useMinDisplayTime.ts        # 最小显示时间
│   ├── useNotifyAfterTimeout.ts    # 超时通知
│   ├── useOfficialMarketplaceNotification.tsx # 官方市场通知
│   ├── usePasteHandler.ts          # 粘贴处理
│   ├── usePluginRecommendationBase.tsx # 插件推荐基类
│   ├── usePromptsFromClaudeInChrome.tsx # Chrome 提示注入
│   ├── usePromptSuggestion.ts      # 提示建议
│   ├── usePrStatus.ts              # PR 状态
│   ├── useQueueProcessor.ts        # 队列处理器
│   ├── useRemoteSession.ts         # 远程会话
│   ├── useReplBridge.tsx           # REPL 桥接
│   ├── useScheduledTasks.ts        # 定时任务
│   ├── useSearchInput.ts           # 搜索输入
│   ├── useSessionBackgrounding.ts  # 会话后台化
│   ├── useSettings.ts              # 设置状态
│   ├── useSettingsChange.ts        # 设置变更监听
│   ├── useSkillImprovementSurvey.ts # 技能改进调查
│   ├── useSkillsChange.ts          # 技能变更监听
│   ├── useSSHSession.ts            # SSH 会话
│   ├── useSwarmInitialization.ts   # Swarm 初始化
│   ├── useSwarmPermissionPoller.ts # Swarm 权限轮询
│   ├── useTaskListWatcher.ts       # 任务列表监视器
│   ├── useTasksV2.ts               # 任务 V2
│   ├── useTeammateViewAutoExit.ts  # Teammate 视图自动退出
│   ├── useTeleportResume.tsx       # Teleport 恢复
│   ├── useTerminalSize.ts          # 终端尺寸
│   ├── useTextInput.ts             # 文本输入
│   ├── useTimeout.ts               # 超时
│   ├── useTurnDiffs.ts             # 回合 Diff
│   ├── useTypeahead.tsx            # 自动补全
│   ├── useUpdateNotification.ts    # 更新通知
│   ├── useVimInput.ts              # Vim 输入
│   ├── useVirtualScroll.ts         # 虚拟滚动
│   ├── useVoice.ts                 # 语音
│   ├── useVoiceEnabled.ts          # 语音启用检测
│   └── useVoiceIntegration.tsx     # 语音集成
│
├── notifs/                # 通知类 hooks (18 文件)
│   ├── useAutoModeUnavailableNotification.ts
│   ├── useDeprecationWarningNotification.ts
│   ├── useFastModeNotification.ts
│   ├── useInstallMessages.ts
│   ├── useLspInitializationNotification.ts
│   ├── useMcpConnectivityStatus.ts
│   ├── useModelMigrationNotifications.ts
│   ├── useNpmDeprecationNotification.ts
│   ├── usePluginAutoupdateNotification.ts
│   ├── usePluginInstallationStatus.ts
│   ├── useRateLimitWarningNotification.ts
│   ├── useSettingsErrors.ts
│   └── useTeammateShutdownNotification.ts
│
├── toolPermission/        # 工具权限 hooks (4 文件)
│
├── src/                   # 内部共享代码 (数个子目录)
│
├── fileSuggestions.ts     # 文件建议 (27KB)
├── renderPlaceholder.ts   # 占位符渲染
└── unifiedSuggestions.ts  # 统一建议系统
```

---

## 分类列表

### 输入处理类

| Hook | 说明 | 大小 |
|------|------|------|
| `useTextInput` | 文本输入状态管理 | - |
| `useVimInput` | Vim 模式输入处理 | - |
| `usePasteHandler` | 粘贴内容处理（文本、图片、文件引用） | 10KB |
| `useArrowKeyHistory` | 方向键历史导航 | 9.5KB |
| `useHistorySearch` | Ctrl+R 历史搜索 | 9.5KB |
| `useInputBuffer` | 输入缓冲管理 | 3.4KB |
| `useSearchInput` | 搜索输入框 | - |
| `useTypeahead` | 自动补全/预测输入 | - |

### 会话与状态类

| Hook | 说明 | 大小 |
|------|------|------|
| `useCancelRequest` | 取消 AI 请求（Ctrl+C 处理） | 10KB |
| `useCanUseTool` | 工具权限检查逻辑 | 9.7KB |
| `useLogMessages` | 日志消息管理 | 5.7KB |
| `useMainLoopModel` | 主循环模型状态 | 1.5KB |
| `useQueueProcessor` | 命令队列处理 | - |
| `useSessionBackgrounding` | 会话后台化管理 | - |
| `useCommandQueue` | 命令队列状态 | 0.5KB |

### 远程与协作类

| Hook | 说明 | 大小 |
|------|------|------|
| `useInboxPoller` | UDS 收件箱轮询（最大的 hook） | 34KB |
| `useRemoteSession` | 远程会话管理 | - |
| `useSSHSession` | SSH 会话 | - |
| `useDirectConnect` | Direct Connect 会话 | 7.5KB |
| `useReplBridge` | REPL 桥接（远程控制） | - |
| `useSwarmInitialization` | Agent Swarm 初始化 | - |
| `useSwarmPermissionPoller` | Swarm 权限同步 | - |
| `useMailboxBridge` | 邮箱桥接 | 0.7KB |

### IDE 集成类

| Hook | 说明 | 大小 |
|------|------|------|
| `useIDEIntegration` | IDE 集成核心 | 2.8KB |
| `useIdeSelection` | IDE 选区同步 | 4.3KB |
| `useIdeLogging` | IDE 日志 | 1.2KB |
| `useIdeConnectionStatus` | IDE 连接状态 | 1KB |
| `useDiffInIDE` | 在 IDE 中打开 Diff | 9.9KB |

### 键绑定与 UI 类

| Hook | 说明 | 大小 |
|------|------|------|
| `useGlobalKeybindings` | 全局键绑定处理 | 9.4KB |
| `useCommandKeybindings` | 命令键绑定 | 4.3KB |
| `useExitOnCtrlCD` | Ctrl+C/D 退出处理 | 3.2KB |
| `useBlink` | 闪烁动画 | 1.3KB |
| `useElapsedTime` | 计时器 | 1.2KB |
| `useTerminalSize` | 终端尺寸响应 | - |
| `useVirtualScroll` | 虚拟滚动 | - |
| `useCopyOnSelect` | 选择复制 | 4.3KB |

### 通知类 (notifs/)

| Hook | 说明 |
|------|------|
| `useRateLimitWarningNotification` | 速率限制警告 |
| `useModelMigrationNotifications` | 模型迁移通知 |
| `useDeprecationWarningNotification` | 弃用警告 |
| `usePluginInstallationStatus` | 插件安装状态 |
| `useMcpConnectivityStatus` | MCP 连接状态 |
| `useSettingsErrors` | 设置错误通知 |
| `useFastModeNotification` | 快速模式通知 |
| `useNpmDeprecationNotification` | NPM 弃用通知 |

---

## 核心类型

```typescript
// useCanUseTool.tsx
type CanUseToolFn = (
  tool: Tool,
  input: unknown,
  context: ToolUseContext,
) => Promise<PermissionDecision>;

// useCancelRequest.ts
// 无独立类型导出，通过 React ref 暴露取消句柄

// useInboxPoller.ts
// 管理 UDS 消息轮询的状态机
```

---

## 与其他模块的关系

```
hooks/
  |
  +-- 被 screens/REPL.tsx 大量使用（80+ hooks）
  |
  +-- 调用 services/* (analytics, mcp, compact, tools)
  |
  +-- 调用 utils/* (permissions, config, auth)
  |
  +-- 使用 ink/hooks/* (底层 Ink hooks)
  |
  +-- 被 components/* 中的 React 组件使用
```

REPL.tsx 是 hooks 的主要消费者。几乎所有 hooks 都在 REPL 组件中被调用，构成了交互界面的副作用层。

---

## 设计模式

1. **关注点分离**: 每个 hook 聚焦单一功能（如 `useCancelRequest` 只处理取消逻辑）
2. **组合模式**: 复杂功能通过组合多个简单 hooks 实现
3. **通知 hooks 子目录**: `notifs/` 下的 hooks 专门处理各类系统通知，与 REPL 的通知上下文集成
4. **条件加载**: `useVoiceIntegration` 等通过 `feature()` 门控，在不支持的构建中被替换为空实现
5. **大文件警示**: `useInboxPoller.ts`（34KB）和 `fileSuggestions.ts`（27KB）是最大的 hooks，可能需要关注重构
