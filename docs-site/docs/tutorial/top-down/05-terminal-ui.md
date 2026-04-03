# 第五章：终端 UI 系统 — React in Terminal

> Claude Code 用 React + Ink 在终端中构建了完整的交互界面。这一章揭示终端 UI 的实现原理。

## 5.1 为什么用 React 写终端 UI？

传统终端工具用 `console.log` 或 ncurses。Claude Code 选择 React + Ink 是因为：

1. **声明式 UI** — 描述「界面长什么样」而不是「怎么画」
2. **组件化** — 150+ 可复用组件
3. **状态驱动** — 数据变化自动更新界面
4. **生态复用** — React hooks、Context 等成熟模式

## 5.2 Ink 的工作原理

```
React 组件
    │ 
    ▼ (React Reconciler - react-reconciler 包)
    │
Ink 虚拟 DOM（不是浏览器 DOM！）
    │
    ▼ (Yoga Layout Engine - Facebook 的 Flexbox 引擎)
    │
布局计算（每个节点的 x, y, width, height）
    │
    ▼ (渲染器)
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
| CSS Flexbox | Yoga Flexbox |
| `style={{ color: 'red' }}` | `<Text color="red">` |
| `onClick` | `useInput` hook |
| DOM 事件 | stdin 按键事件 |

## 5.3 核心 Ink 组件

### Box — 布局容器
```tsx
// 相当于浏览器中的 div
<Box flexDirection="column" padding={1} borderStyle="single">
  <Box justifyContent="space-between">
    <Text>左侧</Text>
    <Text>右侧</Text>
  </Box>
</Box>
```

### Text — 文本显示
```tsx
<Text color="cyan" bold>高亮文本</Text>
<Text dimColor>暗淡文本</Text>
<Text backgroundColor="red">红色背景</Text>
```

### ScrollBox — 可滚动区域
```tsx
// 消息列表就是一个 ScrollBox
<ScrollBox height={terminalHeight - 4}>
  {messages.map(msg => <MessageComponent key={msg.id} message={msg} />)}
</ScrollBox>
```

## 5.4 REPL 屏幕结构：screens/REPL.tsx

REPL.tsx 是整个应用最大的组件（~5000行），它的布局：

```
┌──────────────────────────────────────────┐
│  Logo + 状态信息                          │  ← LogoV2 组件
├──────────────────────────────────────────┤
│                                          │
│  消息列表（可滚动）                        │  ← VirtualMessageList
│                                          │
│  ┌─ 用户消息 ──────────┐                 │
│  │ "帮我写个排序函数"    │                 │
│  └─────────────────────┘                 │
│                                          │
│  ┌─ 助手消息 ──────────┐                 │
│  │ 我来帮你写...        │                 │
│  │ ┌─ 工具调用 ─┐      │                 │
│  │ │ Write sort.ts │   │                 │
│  │ └─ 结果: ✓ ──┘      │                 │
│  └─────────────────────┘                 │
│                                          │
├──────────────────────────────────────────┤
│  ┌─ 输入框 ────────────┐                 │  ← PromptInput
│  │ > _                  │                 │
│  └──────────────────────┘                 │
├──────────────────────────────────────────┤
│  状态栏: 模型 | Token | 花费 | 任务      │  ← StatusLine
└──────────────────────────────────────────┘
```

## 5.5 输入处理

```typescript
// useInput hook 处理键盘输入
useInput((input, key) => {
  if (key.return) {
    // Enter 键 → 提交消息
    submitMessage(inputText)
  }
  if (key.ctrl && input === 'c') {
    // Ctrl+C → 中断当前操作
    cancelCurrentOperation()
  }
  if (key.escape) {
    // Esc → 退出特殊模式
    exitMode()
  }
  if (key.upArrow) {
    // ↑ → 历史命令
    navigateHistory(-1)
  }
})
```

## 5.6 渲染优化

终端 UI 的性能挑战与浏览器不同：

```
终端限制：
- 每次"渲染"都是全屏重绘（ANSI 转义序列）
- 高频更新会导致闪烁
- 终端宽度有限，需要精确换行

优化策略：
1. 帧率控制 — 限制渲染频率
2. 虚拟列表 — 只渲染可见区域的消息
3. 输出缓冲 — 批量写入 stdout
4. 增量更新 — 只重绘变化的区域
```

## 5.7 自定义 Ink 实现

Claude Code 没有直接用 npm 的 ink 包，而是在 `src/ink/` 中维护了**自己的 Ink 实现**（~40个文件）。这是因为需要：

- **自定义布局引擎**（支持更复杂的终端布局）
- **搜索高亮**（在终端输出中高亮搜索结果）
- **选择复制**（鼠标选择终端文本）
- **焦点管理**（Tab 键在组件间切换）
- **性能优化**（缓存行宽计算）

```
src/ink/
├── ink.tsx          # Ink 实例创建
├── root.ts          # React 根节点
├── dom.ts           # 虚拟 DOM 实现
├── output.ts        # 输出缓冲
├── render-node-to-output.ts  # 节点 → 终端输出
├── render-to-screen.ts       # 写入终端
├── layout/
│   ├── engine.ts    # 布局引擎
│   ├── yoga.ts      # Yoga Flexbox 绑定
│   ├── node.ts      # 布局节点
│   └── geometry.ts  # 几何计算
├── components/      # 基础组件
│   ├── Box.tsx
│   ├── Text.tsx
│   ├── ScrollBox.tsx
│   └── ...
└── hooks/           # 终端专用 hooks
    ├── use-input.ts
    ├── use-terminal-viewport.ts
    └── ...
```

## 5.8 下一章预告

→ [第六章：权限与安全](06-permissions.md)
