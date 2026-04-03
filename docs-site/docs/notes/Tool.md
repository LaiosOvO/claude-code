# 阅读笔记：src/Tool.ts

## 文件基本信息
- **路径**: `src/Tool.ts`
- **行数**: 792 行
- **角色**: 工具系统的核心类型定义文件，定义了 `Tool` 接口、`ToolUseContext`（工具执行上下文）以及 `buildTool` 构建函数

## 核心功能

`Tool.ts` 是整个工具系统的"蓝图"。它定义了：
1. **Tool 接口**：每个工具（Bash、Read、Edit、Grep 等）必须实现的完整契约
2. **ToolUseContext**：工具执行时的上下文对象，包含消息历史、应用状态、权限上下文等
3. **ToolPermissionContext**：权限管理上下文，包含允许/拒绝/询问规则
4. **buildTool() 函数**：工具构建工厂，提供安全的默认值

这个文件不包含任何具体工具的实现，而是定义了所有工具必须遵循的接口规范。

## 关键代码解析

### 1. Tool 接口——工具的完整契约

```typescript
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  readonly name: string
  aliases?: string[]
  searchHint?: string

  // 核心方法
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  description(input, options): Promise<string>
  prompt(options): Promise<string>
  checkPermissions(input, context): Promise<PermissionResult>

  // Schema 定义
  readonly inputSchema: Input
  readonly inputJSONSchema?: ToolInputJSONSchema
  outputSchema?: z.ZodType<unknown>

  // 能力声明
  isConcurrencySafe(input): boolean
  isEnabled(): boolean
  isReadOnly(input): boolean
  isDestructive?(input): boolean
  interruptBehavior?(): 'cancel' | 'block'

  // 渲染方法
  renderToolUseMessage(input, options): React.ReactNode
  renderToolResultMessage?(content, progressMessages, options): React.ReactNode
  renderToolUseProgressMessage?(progressMessages, options): React.ReactNode
  // ... 更多渲染方法

  // 权限与验证
  validateInput?(input, context): Promise<ValidationResult>
  preparePermissionMatcher?(input): Promise<(pattern: string) => boolean>

  // 其他
  maxResultSizeChars: number
  readonly strict?: boolean
  readonly shouldDefer?: boolean
  readonly alwaysLoad?: boolean
  // ...
}
```

接口设计的几个关键特点：
- **泛型三参数**：`Input`（输入 schema）、`Output`（输出类型）、`P`（进度数据类型）
- **方法分层**：核心执行（call）、能力声明（isReadOnly、isConcurrencySafe）、UI 渲染（render*）、权限检查（checkPermissions）
- **渲染与逻辑分离**：工具既定义执行逻辑，又定义 UI 渲染方式

### 2. ToolUseContext——执行上下文

```typescript
export type ToolUseContext = {
  options: {
    commands: Command[]
    debug: boolean
    mainLoopModel: string
    tools: Tools
    thinkingConfig: ThinkingConfig
    mcpClients: MCPServerConnection[]
    isNonInteractiveSession: boolean
    agentDefinitions: AgentDefinitionsResult
    maxBudgetUsd?: number
    customSystemPrompt?: string
    appendSystemPrompt?: string
  }
  abortController: AbortController
  readFileState: FileStateCache
  getAppState(): AppState
  setAppState(f: (prev: AppState) => AppState): void
  setToolJSX?: SetToolJSXFn
  messages: Message[]
  contentReplacementState?: ContentReplacementState
  // ...更多字段
}
```

`ToolUseContext` 是工具执行时的"全景环境"。它包含了工具可能需要的一切：
- 模型配置、工具列表、命令列表
- 中止控制器（用于用户中断）
- 应用状态的 getter/setter
- 消息历史
- 文件状态缓存
- 进度报告回调
- 权限决策追踪

### 3. ToolPermissionContext——权限上下文

