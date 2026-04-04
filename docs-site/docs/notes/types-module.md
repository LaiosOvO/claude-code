# types 模块阅读笔记

> 源码路径：`src/types/`
> 文件数量：约 23 个（含 `generated/` 和 `src/`）

## 概述

`types/` 模块是 Claude Code 的 **核心类型定义层**，定义了消息、工具、权限、命令、插件等全局共享的 TypeScript 类型。该模块刻意避免运行时依赖，只包含类型定义和常量，以打破循环导入。

## 文件列表

| 文件 | 职责 |
|---|---|
| `message.ts` | 消息类型：Message、UserMessage、AssistantMessage 等 |
| `command.ts` | 命令类型：PromptCommand、LocalCommandResult |
| `permissions.ts` | 权限类型：PermissionMode、PermissionBehavior、PermissionRule |
| `tools.ts` | 工具进度类型：BashProgress、MCPProgress 等（auto-generated stub） |
| `plugin.ts` | 插件类型：PluginManifest、LoadedPlugin、BuiltinPluginDefinition |
| `ids.ts` | 品牌类型：SessionId、AgentId（编译时防混淆） |
| `hooks.ts` | Hook 类型：PromptRequest/Response、HookEvent 校验 |
| `notebook.ts` | Notebook 类型（Jupyter 相关，auto-generated stub） |
| `logs.ts` | 日志选项类型 |
| `fileSuggestion.ts` | 文件建议类型 |
| `connectorText.ts` | 连接器文本类型 |
| `statusLine.ts` | 状态栏类型 |
| `textInputTypes.ts` | 文本输入类型 |
| `messageQueueTypes.ts` | 消息队列类型 |
| `utils.ts` | 工具类型（DeepImmutable 等） |
| `global.d.ts` | 全局类型声明 |
| `ink-elements.d.ts` | Ink 元素类型声明 |
| `ink-jsx.d.ts` | Ink JSX 类型声明 |
| `react-compiler-runtime.d.ts` | React Compiler 运行时声明 |
| `sdk-stubs.d.ts` | SDK 存根声明 |
| `internal-modules.d.ts` | 内部模块声明 |
| `generated/` | 自动生成的类型（由构建管线产出） |

## 核心类型定义

### Message（message.ts）

```typescript
type MessageType = 'user' | 'assistant' | 'system' | 'attachment' | 'progress' | 'grouped_tool_use' | 'collapsed_read_search'

type Message = {
  type: MessageType
  uuid: UUID
  message?: { role?: string; content?: MessageContent; usage?: BetaUsage }
  // ... 扩展字段
}
```

派生类型包括 `UserMessage`、`AssistantMessage`、`SystemMessage`、`AttachmentMessage`、`ProgressMessage` 等。

### Permissions（permissions.ts）

```typescript
type ExternalPermissionMode = 'acceptEdits' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan'
type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble'
type PermissionBehavior = 'allow' | 'deny' | 'ask'
```

### Branded IDs（ids.ts）

```typescript
type SessionId = string & { readonly __brand: 'SessionId' }
type AgentId = string & { readonly __brand: 'AgentId' }
```

使用 TypeScript 品牌类型在编译时防止 session ID 和 agent ID 混淆。

### Plugin（plugin.ts）

定义了插件清单 `PluginManifest`、已加载插件 `LoadedPlugin`、内置插件 `BuiltinPluginDefinition` 等，支持 MCP server、技能、Hook 等扩展机制。

## 设计亮点

1. **零运行时依赖** — 纯类型定义文件，刻意不引入运行时代码以避免循环导入
2. **品牌类型模式** — `SessionId` 和 `AgentId` 使用 `__brand` 字段实现编译时类型安全
3. **Auto-generated Stubs** — `tools.ts` 和 `notebook.ts` 是自动生成的存根，实际类型由构建管线填充
4. **判别联合** — Message 使用 `type` 字段作为判别符，启用 TypeScript 穷举检查

## 与其他模块的关系

- **state/** — `AppState` 大量引用 `Message`、`TaskState` 等类型
- **components/** — UI 组件使用 Message、Command 类型进行渲染
- **bridge/** — 桥接协议使用 `Message`、`PermissionMode` 类型
- **constants/** — 常量模块为这些类型提供具体值
- **tasks/** — `TaskState` 联合类型被 state 模块引用
