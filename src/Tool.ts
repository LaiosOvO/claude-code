/**
 * ========================================================================
 * Tool.ts — 工具系统的核心类型定义与工厂函数
 * ========================================================================
 *
 * 本文件是 Claude Code 工具系统的类型基础设施，定义了：
 *   1. Tool<Input, Output, P> 接口 — 所有工具必须实现的完整契约
 *   2. ToolDef — 工具定义的简化形式，允许省略可默认字段
 *   3. buildTool() 工厂函数 — 将 ToolDef 补全为完整的 Tool，确保安全默认值
 *   4. ToolUseContext — 工具执行时的运行时上下文（消息列表、权限、状态等）
 *   5. ToolPermissionContext — 权限判定所需的上下文（模式、规则、工作目录）
 *   6. 辅助类型 — ToolResult、ToolProgress、ValidationResult 等
 *
 * 设计原则：
 *   - "fail-closed"（安全关闭）: 默认值倾向于限制而非放行
 *     例如 isReadOnly 默认 false（假设会写入）、isConcurrencySafe 默认 false
 *   - 单一职责：每个工具通过 buildTool() 注册，默认值集中管理
 *   - 类型安全：通过 Zod schema 定义输入，BuiltTool<D> 在类型层面精确模拟运行时展开
 * ========================================================================
 */
import type {
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { UUID } from 'crypto'
import type { z } from 'zod/v4'
import type { Command } from './commands.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import type { ThinkingConfig } from './utils/thinking.js'

/**
 * 工具输入的 JSON Schema 类型定义
 * 用于 MCP 工具直接指定 JSON Schema 格式的输入 schema，而非通过 Zod 转换
 * - type 固定为 'object'，工具输入必须是对象
 * - properties 定义各参数的 schema
 */
export type ToolInputJSONSchema = {
  [x: string]: unknown
  type: 'object'
  properties?: {
    [x: string]: unknown
  }
}

import type { Notification } from './context/notifications.js'
import type {
  MCPServerConnection,
  ServerResource,
} from './services/mcp/types.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from './tools/AgentTool/loadAgentsDir.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemLocalCommandMessage,
  SystemMessage,
  UserMessage,
} from './types/message.js'
// Import permission types from centralized location to break import cycles
// Import PermissionResult from centralized location to break import cycles
import type {
  AdditionalWorkingDirectory,
  PermissionMode,
  PermissionResult,
} from './types/permissions.js'
// Import tool progress types from centralized location to break import cycles
import type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  ToolProgressData,
  WebSearchProgress,
} from './types/tools.js'
import type { FileStateCache } from './utils/fileStateCache.js'
import type { DenialTrackingState } from './utils/permissions/denialTracking.js'
import type { SystemPrompt } from './utils/systemPromptType.js'
import type { ContentReplacementState } from './utils/toolResultStorage.js'

// Re-export progress types for backwards compatibility
export type {
  AgentToolProgress,
  BashProgress,
  MCPProgress,
  REPLToolProgress,
  SkillToolProgress,
  TaskOutputProgress,
  WebSearchProgress,
}

import type { SpinnerMode } from './components/Spinner.js'
import type { QuerySource } from './constants/querySource.js'
import type { SDKStatus } from './entrypoints/agentSdkTypes.js'
import type { AppState } from './state/AppState.js'
import type {
  HookProgress,
  PromptRequest,
  PromptResponse,
} from './types/hooks.js'
import type { AgentId } from './types/ids.js'
import type { DeepImmutable } from './types/utils.js'
import type { AttributionState } from './utils/commitAttribution.js'
import type { FileHistoryState } from './utils/fileHistory.js'
import type { Theme, ThemeName } from './utils/theme.js'

/**
 * 查询链追踪信息
 * 用于跟踪嵌套子代理调用的链路，便于调试和遥测
 * - chainId: 整个调用链的唯一标识
 * - depth: 当前调用在链中的嵌套深度
 */
export type QueryChainTracking = {
  chainId: string
  depth: number
}

/**
 * 工具输入验证结果
 * - result: true 表示验证通过
 * - result: false 时需提供错误消息和错误码，通知模型工具调用失败原因
 */
export type ValidationResult =
  | { result: true }
  | {
      result: false
      message: string
      errorCode: number
    }

/**
 * 工具自定义 UI 渲染回调
 * 允许工具在运行期间接管 UI 显示区域（如显示自定义 JSX 或隐藏输入框）
 * 传入 null 可清除当前的自定义 UI
 */
