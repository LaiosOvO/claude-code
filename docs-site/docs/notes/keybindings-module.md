# keybindings 模块阅读笔记

> 源码路径：`src/keybindings/`
> 文件数量：约 16 个（含 `src/`）

## 概述

`keybindings/` 模块实现了 Claude Code 的 **键盘快捷键系统**。它支持多上下文绑定、和弦序列（chord）、用户自定义覆盖、跨平台兼容，并通过 React Hook 集成到 Ink 终端 UI 中。

## 文件列表

| 文件 | 职责 |
|---|---|
| `types.ts` | 核心类型：ParsedBinding、ParsedKeystroke、KeybindingAction 等 |
| `defaultBindings.ts` | 默认快捷键定义（按上下文分组） |
| `schema.ts` | Zod schema：上下文名列表、描述、校验规则 |
| `parser.ts` | 按键字符串解析器（"ctrl+shift+k" → ParsedKeystroke） |
| `match.ts` | 按键匹配逻辑：Ink Key → 归一化键名 → 修饰符比较 |
| `resolver.ts` | 解析器：输入 + 上下文 → 匹配动作 |
| `validate.ts` | 用户绑定校验 |
| `loadUserBindings.ts` | 从 `~/.claude/keybindings.json` 加载用户配置 |
| `template.ts` | 配置文件模板生成 |
| `reservedShortcuts.ts` | 保留快捷键（ctrl+c/d 不可重绑定） |
| `shortcutFormat.ts` | 快捷键显示格式化 |
| `useKeybinding.ts` | React Hook：在组件中注册快捷键处理 |
| `useShortcutDisplay.ts` | React Hook：获取快捷键显示文本 |
| `KeybindingContext.tsx` | React Context：快捷键上下文提供者 |
| `KeybindingProviderSetup.tsx` | Provider 组装 |

## 上下文系统（schema.ts）

定义了 17 个快捷键上下文：

| 上下文 | 说明 |
|---|---|
| `Global` | 全局生效 |
| `Chat` | 聊天输入框聚焦时 |
| `Autocomplete` | 自动补全菜单可见时 |
| `Confirmation` | 确认/权限对话框 |
| `Help` | 帮助覆盖层 |
| `Transcript` | 查看对话记录 |
| `HistorySearch` | 历史搜索（ctrl+r） |
| `Task` | 前台任务运行中 |
| `ThemePicker` | 主题选择器 |
| `Settings` | 设置菜单 |
| `Tabs` | Tab 导航 |
| `Attachments` | 附件选择 |
| `Footer` | 底部指示器 |
| `MessageSelector` | 消息选择器（rewind） |
| `DiffDialog` | 差异对话框 |
| `ModelPicker` | 模型选择器 |
| `Select` | 选择/列表组件 |
| `Plugin` | 插件对话框 |

## 默认绑定摘要（defaultBindings.ts）

### Global 上下文
- `ctrl+c` — 中断（保留，不可重绑定）
- `ctrl+d` — 退出（保留）
- `ctrl+l` — 重绘
- `ctrl+t` — 切换 Todo
- `ctrl+o` — 切换对话记录
- `ctrl+r` — 历史搜索

### Chat 上下文
- `escape` — 取消
- `ctrl+x ctrl+k` — 终止所有 Agent（和弦序列）
- `shift+tab` — 循环模式（Windows 无 VT 时回退到 `meta+m`）
- `enter` — 提交
- `up/down` — 历史导航

## 按键解析流程

```
用户按键 → Ink Key 对象
         → match.ts: getKeyName() 归一化键名
         → resolver.ts: resolveKey() 在活跃上下文中查找匹配
         → 返回 { type: 'match', action } | { type: 'none' } | { type: 'chord_started' }
```

### 和弦序列支持

解析器支持 `"ctrl+x ctrl+k"` 这样的两键序列：
1. 第一次按键返回 `{ type: 'chord_started', pending }`
2. 第二次按键返回 `{ type: 'match', action }` 或 `{ type: 'chord_cancelled' }`

## 设计亮点

1. **跨平台适配** — Windows Terminal VT 模式检测，自动选择 `shift+tab` 或 `meta+m`
2. **和弦序列** — 使用 `ctrl+x` 前缀避免与 readline 编辑键冲突
3. **最后匹配胜出** — 用户覆盖绑定排在默认绑定之后，自然实现覆盖语义
4. **保留键保护** — `ctrl+c` / `ctrl+d` 在 `reservedShortcuts.ts` 中被标记为不可重绑定
5. **pure 解析** — `resolveKey()` 是纯函数，无状态无副作用

## 与其他模块的关系

- **components/** — 通过 `useKeybinding` Hook 在 UI 组件中注册快捷键
- **state/** — 快捷键动作触发 AppState 更新（如切换模式）
- **bootstrap/** — 不依赖 bootstrap（保持模块独立性）
- **entrypoints/** — CLI 入口不直接使用键盘绑定（仅交互模式使用）
