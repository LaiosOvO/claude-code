# 第五章：终端 UI 系统 — React in Terminal

> ccb 用 React + 自定义 Ink 在终端中构建了完整的交互界面。这一章揭示终端 UI 的实现原理。

## 5.1 为什么用 React 写终端 UI？

传统终端工具用 `console.log` 或 ncurses。ccb 选择 React + Ink 是因为：

1. **声明式 UI** — 描述「界面长什么样」而不是「怎么画」
2. **组件化** — 147+ 可复用组件
3. **状态驱动** — 数据变化自动更新界面
4. **生态复用** — React hooks、Context、React Compiler 等成熟模式
5. **类型安全** — TypeScript + TSX 全链路类型检查

## 5.2 自定义 Ink 实现

ccb 没有直接用 npm 的 ink 包，而是在 `src/ink/` 中维护了**完整的自定义 Ink 实现**（48+ 文件）。这是因为需要：

- **自定义布局引擎** — 支持更复杂的终端布局
- **搜索高亮** — `searchHighlight.ts` 在终端输出中高亮搜索结果
- **选择复制** — `selection.ts` 支持鼠标选择终端文本
- **焦点管理** — `focus.ts` Tab 键在组件间切换
- **性能优化** — `line-width-cache.ts` 缓存行宽计算
- **终端查询** — `terminal-querier.ts` 检测终端能力（颜色、Unicode）
- **标签状态** — `use-tab-status.ts` 管理终端标签页状态
- **Bidi 文本** — `bidi.ts` 支持双向文本渲染

```
src/ink/
├── ink.tsx                      # Ink 实例创建 — 导出核心 API
├── root.ts                      # React 根节点管理
├── dom.ts                       # 虚拟 DOM 实现
├── reconciler.ts                # React Reconciler 自定义实现
├── output.ts                    # 输出缓冲
├── render-node-to-output.ts     # 虚拟 DOM → 输出矩阵
├── render-border.ts             # 边框渲染
├── render-to-screen.ts          # 输出矩阵 → ANSI 转义序列
├── renderer.ts                  # 渲染器
├── screen.ts                    # 屏幕管理
├── optimizer.ts                 # 输出优化
├── frame.ts                     # 帧管理
│
├── layout/                      # 布局引擎（基于 Yoga Flexbox）
│   ├── engine.ts                # 布局计算
│   └── ...
│
├── components/                  # 基础组件 (18个)
│   ├── Box.tsx                  #   布局容器（相当于 <div>）
│   ├── Text.tsx                 #   文本（相当于 <span>）
│   ├── ScrollBox.tsx            #   可滚动区域
│   ├── App.tsx                  #   Ink 应用包装器
│   ├── AppContext.ts            #   应用上下文
│   ├── Link.tsx                 #   超链接
│   ├── Button.tsx               #   按钮
│   ├── Spacer.tsx               #   弹性空间
│   ├── Newline.tsx              #   换行
│   ├── NoSelect.tsx             #   不可选择区域
│   ├── RawAnsi.tsx              #   原始 ANSI 输出
│   ├── AlternateScreen.tsx      #   备用屏幕缓冲区
│   ├── ErrorOverview.tsx        #   错误展示
│   └── ...
│
├── hooks/                       # 终端专用 hooks (12个)
│   ├── use-input.ts             #   键盘输入
│   ├── use-stdin.ts             #   标准输入
│   ├── use-terminal-viewport.ts #   终端视口大小
│   ├── use-terminal-focus.ts    #   终端焦点
│   ├── use-terminal-title.ts    #   终端标题
│   ├── use-tab-status.ts        #   标签页状态
│   ├── use-search-highlight.ts  #   搜索高亮
│   ├── use-selection.ts         #   文本选择
│   ├── use-declared-cursor.ts   #   光标声明
│   ├── use-animation-frame.ts   #   动画帧
│   ├── use-interval.ts          #   定时器
│   └── use-app.ts               #   应用上下文
│
├── events/                      # 事件系统
├── termio/                      # 终端底层 I/O
│   ├── dec.ts                   #   DEC 特殊字符（SHOW_CURSOR 等）
│   └── ...
│
├── searchHighlight.ts           # 搜索结果高亮
├── selection.ts                 # 鼠标选择
├── focus.ts                     # 焦点管理
├── hit-test.ts                  # 点击测试（鼠标交互）
├── stringWidth.ts               # 字符串宽度计算
├── line-width-cache.ts          # 行宽缓存
├── measure-text.ts              # 文本测量
├── measure-element.ts           # 元素测量
├── colorize.ts                  # 颜色处理
├── Ansi.tsx                     # ANSI 相关
├── bidi.ts                      # 双向文本
├── cursor.ts                    # 光标操作
├── constants.ts                 # 常量
├── styles.ts                    # 样式
├── supports-hyperlinks.ts       # 超链接支持检测
├── tabstops.ts                  # 制表位
├── squash-text-nodes.ts         # 文本节点合并
├── wrapAnsi.ts                  # ANSI 换行
├── wrap-text.ts                 # 文本换行
└── node-cache.ts                # 节点缓存
```