export type SetToolJSXFn = (
  args: {
    jsx: React.ReactNode | null // 要显示的自定义 JSX 内容
    shouldHidePromptInput: boolean // 是否隐藏用户输入框
    shouldContinueAnimation?: true // 是否继续播放动画
    showSpinner?: boolean // 是否显示加载动画
    isLocalJSXCommand?: boolean // 是否为本地 JSX 命令
    isImmediate?: boolean // 是否立即渲染（无过渡）
    /** Set to true to clear a local JSX command (e.g., from its onDone callback) */
    clearLocalJSX?: boolean
  } | null,
) => void

// Import tool permission types from centralized location to break import cycles
import type { ToolPermissionRulesBySource } from './types/permissions.js'

// Re-export for backwards compatibility
export type { ToolPermissionRulesBySource }

/**
 * 工具权限上下文（不可变）
 *
 * 包含判定工具是否被允许执行所需的全部信息。
 * 通过 DeepImmutable 确保权限上下文在传递过程中不会被意外修改。
 *
 * 权限模式（mode）决定了整体策略：
 *   - 'default': 标准模式，根据规则逐条判断
 *   - 'plan': 计划模式，限制写操作
 *   - 'bypassPermissions': 绕过权限检查（需要显式开启）
 *
 * 三套规则（alwaysAllow / alwaysDeny / alwaysAsk）：
 *   每套规则按来源（source）组织，支持项目级、用户级等多层配置
 */
// Apply DeepImmutable to the imported type
export type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode // 当前权限模式
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory> // 额外的工作目录（多项目场景）
  alwaysAllowRules: ToolPermissionRulesBySource // 始终允许规则
  alwaysDenyRules: ToolPermissionRulesBySource // 始终拒绝规则
  alwaysAskRules: ToolPermissionRulesBySource // 始终询问用户规则
  isBypassPermissionsModeAvailable: boolean // 是否可用"绕过权限"模式
  isAutoModeAvailable?: boolean // 是否可用自动模式
  strippedDangerousRules?: ToolPermissionRulesBySource // 被移除的危险规则（用于审计）
  /** When true, permission prompts are auto-denied (e.g., background agents that can't show UI) */
  shouldAvoidPermissionPrompts?: boolean // 后台代理无法展示 UI 时自动拒绝权限提示
  /** When true, automated checks (classifier, hooks) are awaited before showing the permission dialog (coordinator workers) */
  awaitAutomatedChecksBeforeDialog?: boolean // 协调器工作线程在展示对话框前等待自动检查
  /** Stores the permission mode before model-initiated plan mode entry, so it can be restored on exit */
  prePlanMode?: PermissionMode // 进入计划模式前的权限模式，退出时恢复
}>

/** 创建一个空的工具权限上下文（所有规则为空，使用默认模式） */
export const getEmptyToolPermissionContext: () => ToolPermissionContext =
  () => ({
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  })

/**
 * 上下文压缩进度事件
 * 在对话上下文被压缩（compact）时发出，用于驱动 UI 进度显示
 */
export type CompactProgressEvent =
  | {
      type: 'hooks_start'
      hookType: 'pre_compact' | 'post_compact' | 'session_start'
    }
  | { type: 'compact_start' } // 压缩开始
  | { type: 'compact_end' } // 压缩结束

/**
 * 工具执行上下文（ToolUseContext）
 *
 * 每次工具调用时传入的完整运行时环境。包含：
 *   - options: 会话级配置（模型、调试标志、MCP 客户端等）
 *   - abortController: 用于取消正在执行的工具
 *   - 消息列表、文件状态缓存、应用状态读写等
 *   - UI 回调（setToolJSX、setStreamMode 等）
 *   - 权限追踪、文件历史、归因状态等
 *
 * 这是工具与宿主环境之间的唯一通信桥梁。
 */
