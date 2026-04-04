/**
 * ============================================================================
 * QueryEngine.ts — 高层编排器与会话管理
 * ============================================================================
 *
 * 【文件职责】
 * QueryEngine 是整个 Claude Code Agent 的高层编排器，负责：
 *   1. 管理一个完整对话会话的生命周期（消息历史、token 用量、文件状态等）
 *   2. 处理用户输入（slash commands、权限、附件等）
 *   3. 调用底层 query() 循环并消费其 AsyncGenerator 输出
 *   4. 将内部消息格式转换为 SDK 消费者可用的 SDKMessage 格式
 *   5. 管理会话持久化（transcript 录制、session storage 刷新）
 *   6. 追踪 token 使用量、成本、权限拒绝等元数据
 *
 * 【核心数据流】
 * SDK 调用方（headless / REPL / desktop）
 *   → new QueryEngine(config)         // 创建引擎实例
 *   → engine.submitMessage(prompt)     // 提交用户消息
 *     → processUserInput()             // 处理 slash commands 等
 *     → query()（query.ts）            // 进入 Agent 主循环
 *       → for await (message of query()) // 消费 generator 输出
 *         → normalizeMessage()          // 转换为 SDK 格式并 yield
 *         → recordTranscript()          // 持久化转录
 *         → 追踪 usage / cost / permissions
 *     → yield result                    // 产出最终结果（success / error）
 *
 * 【与其他模块的关系】
 * - query.ts：底层 Agent 循环，本文件调用其 query() 函数
 * - utils/processUserInput/：用户输入预处理（slash commands、模型切换等）
 * - utils/queryContext.ts：系统提示构建
 * - utils/sessionStorage.ts：会话持久化
 * - utils/messages/mappers.ts：消息格式转换
 * - state/AppState.ts：全局应用状态
 * - cost-tracker.ts：API 调用成本追踪
 *
 * 【导出接口】
 * - QueryEngine 类：一个会话一个实例，通过 submitMessage() 驱动多轮对话
 * - QueryEngineConfig 类型：构造 QueryEngine 所需的配置
 * - ask() 函数：便捷封装，适用于一次性查询场景（内部创建 QueryEngine）
 * ============================================================================
 */
