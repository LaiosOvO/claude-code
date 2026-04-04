# src/ink/ 模块阅读笔记

**文件数量**: 约 104 个（包括子目录）  
**模块定位**: 自定义 Ink 框架 — Claude Code 深度定制的终端 UI 渲染引擎，基于 React + Yoga 布局

---

## 目录结构

```
src/ink/
├── 核心渲染管线
│   ├── ink.tsx              # Ink 主类 — 76KB，渲染循环核心
│   ├── reconciler.ts        # React Reconciler 适配器
│   ├── dom.ts               # 虚拟 DOM 节点
│   ├── renderer.ts          # 渲染器（帧构建）
│   ├── output.ts            # 输出缓冲区管理
│   ├── render-node-to-output.ts  # 节点到输出的转换 (63KB)
│   ├── render-border.ts     # 边框渲染
│   ├── render-to-screen.ts  # 输出到屏幕的最终写入
│   ├── log-update.ts        # 增量日志更新 (27KB)
│   ├── screen.ts            # 屏幕缓冲区 (49KB)
│   ├── frame.ts             # 帧数据结构
│   ├── optimizer.ts         # 帧输出优化
│   └── root.ts              # Ink Root 实例管理
│
├── 布局引擎 (layout/)
│   ├── engine.ts            # 布局计算引擎
│   ├── geometry.ts          # 几何计算
│   ├── node.ts              # 布局节点
│   └── yoga.ts              # Yoga Layout 绑定
│
├── 事件系统 (events/)
│   ├── dispatcher.ts        # 事件分发器
│   ├── emitter.ts           # 事件发射器
│   ├── event-handlers.ts    # 事件处理器注册
│   ├── event.ts             # 基础事件类型
│   ├── click-event.ts       # 点击事件
│   ├── focus-event.ts       # 焦点事件
│   ├── input-event.ts       # 输入事件
│   ├── keyboard-event.ts    # 键盘事件
│   ├── paste-event.ts       # 粘贴事件
│   ├── resize-event.ts      # 调整大小事件
│   ├── terminal-event.ts    # 终端事件
│   └── terminal-focus-event.ts # 终端焦点事件
│
├── 终端 I/O (termio/)
│   ├── ansi.ts              # ANSI 转义序列
│   ├── csi.ts               # CSI（控制序列引导器）
│   ├── dec.ts               # DEC 私有模式序列
│   ├── esc.ts               # ESC 转义序列
│   ├── osc.ts               # OSC（操作系统命令）
│   ├── sgr.ts               # SGR（选择图形表现）
│   ├── parser.ts            # 转义序列解析器
│   ├── tokenize.ts          # 转义序列分词器
│   └── types.ts             # 终端 I/O 类型
│
├── 内置 React 组件 (components/)
│   ├── AlternateScreen.tsx  # 备用屏幕
│   ├── App.tsx              # Ink 内部 App 容器
│   ├── AppContext.ts        # App 上下文
│   ├── Box.tsx              # 盒模型组件
│   ├── Button.tsx           # 按钮组件
│   ├── ClockContext.tsx      # 时钟上下文
│   ├── CursorDeclarationContext.ts # 光标声明上下文
│   ├── ErrorOverview.tsx    # 错误概览
│   ├── Link.tsx             # 超链接组件
│   ├── Newline.tsx          # 换行组件
│   ├── NoSelect.tsx         # 不可选择区域
│   ├── RawAnsi.tsx          # 原始 ANSI 输出
│   ├── ScrollBox.tsx        # 滚动容器
│   ├── Spacer.tsx           # 间隔组件
│   ├── StdinContext.ts      # 标准输入上下文
│   ├── TerminalFocusContext.tsx # 终端焦点上下文
│   ├── TerminalSizeContext.tsx  # 终端尺寸上下文
│   └── Text.tsx             # 文本组件
│
├── 内置 React Hooks (hooks/)
│   ├── use-animation-frame.ts   # 动画帧
│   ├── use-app.ts               # Ink App 实例
│   ├── use-declared-cursor.ts   # 声明式光标
│   ├── use-input.ts             # 键盘输入
│   ├── use-interval.ts          # 定时器
│   ├── use-search-highlight.ts  # 搜索高亮
│   ├── use-selection.ts         # 文本选择
│   ├── use-stdin.ts             # 标准输入
│   ├── use-tab-status.ts        # Tab 状态
│   ├── use-terminal-focus.ts    # 终端焦点
│   ├── use-terminal-title.ts    # 终端标题
│   └── use-terminal-viewport.ts # 终端视口
│
├── 文本处理
│   ├── Ansi.tsx             # ANSI 序列 React 组件
│   ├── bidi.ts              # 双向文本支持
│   ├── colorize.ts          # 颜色化处理
│   ├── measure-text.ts      # 文本测量
│   ├── stringWidth.ts       # 字符串宽度计算
│   ├── styles.ts            # 样式处理 (20KB)
│   ├── squash-text-nodes.ts # 文本节点合并
│   ├── tabstops.ts          # Tab 制表位处理
│   ├── wrap-text.ts         # 文本换行
│   ├── widest-line.ts       # 最宽行计算
│   └── wrapAnsi.ts          # ANSI 感知文本换行
│
├── 交互功能
│   ├── clearTerminal.ts     # 终端清屏
│   ├── cursor.ts            # 光标管理
│   ├── focus.ts             # 焦点管理
│   ├── hit-test.ts          # 点击命中测试
│   ├── parse-keypress.ts    # 按键解析 (23KB)
│   ├── searchHighlight.ts   # 搜索高亮
│   ├── selection.ts         # 文本选择 (34KB)
│   ├── terminal-querier.ts  # 终端能力查询
│   └── terminal.ts          # 终端适配
│
├── 实用工具
│   ├── constants.ts         # 常量定义
│   ├── devtools.ts          # 开发工具支持
│   ├── get-max-width.ts     # 最大宽度计算
│   ├── instances.ts         # 实例管理
│   ├── line-width-cache.ts  # 行宽缓存
│   ├── measure-element.ts   # 元素测量
│   ├── node-cache.ts        # 节点缓存
│   ├── supports-hyperlinks.ts # 超链接支持检测
│   ├── terminal-focus-state.ts # 终端焦点状态
│   ├── warn.ts              # 警告输出
│   └── termio.ts            # 终端 I/O 入口
│
└── useTerminalNotification.ts # 终端通知 hook
```