export type ToolUseContext = {
  options: {
    commands: Command[] // 可用的斜杠命令列表
    debug: boolean // 调试模式开关
    mainLoopModel: string // 主循环使用的模型标识
    tools: Tools // 当前可用的工具集合
    verbose: boolean // 详细输出模式
    thinkingConfig: ThinkingConfig // 思考/推理配置
    mcpClients: MCPServerConnection[] // MCP 服务器连接列表
    mcpResources: Record<string, ServerResource[]> // MCP 资源映射
    isNonInteractiveSession: boolean // 是否为非交互式会话（如 SDK/CI 模式）
    agentDefinitions: AgentDefinitionsResult // 代理定义列表
    maxBudgetUsd?: number // 最大预算（美元），用于费用控制
    /** Custom system prompt that replaces the default system prompt */
    customSystemPrompt?: string
    /** Additional system prompt appended after the main system prompt */
    appendSystemPrompt?: string
    /** Override querySource for analytics tracking */
    querySource?: QuerySource
    /** Optional callback to get the latest tools (e.g., after MCP servers connect mid-query) */
    refreshTools?: () => Tools
  }
  abortController: AbortController // 中止控制器，用于取消工具执行
  readFileState: FileStateCache // 文件读取状态的 LRU 缓存
  getAppState(): AppState // 获取当前应用状态快照
  setAppState(f: (prev: AppState) => AppState): void // 原子性更新应用状态
  /**
   * Always-shared setAppState for session-scoped infrastructure (background
   * tasks, session hooks). Unlike setAppState, which is no-op for async agents
   * (see createSubagentContext), this always reaches the root store so agents
   * at any nesting depth can register/clean up infrastructure that outlives
   * a single turn. Only set by createSubagentContext; main-thread contexts
   * fall back to setAppState.
   */
  setAppStateForTasks?: (f: (prev: AppState) => AppState) => void
  /**
   * Optional handler for URL elicitations triggered by tool call errors (-32042).
   * In print/SDK mode, this delegates to structuredIO.handleElicitation.
   * In REPL mode, this is undefined and the queue-based UI path is used.
   */
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
  setToolJSX?: SetToolJSXFn
  addNotification?: (notif: Notification) => void
  /** Append a UI-only system message to the REPL message list. Stripped at the
   *  normalizeMessagesForAPI boundary — the Exclude<> makes that type-enforced. */
  appendSystemMessage?: (
    msg: Exclude<SystemMessage, SystemLocalCommandMessage>,
  ) => void
  /** Send an OS-level notification (iTerm2, Kitty, Ghostty, bell, etc.) */
  sendOSNotification?: (opts: {
    message: string
    notificationType: string
  }) => void
  nestedMemoryAttachmentTriggers?: Set<string>
  /**
   * CLAUDE.md paths already injected as nested_memory attachments this
   * session. Dedup for memoryFilesToAttachments — readFileState is an LRU
   * that evicts entries in busy sessions, so its .has() check alone can
   * re-inject the same CLAUDE.md dozens of times.
   */
  loadedNestedMemoryPaths?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  /** Skill names surfaced via skill_discovery this session. Telemetry only (feeds was_discovered). */
  discoveredSkillNames?: Set<string>
  userModified?: boolean
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void
  /** Only wired in interactive (REPL) contexts; SDK/QueryEngine don't set this. */
  setHasInterruptibleToolInProgress?: (v: boolean) => void
  setResponseLength: (f: (prev: number) => number) => void
  /** Ant-only: push a new API metrics entry for OTPS tracking.
   *  Called by subagent streaming when a new API request starts. */
  pushApiMetricsEntry?: (ttftMs: number) => void
  setStreamMode?: (mode: SpinnerMode) => void
  onCompactProgress?: (event: CompactProgressEvent) => void
  setSDKStatus?: (status: SDKStatus) => void
  openMessageSelector?: () => void
  updateFileHistoryState: (
    updater: (prev: FileHistoryState) => FileHistoryState,
  ) => void
  updateAttributionState: (
    updater: (prev: AttributionState) => AttributionState,
  ) => void
  setConversationId?: (id: UUID) => void
  agentId?: AgentId // Only set for subagents; use getSessionId() for session ID. Hooks use this to distinguish subagent calls.
  agentType?: string // Subagent type name. For the main thread's --agent type, hooks fall back to getMainThreadAgentType().
  /** When true, canUseTool must always be called even when hooks auto-approve.
   *  Used by speculation for overlay file path rewriting. */
  requireCanUseTool?: boolean
  messages: Message[] // 当前对话的消息列表
  fileReadingLimits?: { // 文件读取限制
    maxTokens?: number
    maxSizeBytes?: number
  }
  globLimits?: {
    maxResults?: number
  }
  toolDecisions?: Map<
    string,
    {
      source: string
      decision: 'accept' | 'reject'
      timestamp: number
    }
  >
  queryTracking?: QueryChainTracking
  /** Callback factory for requesting interactive prompts from the user.
   * Returns a prompt callback bound to the given source name.
   * Only available in interactive (REPL) contexts. */
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>
  toolUseId?: string
  criticalSystemReminder_EXPERIMENTAL?: string
  /** When true, preserve toolUseResult on messages even for subagents.
   * Used by in-process teammates whose transcripts are viewable by the user. */
  preserveToolUseResults?: boolean
  /** Local denial tracking state for async subagents whose setAppState is a
   *  no-op. Without this, the denial counter never accumulates and the
   *  fallback-to-prompting threshold is never reached. Mutable — the
   *  permissions code updates it in place. */
  localDenialTracking?: DenialTrackingState
  /**
   * Per-conversation-thread content replacement state for the tool result
   * budget. When present, query.ts applies the aggregate tool result budget.
   * Main thread: REPL provisions once (never resets — stale UUID keys
   * are inert). Subagents: createSubagentContext clones the parent's state
   * by default (cache-sharing forks need identical decisions), or
   * resumeAgentBackground threads one reconstructed from sidechain records.
   */
  contentReplacementState?: ContentReplacementState
  /**
   * Parent's rendered system prompt bytes, frozen at turn start.
   * Used by fork subagents to share the parent's prompt cache — re-calling
   * getSystemPrompt() at fork-spawn time can diverge (GrowthBook cold→warm)
   * and bust the cache. See forkSubagent.ts.
   */
  renderedSystemPrompt?: SystemPrompt
}