import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import last from 'lodash-es/last.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from 'src/bootstrap/state.js'
import type {
  PermissionMode,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKStatus,
  SDKUserMessageReplay,
} from 'src/entrypoints/agentSdkTypes.js'
import type { BetaMessageDeltaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { accumulateUsage, updateUsage } from 'src/services/api/claude.js'
import type { NonNullableUsage } from 'src/services/api/logging.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import stripAnsi from 'strip-ansi'
import type { Command } from './commands.js'
import { getSlashCommandToolSkills } from './commands.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from './constants/xml.js'
import {
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
} from './cost-tracker.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'
import { query } from './query.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import type { MCPServerConnection } from './services/mcp/types.js'
import type { AppState } from './state/AppState.js'
import { type Tools, type ToolUseContext, toolMatchesName } from './Tool.js'
import type { AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { APIError } from '@anthropic-ai/sdk'
import type { CompactMetadata, Message, SystemCompactBoundaryMessage } from './types/message.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { createAbortController } from './utils/abortController.js'
import type { AttributionState } from './utils/commitAttribution.js'
import { getGlobalConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { getFastModeState } from './utils/fastMode.js'
import {
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from './utils/fileHistory.js'
import {
  cloneFileStateCache,
  type FileStateCache,
} from './utils/fileStateCache.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { getInMemoryErrors } from './utils/log.js'
import { countToolCalls, SYNTHETIC_MESSAGES } from './utils/messages.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from './utils/model/model.js'
import { loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js'
import {
  type ProcessUserInputContext,
  processUserInput,
} from './utils/processUserInput/processUserInput.js'
import { fetchSystemPromptParts } from './utils/queryContext.js'
import { setCwd } from './utils/Shell.js'
import {
  flushSessionStorage,
  recordTranscript,
} from './utils/sessionStorage.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { resolveThemeSetting } from './utils/systemTheme.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './utils/thinking.js'

// Lazy: MessageSelector.tsx pulls React/ink; only needed for message filtering at query time
/* eslint-disable @typescript-eslint/no-require-imports */
const messageSelector =
  (): typeof import('src/components/MessageSelector.js') =>
    require('src/components/MessageSelector.js')

import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import {
  buildSystemInitMessage,
  sdkCompatToolName,
} from './utils/messages/systemInit.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from './utils/permissions/filesystem.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  handleOrphanedPermission,
  isResultSuccessful,
  normalizeMessage,
} from './utils/queryHelpers.js'

// Dead code elimination: conditional import for coordinator mode
/* eslint-disable @typescript-eslint/no-require-imports */
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({})
/* eslint-enable @typescript-eslint/no-require-imports */

// Dead code elimination: conditional import for snip compaction
/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const snipProjection = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipProjection.js') as typeof import('./services/compact/snipProjection.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * QueryEngine 的构造配置类型。
 *
 * 包含创建一个会话引擎所需的所有参数：工具列表、命令、MCP 连接、
 * 权限检查、状态管理、模型配置等。
 */
export type QueryEngineConfig = {
  /** 工作目录 */
  cwd: string
  /** 可用工具列表 */
  tools: Tools
  /** 可用 slash 命令列表 */
  commands: Command[]
  /** MCP（Model Context Protocol）服务器连接 */
  mcpClients: MCPServerConnection[]
  /** Agent 定义列表 */
  agents: AgentDefinition[]
  /** 工具使用权限检查回调 */
  canUseTool: CanUseToolFn
  /** 获取全局应用状态 */
  getAppState: () => AppState
  /** 更新全局应用状态 */
  setAppState: (f: (prev: AppState) => AppState) => void
  /** 初始消息历史（用于会话恢复） */
  initialMessages?: Message[]
  /** 文件读取状态缓存（避免重复读取同一文件） */
  readFileCache: FileStateCache
  /** 自定义系统提示（替换默认系统提示） */
  customSystemPrompt?: string
  /** 追加系统提示（附加到默认系统提示之后） */
  appendSystemPrompt?: string
  /** 用户指定的模型名称 */
  userSpecifiedModel?: string
  /** 备用模型名称（主模型不可用时） */
  fallbackModel?: string
  /** 思维链配置（adaptive / disabled） */
  thinkingConfig?: ThinkingConfig
  /** 最大轮次限制 */
  maxTurns?: number
  /** 最大 USD 预算限制 */
  maxBudgetUsd?: number
  /** API 任务预算 */
  taskBudget?: { total: number }
  /** JSON Schema（用于结构化输出强制执行） */
  jsonSchema?: Record<string, unknown>
  /** 详细模式 */
  verbose?: boolean
  /** 是否回放用户消息给 SDK 调用方 */
  replayUserMessages?: boolean
  /** MCP 工具 -32042 错误触发的 URL 引出处理器 */
  handleElicitation?: ToolUseContext['handleElicitation']
  /** 是否包含部分消息（流式事件） */
  includePartialMessages?: boolean
  /** SDK 状态更新回调 */
  setSDKStatus?: (status: SDKStatus) => void
  /** 外部提供的中断控制器 */
  abortController?: AbortController
  /** 孤立权限（上次会话中断留下的待处理权限请求） */
  orphanedPermission?: OrphanedPermission
  /**
   * Snip-boundary handler: receives each yielded system message plus the
   * current mutableMessages store. Returns undefined if the message is not a
   * snip boundary; otherwise returns the replayed snip result. Injected by
   * ask() when HISTORY_SNIP is enabled so feature-gated strings stay inside
   * the gated module (keeps QueryEngine free of excluded strings and testable
   * despite feature() returning false under bun test). SDK-only: the REPL
   * keeps full history for UI scrollback and projects on demand via
   * projectSnippedView; QueryEngine truncates here to bound memory in long
   * headless sessions (no UI to preserve).
   */
  snipReplay?: (
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
}

/**
 * QueryEngine — 对话会话的核心编排器。
 *
 * 拥有查询生命周期和会话状态。从 ask() 中提取核心逻辑为独立类，
 * 可被 headless/SDK 路径和 REPL 共同使用。
 *
 * 一个会话对应一个 QueryEngine 实例。每次 submitMessage() 调用在同一会话中
 * 启动新的轮次。状态（消息历史、文件缓存、token 用量等）跨轮次持久化。
 *
 * 【主要职责】
 * - submitMessage()：处理用户输入 → 调用 query() → 消费并转换输出 → yield SDK 消息
 * - interrupt()：中断当前查询
 * - getMessages()：获取完整消息历史
 * - setModel()：动态切换模型
 */
export class QueryEngine {
  /** 引擎配置（不可变引用，但 userSpecifiedModel 可通过 setModel 修改） */
  private config: QueryEngineConfig
  /** 可变消息数组 — 整个会话的消息历史，跨轮次累积 */
  private mutableMessages: Message[]
  /** 中断控制器 — 调用 abort() 可中断当前正在进行的查询 */
  private abortController: AbortController
  /** 权限拒绝记录 — 用于 SDK 结果报告 */
  private permissionDenials: SDKPermissionDenial[]
  /** 累计 token 使用量 — 跨所有 API 调用累加 */
  private totalUsage: NonNullableUsage
  /** 是否已处理过孤立权限（仅处理一次） */
  private hasHandledOrphanedPermission = false
  /** 文件读取状态缓存 — 跨轮次持久化，避免重复读取 */
  private readFileState: FileStateCache
  /**
   * 轮次级别的技能发现追踪。每次 submitMessage 开头清空，
   * 但在 submitMessage 内的两次 processUserInputContext 重建间持久。
   */
  private discoveredSkillNames = new Set<string>()
  /** 已加载的嵌套 memory 路径（避免重复加载） */
  private loadedNestedMemoryPaths = new Set<string>()

  /**
   * 构造 QueryEngine 实例。
   *
   * @param config - 包含工具、命令、MCP 连接、权限等的完整配置
   */
  constructor(config: QueryEngineConfig) {
    this.config = config
    this.mutableMessages = config.initialMessages ?? []  // 初始消息（会话恢复时非空）
    this.abortController = config.abortController ?? createAbortController()
    this.permissionDenials = []
    this.readFileState = config.readFileCache
    this.totalUsage = EMPTY_USAGE  // 初始化为零用量
  }

  /**
   * submitMessage() — 提交用户消息并驱动一个完整的对话轮次。
   *
   * 这是 QueryEngine 的核心方法，作为 AsyncGenerator 产出 SDKMessage 流。
   * 调用方（如 headless runner、desktop client）通过 for-await-of 消费输出。
   *
   * 【执行流程】
   * 1. 解构配置、初始化轮次
   * 2. 包装 canUseTool 以追踪权限拒绝
   * 3. 构建系统提示（默认 + custom + append + memory）
   * 4. processUserInput()：处理 slash commands、模型切换等
   * 5. 持久化用户消息到 transcript
   * 6. 构建 system_init 消息（工具列表、模型信息等）
   * 7. 如果不需要查询（纯本地命令），直接返回结果
   * 8. 调用 query()（query.ts）进入 Agent 主循环
   * 9. for-await 消费 query() 产出 → 转换为 SDK 格式 → yield
   * 10. 产出最终 result 消息（success / error_max_turns / error_max_budget 等）
   *
   * @param prompt - 用户输入（字符串或结构化内容块）
   * @param options - 可选参数（uuid、isMeta 标记）
   * @yields SDKMessage — SDK 消费者可直接使用的消息格式
   */
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // 解构配置（每次 submitMessage 都重新解构���以捕获 setModel 的更新）
    const {
      cwd,
      commands,
      tools,
      mcpClients,
      verbose = false,
      thinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      canUseTool,
      customSystemPrompt,
      appendSystemPrompt,
      userSpecifiedModel,
      fallbackModel,
      jsonSchema,
      getAppState,
      setAppState,
      replayUserMessages = false,
      includePartialMessages = false,
      agents = [],
      setSDKStatus,
      orphanedPermission,
    } = this.config

    // 每个轮次清空技能发现集合（避免跨轮次无限增长）
    this.discoveredSkillNames.clear()
    setCwd(cwd)
    const persistSession = !isSessionPersistenceDisabled()
    const startTime = Date.now()

    // 包装 canUseTool 回调，在原有权限检查基础上追踪拒绝记录（用于 SDK 报告）
    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      const result = await canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )

      // Track denials for SDK reporting
      if (result.behavior !== 'allow') {
        this.permissionDenials.push({
          type: 'permission_denial',
          tool_name: sdkCompatToolName(tool.name),
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }

      return result
    }

    // 快照初始状态（在轮次开始时捕获，轮次内不变）
    const initialAppState = getAppState()
    // 确定主循环使��的模型（优先使用用户指定的模型）
    const initialMainLoopModel = userSpecifiedModel
      ? parseUserSpecifiedModel(userSpecifiedModel)
      : getMainLoopModel()

    // 确定思维链配置：用户显式配置 > 默认启用 adaptive > disabled
    const initialThinkingConfig: ThinkingConfig = thinkingConfig
      ? thinkingConfig
      : shouldEnableThinkingByDefault() !== false
        ? { type: 'adaptive' }
        : { type: 'disabled' }

    // ===== 系统提示构建 =====
    headlessProfilerCheckpoint('before_getSystemPrompt')
    const customPrompt =
      typeof customSystemPrompt === 'string' ? customSystemPrompt : undefined
    // 获取系统提示的三个组成部分：默认提示、用户上下文、系统上下文
    const {
      defaultSystemPrompt,
      userContext: baseUserContext,
      systemContext,
    } = await fetchSystemPromptParts({
      tools,
      mainLoopModel: initialMainLoopModel,
      additionalWorkingDirectories: Array.from(
        initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt: customPrompt,
    })
    headlessProfilerCheckpoint('after_getSystemPrompt')
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(
        mcpClients,
        isScratchpadEnabled() ? getScratchpadDir() : undefined,
      ),
    }

    // 当 SDK 调用方提供了自定义系统提示且设置了 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 时，
    // 注入 memory 机制提示。告诉 Claude 如何使用 Write/Edit 工具操作 MEMORY.md。
    const memoryMechanicsPrompt =
      customPrompt !== undefined && hasAutoMemPathOverride()
        ? await loadMemoryPrompt()
        : null

    // 组合最终系统提示：自定义提示 / 默认提示 + memory 提示 + 追加提示
    const systemPrompt = asSystemPrompt([
      ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
      ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])

    // 如果有 JSON Schema 且存在结构化输出工具，注册强制执行 hook
    const hasStructuredOutputTool = tools.some(t =>
      toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    )
    if (jsonSchema && hasStructuredOutputTool) {
      registerStructuredOutputEnforcement(setAppState, getSessionId())
    }

    // ===== 构建用户输入处理上下文 =====
    // 第一次构建：用于 processUserInput()（处理 slash commands 等）
    let processUserInputContext: ProcessUserInputContext = {
      messages: this.mutableMessages,
      // Slash commands that mutate the message array (e.g. /force-snip)
      // call setMessages(fn).  In interactive mode this writes back to
      // AppState; in print mode we write back to mutableMessages so the
      // rest of the query loop (push at :389, snapshot at :392) sees
      // the result.  The second processUserInputContext below (after
      // slash-command processing) keeps the no-op — nothing else calls
      // setMessages past that point.
      setMessages: fn => {
        this.mutableMessages = fn(this.mutableMessages)
      },
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false, // we use stdout, so don't want to clobber it
        tools,
        verbose,
        mainLoopModel: initialMainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        theme: resolveThemeSetting(getGlobalConfig().theme),
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: (
        updater: (prev: FileHistoryState) => FileHistoryState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.fileHistory)
          if (updated === prev.fileHistory) return prev
          return { ...prev, fileHistory: updated }
        })
      },
      updateAttributionState: (
        updater: (prev: AttributionState) => AttributionState,
      ) => {
        setAppState(prev => {
          const updated = updater(prev.attribution)
          if (updated === prev.attribution) return prev
          return { ...prev, attribution: updated }
        })
      },
      setSDKStatus,
    }

    // ===== 处理孤立权限请求（仅在引擎生命周期内处理一次）=====
    // 上次会话中断时可能留下未处理的权限请求
    if (orphanedPermission && !this.hasHandledOrphanedPermission) {
      this.hasHandledOrphanedPermission = true
      for await (const message of handleOrphanedPermission(
        orphanedPermission,
        tools,
        this.mutableMessages,
        processUserInputContext,
      )) {
        yield message
      }
    }

    // ===== 处理用户输入 =====
    // processUserInput 负责：
    //   - 解析 slash commands（如 /compact, /model, /clear 等）
    //   - 创建用户消息和附件消息
    //   - 确定是否需要向 API 发起查询（shouldQuery）
    //   - 返回允许的工具列表和可能的模型切换
    const {
      messages: messagesFromUserInput,
      shouldQuery,
      allowedTools,
      model: modelFromUserInput,
      resultText,
    } = await processUserInput({
      input: prompt,
      mode: 'prompt',
      setToolJSX: () => {},
      context: {
        ...processUserInputContext,
        messages: this.mutableMessages,
      },
      messages: this.mutableMessages,
      uuid: options?.uuid,
      isMeta: options?.isMeta,
      querySource: 'sdk',
    })

    // 将用户输入产生的消息（用户消息 + 附件）追加到可变消息数组
    this.mutableMessages.push(...messagesFromUserInput)

    // 创建消息数组的快照（用于传递给 query() 和 transcript）
    const messages = [...this.mutableMessages]

    // 在进入查询循环之前先持久化用户消息到 transcript。
    // 这确保即使 API 响应到达之前进程被杀死（如用户在 cowork 中点击 Stop），
    // transcript 仍然包含用户消息，--resume 可以从该点恢复。
    //
    // --bare / SIMPLE: fire-and-forget. Scripted calls don't --resume after
    // kill-mid-request. The await is ~4ms on SSD, ~30ms under disk contention
    // — the single largest controllable critical-path cost after module eval.
    // Transcript is still written (for post-hoc debugging); just not blocking.
    if (persistSession && messagesFromUserInput.length > 0) {
      const transcriptPromise = recordTranscript(messages)
      if (isBareMode()) {
        void transcriptPromise
      } else {
        await transcriptPromise
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }
    }

    // 过滤需要回放确认的消息（用户消息 + 压缩边界，排除合成消息和工具结果）
    const replayableMessages = messagesFromUserInput.filter(
      msg =>
        (msg.type === 'user' &&
          !msg.isMeta && // Skip synthetic caveat messages
          !msg.toolUseResult && // Skip tool results (they'll be acked from query)
          messageSelector().selectableUserMessagesFilter(msg)) || // Skip non-user-authored messages (task notifications, etc.)
        (msg.type === 'system' && msg.subtype === 'compact_boundary'), // Always ack compact boundaries
    )
    const messagesToAck = replayUserMessages ? replayableMessages : []

    // 根据用户输入处理结果更新工具权限上下文（如 slash command 授权的工具）
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        alwaysAllowRules: {
          ...prev.toolPermissionContext.alwaysAllowRules,
          command: allowedTools,
        },
      },
    }))

    // 如果 slash command 切换了模型，使用新模型；否则使用初始模型
    const mainLoopModel = modelFromUserInput ?? initialMainLoopModel

    // 第二次构建 processUserInputContext：更新消息和模型（slash commands 可能已修改）
    processUserInputContext = {
      messages,
      setMessages: () => {},
      onChangeAPIKey: () => {},
      handleElicitation: this.config.handleElicitation,
      options: {
        commands,
        debug: false,
        tools,
        verbose,
        mainLoopModel,
        thinkingConfig: initialThinkingConfig,
        mcpClients,
        mcpResources: {},
        ideInstallationStatus: null,
        isNonInteractiveSession: true,
        customSystemPrompt,
        appendSystemPrompt,
        theme: resolveThemeSetting(getGlobalConfig().theme),
        agentDefinitions: { activeAgents: agents, allAgents: [] },
        maxBudgetUsd,
      },
      getAppState,
      setAppState,
      abortController: this.abortController,
      readFileState: this.readFileState,
      nestedMemoryAttachmentTriggers: new Set<string>(),
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      dynamicSkillDirTriggers: new Set<string>(),
      discoveredSkillNames: this.discoveredSkillNames,
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: processUserInputContext.updateFileHistoryState,
      updateAttributionState: processUserInputContext.updateAttributionState,
      setSDKStatus,
    }

    // ===== 加载技能和插件（仅从缓存，不阻塞网络）=====
    headlessProfilerCheckpoint('before_skills_plugins')
    const [skills, { enabled: enabledPlugins }] = await Promise.all([
      getSlashCommandToolSkills(getCwd()),
      loadAllPluginsCacheOnly(),
    ])
    headlessProfilerCheckpoint('after_skills_plugins')

    // 产出系统初始化消息（包含工具列表、模型信息、权限模式等元数据）
    yield buildSystemInitMessage({
      tools,
      mcpClients,
      model: mainLoopModel,
      permissionMode: initialAppState.toolPermissionContext
        .mode as PermissionMode, // TODO: avoid the cast
      commands,
      agents,
      skills,
      plugins: enabledPlugins,
      fastMode: initialAppState.fastMode,
    })

    // Record when system message is yielded for headless latency tracking
    headlessProfilerCheckpoint('system_message_yielded')

    // ===== 本地命令路径（无需 API 查询）=====
    // 当 processUserInput 返回 shouldQuery=false 时（如 /compact, /clear 等），
    // 直接返回命令执行结果，不进入 Agent 主循环。
    if (!shouldQuery) {
      // Use messagesFromUserInput (not replayableMessages) for command output
      // because selectableUserMessagesFilter excludes local-command-stdout tags.
      for (const msg of messagesFromUserInput) {
        if (
          msg.type === 'user' &&
          typeof msg.message.content === 'string' &&
          (msg.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.message.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`) ||
            msg.isCompactSummary)
        ) {
          yield {
            type: 'user',
            message: {
              ...msg.message,
              content: stripAnsi(msg.message.content),
            },
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
            isReplay: !msg.isCompactSummary,
            isSynthetic: msg.isMeta || msg.isVisibleInTranscriptOnly,
          } as unknown as SDKUserMessageReplay
        }

        // Local command output — yield as a synthetic assistant message so
        // RC renders it as assistant-style text rather than a user bubble.
        // Emitted as assistant (not the dedicated SDKLocalCommandOutputMessage
        // system subtype) so mobile clients + session-ingress can parse it.
        if (
          msg.type === 'system' &&
          msg.subtype === 'local_command' &&
          typeof msg.content === 'string' &&
          (msg.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            msg.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          yield localCommandOutputToSDKAssistantMessage(msg.content, msg.uuid)
        }

        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          const compactMsg = msg as SystemCompactBoundaryMessage
          yield {
            type: 'system',
            subtype: 'compact_boundary' as const,
            session_id: getSessionId(),
            uuid: msg.uuid,
            compact_metadata: toSDKCompactMetadata(compactMsg.compactMetadata),
          } as unknown as SDKCompactBoundaryMessage
        }
      }

      if (persistSession) {
        await recordTranscript(messages)
        if (
          isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
          isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
        ) {
          await flushSessionStorage()
        }
      }

      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        num_turns: messages.length - 1,
        result: resultText ?? '',
        stop_reason: null,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
      }
      return
    }

    // ===== 文件历史快照（用于 undo 支持）=====
    if (fileHistoryEnabled() && persistSession) {
      messagesFromUserInput
        .filter(messageSelector().selectableUserMessagesFilter)
        .forEach(message => {
          void fileHistoryMakeSnapshot(
            (updater: (prev: FileHistoryState) => FileHistoryState) => {
              setAppState(prev => ({
                ...prev,
                fileHistory: updater(prev.fileHistory),
              }))
            },
            message.uuid,
          )
        })
    }

    // ===== 进入 Agent 主循环 =====
    // 以下变量跟踪本次 submitMessage 调用期间的状态

    /** 当前 API 消息的 token 用量（每次 message_start 重置） */
    let currentMessageUsage: NonNullableUsage = EMPTY_USAGE
    /** 轮次计数（用户消息每出现一次 +1） */
    let turnCount = 1
    /** 是否已回放确认初始消息 */
    let hasAcknowledgedInitialMessages = false
    /** 结构化输出工具的输出（如果有 JSON Schema 约束） */
    let structuredOutputFromTool: unknown
    /** 最后一个 stop_reason（从 message_delta 事件中捕获） */
    let lastStopReason: string | null = null
    // Reference-based watermark so error_during_execution's errors[] is
    // turn-scoped. A length-based index breaks when the 100-entry ring buffer
    // shift()s during the turn — the index slides. If this entry is rotated
    // out, lastIndexOf returns -1 and we include everything (safe fallback).
    const errorLogWatermark = getInMemoryErrors().at(-1)
    // Snapshot count before this query for delta-based retry limiting
    const initialStructuredOutputCalls = jsonSchema
      ? countToolCalls(this.mutableMessages, SYNTHETIC_OUTPUT_TOOL_NAME)
      : 0

    // 调用 query()（query.ts）— Agent 核心主循环
    // 消费其 AsyncGenerator 输出，逐条处理并转换为 SDK 格式
    for await (const message of query({
      messages,
      systemPrompt,
      userContext,
      systemContext,
      canUseTool: wrappedCanUseTool,
      toolUseContext: processUserInputContext,
      fallbackModel,
      querySource: 'sdk',
      maxTurns,
      taskBudget,
    })) {
      // ===== 消息持久化：记录 assistant / user / compact_boundary 消息到 transcript =====
      if (
        message.type === 'assistant' ||
        message.type === 'user' ||
        (message.type === 'system' && message.subtype === 'compact_boundary')
      ) {
        // Before writing a compact boundary, flush any in-memory-only
        // messages up through the preservedSegment tail. Attachments and
        // progress are now recorded inline (their switch cases below), but
        // this flush still matters for the preservedSegment tail walk.
        // If the SDK subprocess restarts before then (claude-desktop kills
        // between turns), tailUuid points to a never-written message →
        // applyPreservedSegmentRelinks fails its tail→head walk → returns
        // without pruning → resume loads full pre-compact history.
        if (
          persistSession &&
          message.type === 'system' &&
          message.subtype === 'compact_boundary'
        ) {
          const compactMsg = message as SystemCompactBoundaryMessage
          const tailUuid = compactMsg.compactMetadata?.preservedSegment?.tailUuid
          if (tailUuid) {
            const tailIdx = this.mutableMessages.findLastIndex(
              m => m.uuid === tailUuid,
            )
            if (tailIdx !== -1) {
              await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1))
            }
          }
        }
        messages.push(message as Message)
        if (persistSession) {
          // Fire-and-forget for assistant messages. claude.ts yields one
          // assistant message per content block, then mutates the last
          // one's message.usage/stop_reason on message_delta — relying on
          // the write queue's 100ms lazy jsonStringify. Awaiting here
          // blocks ask()'s generator, so message_delta can't run until
          // every block is consumed; the drain timer (started at block 1)
          // elapses first. Interactive CC doesn't hit this because
          // useLogMessages.ts fire-and-forgets. enqueueWrite is
          // order-preserving so fire-and-forget here is safe.
          if (message.type === 'assistant') {
            void recordTranscript(messages)
          } else {
            await recordTranscript(messages)
          }
        }

        // Acknowledge initial user messages after first transcript recording
        if (!hasAcknowledgedInitialMessages && messagesToAck.length > 0) {
          hasAcknowledgedInitialMessages = true
          for (const msgToAck of messagesToAck) {
            if (msgToAck.type === 'user') {
              yield {
                type: 'user',
                message: msgToAck.message,
                session_id: getSessionId(),
                parent_tool_use_id: null,
                uuid: msgToAck.uuid,
                timestamp: msgToAck.timestamp,
                isReplay: true,
              } as unknown as SDKUserMessageReplay
            }
          }
        }
      }

      // 用��消息出现时递增轮次计数
      if (message.type === 'user') {
        turnCount++
      }

      // ===== 消息类型分发处理 =====
      switch (message.type) {
        case 'tombstone':
          // Tombstone 是控制信号，用于���除已作废的消息（如 fallback 前的孤立消息），跳过
          break
        case 'assistant': {
          // Capture stop_reason if already set (synthetic messages). For
          // streamed responses, this is null at content_block_stop time;
          // the real value arrives via message_delta (handled below).
          const msg = message as Message
          const stopReason = msg.message?.stop_reason as string | null | undefined
          if (stopReason != null) {
            lastStopReason = stopReason
          }
          this.mutableMessages.push(msg)
          yield* normalizeMessage(msg)
          break
        }
        case 'progress': {
          const msg = message as Message
          this.mutableMessages.push(msg)
          // Record inline so the dedup loop in the next ask() call sees it
          // as already-recorded. Without this, deferred progress interleaves
          // with already-recorded tool_results in mutableMessages, and the
          // dedup walk freezes startingParentUuid at the wrong message —
          // forking the chain and orphaning the conversation on resume.
          if (persistSession) {
            messages.push(msg)
            void recordTranscript(messages)
          }
          yield* normalizeMessage(msg)
          break
        }
        case 'user': {
          const msg = message as Message
          this.mutableMessages.push(msg)
          yield* normalizeMessage(msg)
          break
        }
        case 'stream_event': {
          // ---- 流式事件处���：追踪 token 用量和 stop_reason ----
          const event = (message as unknown as { event: Record<string, unknown> }).event
          if (event.type === 'message_start') {
            // 新消息开始：重置当前消息用量
            currentMessageUsage = EMPTY_USAGE
            const eventMessage = event.message as { usage: BetaMessageDeltaUsage }
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              eventMessage.usage,
            )
          }
          if (event.type === 'message_delta') {
            currentMessageUsage = updateUsage(
              currentMessageUsage,
              event.usage as BetaMessageDeltaUsage,
            )
            // Capture stop_reason from message_delta. The assistant message
            // is yielded at content_block_stop with stop_reason=null; the
            // real value only arrives here (see claude.ts message_delta
            // handler). Without this, result.stop_reason is always null.
            const delta = event.delta as { stop_reason?: string | null }
            if (delta.stop_reason != null) {
              lastStopReason = delta.stop_reason
            }
          }
          if (event.type === 'message_stop') {
            // 消息结束：将当前消息用量累加到总用量
            this.totalUsage = accumulateUsage(
              this.totalUsage,
              currentMessageUsage,
            )
          }

          if (includePartialMessages) {
            yield {
              type: 'stream_event' as const,
              event,
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: randomUUID(),
            }
          }

          break
        }
        case 'attachment': {
          // ---- 附件消息处理 ----
          const msg = message as Message
          this.mutableMessages.push(msg)
          if (persistSession) {
            messages.push(msg)
            void recordTranscript(messages)
          }

          const attachment = msg.attachment as { type: string; data?: unknown; turnCount?: number; maxTurns?: number; prompt?: string; source_uuid?: string; [key: string]: unknown }

          // 提取结构化输出（来自 StructuredOutput 工具调用）
          if (attachment.type === 'structured_output') {
            structuredOutputFromTool = attachment.data
          }
          // query.ts 发出的最大轮次达到信号 → 产出 error_max_turns 结果并终止
          else if (attachment.type === 'max_turns_reached') {
            if (persistSession) {
              if (
                isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
                isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
              ) {
                await flushSessionStorage()
              }
            }
            yield {
              type: 'result',
              subtype: 'error_max_turns',
              duration_ms: Date.now() - startTime,
              duration_api_ms: getTotalAPIDuration(),
              is_error: true,
              num_turns: attachment.turnCount as number,
              stop_reason: lastStopReason,
              session_id: getSessionId(),
              total_cost_usd: getTotalCost(),
              usage: this.totalUsage,
              modelUsage: getModelUsage(),
              permission_denials: this.permissionDenials,
              fast_mode_state: getFastModeState(
                mainLoopModel,
                initialAppState.fastMode,
              ),
              uuid: randomUUID(),
              errors: [
                `Reached maximum number of turns (${attachment.maxTurns})`,
              ],
            }
            return
          }
          // Yield queued_command attachments as SDK user message replays
          else if (
            replayUserMessages &&
            attachment.type === 'queued_command'
          ) {
            yield {
              type: 'user',
              message: {
                role: 'user' as const,
                content: attachment.prompt,
              },
              session_id: getSessionId(),
              parent_tool_use_id: null,
              uuid: attachment.source_uuid || msg.uuid,
              timestamp: msg.timestamp,
              isReplay: true,
            } as unknown as SDKUserMessageReplay
          }
          break
        }
        case 'stream_request_start':
          // Don't yield stream request start messages
          break
        case 'system': {
          // ---- 系统消息处理：snip 边界 / compact 边界 / API 错误 ----
          const msg = message as Message
          // Snip 边界处理：在 mutableMessages 上重放，移除僵尸消息和过期标记。
          // 防止 mutableMessages 在长 SDK 会话中无限增长（内存泄漏）。
          const snipResult = this.config.snipReplay?.(
            msg,
            this.mutableMessages,
          )
          if (snipResult !== undefined) {
            if (snipResult.executed) {
              this.mutableMessages.length = 0
              this.mutableMessages.push(...snipResult.messages)
            }
            break
          }
          this.mutableMessages.push(msg)
          // Compact 边界消息：释放压缩边界之前的消息以供 GC 回收，
          // 因为 query.ts 内部已使用 getMessagesAfterCompactBoundary()，
          // 后续只需要边界之后的消息。
          if (
            msg.subtype === 'compact_boundary' &&
            msg.compactMetadata
          ) {
            const compactMsg = msg as SystemCompactBoundaryMessage
            // 释放压缩前的消息（splice 掉边界之前的所有消息）
            const mutableBoundaryIdx = this.mutableMessages.length - 1
            if (mutableBoundaryIdx > 0) {
              this.mutableMessages.splice(0, mutableBoundaryIdx)
            }
            const localBoundaryIdx = messages.length - 1
            if (localBoundaryIdx > 0) {
              messages.splice(0, localBoundaryIdx)
            }

            yield {
              type: 'system',
              subtype: 'compact_boundary' as const,
              session_id: getSessionId(),
              uuid: msg.uuid,
              compact_metadata: toSDKCompactMetadata(compactMsg.compactMetadata),
            }
          }
          if (msg.subtype === 'api_error') {
            const apiErrorMsg = msg as Message & { retryAttempt: number; maxRetries: number; retryInMs: number; error: APIError }
            yield {
              type: 'system',
              subtype: 'api_retry' as const,
              attempt: apiErrorMsg.retryAttempt,
              max_retries: apiErrorMsg.maxRetries,
              retry_delay_ms: apiErrorMsg.retryInMs,
              error_status: apiErrorMsg.error.status ?? null,
              error: categorizeRetryableAPIError(apiErrorMsg.error),
              session_id: getSessionId(),
              uuid: msg.uuid,
            }
          }
          // Don't yield other system messages in headless mode
          break
        }
        case 'tool_use_summary': {
          const msg = message as Message & { summary: unknown; precedingToolUseIds: unknown }
          // Yield tool use summary messages to SDK
          yield {
            type: 'tool_use_summary' as const,
            summary: msg.summary,
            preceding_tool_use_ids: msg.precedingToolUseIds,
            session_id: getSessionId(),
            uuid: msg.uuid,
          }
          break
        }
      }

      // ===== 预算检查：USD 成本是否超限 =====
      if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
        if (persistSession) {
          if (
            isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
            isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
          ) {
            await flushSessionStorage()
          }
        }
        yield {
          type: 'result',
          subtype: 'error_max_budget_usd',
          duration_ms: Date.now() - startTime,
          duration_api_ms: getTotalAPIDuration(),
          is_error: true,
          num_turns: turnCount,
          stop_reason: lastStopReason,
          session_id: getSessionId(),
          total_cost_usd: getTotalCost(),
          usage: this.totalUsage,
          modelUsage: getModelUsage(),
          permission_denials: this.permissionDenials,
          fast_mode_state: getFastModeState(
            mainLoopModel,
            initialAppState.fastMode,
          ),
          uuid: randomUUID(),
          errors: [`Reached maximum budget ($${maxBudgetUsd})`],
        }
        return
      }

      // 检查结构化输出重试次数是否超限（仅对用户消息检查）
      if (message.type === 'user' && jsonSchema) {
        const currentCalls = countToolCalls(
          this.mutableMessages,
          SYNTHETIC_OUTPUT_TOOL_NAME,
        )
        const callsThisQuery = currentCalls - initialStructuredOutputCalls
        const maxRetries = parseInt(
          process.env.MAX_STRUCTURED_OUTPUT_RETRIES || '5',
          10,
        )
        if (callsThisQuery >= maxRetries) {
          if (persistSession) {
            if (
              isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
              isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
            ) {
              await flushSessionStorage()
            }
          }
          yield {
            type: 'result',
            subtype: 'error_max_structured_output_retries',
            duration_ms: Date.now() - startTime,
            duration_api_ms: getTotalAPIDuration(),
            is_error: true,
            num_turns: turnCount,
            stop_reason: lastStopReason,
            session_id: getSessionId(),
            total_cost_usd: getTotalCost(),
            usage: this.totalUsage,
            modelUsage: getModelUsage(),
            permission_denials: this.permissionDenials,
            fast_mode_state: getFastModeState(
              mainLoopModel,
              initialAppState.fastMode,
            ),
            uuid: randomUUID(),
            errors: [
              `Failed to provide valid structured output after ${maxRetries} attempts`,
            ],
          }
          return
        }
      }
    }

    // ===== query() 循环结��，处理最终结果 =====
    // 查找最后一条 assistant 或 user 消息作为结果（跳过 progress/attachment）
    const result = messages.findLast(
      m => m.type === 'assistant' || m.type === 'user',
    )
    // Capture for the error_during_execution diagnostic — isResultSuccessful
    // is a type predicate (message is Message), so inside the false branch
    // `result` narrows to never and these accesses don't typecheck.
    const edeResultType = result?.type ?? 'undefined'
    const edeLastContentType =
      result?.type === 'assistant'
        ? (last(result.message.content)?.type ?? 'none')
        : 'n/a'

    // Flush buffered transcript writes before yielding result.
    // The desktop app kills the CLI process immediately after receiving the
    // result message, so any unflushed writes would be lost.
    if (persistSession) {
      if (
        isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
        isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
      ) {
        await flushSessionStorage()
      }
    }

    // 结果验���失败 → 产出 error_during_execution 结果
    if (!isResultSuccessful(result, lastStopReason)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        is_error: true,
        num_turns: turnCount,
        stop_reason: lastStopReason,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          mainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
        // Diagnostic prefix: these are what isResultSuccessful() checks — if
        // the result type isn't assistant-with-text/thinking or user-with-
        // tool_result, and stop_reason isn't end_turn, that's why this fired.
        // errors[] is turn-scoped via the watermark; previously it dumped the
        // entire process's logError buffer (ripgrep timeouts, ENOENT, etc).
        errors: (() => {
          const all = getInMemoryErrors()
          const start = errorLogWatermark
            ? all.lastIndexOf(errorLogWatermark) + 1
            : 0
          return [
            `[ede_diagnostic] result_type=${edeResultType} last_content_type=${edeLastContentType} stop_reason=${lastStopReason}`,
            ...all.slice(start).map(_ => _.error),
          ]
        })(),
      }
      return
    }

    // 从最终 assistant 消息中提取文本结果
    let textResult = ''
    let isApiError = false

    if (result.type === 'assistant') {
      const lastContent = last(result.message.content)
      if (
        lastContent?.type === 'text' &&
        !SYNTHETIC_MESSAGES.has(lastContent.text)
      ) {
        textResult = lastContent.text
      }
      isApiError = Boolean(result.isApiErrorMessage)
    }

    // ===== 产出成功结果 =====
    yield {
      type: 'result',
      subtype: 'success',
      is_error: isApiError,                     // API 错误��算"成功完成"（正常退出）
      duration_ms: Date.now() - startTime,      // 总耗时
      duration_api_ms: getTotalAPIDuration(),    // API 调用耗时
      num_turns: turnCount,                     // 总轮次数
      result: textResult,                       // 最终文本输出
      stop_reason: lastStopReason,              // 停止原���（end_turn / tool_use 等）
      session_id: getSessionId(),
      total_cost_usd: getTotalCost(),           // 总 USD 成本
      usage: this.totalUsage,                   // 累计 token 用量
      modelUsage: getModelUsage(),              // 按模型分类的用量
      permission_denials: this.permissionDenials, // 权限拒绝记录
      structured_output: structuredOutputFromTool, // 结构化输出（如有 JSON Schema）
      fast_mode_state: getFastModeState(
        mainLoopModel,
        initialAppState.fastMode,
      ),
      uuid: randomUUID(),
    }
  } // submitMessage() 结束

  /** 中断当前正在进行的查询（触发 AbortController.abort()） */
  interrupt(): void {
    this.abortController.abort()
  }

  /** 获取完整的消息历史（只读视图） */
  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  /** 获取文件读取状态缓存 */
  getReadFileState(): FileStateCache {
    return this.readFileState
  }

  /** 获取当前会话 ID */
  getSessionId(): string {
    return getSessionId()
  }

  /** 动态切换���型（影响下一次 submitMessage 调用） */
  setModel(model: string): void {
    this.config.userSpecifiedModel = model
  }
}

/**
 * ask() — 一次性查询的便捷封装函数。
 *
 * 向 Claude API 发送单个提示并返回响应。假定以非交互方式使用 —
 * 不会向用户请求权限或进一步输入。
 *
 * 内部创建一个 QueryEngine 实例，调用 submitMessage()，
 * 然后在 finally 中将更新后的文件状态缓存写回。
 *
 * 适用场景：headless 模式、SDK print 路径、单次查询等。
 */
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  orphanedPermission,
}: {
  commands: Command[]
  prompt: string | Array<ContentBlockParam>
  promptUuid?: string
  isMeta?: boolean
  cwd: string
  tools: Tools
  verbose?: boolean
  mcpClients: MCPServerConnection[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  canUseTool: CanUseToolFn
  mutableMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  jsonSchema?: Record<string, unknown>
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
  abortController?: AbortController
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  agents?: AgentDefinition[]
  setSDKStatus?: (status: SDKStatus) => void
  orphanedPermission?: OrphanedPermission
}): AsyncGenerator<SDKMessage, void, unknown> {
  const engine = new QueryEngine({
    cwd,
    tools,
    commands,
    mcpClients,
    agents: agents ?? [],
    canUseTool,
    getAppState,
    setAppState,
    initialMessages: mutableMessages,
    readFileCache: cloneFileStateCache(getReadFileCache()),
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    abortController,
    orphanedPermission,
    ...(feature('HISTORY_SNIP')
      ? {
          snipReplay: (yielded: Message, store: Message[]) => {
            if (!snipProjection!.isSnipBoundaryMessage(yielded))
              return undefined
            return snipModule!.snipCompactIfNeeded(store, { force: true })
          },
        }
      : {}),
  })

  try {
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
    })
  } finally {
    setReadFileCache(engine.getReadFileState())
  }
}