---

## 架构设计

### 渲染管线

```
React 组件树
    |
    v
reconciler.ts (React Reconciler)
    |  - 将 React 虚拟 DOM 映射到 Ink 节点
    v
dom.ts (虚拟 DOM)
    |  - Ink 特有的节点树
    v
layout/ (Yoga 布局引擎)
    |  - 计算每个节点的位置和尺寸
    v
render-node-to-output.ts
    |  - 将布局后的节点转换为字符输出
    v
output.ts (输出缓冲区)
    |  - 2D 字符网格
    v
render-to-screen.ts
    |  - 搜索高亮、选择叠加
    v
screen.ts (屏幕缓冲区)
    |  - 双缓冲差分更新
    v
log-update.ts
    |  - 增量终端写入
    v
terminal (stdout)
```

### 核心类：Ink

**文件**: `ink.tsx` (76KB)

这是整个 Ink 框架的核心类，职责包括：

1. **帧调度**: 使用 requestAnimationFrame 风格的帧循环
2. **React 根管理**: 通过 reconciler 驱动 React fiber 树
3. **事件分发**: 键盘、鼠标、粘贴、调整大小等事件
4. **屏幕管理**: 双缓冲、差分更新、同步输出
5. **选择和搜索**: 文本选择、搜索高亮
6. **焦点管理**: Tab 导航和焦点追踪
7. **光标管理**: 声明式光标位置

---

## 关键函数签名

```typescript
// ink.tsx - Ink 类核心方法
class Ink {
  render(element: ReactNode): void;
  unmount(): void;
  waitUntilExit(): Promise<void>;
  // 内部方法
  private onRender(): void;           // 渲染回调
  private renderFrame(): Frame;       // 构建帧
  private handleInput(data: Buffer): void; // 输入处理
}

// reconciler.ts
const reconciler = createReconciler({
  createInstance(type, props): DOMElement;
  appendChildToContainer(container, child): void;
  commitUpdate(instance, type, oldProps, newProps): void;
  // ...
});

// screen.ts
function createScreen(width, height): Screen;
function cellAt(screen, x, y): Cell;

// selection.ts
function createSelectionState(): SelectionState;
function startSelection(state, x, y): SelectionState;
function getSelectedText(state): string;
```

---

## 与其他模块的关系

```
ink/
  |
  +-- 被 screens/REPL.tsx 使用 (Box, Text, useInput, useStdin 等)
  |
  +-- 被 components/* 使用 (所有 UI 组件的基础)
  |
  +-- 被 interactiveHelpers.tsx 使用 (createRoot, Root)
  |
  +-- 被 hooks/* 使用 (ink/hooks 提供底层 hooks)
  |
  +-- 依赖 native-ts/yoga-layout (布局计算)
```

---

## 相比官方 Ink 的定制

Claude Code 的 Ink 是从官方 Ink 深度 fork 的版本，主要增强包括：

1. **双缓冲屏幕**: `screen.ts` 实现了完整的双缓冲区差分更新，只写入变化的字符
2. **文本选择**: `selection.ts` (34KB) 实现了终端内文本选择、鼠标拖拽、剪贴板集成
3. **搜索高亮**: `searchHighlight.ts` 支持正则搜索和匹配高亮
4. **高级键盘处理**: `parse-keypress.ts` (23KB) 支持 Kitty keyboard protocol、组合键、修改键
5. **ANSI 感知**: `Ansi.tsx` 和 `bidi.ts` 正确处理 ANSI 转义序列和双向文本
6. **性能优化**: 帧率控制、行宽缓存、节点缓存、优化器等
7. **鼠标支持**: 点击、拖拽、悬停的完整事件系统
8. **同步输出**: 使用 DEC 同步输出协议减少闪烁
9. **备用屏幕**: `AlternateScreen.tsx` 支持全屏应用

---

## 设计模式

1. **React 宿主**: 通过 `react-reconciler` 将 React 渲染到终端，复用 React 的 concurrent mode
2. **声明式 UI**: 组件通过 `<Box>` 和 `<Text>` 声明布局，由 Yoga 引擎计算实际位置
3. **事件驱动**: 所有输入通过事件系统分发到 React 组件树
4. **增量更新**: 双缓冲 + diff 算法确保只重绘变化的部分
5. **分层架构**: termio(原始转义) -> screen(字符网格) -> output(语义节点) -> React(声明式组件)