// Re-export ToolProgressData from centralized location
export type { ToolProgressData }

/** 进度事件的联合类型：工具进度或钩子进度 */
export type Progress = ToolProgressData | HookProgress

/**
 * 工具进度事件
 * 通过 toolUseID 关联到具体的工具调用实例
 */
export type ToolProgress<P extends ToolProgressData> = {
  toolUseID: string // 对应工具调用的唯一 ID
  data: P // 具体的进度数据
}

/** 从进度消息中过滤掉 hook_progress 类型，只保留工具进度消息 */
export function filterToolProgressMessages(
  progressMessagesForMessage: ProgressMessage[],
): ProgressMessage<ToolProgressData>[] {
  return progressMessagesForMessage.filter(
    (msg): msg is ProgressMessage<ToolProgressData> =>
      (msg.data as { type?: string })?.type !== 'hook_progress',
  )
}

/**
 * 工具执行结果
 * - data: 工具的原始输出数据
 * - newMessages: 工具执行过程中产生的新消息（如子代理对话）
 * - contextModifier: 上下文修改器，仅在非并发安全工具上生效，可修改后续工具的执行上下文
 * - mcpMeta: MCP 协议元数据透传
 */
export type ToolResult<T> = {
  data: T
  newMessages?: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
  )[]
  // contextModifier 仅在 isConcurrencySafe 为 false 的工具上生效
  contextModifier?: (context: ToolUseContext) => ToolUseContext
  /** MCP protocol metadata (structuredContent, _meta) to pass through to SDK consumers */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
}

/** 工具执行进度回调函数类型 */
export type ToolCallProgress<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>,
) => void

/** 工具输入 schema 的通用类型——任何输出为对象类型的 Zod schema */
export type AnyObject = z.ZodType<{ [key: string]: unknown }>

/**
 * Checks if a tool matches the given name (primary name or alias).
 */
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}

/**
 * Finds a tool by name or alias from a list of tools.
 */
export function findToolByName(tools: Tools, name: string): Tool | undefined {
  return tools.find(t => toolMatchesName(t, name))
}