## 5.3 Ink 的工作原理

```
React 组件（JSX）
    │
    ▼ (reconciler.ts — 自定义 React Reconciler)
    │
Ink 虚拟 DOM (dom.ts — 不是浏览器 DOM！)
    │
    ▼ (layout/engine.ts — Yoga Flexbox 引擎)
    │
布局计算（每个节点的 x, y, width, height）
    │
    ▼ (render-node-to-output.ts)
    │
输出矩阵（二维字符数组）
    │
    ▼ (render-to-screen.ts + optimizer.ts)
    │
ANSI 转义序列字符串
    │
    ▼ (写入 stdout)
    │
终端显示
```

### Ink 组件 vs 浏览器组件

| 浏览器 React | Ink (终端) |
|-------------|-----------|
| `<div>` | `<Box>` |
| `<span>` | `<Text>` |
| `<a>` | `<Link>` |
| CSS Flexbox | Yoga Flexbox |
| `style={{ color: 'red' }}` | `<Text color="red">` |
| `onClick` | `useInput` hook |
| DOM 事件 | stdin 按键事件 |
| `document.title = ...` | `useTerminalTitle()` |
| `window.innerWidth` | `useTerminalSize()` |
| `scroll` | `<ScrollBox>` |

## 5.4 REPL 屏幕结构：screens/REPL.tsx (5003行)

REPL.tsx 是整个应用最大的组件，它定义了交互界面的全部逻辑：

```
┌──────────────────────────────────────────┐
│  Logo + 状态信息 + 提示                   │  ← LogoV2 组件
│  Model: opus-4 | Tokens: 12k | $0.15     │
├──────────────────────────────────────────┤
│                                          │
│  消息列表（虚拟滚动）                      │  ← VirtualMessageList
│                                          │
│  ┌─ 用户消息 ──────────┐                 │
│  │ "帮我写个排序函数"    │                 │
│  └─────────────────────┘                 │
│                                          │
│  ┌─ 助手消息 ──────────┐                 │
│  │ 我来帮你写...        │                 │
│  │ ┌─ 工具调用 ───────┐ │                │
│  │ │ Write sort.ts    │ │                │
│  │ │ ┌─ 差异视图 ──┐  │ │                │  ← diff/ 组件
│  │ │ │ +function... │  │ │                │
│  │ │ └─────────────┘  │ │                │
│  │ └─ 结果: ✓ ────────┘ │                │
│  └──────────────────────┘                │
│                                          │
│  ┌─ Spinner ───────────┐                 │  ← SpinnerWithVerb
│  │ ◉ Thinking...       │                 │
│  └─────────────────────┘                 │
│                                          │
├──────────────────────────────────────────┤
│  [权限对话框（条件显示）]                   │  ← PermissionRequest
│  Allow BashTool to run "npm test"?       │
│  [y] Yes  [n] No  [a] Always Allow       │
├──────────────────────────────────────────┤
│  ┌─ 输入框 ────────────┐                 │  ← PromptInput
│  │ > _                  │                 │     支持 Vim 模式
│  └──────────────────────┘                 │
├──────────────────────────────────────────┤
│  状态栏: 模型 | Token | 花费 | 快捷键     │  ← StatusLine
└──────────────────────────────────────────┘
```

### REPL.tsx 的主要职责

REPL.tsx 5003行中包含了大量逻辑：