```typescript
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
  alwaysAskRules: ToolPermissionRulesBySource
  isBypassPermissionsModeAvailable: boolean
  isAutoModeAvailable?: boolean
  shouldAvoidPermissionPrompts?: boolean
  awaitAutomatedChecksBeforeDialog?: boolean
  prePlanMode?: PermissionMode
}>
```

使用 `DeepImmutable` 包装，确保权限上下文在传递过程中不会被意外修改。权限规则按来源（source）分组，支持来自不同配置层级的规则叠加。

### 4. buildTool() 工厂函数

```typescript
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,  // 默认不并发安全
  isReadOnly: (_input?: unknown) => false,          // 默认假设会写入
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (input, _ctx?) => 
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
```

`buildTool` 的设计理念：
- **失败关闭原则**（fail-closed）：`isConcurrencySafe` 默认 false（不安全直到显式声明安全），`isReadOnly` 默认 false（假设会写入直到显式声明只读）
- **统一默认值**：所有 60+ 个工具都通过 `buildTool` 构建，确保默认行为一致
- **类型安全**：使用高级 TypeScript 类型（`BuiltTool<D>`、条件类型）确保覆盖的方法保持正确的类型

### 5. ToolResult 类型

```typescript
export type ToolResult<T> = {
  data: T
  newMessages?: (UserMessage | AssistantMessage | AttachmentMessage | SystemMessage)[]
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}
```

工具返回值不仅包含数据，还可以附带新消息（如中间状态消息）和上下文修改器（修改后续工具的执行环境）。

### 6. 辅助函数

```typescript
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => toolMatchesName(t, name))
}
```

支持工具别名查找。当工具重命名时，旧名称可以作为 alias 保留，确保向后兼容。

## 数据流

```
工具定义文件 (如 BashTool.ts)
  └─> buildTool({ name, call, inputSchema, ... })
       └─> Tool 对象 (完整接口)
            └─> 注册到工具列表 (tools.ts)
                 └─> 在 query loop 中执行:
                      call(args, context, canUseTool, parentMessage, onProgress)
                        └─> ToolResult<Output>
```

## 与其他模块的关系
- **被依赖（广泛）**：
  - 所有工具实现文件（`tools/BashTool/`、`tools/FileReadTool/` 等）—— 使用 `Tool` 类型和 `buildTool`
  - `tools.ts` —— 使用 `Tools` 类型
  - `query.ts` —— 使用 `ToolUseContext`
  - `QueryEngine.ts` —— 使用 `Tool`、`ToolUseContext`
- **依赖**：
  - `commands.ts` —— `Command` 类型
  - `types/message.ts` —— 消息类型
  - `types/permissions.ts` —— 权限类型
  - `types/tools.ts` —— 工具进度类型

## 设计亮点与思考

1. **接口驱动设计**：792 行几乎全是类型定义，将"做什么"（接口）和"怎么做"（实现）完全分离。
2. **失败关闭的默认值**：`buildTool` 的默认值在安全性上采取保守策略——不确定就不并发、不确定就假设会写入。
3. **DeepImmutable 保护**：权限上下文使用深度不可变类型，防止意外修改造成安全漏洞。
4. **渲染方法分层**：工具可以定义多层渲染——使用中、结果、进度、错误、拒绝、排队、分组——每个状态都有对应的渲染钩子。
5. **ToolSearch 延迟加载**：通过 `shouldDefer` 和 `alwaysLoad` 字段支持工具的按需加载，减少初始 prompt 的 token 数量。

## 要点总结

1. **核心类型定义文件**：定义了 `Tool`、`ToolUseContext`、`ToolPermissionContext` 等核心类型
2. **buildTool 工厂**：统一的工具构建入口，提供安全的默认值
3. **失败关闭原则**：默认假设工具不安全、会写入——必须显式声明才能放开
4. **接口极其丰富**：一个工具需要实现 call、description、prompt、渲染、权限检查等十余个方法
5. **类型安全**：大量使用 TypeScript 高级类型确保编译时类型检查