/**
 * Tool 接口 — 所有工具必须实现的完整契约
 *
 * 泛型参数：
 *   - Input: 工具输入的 Zod schema 类型（必须是对象类型）
 *   - Output: 工具输出的数据类型
 *   - P: 工具进度事件的数据类型
 *
 * 核心方法分为以下几组：
 *   【执行】call() — 实际执行逻辑
 *   【权限】checkPermissions(), validateInput() — 调用前的安全检查
 *   【元数据】name, description(), prompt() — 告知模型如何使用此工具
 *   【行为标记】isReadOnly(), isConcurrencySafe(), isDestructive() — 描述工具特性
 *   【UI 渲染】renderToolUseMessage(), renderToolResultMessage() 等 — 终端显示
 *   【搜索与延迟加载】shouldDefer, searchHint — 配合 ToolSearch 的延迟加载机制
 */
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  /**
   * Optional aliases for backwards compatibility when a tool is renamed.
   * The tool can be looked up by any of these names in addition to its primary name.
   */
  aliases?: string[]
  /**
   * One-line capability phrase used by ToolSearch for keyword matching.
   * Helps the model find this tool via keyword search when it's deferred.
   * 3–10 words, no trailing period.
   * Prefer terms not already in the tool name (e.g. 'jupyter' for NotebookEdit).
   */
  searchHint?: string
  /**
   * 工具的核心执行方法
   * @param args - 经 Zod schema 验证后的输入参数
   * @param context - 工具执行上下文（包含消息列表、状态、权限等）
   * @param canUseTool - 权限检查回调，用于子工具调用
   * @param parentMessage - 触发此工具调用的助手消息
   * @param onProgress - 可选的进度回调，用于报告执行进度
   */
  call(
    args: z.infer<Input>,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: ToolCallProgress<P>,
  ): Promise<ToolResult<Output>>
  /** 返回工具的描述文本，供模型了解工具功能。可根据输入和上下文动态生成 */
  description(
    input: z.infer<Input>,
    options: {
      isNonInteractiveSession: boolean
      toolPermissionContext: ToolPermissionContext
      tools: Tools
    },
  ): Promise<string>
  readonly inputSchema: Input // 工具输入的 Zod schema 定义
  // MCP 工具可直接指定 JSON Schema 格式的输入 schema，无需从 Zod 转换
  readonly inputJSONSchema?: ToolInputJSONSchema
  // 输出 schema（TungstenTool 未定义，因此为可选）
  outputSchema?: z.ZodType<unknown>
  /** 判断两组输入是否等价（用于去重并发调用） */
  inputsEquivalent?(a: z.infer<Input>, b: z.infer<Input>): boolean
  /**
   * 是否并发安全
   * 返回 true 表示此工具可与其他工具并行执行（如只读搜索）
   * 返回 false（默认）表示必须独占执行（如文件写入）
   */
  isConcurrencySafe(input: z.infer<Input>): boolean
  /** 工具是否启用。返回 false 的工具会被从工具池中过滤掉 */
  isEnabled(): boolean
  /**
   * 是否为只读操作
   * 返回 true 表示此工具不会修改文件系统或外部状态（如 Read、Grep）
   * 返回 false（默认）表示可能有写入副作用
   * 计划模式（plan mode）下只允许只读工具执行
   */
  isReadOnly(input: z.infer<Input>): boolean
  /** Defaults to false. Only set when the tool performs irreversible operations (delete, overwrite, send). */
  isDestructive?(input: z.infer<Input>): boolean
  /**
   * What should happen when the user submits a new message while this tool
   * is running.
   *
   * - `'cancel'` — stop the tool and discard its result
   * - `'block'`  — keep running; the new message waits
   *
   * Defaults to `'block'` when not implemented.
   */
  interruptBehavior?(): 'cancel' | 'block'
  /**
   * Returns information about whether this tool use is a search or read operation
   * that should be collapsed into a condensed display in the UI. Examples include
   * file searching (Grep, Glob), file reading (Read), and bash commands like find,
   * grep, wc, etc.
   *
   * Returns an object indicating whether the operation is a search or read operation:
   * - `isSearch: true` for search operations (grep, find, glob patterns)
   * - `isRead: true` for read operations (cat, head, tail, file read)
   * - `isList: true` for directory-listing operations (ls, tree, du)
   * - All can be false if the operation shouldn't be collapsed
   */
  isSearchOrReadCommand?(input: z.infer<Input>): {
    isSearch: boolean
    isRead: boolean
    isList?: boolean
  }
  isOpenWorld?(input: z.infer<Input>): boolean
  requiresUserInteraction?(): boolean
  isMcp?: boolean // 标记此工具来自 MCP（Model Context Protocol）服务器
  isLsp?: boolean // 标记此工具来自 LSP（Language Server Protocol）服务器
  /**
   * When true, this tool is deferred (sent with defer_loading: true) and requires
   * ToolSearch to be used before it can be called.
   */
  readonly shouldDefer?: boolean
  /**
   * When true, this tool is never deferred — its full schema appears in the
   * initial prompt even when ToolSearch is enabled. For MCP tools, set via
   * `_meta['anthropic/alwaysLoad']`. Use for tools the model must see on
   * turn 1 without a ToolSearch round-trip.
   */
  readonly alwaysLoad?: boolean
  /**
   * For MCP tools: the server and tool names as received from the MCP server (unnormalized).
   * Present on all MCP tools regardless of whether `name` is prefixed (mcp__server__tool)
   * or unprefixed (CLAUDE_AGENT_SDK_MCP_NO_PREFIX mode).
   */
  mcpInfo?: { serverName: string; toolName: string }
  readonly name: string // 工具的唯一标识名称（如 'Bash'、'Read'、'Edit'）
  /**
   * Maximum size in characters for tool result before it gets persisted to disk.
   * When exceeded, the result is saved to a file and Claude receives a preview
   * with the file path instead of the full content.
   *
   * Set to Infinity for tools whose output must never be persisted (e.g. Read,
   * where persisting creates a circular Read→file→Read loop and the tool
   * already self-bounds via its own limits).
   */
  maxResultSizeChars: number
  /**
   * When true, enables strict mode for this tool, which causes the API to
   * more strictly adhere to tool instructions and parameter schemas.
   * Only applied when the tengu_tool_pear is enabled.
   */
  readonly strict?: boolean

  /**
   * Called on copies of tool_use input before observers see it (SDK stream,
   * transcript, canUseTool, PreToolUse/PostToolUse hooks). Mutate in place
   * to add legacy/derived fields. Must be idempotent. The original API-bound
   * input is never mutated (preserves prompt cache). Not re-applied when a
   * hook/permission returns a fresh updatedInput — those own their shape.
   */
  backfillObservableInput?(input: Record<string, unknown>): void

  /**
   * Determines if this tool is allowed to run with this input in the current context.
   * It informs the model of why the tool use failed, and does not directly display any UI.
   * @param input
   * @param context
   */
  validateInput?(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<ValidationResult>

  /**
   * 工具级权限检查（tool-specific permission check）
   *
   * 在 validateInput() 通过后调用。通用权限逻辑在 permissions.ts 中，
   * 此方法包含工具特有的权限判定（如 Bash 检查命令是否危险，Edit 检查路径是否在工作目录内）。
   *
   * 返回值类型 PermissionResult：
   *   - { behavior: 'allow', updatedInput } — 允许执行（可能修改输入）
   *   - { behavior: 'deny', message } — 拒绝执行
   *   - { behavior: 'ask', ... } — 需要用户确认
   *
   * 默认实现（由 buildTool 提供）直接返回 allow，将权限判定完全委托给通用权限系统。
   */
  checkPermissions(
    input: z.infer<Input>,
    context: ToolUseContext,
  ): Promise<PermissionResult>

  // Optional method for tools that operate on a file path
  getPath?(input: z.infer<Input>): string

  /**
   * Prepare a matcher for hook `if` conditions (permission-rule patterns like
   * "git *" from "Bash(git *)"). Called once per hook-input pair; any
   * expensive parsing happens here. Returns a closure that is called per
   * hook pattern. If not implemented, only tool-name-level matching works.
   */
  preparePermissionMatcher?(
    input: z.infer<Input>,
  ): Promise<(pattern: string) => boolean>

  /**
   * 生成此工具的系统提示词片段
   * 会被拼接到整体 system prompt 中，告知模型此工具的使用方法和注意事项
   */
  prompt(options: {
    getToolPermissionContext: () => Promise<ToolPermissionContext>
    tools: Tools
    agents: AgentDefinition[]
    allowedAgentTypes?: string[]
  }): Promise<string>
  /** 返回面向用户的显示名称（如 "Read(src/foo.ts)"），用于 UI 和日志 */
  userFacingName(input: Partial<z.infer<Input>> | undefined): string
  userFacingNameBackgroundColor?(
    input: Partial<z.infer<Input>> | undefined,
  ): keyof Theme | undefined
  /**
   * Transparent wrappers (e.g. REPL) delegate all rendering to their progress
   * handler, which emits native-looking blocks for each inner tool call.
   * The wrapper itself shows nothing.
   */
  isTransparentWrapper?(): boolean
  /**
   * Returns a short string summary of this tool use for display in compact views.
   * @param input The tool input
   * @returns A short string summary, or null to not display
   */
  getToolUseSummary?(input: Partial<z.infer<Input>> | undefined): string | null
  /**
   * Returns a human-readable present-tense activity description for spinner display.
   * Example: "Reading src/foo.ts", "Running bun test", "Searching for pattern"
   * @param input The tool input
   * @returns Activity description string, or null to fall back to tool name
   */
  getActivityDescription?(
    input: Partial<z.infer<Input>> | undefined,
  ): string | null
  /**
   * Returns a compact representation of this tool use for the auto-mode
   * security classifier. Examples: `ls -la` for Bash, `/tmp/x: new content`
   * for Edit. Return '' to skip this tool in the classifier transcript
   * (e.g. tools with no security relevance). May return an object to avoid
   * double-encoding when the caller JSON-wraps the value.
   */
  /**
   * 将工具输入转换为自动安全分类器所需的紧凑格式
   * 返回空字符串表示跳过此工具的分类检查（无安全相关性的工具）
   * 安全相关的工具必须重写此方法（如 Bash 返回命令字符串）
   */
  toAutoClassifierInput(input: z.infer<Input>): unknown
  /** 将工具输出转换为 Anthropic API 标准的 ToolResultBlockParam 格式 */
  mapToolResultToToolResultBlockParam(
    content: Output,
    toolUseID: string,
  ): ToolResultBlockParam
  /**
   * Optional. When omitted, the tool result renders nothing (same as returning
   * null). Omit for tools whose results are surfaced elsewhere (e.g., TodoWrite
   * updates the todo panel, not the transcript).
   */
  renderToolResultMessage?(
    content: Output,
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
      isBriefOnly?: boolean
      /** Original tool_use input, when available. Useful for compact result
       * summaries that reference what was requested (e.g. "Sent to #foo"). */
      input?: unknown
    },
  ): React.ReactNode
  /**
   * Flattened text of what renderToolResultMessage shows IN TRANSCRIPT
   * MODE (verbose=true, isTranscriptMode=true). For transcript search
   * indexing: the index counts occurrences in this string, the highlight
   * overlay scans the actual screen buffer. For count ≡ highlight, this
   * must return the text that ends up visible — not the model-facing
   * serialization from mapToolResultToToolResultBlockParam (which adds
   * system-reminders, persisted-output wrappers).
   *
   * Chrome can be skipped (under-count is fine). "Found 3 files in 12ms"
   * isn't worth indexing. Phantoms are not fine — text that's claimed
   * here but doesn't render is a count≠highlight bug.
   *
   * Optional: omitted → field-name heuristic in transcriptSearch.ts.
   * Drift caught by test/utils/transcriptSearch.renderFidelity.test.tsx
   * which renders sample outputs and flags text that's indexed-but-not-
   * rendered (phantom) or rendered-but-not-indexed (under-count warning).
   */
  extractSearchText?(out: Output): string
  /**
   * Render the tool use message. Note that `input` is partial because we render
   * the message as soon as possible, possibly before tool parameters have fully
   * streamed in.
   */
  renderToolUseMessage(
    input: Partial<z.infer<Input>>,
    options: { theme: ThemeName; verbose: boolean; commands?: Command[] },
  ): React.ReactNode
  /**
   * Returns true when the non-verbose rendering of this output is truncated
   * (i.e., clicking to expand would reveal more content). Gates
   * click-to-expand in fullscreen — only messages where verbose actually
   * shows more get a hover/click affordance. Unset means never truncated.
   */
  isResultTruncated?(output: Output): boolean
  /**
   * Renders an optional tag to display after the tool use message.
   * Used for additional metadata like timeout, model, resume ID, etc.
   * Returns null to not display anything.
   */
  renderToolUseTag?(input: Partial<z.infer<Input>>): React.ReactNode
  /**
   * Optional. When omitted, no progress UI is shown while the tool runs.
   */
  renderToolUseProgressMessage?(
    progressMessagesForMessage: ProgressMessage<P>[],
    options: {
      tools: Tools
      verbose: boolean
      terminalSize?: { columns: number; rows: number }
      inProgressToolCallCount?: number
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
  renderToolUseQueuedMessage?(): React.ReactNode
  /**
   * Optional. When omitted, falls back to <FallbackToolUseRejectedMessage />.
   * Only define this for tools that need custom rejection UI (e.g., file edits
   * that show the rejected diff).
   */
  renderToolUseRejectedMessage?(
    input: z.infer<Input>,
    options: {
      columns: number
      messages: Message[]
      style?: 'condensed'
      theme: ThemeName
      tools: Tools
      verbose: boolean
      progressMessagesForMessage: ProgressMessage<P>[]
      isTranscriptMode?: boolean
    },
  ): React.ReactNode
  /**
   * Optional. When omitted, falls back to <FallbackToolUseErrorMessage />.
   * Only define this for tools that need custom error UI (e.g., search tools
   * that show "File not found" instead of the raw error).
   */
  renderToolUseErrorMessage?(
    result: ToolResultBlockParam['content'],
    options: {
      progressMessagesForMessage: ProgressMessage<P>[]
      tools: Tools
      verbose: boolean
      isTranscriptMode?: boolean
    },
  ): React.ReactNode

  /**
   * Renders multiple parallel instances of this tool as a group.
   * @returns React node to render, or null to fall back to individual rendering
   */
  /**
   * Renders multiple tool uses as a group (non-verbose mode only).
   * In verbose mode, individual tool uses render at their original positions.
   * @returns React node to render, or null to fall back to individual rendering
   */
  renderGroupedToolUse?(
    toolUses: Array<{
      param: ToolUseBlockParam
      isResolved: boolean
      isError: boolean
      isInProgress: boolean
      progressMessages: ProgressMessage<P>[]
      result?: {
        param: ToolResultBlockParam
        output: unknown
      }
    }>,
    options: {
      shouldAnimate: boolean
      tools: Tools
    },
  ): React.ReactNode | null
}

/**
 * 工具集合类型
 * 使用 readonly Tool[] 而非普通数组，便于在代码库中追踪工具集的组装、传递和过滤
 */
export type Tools = readonly Tool[]

/**
 * buildTool() 会为以下方法提供默认实现的键名集合
 * ToolDef 中这些方法是可选的；经 buildTool() 处理后的 Tool 始终包含它们
 *
 * 这些默认值遵循"fail-closed"原则：
 *   - isEnabled → true（默认启用）
 *   - isConcurrencySafe → false（默认不并发安全，串行执行更安全）
 *   - isReadOnly → false（默认假设会写入，需要权限检查）
 *   - isDestructive → false（默认非破坏性）
 *   - checkPermissions → allow（委托给通用权限系统）
 *   - toAutoClassifierInput → ''（默认跳过安全分类）
 *   - userFacingName → 工具名称
 */
type DefaultableToolKeys =
  | 'isEnabled'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
  | 'userFacingName'

/**
 * 工具定义类型（传入 buildTool 的参数类型）
 *
 * 与 Tool 接口形状相同，但 DefaultableToolKeys 中的方法变为可选。
 * buildTool() 会为未提供的方法填入安全默认值，确保输出的 Tool 总是完整的。
 * 这样每个工具的定义文件只需关注自身特有的逻辑，无需重复书写样板代码。
 */
export type ToolDef<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = Omit<Tool<Input, Output, P>, DefaultableToolKeys> &
  Partial<Pick<Tool<Input, Output, P>, DefaultableToolKeys>>

/**
 * buildTool 输出的精确类型
 *
 * 在类型层面模拟运行时的 { ...TOOL_DEFAULTS, ...def } 展开行为：
 * - 对于 DefaultableToolKeys 中的每个键：
 *   - 如果 D 提供了（required），使用 D 的类型
 *   - 如果 D 未提供或为 optional，使用 TOOL_DEFAULTS 的类型
 * - 其他所有键直接从 D 中取，保留参数数量、可选性和字面量类型
 */
type BuiltTool<D> = Omit<D, DefaultableToolKeys> & {
  [K in DefaultableToolKeys]-?: K extends keyof D
    ? undefined extends D[K]
      ? ToolDefaults[K]
      : D[K]
    : ToolDefaults[K]
}

/**
 * 工具默认值映射表
 *
 * 所有工具通过 buildTool() 注册时，未显式提供的方法会从此处获取默认实现。
 * 默认值的设计遵循"安全关闭"（fail-closed）原则：
 *
 *   isEnabled → true
 *     默认启用。需要禁用的工具应显式返回 false。
 *
 *   isConcurrencySafe → false
 *     默认假设不并发安全。只有确认无副作用的工具（如纯读取）才应返回 true。
 *     这确保有疑问时串行执行，避免竞态条件。
 *
 *   isReadOnly → false
 *     默认假设工具会执行写操作。只读工具需显式声明。
 *     这确保计划模式（plan mode）下默认阻止工具执行。
 *
 *   isDestructive → false
 *     默认非破坏性。执行不可逆操作（删除、覆盖、发送）的工具需显式声明。
 *
 *   checkPermissions → allow
 *     默认允许，将权限判定完全委托给通用权限系统（permissions.ts）。
 *     需要工具级权限检查的工具应重写此方法。
 *
 *   toAutoClassifierInput → ''
 *     默认返回空字符串，跳过安全分类器。
 *     安全相关的工具（如 Bash）必须重写以提供分类器所需的输入。
 *
 *   userFacingName → 工具名称
 *     默认使用 name 字段，可被 buildTool 覆盖为 () => def.name。
 */
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: (
    input: { [key: string]: unknown },
    _ctx?: ToolUseContext,
  ): Promise<PermissionResult> =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

// The defaults type is the ACTUAL shape of TOOL_DEFAULTS (optional params so
// both 0-arg and full-arg call sites type-check — stubs varied in arity and
// tests relied on that), not the interface's strict signatures.
type ToolDefaults = typeof TOOL_DEFAULTS

// D infers the concrete object-literal type from the call site. The
// constraint provides contextual typing for method parameters; `any` in
// constraint position is structural and never leaks into the return type.
// BuiltTool<D> mirrors runtime `{...TOOL_DEFAULTS, ...def}` at the type level.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = ToolDef<any, any, any>

/**
 * buildTool() — 工具工厂函数
 *
 * 将一个 ToolDef（部分定义）展开为完整的 Tool 对象。
 * 运行时行为等价于：{ ...TOOL_DEFAULTS, userFacingName: () => def.name, ...def }
 *
 * 展开顺序保证：
 *   1. 先铺底 TOOL_DEFAULTS（提供所有默认方法）
 *   2. 设置 userFacingName 默认为工具名称
 *   3. 最后展开 def，工具自定义的方法会覆盖默认值
 *
 * 所有 60+ 个工具的导出都应通过此函数，确保：
 *   - 默认值集中管理，修改一处即可全局生效
 *   - 调用方无需 ?.() ?? default 防御性编程
 *   - 类型安全由 BuiltTool<D> 在编译期保证
 */
export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  // 运行时展开很直观；as 断言弥合了结构化 any 约束与精确 BuiltTool<D> 返回类型的差距
  // 类型正确性由全部 60+ 工具的零错误类型检查证明
  return {
    ...TOOL_DEFAULTS, // 第一层：安全默认值
    userFacingName: () => def.name, // 第二层：默认用工具名作为用户可见名
    ...def, // 第三层：工具自定义实现覆盖默认值
  } as BuiltTool<D>
}