```typescript
// 概念上 REPL.tsx 的结构
function REPL(props) {
  // === 状态管理 (30+ useState) ===
  const [messages, setMessages] = useState([])
  const [inputMode, setInputMode] = useState<PromptInputMode>('normal')
  const [isStreaming, setIsStreaming] = useState(false)
  const [permissionRequest, setPermissionRequest] = useState(null)
  // ...

  // === Hooks (50+) ===
  const { width, height } = useTerminalSize()
  const { cost, tokens } = useCostSummary()
  useReplBridge(...)         // Bridge 远程控制集成
  useSSHSession(...)         // SSH 会话管理
  useAssistantHistory(...)   // 助手历史（Kairos）
  useIdeLogging(...)         // IDE 集成日志
  useSearchInput(...)        // 搜索输入
  useSearchHighlight(...)    // 搜索高亮
  useNotifications(...)      // 通知系统
  useMoreRight(...)          // MoreRight 功能
  useSkillImprovementSurvey(...)  // 技能改进调查
  // ...

  // === 消息提交 ===
  const submitMessage = useCallback(async (text) => {
    // 1. 检查是否是 /command
    // 2. 创建 UserMessage
    // 3. 调用 QueryEngine.submitMessage()
    // 4. 消费 AsyncGenerator 事件
    // 5. 更新 UI
  }, [])

  // === 权限处理 ===
  const handlePermission = useCallback(async (toolUse) => {
    setPermissionRequest(toolUse)
    const decision = await waitForUserDecision()
    setPermissionRequest(null)
    return decision
  }, [])

  // === 渲染 ===
  return (
    <Box flexDirection="column" height={height}>
      <VirtualMessageList messages={messages} ... />
      {permissionRequest && <PermissionRequest ... />}
      {elicitation && <ElicitationDialog ... />}
      <PromptInput onSubmit={submitMessage} mode={inputMode} ... />
      <StatusLine cost={cost} tokens={tokens} model={model} />
    </Box>
  )
}
```

## 5.5 组件层次结构

```
<App>                           ← components/App.tsx — 顶层包装器
  <FpsMetricsProvider>          ← 帧率监控
    <StatsProvider>             ← 统计上下文
      <AppStateProvider>        ← 全局状态（类 Zustand）
        <VoiceProvider>         ← 语音模式（feature gate）
          <MailboxProvider>     ← 消息邮箱
            <REPL>              ← screens/REPL.tsx — 主界面
              <VirtualMessageList>
                <UserMessageComponent>
                <AssistantMessageComponent>
                  <ToolUseComponent>
                    <UI.tsx>    ← 每个工具的 UI 组件
              <PermissionRequest>
              <ElicitationDialog>
              <PromptDialog>
              <PromptInput>
                <BaseTextInput>
              <StatusLine>
              <CostThresholdDialog>
              <IdleReturnDialog>
              <SkillImprovementSurvey>
              <CoordinatorAgentStatus>
              <WorkerPendingPermission>
```

## 5.6 状态管理：AppState（类 Zustand）

ccb 实现了类似 Zustand 的轻量状态管理：

```typescript
// src/state/store.ts
export function createStore(
  initialState: AppState,
  onChange?: ({ newState, oldState }) => void,
): AppStateStore {
  let state = initialState
  const listeners = new Set<() => void>()

  return {
    getState: () => state,
    setState: (fn) => {
      const oldState = state
      state = fn(state)
      if (onChange) onChange({ newState: state, oldState })
      listeners.forEach(l => l())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// 在组件中使用
function MyComponent() {
  const store = useContext(AppStoreContext)
  const value = useSyncExternalStore(
    store.subscribe,
    () => store.getState().someValue,
  )
}
```

AppState 包含：
- 工具权限上下文
- MCP 连接状态
- 当前主题（light/dark/auto）
- Agent 定义
- 推测执行状态
- 任务列表
- 团队成员状态
- ...大量运行时状态

## 5.7 输入处理

### 键盘输入
```typescript
// src/ink/hooks/use-input.ts
useInput((input, key) => {
  if (key.return) {
    submitMessage(inputText)    // Enter → 提交
  }
  if (key.ctrl && input === 'c') {
    cancelCurrentOperation()    // Ctrl+C → 中断
  }
  if (key.escape) {
    exitMode()                  // Esc → 退出
  }
  if (key.upArrow) {
    navigateHistory(-1)         // ↑ → 历史
  }
})
```

### Vim 模式

ccb 实现了完整的 Vim 模式（`src/vim/`）：

```
src/vim/
├── motions.ts        # 移动命令 (h/j/k/l/w/b/e/0/$...)
├── operators.ts      # 操作符 (d/c/y/p...)
├── textObjects.ts    # 文本对象 (iw/aw/i"/a"...)
├── transitions.ts    # 模式转换 (Normal → Insert → Visual...)
└── types.ts          # 类型定义 (VimMode, VimState...)
```

输入框支持 Normal / Insert / Visual 三种模式。

### 快捷键系统

```typescript
// 可配置的快捷键
// 存储在 ~/.claude/keybindings.json
useCommandKeybindings()     // 命令快捷键
useGlobalKeybindings()      // 全局快捷键
useExitOnCtrlCD()           // Ctrl+C/D 退出
useBackgroundTaskNavigation() // 后台任务导航
```

## 5.8 渲染优化

终端 UI 面临独特的性能挑战：

### 挑战 1：全屏重绘
```
终端的"渲染"= 清屏 + 写入 ANSI 转义序列
高频更新 → 闪烁
```

### 优化策略

**帧率控制**
```typescript
// FpsMetricsProvider 追踪渲染帧率
const { getFpsMetrics } = useFpsMetrics()
// 限制渲染频率，避免过度重绘
```

**虚拟列表**
```typescript
// VirtualMessageList 只渲染可见区域的消息
// 长对话（数百条消息）不会拖慢渲染
<VirtualMessageList
  messages={messages}
  height={availableHeight}
  // 只渲染视口内的消息
/>
```

**输出缓冲**
```typescript
// src/ink/output.ts
// 批量写入 stdout，减少 syscall 次数
```

**行宽缓存**
```typescript
// src/ink/line-width-cache.ts
// 缓存字符串宽度计算（Unicode 字符宽度不固定）
// 避免重复计算同一字符串的显示宽度
```

**React Compiler**
```typescript
// REPL.tsx 和 AppState.tsx 使用 React Compiler（react/compiler-runtime）
// 自动优化 re-render，无需手动 useMemo/useCallback
import { c as _c } from "react/compiler-runtime";
```

## 5.9 Bridge / SSH / Voice 集成

REPL.tsx 通过 hooks 集成了多种远程和输入模式：

### Bridge 远程控制
```typescript
// hooks/useReplBridge.ts
// 让外部（手机、网页）通过 Bridge 服务控制本地 ccb
useReplBridge({
  onRemoteMessage: (msg) => submitMessage(msg),
  onRemotePermission: (decision) => handlePermission(decision),
})
```

### SSH 会话
```typescript
// hooks/useSSHSession.ts
// 管理通过 SSH 连接的远程会话
useSSHSession({
  session: sshSession,  // src/ssh/createSSHSession.ts
})
```

### 语音模式
```typescript
// state/AppState.tsx 中条件加载
const VoiceProvider = feature('VOICE_MODE')
  ? require('../context/voice.js').VoiceProvider
  : ({ children }) => children;

// services/voice.ts — 语音处理
// services/voiceStreamSTT.ts — 流式语音转文字
// packages/audio-capture-napi — 原生音频捕获
```

### Assistant 历史（Kairos）
```typescript
// hooks/useAssistantHistory.ts
// 管理 Kairos 助手模式的会话历史
useAssistantHistory({
  onSessionSelect: (session) => resumeSession(session),
})
```

## 5.10 Buddy AI 助手

ccb 有一个名为 Buddy 的伴侣 AI：

```
src/buddy/
├── companion.ts            # 伴侣逻辑
├── CompanionSprite.tsx     # 精灵动画组件
├── prompt.ts               # 伴侣的系统提示词
├── sprites.ts              # 精灵图素材
├── types.ts                # 类型定义
└── useBuddyNotification.tsx # 通知 hook
```

Buddy 在输入框旁边显示一个小机器人精灵，偶尔在对话气泡中发表评论。

## 5.11 组件设计系统

```
src/components/design-system/
└── ...  # 统一的设计组件

src/components/
├── diff/                    # 差异显示组件
├── permissions/             # 权限对话框组件
│   ├── PermissionRequest.tsx
│   └── WorkerPendingPermission.tsx
├── PromptInput/             # 输入框组件
│   ├── PromptInput.tsx
│   └── PromptInputQueuedCommands.tsx
├── CustomSelect/            # 自定义选择器
├── ClaudeCodeHint/          # 提示组件
├── DesktopUpsell/           # 桌面版推广
├── Spinner.tsx              # 加载动画
├── CompactSummary.tsx       # 压缩摘要
├── ContextVisualization.tsx # 上下文可视化
├── CoordinatorAgentStatus.tsx # 协调器状态
├── DiagnosticsDisplay.tsx   # 诊断信息
├── ExportDialog.tsx         # 导出对话框
├── MessageSelector.tsx      # 消息选择器
└── ...                      # 147+ 组件
```

## 5.12 主要 React Hooks

ccb 有 86+ 自定义 hooks：

| Hook | 用途 |
|------|------|
| `useTerminalSize` | 终端宽高 |
| `useCanUseTool` | 工具权限检查 |
| `useReplBridge` | Bridge 远程控制 |
| `useSSHSession` | SSH 会话管理 |
| `useAssistantHistory` | Kairos 助手历史 |
| `useSearchInput` | 搜索输入 |
| `useCostSummary` | 花费摘要 |
| `useLogMessages` | 日志消息 |
| `useIdeLogging` | IDE 集成日志 |
| `useNotifications` | 通知系统 |
| `useRemoteSession` | 远程会话 |
| `useDirectConnect` | 直连模式 |
| `useMoreRight` | MoreRight 功能 |
| `useCommandKeybindings` | 命令快捷键 |
| `useGlobalKeybindings` | 全局快捷键 |
| `useArrowKeyHistory` | 箭头键历史 |
| `useHistorySearch` | 历史搜索 |
| `useFileHistorySnapshotInit` | 文件历史快照 |
| `useAfterFirstRender` | 首次渲染后 |
| `useDeferredHookMessages` | 延迟 hook 消息 |
| `useSkillImprovementSurvey` | 技能改进调查 |
| `useBlink` | 闪烁动画 |
| `useElapsedTime` | 经过时间 |
| `useDiffData` | 差异数据 |
| `useInboxPoller` | UDS 收件箱轮询 |
| `useInputBuffer` | 输入缓冲 |
| `useSettingsChange` | 设置变更 |
| ... | ... |

## 5.13 架构总结

```
┌─────────────────────────────────────────────────────┐
│                     用户                              │
│                   终端窗口                             │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌───── REPL Screen (5003行) ──────────────────────┐ │
│  │                                                  │ │
│  │  ┌─ VirtualMessageList ──────────────────────┐  │ │
│  │  │  React 组件 → 自定义 Ink → Yoga 布局       │  │ │
│  │  │  → 输出矩阵 → ANSI 序列 → stdout          │  │ │
│  │  └───────────────────────────────────────────┘  │ │
│  │                                                  │ │
│  │  ┌─ PromptInput ─────────────────────────────┐  │ │
│  │  │  Vim 模式 / 正常输入 / 搜索模式            │  │ │
│  │  │  快捷键绑定 / 历史导航 / 自动补全          │  │ │
│  │  └───────────────────────────────────────────┘  │ │
│  │                                                  │ │
│  └──────────────────────────────────────────────────┘ │
│                                                      │
│  ┌─ 状态层 ──────────────────────────────────────────┐│
│  │  AppState (类 Zustand) — 权限/MCP/主题/任务/团队   ││
│  │  Context Providers — FPS/Stats/Voice/Mailbox       ││
│  └───────────────────────────────────────────────────┘│
│                                                      │
│  ┌─ 集成层 ──────────────────────────────────────────┐│
│  │  Bridge(远程) / SSH / Voice(语音) / IDE / Buddy    ││
│  └───────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

ccb 的终端 UI 是整个项目中最复杂的部分之一。它将 React 的声明式编程模型完整地搬到了终端环境中，同时通过自定义 Ink 实现、虚拟列表、React Compiler 等手段保证了性能。加上 Vim 模式、Bridge 远程控制、Voice 语音输入、SSH 会话等集成，构成了一个功能完备的终端 IDE 体验。
