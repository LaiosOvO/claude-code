/**
 * ============================================================================
 * query.ts — AI Agent 核心执行引擎（AsyncGenerator 主循环）
 * ============================================================================
 *
 * 【文件职责】
 * 本文件实现了 Claude Code Agent 的核心 query 循环，是整个系统的"心脏"。
 * 它通过 AsyncGenerator 模式驱动 AI 与工具之间的多轮交互：
 *   1. 向 Claude API 发送消息并流式接收响应
 *   2. 解析响应中的 tool_use 块，执行对应工具
 *   3. 将工具执行结果反馈给模型，继续下一轮对话
 *   4. 管理上下文压缩（autocompact / reactive compact / microcompact / snip）
 *   5. 处理各种错误恢复（prompt-too-long / max-output-tokens / fallback model）
 *
 * 【核心数据流】
 * 用户输入 → QueryEngine.submitMessage()
 *   → query() 入口（本文件）
 *     → queryLoop() 主循环（while(true)）
 *       → 上下文预处理（snip / microcompact / context-collapse / autocompact）
 *       → deps.callModel() 调用 Claude API 流式响应
 *       → 收集 assistant 消息和 tool_use 块
 *       → runTools() / StreamingToolExecutor 执行工具
 *       → 收集工具结果 + 附件（memory / skill / queued commands）
 *       → 组装下一轮消息 → continue（回到循环顶部）
 *     → 循环终止：无 tool_use / 中断 / 达到最大轮次 / 错误
 *   → 返回 Terminal（终止原因）
 *
 * 【与其他模块的关系】
 * - QueryEngine.ts：上层编排器，管理会话状态，调用本文件的 query()
 * - services/api/claude.ts：底层 API 调用，本文件通过 deps.callModel 间接调用
 * - services/tools/toolOrchestration.ts：工具执行编排（runTools）
 * - services/compact/：上下文压缩系列模块（autocompact / reactive / snip / microcompact）
 * - query/stopHooks.ts：停止钩子处理
 * - query/config.ts：查询配置构建
 * - query/deps.ts：依赖注入（便于测试）
 * - query/transitions.ts：状态转换类型定义（Terminal / Continue）
 *
 * 【状态机概览】
 * queryLoop 是一个显式状态机，每次循环迭代的终止方式由 State.transition 标记：
 *   - next_turn：正常工具调用后继续下一轮
 *   - reactive_compact_retry：reactive compact 后重试
 *   - collapse_drain_retry：context collapse 排空后重试
 *   - max_output_tokens_recovery：输出 token 超限恢复
 *   - max_output_tokens_escalate：升级 max_output_tokens 上限
 *   - stop_hook_blocking：stop hook 阻止退出，注入错误后重试
 *   - token_budget_continuation：token 预算尚有余额，继续执行
 *   最终退出（return Terminal）：completed / aborted / max_turns / error 等
 * ============================================================================
 */
// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { FallbackTriggeredError } from './services/api/withRetry.js'
import {
  calculateTokenWarningState,
  isAutoCompactEnabled,
  type AutoCompactTrackingState,
} from './services/compact/autoCompact.js'
import { buildPostCompactMessages } from './services/compact/compact.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as typeof import('./services/compact/reactiveCompact.js'))
  : null
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { ImageSizeError } from './utils/imageValidation.js'
import { ImageResizeError } from './utils/imageResizer.js'
import { findToolByName, type ToolUseContext } from './Tool.js'
import { asSystemPrompt, type SystemPrompt } from './utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  ToolUseSummaryMessage,
  UserMessage,
  TombstoneMessage,
} from './types/message.js'
import { logError } from './utils/log.js'
import {
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  isPromptTooLongMessage,
} from './services/api/errors.js'
import { logAntError, logForDebugging } from './utils/debug.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createAssistantAPIErrorMessage,
  getMessagesAfterCompactBoundary,
  createToolUseSummaryMessage,
  createMicrocompactBoundaryMessage,
  stripSignatureBlocks,
} from './utils/messages.js'
import { generateToolUseSummary } from './services/toolUseSummary/toolUseSummaryGenerator.js'
import { prependUserContext, appendSystemContext } from './utils/api.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from './utils/attachments.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const skillPrefetch = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('./services/skillSearch/prefetch.js') as typeof import('./services/skillSearch/prefetch.js'))
  : null
const jobClassifier = feature('TEMPLATES')
  ? (require('./jobs/classifier.js') as typeof import('./jobs/classifier.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  remove as removeFromQueue,
  getCommandsByMaxPriority,
  isSlashCommand,
} from './utils/messageQueueManager.js'
import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import {
  getRuntimeMainLoopModel,
  renderModelName,
} from './utils/model/model.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from './utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from './utils/context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from './services/analytics/growthbook.js'
import { SLEEP_TOOL_NAME } from './tools/SleepTool/prompt.js'
import { executePostSamplingHooks } from './utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from './utils/hooks.js'
import type { QuerySource } from './constants/querySource.js'
import { createDumpPromptsFetch } from './services/api/dumpPrompts.js'
import { StreamingToolExecutor } from './services/tools/StreamingToolExecutor.js'
import { queryCheckpoint } from './utils/queryProfiler.js'
import { runTools } from './services/tools/toolOrchestration.js'
import { applyToolResultBudget } from './utils/toolResultStorage.js'
import { recordContentReplacement } from './utils/sessionStorage.js'
import { handleStopHooks } from './query/stopHooks.js'
import { buildQueryConfig } from './query/config.js'
import { productionDeps, type QueryDeps } from './query/deps.js'
import type { Terminal, Continue } from './query/transitions.js'
import { feature } from 'bun:bundle'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
} from './bootstrap/state.js'
import { createBudgetTracker, checkTokenBudget } from './query/tokenBudget.js'
import { count } from './utils/array.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const taskSummaryModule = feature('BG_SESSIONS')
  ? (require('./utils/taskSummary.js') as typeof import('./utils/taskSummary.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 为所有未完成的 tool_use 生成错误 tool_result 消息。
 *
 * 【使用场景】
 * 当 API 流式传输过程中发生异常（如模型错误、fallback 触发、中断等），
 * 可能已经 yield 了 tool_use 块但还没有对应的 tool_result。
 * Claude API 要求每个 tool_use 必须有匹配的 tool_result，否则会报错。
 * 此函数为所有孤立的 tool_use 补充错误类型的 tool_result，保持消息链完整。
 *
 * @param assistantMessages - 已收集的 assistant 消息（可能包含 tool_use 块）
 * @param errorMessage - 错误原因文本，填入 tool_result.content
 */
function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    // 从 assistant 消息中提取所有 tool_use 内容块
    const toolUseBlocks = (Array.isArray(assistantMessage.message?.content) ? assistantMessage.message.content : []).filter(
      (content: { type: string }) => content.type === 'tool_use',
    ) as ToolUseBlock[]

    // 为每个 tool_use 生成一条错误类型的 tool_result 用户消息
    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
  }
}

/**
 * The rules of thinking are lengthy and fortuitous. They require plenty of thinking
 * of most long duration and deep meditation for a wizard to wrap one's noggin around.
 *
 * The rules follow:
 * 1. A message that contains a thinking or redacted_thinking block must be part of a query whose max_thinking_length > 0
 * 2. A thinking block may not be the last message in a block
 * 3. Thinking blocks must be preserved for the duration of an assistant trajectory (a single turn, or if that turn includes a tool_use block then also its subsequent tool_result and the following assistant message)
 *
 * Heed these rules well, young wizard. For they are the rules of thinking, and
 * the rules of thinking are the rules of the universe. If ye does not heed these
 * rules, ye will be punished with an entire day of debugging and hair pulling.
 */
// max_output_tokens 恢复的最大重试次数。超过此次数后放弃恢复，将错误暴露给调用方。
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/**
 * 判断消息是否为 max_output_tokens 错误（模型输出达到 token 上限被截断）。
 *
 * 流式循环会暂扣（withhold）此类错误消息，不立即 yield 给 SDK 调用方，
 * 直到确认恢复循环是否能够继续。过早 yield 错误会导致 SDK 调用方
 * （如 cowork/desktop）终止会话，而恢复循环实际上仍在运行。
 *
 * 与 reactiveCompact.isWithheldPromptTooLong 逻辑类似。
 */
function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

/**
 * query() 函数的输入参数类型。
 *
 * 由 QueryEngine.submitMessage() 构造并传入，包含本次查询所需的所有上下文。
 */
export type QueryParams = {
  /** 当前对话的完整消息历史 */
  messages: Message[]
  /** 系统提示词（包含工具定义、角色指令等） */
  systemPrompt: SystemPrompt
  /** 用户上下文键值对，会被拼接到消息头部 */
  userContext: { [k: string]: string }
  /** 系统上下文键值对，会被追加到系统提示末尾 */
  systemContext: { [k: string]: string }
  /** 权限检查回调：判断是否允许使用某个工具 */
  canUseTool: CanUseToolFn
  /** 工具执行上下文（包含可用工具列表、应用状态、中断控制器等） */
  toolUseContext: ToolUseContext
  /** 主模型不可用时的备用模型名称 */
  fallbackModel?: string
  /** 查询来源标识（如 'sdk'、'repl_main_thread'、'compact'、'agent:xxx'） */
  querySource: QuerySource
  /** 覆盖默认的 max_output_tokens 值 */
  maxOutputTokensOverride?: number
  /** 最大轮次限制（每次工具调用+模型响应算一轮） */
  maxTurns?: number
  /** 是否跳过缓存写入 */
  skipCacheWrite?: boolean
  /**
   * API 任务预算（output_config.task_budget）。
   * 与 tokenBudget 的 +500k 自动继续特性不同。total 是整个 agent 轮次的预算；
   * remaining 在每次迭代中根据累计 API 用量计算。
   * 详见 claude.ts 的 configureTaskBudgetParams。
   */
  taskBudget?: { total: number }
  /** 依赖注入（用于测试时替换 callModel / autocompact 等） */
  deps?: QueryDeps
}

// ========== query 循环状态定义 ==========

/**
 * 主循环中在迭代之间传递的可变状态。
 *
 * 每次循环迭代结束时通过 `state = { ... }` 整体赋值来推进状态，
 * 而非逐字段修改，确保状态转换的原子性和可追踪性。
 * 每个 `continue` 站点都会构造一个新的 State 对象。
 */
type State = {
  /** 当前消息数组（每轮迭代后追加 assistant 消息和 tool_result） */
  messages: Message[]
  /** 工具执行上下文（包含工具列表、应用状态、中断信号等） */
  toolUseContext: ToolUseContext
  /** 自动压缩追踪状态（压缩发生后重置 turnCounter） */
  autoCompactTracking: AutoCompactTrackingState | undefined
  /** max_output_tokens 恢复重试计数（上限 MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3） */
  maxOutputTokensRecoveryCount: number
  /** 是否已尝试过 reactive compact（防止无限重试） */
  hasAttemptedReactiveCompact: boolean
  /** max_output_tokens 覆盖值（用于升级重试，如从 8k 升到 64k） */
  maxOutputTokensOverride: number | undefined
  /** 上一轮的工具使用摘要 Promise（异步生成，在下一轮 yield） */
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  /** stop hook 是否处于活跃状态（阻止轮次退出后设为 true） */
  stopHookActive: boolean | undefined
  /** 当前轮次计数（从 1 开始，每次工具调用后递增） */
  turnCount: number
  /**
   * 上一次迭代为何 continue 的原因。首次迭代为 undefined。
   * 用于测试断言和 collapse_drain_retry 的重复检测。
   */
  transition: Continue | undefined
}

/**
 * query() — Agent 主循环的公开入口。
 *
 * 这是一个 AsyncGenerator 函数，调用方通过 for-await-of 消费它产出的消息流。
 * 它是 queryLoop() 的薄包装层，负责在循环正常结束后通知已消费的排队命令。
 *
 * 【产出类型】
 * - StreamEvent：流式事件（stream_request_start 等）
 * - RequestStartEvent：API 请求开始事件
 * - Message：assistant / user / system / attachment / progress 消息
 * - TombstoneMessage：tombstone 标记（用于撤销 fallback 前的孤立消息）
 * - ToolUseSummaryMessage：工具使用摘要（供移动端 UI 展示）
 *
 * 【返回值】Terminal — 描述循环为何终止（completed / aborted / max_turns / error 等）
 *
 * @param params - 查询参数（消息、系统提示、工具上下文等）
 */
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // 收集本轮中消费的排队命令 UUID，用于在正常结束时发送 'completed' 生命周期通知
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 仅在 queryLoop 正常返回时执行。throw 和 .return() 路径会跳过这里。
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}

/**
 * queryLoop() — Agent 核心主循环的实际实现。
 *
 * 这是一个 while(true) 无限循环，每次迭代代表一个"轮次"：
 *   1. 上下文预处理（压缩、裁剪、缓存编辑等）
 *   2. 调用 Claude API 获取模型响应
 *   3. 处理响应中的 tool_use → 执行工具 → 收集结果
 *   4. 决定是否继续下一轮（有 tool_use 且未中断/超限）
 *
 * 循环通过 State 对象在迭代间传递状态，通过 `return` 终止。
 */
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // 不可变参数 — 在整个循环过程中不会被重新赋值
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  // 依赖注入：默认使用生产环境依赖，测试时可替换
  const deps = params.deps ?? productionDeps()

  // 可变的跨迭代状态。循环体在每次迭代顶部解构此对象以便简洁访问。
  // 每个 continue 站点通过 `state = { ... }` 整体替换，而非逐字段修改。
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,                    // 轮次从 1 开始
    pendingToolUseSummary: undefined,
    transition: undefined,            // 首次迭代无前序转换
  }
  // Token 预算追踪器（TOKEN_BUDGET 特性开关控制）
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

  // task_budget.remaining 在压缩边界间的追踪。
  // 首次压缩前为 undefined — 此时服务器能看到完整历史并自行从 {total} 倒计。
  // 压缩后服务器只能看到摘要，会低估已消耗的预算；remaining 告诉它
  // 被压缩掉的那部分上下文窗口的大小。跨多次压缩累积：每次减去触发点的最终上下文。
  // 放在循环局部变量而非 State 上，避免修改 7 个 continue 站点。
  let taskBudgetRemaining: number | undefined = undefined

  // 在入口处一次性快照不可变的环境/statsig/会话状态。详见 QueryConfig。
  const config = buildQueryConfig()

  // 每个用户轮次只触发一次 memory 预取 — 因为 prompt 在循环迭代间不变，
  // 多次触发只会重复执行相同查询。使用 `using` 关键字确保在 generator
  // 的所有退出路径（return / throw / .return()）上自动 dispose。
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  // ==================== 主循环开始 ====================
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 在每次迭代顶部解构 state。toolUseContext 可在迭代内重新赋值
    // （queryTracking 更新、messages 更新等），其余字段在 continue 站点间只读。
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = state

    // 技能发现预取 — 每次迭代触发，在模型流式响应和工具执行期间并行运行，
    // 在工具完成后与 memory 预取一起消费结果。
    const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
      null,
      messages,
      toolUseContext,
    )

    // 通知调用方：即将发起一次新的 API 请求
    yield { type: 'stream_request_start' }

    queryCheckpoint('query_fn_entry')

    // Record query start for headless latency tracking (skip for subagents)
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // 初始化或递增查询链追踪（用于 analytics 关联同一会话内的多次 API 调用）
    // chainId：同一用户轮次内唯一，depth：递增计数
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const queryChainIdForAnalytics =
      queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    // 获取压缩边界之后的消息（如果发生过压缩，只取压缩点之后的消息）
    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

    let tracking = autoCompactTracking

    // ===== 阶段 1: 上下文预处理管线 =====
    // 执行顺序：工具结果预算裁剪 → snip → microcompact → context-collapse → autocompact
    // 每个阶段都可能缩减 messagesForQuery 的大小，为 API 调用腾出上下文空间。

    // 对聚合工具结果大小执行每消息预算限制。在 microcompact 之前运行，
    // 因为缓存 MC 仅按 tool_use_id 操作，不检查内容，两者可干净组合。
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    messagesForQuery = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      persistReplacements
        ? records =>
            void recordContentReplacement(
              records,
              toolUseContext.agentId,
            ).catch(logError)
        : undefined,
      new Set(
        toolUseContext.options.tools
          .filter(t => !Number.isFinite(t.maxResultSizeChars))
          .map(t => t.name),
      ),
    )

    // --- Snip 裁剪：按历史长度截断旧消息（HISTORY_SNIP 特性开关）---
    // snip 和 microcompact 可以同时运行，不互斥。
    // snipTokensFreed 会传递给 autocompact，使其阈值检查能反映 snip 已释放的 token。
    let snipTokensFreed = 0
    if (feature('HISTORY_SNIP')) {
      queryCheckpoint('query_snip_start')
      const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = snipResult.messages
      snipTokensFreed = snipResult.tokensFreed
      if (snipResult.boundaryMessage) {
        yield snipResult.boundaryMessage  // 通知调用方发生了 snip
      }
      queryCheckpoint('query_snip_end')
    }

    // --- Microcompact：精细级别的上下文压缩（删除冗余工具结果等）---
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages
    // For cached microcompact (cache editing), defer boundary message until after
    // the API response so we can use actual cache_deleted_input_tokens.
    // Gated behind feature() so the string is eliminated from external builds.
    const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
      ? microcompactResult.compactionInfo?.pendingCacheEdits
      : undefined
    queryCheckpoint('query_microcompact_end')

    // --- Context Collapse：上下文折叠（CONTEXT_COLLAPSE 特性开关）---
    // 在 autocompact 之前运行：如果折叠能让 token 数降到 autocompact 阈值以下，
    // autocompact 就不会触发，保留更细粒度的上下文而非生成单一摘要。
    // 折叠视图是读时投影，不修改 REPL 数组，摘要存在 collapse store 中。
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      messagesForQuery = collapseResult.messages
    }

    // 将系统上下文追加到系统提示末尾，构造完整的系统提示
    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    // --- Autocompact：自动上下文压缩（核心 token 管理机制）---
    // 当 token 数超过阈值时，自动将旧消息压缩为摘要。
    // 这是防止 prompt-too-long 错误的主要防线。
    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      querySource,
      tracking,
      snipTokensFreed,
    )
    queryCheckpoint('query_autocompact_end')

    // ===== 阶段 1.5: 处理压缩结果 =====
    if (compactionResult) {
      // 压缩成功：提取压缩前后的 token 计数用于 analytics
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      logEvent('tengu_auto_compact_succeeded', {
        originalMessageCount: messages.length,
        compactedMessageCount:
          compactionResult.summaryMessages.length +
          compactionResult.attachments.length +
          compactionResult.hookResults.length,
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionInputTokens: compactionUsage?.input_tokens,
        compactionOutputTokens: compactionUsage?.output_tokens,
        compactionCacheReadTokens:
          compactionUsage?.cache_read_input_tokens ?? 0,
        compactionCacheCreationTokens:
          compactionUsage?.cache_creation_input_tokens ?? 0,
        compactionTotalTokens: compactionUsage
          ? compactionUsage.input_tokens +
            (compactionUsage.cache_creation_input_tokens ?? 0) +
            (compactionUsage.cache_read_input_tokens ?? 0) +
            compactionUsage.output_tokens
          : 0,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // task_budget: capture pre-compact final context window before
      // messagesForQuery is replaced with postCompactMessages below.
      // iterations[-1] is the authoritative final window (post server tool
      // loops); see #304930.
      if (params.taskBudget) {
        const preCompactContext =
          finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
        )
      }

      // 每次压缩后重置追踪状态，使 turnCounter/turnId 反映最近一次压缩
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }

      // 构建压缩后的消息（摘要 + 附件 + hook 结果）
      const postCompactMessages = buildPostCompactMessages(compactionResult)

      // 将压缩边界消息 yield 给调用方（QueryEngine 用于更新 UI 和转录）
      for (const message of postCompactMessages) {
        yield message
      }

      // 用压缩后的消息替换原消息，继续当前查询
      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      // Autocompact failed — propagate failure count so the circuit breaker
      // can stop retrying on the next iteration.
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    // 更新 toolUseContext 中的 messages 引用为预处理后的消息
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    // ===== 阶段 2: 调用 Claude API 并收集响应 =====

    // 本轮迭代收集的 assistant 消息（可能多条，每个 content_block_stop 产生一条）
    const assistantMessages: AssistantMessage[] = []
    // 本轮工具执行的结果消息
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    // 本轮收集到的所有 tool_use 块
    // 注意：stop_reason === 'tool_use' 不可靠，这里直接检测 tool_use 块是否存在
    const toolUseBlocks: ToolUseBlock[] = []
    // 是否需要继续下一轮（有 tool_use 块时为 true）
    let needsFollowUp = false

    queryCheckpoint('query_setup_start')
    // 流式工具执行器：在模型流式输出 tool_use 块时立即开始执行工具，
    // 而非等待模型响应完全结束。这可以显著减少端到端延迟。
    const useStreamingToolExecution = config.gates.streamingToolExecution
    let streamingToolExecutor = useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

    // 确定当前使用的模型（考虑权限模式和上下文大小）
    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      // plan 模式下超过 200k token 时可能切换模型
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })

    queryCheckpoint('query_setup_end')

    // Create fetch wrapper once per query session to avoid memory retention.
    // Each call to createDumpPromptsFetch creates a closure that captures the request body.
    // Creating it once means only the latest request body is retained (~700KB),
    // instead of all request bodies from the session (~500MB for long sessions).
    // Note: agentId is effectively constant during a query() call - it only changes
    // between queries (e.g., /clear command or session resume).
    const dumpPromptsFetch = config.gates.isAnt
      ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
      : undefined

    // Block if we've hit the hard blocking limit (only applies when auto-compact is OFF)
    // This reserves space so users can still run /compact manually
    // Skip this check if compaction just happened - the compaction result is already
    // validated to be under the threshold, and tokenCountWithEstimation would use
    // stale input_tokens from kept messages that reflect pre-compaction context size.
    // ===== 阶段 1.9: 阻塞限制检查（仅在自动压缩关闭时生效）=====
    // 当 token 数超过硬上限时阻止 API 调用，为手动 /compact 保留空间。
    // 跳过条件（不做预检）：
    //   - 刚发生过压缩（compactionResult 非空）
    //   - compact/session_memory 查询源（本身就是压缩 agent）
    //   - reactive compact 启用且自动压缩开启（让 API 返回真实 413 以触发恢复）
    //   - context-collapse 启用且自动压缩开启（同理）
    let collapseOwnsIt = false
    if (feature('CONTEXT_COLLAPSE')) {
      collapseOwnsIt =
        (contextCollapse?.isContextCollapseEnabled() ?? false) &&
        isAutoCompactEnabled()
    }
    // Hoist media-recovery gate once per turn. Withholding (inside the
    // stream loop) and recovery (after) must agree; CACHED_MAY_BE_STALE can
    // flip during the 5-30s stream, and withhold-without-recover would eat
    // the message. PTL doesn't hoist because its withholding is ungated —
    // it predates the experiment and is already the control-arm baseline.
    const mediaRecoveryEnabled =
      reactiveCompact?.isReactiveCompactEnabled() ?? false
    if (
      !compactionResult &&
      querySource !== 'compact' &&
      querySource !== 'session_memory' &&
      !(
        reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()
      ) &&
      !collapseOwnsIt
    ) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
        toolUseContext.options.mainLoopModel,
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    // attemptWithFallback 控制 fallback 模型重试循环
    let attemptWithFallback = true

    // ===== 阶段 2.1: API 调用 + 流式响应处理 =====
    queryCheckpoint('query_api_loop_start')
    try {
      // Fallback 重试循环：首次使用主模型，失败后切换到 fallback 模型重试
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')
          // 核心 API 调用：deps.callModel 返回 AsyncIterable，流式产出消息
          for await (const message of deps.callModel({
            messages: prependUserContext(messagesForQuery, userContext),
            systemPrompt: fullSystemPrompt,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolUseContext.options.tools,
            signal: toolUseContext.abortController.signal,
            options: {
              async getToolPermissionContext() {
                const appState = toolUseContext.getAppState()
                return appState.toolPermissionContext
              },
              model: currentModel,
              ...(config.gates.fastModeEnabled && {
                fastMode: appState.fastMode,
              }),
              toolChoice: undefined,
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              onStreamingFallback: () => {
                streamingFallbackOccured = true
              },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes:
                toolUseContext.options.agentDefinitions.allowedAgentTypes,
              hasAppendSystemPrompt:
                !!toolUseContext.options.appendSystemPrompt,
              maxOutputTokensOverride,
              fetchOverride: dumpPromptsFetch,
              mcpTools: appState.mcp.tools,
              hasPendingMcpServers: appState.mcp.clients.some(
                c => c.type === 'pending',
              ),
              queryTracking,
              effortValue: appState.effortValue,
              advisorModel: appState.advisorModel,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
              addNotification: toolUseContext.addNotification,
              ...(params.taskBudget && {
                taskBudget: {
                  total: params.taskBudget.total,
                  ...(taskBudgetRemaining !== undefined && {
                    remaining: taskBudgetRemaining,
                  }),
                },
              }),
            },
          })) {
            // ---- 流式响应消息处理 ----
            // 处理流式 fallback：如果在流式传输期间触发了 fallback，
            // 丢弃首次尝试的所有消息（避免合并不同模型的 tool_use_id）
            if (streamingFallbackOccured) {
              // Yield tombstones for orphaned messages so they're removed from UI and transcript.
              // These partial messages (especially thinking blocks) have invalid signatures
              // that would cause "thinking blocks cannot be modified" API errors.
              for (const msg of assistantMessages) {
                yield { type: 'tombstone' as const, message: msg }
              }
              logEvent('tengu_orphaned_messages_tombstoned', {
                orphanedMessageCount: assistantMessages.length,
                queryChainId: queryChainIdForAnalytics,
                queryDepth: queryTracking.depth,
              })

              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false

              // Discard pending results from the failed streaming attempt and create
              // a fresh executor. This prevents orphan tool_results (with old tool_use_ids)
              // from being yielded after the fallback response arrives.
              if (streamingToolExecutor) {
                streamingToolExecutor.discard()
                streamingToolExecutor = new StreamingToolExecutor(
                  toolUseContext.options.tools,
                  canUseTool,
                  toolUseContext,
                )
              }
            }
            // 回填 tool_use 的 input 字段到克隆消息（不修改原始消息以保证缓存一致性）。
            // SDK 流输出和转录序列化需要看到完整的 legacy/derived 字段。
            let yieldMessage: typeof message = message
            if (message.type === 'assistant') {
              const assistantMsg = message as AssistantMessage
              const contentArr = Array.isArray(assistantMsg.message?.content) ? assistantMsg.message.content as unknown as Array<{ type: string; input?: unknown; name?: string; [key: string]: unknown }> : []
              let clonedContent: typeof contentArr | undefined
              for (let i = 0; i < contentArr.length; i++) {
                const block = contentArr[i]!
                if (
                  block.type === 'tool_use' &&
                  typeof block.input === 'object' &&
                  block.input !== null
                ) {
                  const tool = findToolByName(
                    toolUseContext.options.tools,
                    block.name as string,
                  )
                  if (tool?.backfillObservableInput) {
                    const originalInput = block.input as Record<string, unknown>
                    const inputCopy = { ...originalInput }
                    tool.backfillObservableInput(inputCopy)
                    // Only yield a clone when backfill ADDED fields; skip if
                    // it only OVERWROTE existing ones (e.g. file tools
                    // expanding file_path). Overwrites change the serialized
                    // transcript and break VCR fixture hashes on resume,
                    // while adding nothing the SDK stream needs — hooks get
                    // the expanded path via toolExecution.ts separately.
                    const addedFields = Object.keys(inputCopy).some(
                      k => !(k in originalInput),
                    )
                    if (addedFields) {
                      clonedContent ??= [...contentArr]
                      clonedContent[i] = { ...block, input: inputCopy }
                    }
                  }
                }
              }
              if (clonedContent) {
                yieldMessage = {
                  ...message,
                  message: { ...(assistantMsg.message ?? {}), content: clonedContent },
                } as typeof message
              }
            }
            // 暂扣可恢复错误（prompt-too-long / max-output-tokens / media-size）。
            // 不立即 yield 给调用方，等恢复逻辑（collapse drain / reactive compact /
            // 截断重试）尝试后再决定是否暴露错误。
            // 仍然 push 到 assistantMessages 以便后续恢复检查能找到它们。
            //
            // feature() 只在 if/ternary 条件中生效（bun:bundle tree-shaking 限制），
            // 所以 collapse 检查是嵌套的
            // rather than composed.
            let withheld = false
            if (feature('CONTEXT_COLLAPSE')) {
              if (
                contextCollapse?.isWithheldPromptTooLong(
                  message as Message,
                  isPromptTooLongMessage,
                  querySource,
                )
              ) {
                withheld = true
              }
            }
            if (reactiveCompact?.isWithheldPromptTooLong(message as Message)) {
              withheld = true
            }
            if (
              mediaRecoveryEnabled &&
              reactiveCompact?.isWithheldMediaSizeError(message as Message)
            ) {
              withheld = true
            }
            if (isWithheldMaxOutputTokens(message)) {
              withheld = true
            }
            // 未被暂扣的消息正常 yield 给调用方
            if (!withheld) {
              yield yieldMessage
            }
            // 处理 assistant 类型消息：收集并提取 tool_use 块
            if (message.type === 'assistant') {
              const assistantMessage = message as AssistantMessage
              assistantMessages.push(assistantMessage)

              // 提取当前 assistant 消息中的所有 tool_use 块
              const msgToolUseBlocks = (Array.isArray(assistantMessage.message?.content) ? assistantMessage.message.content : []).filter(
                (content: { type: string }) => content.type === 'tool_use',
              ) as ToolUseBlock[]
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true  // 标记需要继续下一轮（有工具需要执行）
              }

              // 流式工具执行：收到 tool_use 块后立即提交给执行器并行处理
              if (
                streamingToolExecutor &&
                !toolUseContext.abortController.signal.aborted
              ) {
                for (const toolBlock of msgToolUseBlocks) {
                  streamingToolExecutor.addTool(toolBlock, assistantMessage)
                }
              }
            }

            // 收集流式执行器中已完成的工具结果（与模型流式输出并行执行的成果）
            if (
              streamingToolExecutor &&
              !toolUseContext.abortController.signal.aborted
            ) {
              for (const result of streamingToolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message
                  toolResults.push(
                    ...normalizeMessagesForAPI(
                      [result.message],
                      toolUseContext.options.tools,
                    ).filter(_ => _.type === 'user'),
                  )
                }
              }
            }
          } // for await — 流式消息循环结束
          queryCheckpoint('query_api_streaming_end')

          // Yield deferred microcompact boundary message using actual API-reported
          // token deletion count instead of client-side estimates.
          // Entire block gated behind feature() so the excluded string
          // is eliminated from external builds.
          if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
            const lastAssistant = assistantMessages.at(-1)
            // The API field is cumulative/sticky across requests, so we
            // subtract the baseline captured before this request to get the delta.
            const usage = lastAssistant?.message.usage
            const cumulativeDeleted = usage
              ? ((usage as unknown as Record<string, number>)
                  .cache_deleted_input_tokens ?? 0)
              : 0
            const deletedTokens = Math.max(
              0,
              cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens,
            )
            if (deletedTokens > 0) {
              yield createMicrocompactBoundaryMessage(
                pendingCacheEdits.trigger,
                0,
                deletedTokens,
                pendingCacheEdits.deletedToolIds,
                [],
              )
            }
          }
        } catch (innerError) {
          // ---- 错误处理：Fallback 模型切换 ----
          // 当主模型因负载过高触发 FallbackTriggeredError 时，切换到备用模型重试
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            currentModel = fallbackModel
            attemptWithFallback = true  // 设为 true 触发外层 while 循环重试

            // 清空首次尝试的所有消息（将为孤立的 tool_use 补充错误结果）
            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Model fallback triggered',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            // Discard pending results from the failed attempt and create a
            // fresh executor. This prevents orphan tool_results (with old
            // tool_use_ids) from leaking into the retry.
            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            // Update tool use context with new model
            toolUseContext.options.mainLoopModel = fallbackModel

            // Thinking signatures are model-bound: replaying a protected-thinking
            // block (e.g. capybara) to an unprotected fallback (e.g. opus) 400s.
            // Strip before retry so the fallback model gets clean history.
            if (process.env.USER_TYPE === 'ant') {
              messagesForQuery = stripSignatureBlocks(messagesForQuery)
            }

            // Log the fallback event
            logEvent('tengu_model_fallback_triggered', {
              original_model:
                innerError.originalModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              entrypoint:
                'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              queryChainId: queryChainIdForAnalytics,
              queryDepth: queryTracking.depth,
            })

            // Yield system message about fallback — use 'warning' level so
            // users see the notification without needing verbose mode
            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            )

            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      // ---- 错误处理：API 调用异常 ----
      // 通常 queryModelWithStreaming 不应该抛出异常，而是将错误作为合成 assistant 消息 yield。
      // 但如果因 bug 抛出了，这里作为最后防线处理。
      logError(error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logEvent('tengu_query_error', {
        assistantMessages: assistantMessages.length,
        toolUses: assistantMessages.flatMap(_ =>
          (Array.isArray(_.message?.content) ? _.message.content as Array<{ type: string }> : []).filter(content => content.type === 'tool_use'),
        ).length,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // 图片大小/缩放错误：生成友好的错误消息并终止
      if (
        error instanceof ImageSizeError ||
        error instanceof ImageResizeError
      ) {
        yield createAssistantAPIErrorMessage({
          content: error.message,
        })
        return { reason: 'image_error' }
      }

      // Generally queryModelWithStreaming should not throw errors but instead
      // yield them as synthetic assistant messages. However if it does throw
      // due to a bug, we may end up in a state where we have already emitted
      // a tool_use block but will stop before emitting the tool_result.
      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

      // Surface the real error instead of a misleading "[Request interrupted
      // by user]" — this path is a model/runtime failure, not a user action.
      // SDK consumers were seeing phantom interrupts on e.g. Node 18's missing
      // Array.prototype.with(), masking the actual cause.
      yield createAssistantAPIErrorMessage({
        content: errorMessage,
      })

      // To help track down bugs, log loudly for ants
      logAntError('Query error', error)
      return { reason: 'model_error', error }
    }

    // ===== 阶段 2.2: 后采样处理 =====
    // 模型响应完成后执行 post-sampling hooks（fire-and-forget，不阻塞主循环）
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // ===== 中断检查点 1: 流式传输期间被中断 =====
    // 必须最先处理中断。使用 streamingToolExecutor 时必须消费 getRemainingResults()，
    // 让执行器为排队/进行中的工具生成合成的 tool_result 块，保持消息链完整。
    if (toolUseContext.abortController.signal.aborted) {
      if (streamingToolExecutor) {
        // Consume remaining results - executor generates synthetic tool_results for
        // aborted tools since it checks the abort signal in executeTool()
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) {
            yield update.message
          }
        }
      } else {
        yield* yieldMissingToolResultBlocks(
          assistantMessages,
          'Interrupted by user',
        )
      }
      // chicago MCP: auto-unhide + lock release on interrupt. Same cleanup
      // as the natural turn-end path in stopHooks.ts. Main thread only —
      // see stopHooks.ts for the subagent-releasing-main's-lock rationale.
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // Failures are silent — this is dogfooding cleanup, not critical path
        }
      }

      // Skip the interruption message for submit-interrupts — the queued
      // user message that follows provides sufficient context.
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: false,
        })
      }
      return { reason: 'aborted_streaming' }
    }

    // 产出上一轮的工具使用摘要（由 Haiku 异步生成，约 1 秒，在模型流式响应期间已完成）
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    // ===== 阶段 3: 判断是否继续循环 =====
    // needsFollowUp = false 表示模型没有请求工具调用，这一轮可以结束
    if (!needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      // ---- 状态转换: prompt-too-long 恢复策略 ----
      // 恢复优先级：1. context-collapse drain（廉价，保留细粒度上下文）
      //            2. reactive compact（完整摘要）
      //            3. 放弃恢复，暴露错误
      const isWithheld413 =
        lastMessage?.type === 'assistant' &&
        lastMessage.isApiErrorMessage &&
        isPromptTooLongMessage(lastMessage)
      // Media-size rejections (image/PDF/many-image) are recoverable via
      // reactive compact's strip-retry. Unlike PTL, media errors skip the
      // collapse drain — collapse doesn't strip images. mediaRecoveryEnabled
      // is the hoisted gate from before the stream loop (same value as the
      // withholding check — these two must agree or a withheld message is
      // lost). If the oversized media is in the preserved tail, the
      // post-compact turn will media-error again; hasAttemptedReactiveCompact
      // prevents a spiral and the error surfaces.
      const isWithheldMedia =
        mediaRecoveryEnabled &&
        reactiveCompact?.isWithheldMediaSizeError(lastMessage)
      if (isWithheld413) {
        // First: drain all staged context-collapses. Gated on the PREVIOUS
        // transition not being collapse_drain_retry — if we already drained
        // and the retry still 413'd, fall through to reactive compact.
        if (
          feature('CONTEXT_COLLAPSE') &&
          contextCollapse &&
          state.transition?.reason !== 'collapse_drain_retry'
        ) {
          const drained = contextCollapse.recoverFromOverflow(
            messagesForQuery,
            querySource,
          )
          if (drained.committed > 0) {
            const next: State = {
              messages: drained.messages,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: undefined,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              transition: {
                reason: 'collapse_drain_retry',
                committed: drained.committed,
              },
            }
            state = next
            continue
          }
        }
      }
      if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
        const compacted = await reactiveCompact.tryReactiveCompact({
          hasAttempted: hasAttemptedReactiveCompact,
          querySource,
          aborted: toolUseContext.abortController.signal.aborted,
          messages: messagesForQuery,
          cacheSafeParams: {
            systemPrompt,
            userContext,
            systemContext,
            toolUseContext,
            forkContextMessages: messagesForQuery,
          },
        })

        if (compacted) {
          // task_budget: same carryover as the proactive path above.
          // messagesForQuery still holds the pre-compact array here (the
          // 413-failed attempt's input).
          if (params.taskBudget) {
            const preCompactContext =
              finalContextTokensFromLastResponse(messagesForQuery)
            taskBudgetRemaining = Math.max(
              0,
              (taskBudgetRemaining ?? params.taskBudget.total) -
                preCompactContext,
            )
          }

          const postCompactMessages = buildPostCompactMessages(compacted)
          for (const msg of postCompactMessages) {
            yield msg
          }
          const next: State = {
            messages: postCompactMessages,
            toolUseContext,
            autoCompactTracking: undefined,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact: true,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'reactive_compact_retry' },
          }
          state = next
          continue
        }

        // No recovery — surface the withheld error and exit. Do NOT fall
        // through to stop hooks: the model never produced a valid response,
        // so hooks have nothing meaningful to evaluate. Running stop hooks
        // on prompt-too-long creates a death spiral: error → hook blocking
        // → retry → error → … (the hook injects more tokens each cycle).
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
      } else if (feature('CONTEXT_COLLAPSE') && isWithheld413) {
        // reactiveCompact compiled out but contextCollapse withheld and
        // couldn't recover (staged queue empty/stale). Surface. Same
        // early-return rationale — don't fall through to stop hooks.
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'prompt_too_long' }
      }

      // ---- 状态转换: max_output_tokens 恢复策略 ----
      // 模型输出被截断时的恢复：
      //   1. 首先尝试升级 max_output_tokens（如从 8k 升到 64k，单次机会）
      //   2. 然后注入恢复消息要求模型从断点继续（最多 3 次）
      //   3. 恢复次数耗尽后暴露错误
      if (isWithheldMaxOutputTokens(lastMessage)) {
        // Escalating retry: if we used the capped 8k default and hit the
        // limit, retry the SAME request at 64k — no meta message, no
        // multi-turn dance. This fires once per turn (guarded by the
        // override check), then falls through to multi-turn recovery if
        // 64k also hits the cap.
        // 3P default: false (not validated on Bedrock/Vertex)
        const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_otk_slot_v1',
          false,
        )
        if (
          capEnabled &&
          maxOutputTokensOverride === undefined &&
          !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
        ) {
          logEvent('tengu_max_tokens_escalate', {
            escalatedTo: ESCALATED_MAX_TOKENS,
          })
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          state = next
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
            isMeta: true,
          })

          const next: State = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: maxOutputTokensRecoveryCount + 1,
            },
          }
          state = next
          continue
        }

        // Recovery exhausted — surface the withheld error now.
        yield lastMessage
      }

      // 当最后一条消息是 API 错误（限流/prompt-too-long/认证失败等）时跳过 stop hooks。
      // 模型从未产生有效响应，在此基础上运行 hooks 会导致死循环：
      // 错误 → hook 阻止 → 重试 → 错误 → ...
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'completed' }
      }

      // ---- Stop Hooks 处理 ----
      // 在模型完成响应（无 tool_use）时执行 stop hooks。
      // hooks 可以阻止退出（注入 blocking errors）或完全禁止继续。
      const stopHookResult = yield* handleStopHooks(
        messagesForQuery,
        assistantMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        stopHookActive,
      )

      // 状态转换: stop hook 禁止继续 → 立即终止
      if (stopHookResult.preventContinuation) {
        return { reason: 'stop_hook_prevented' }
      }

      // 状态转换: stop hook 返回 blocking errors → 注入错误消息后 continue 重试
      if (stopHookResult.blockingErrors.length > 0) {
        const next: State = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          // Preserve the reactive compact guard — if compact already ran and
          // couldn't recover from prompt-too-long, retrying after a stop-hook
          // blocking error will produce the same result. Resetting to false
          // here caused an infinite loop: compact → still too long → error →
          // stop hook blocking → compact → … burning thousands of API calls.
          hasAttemptedReactiveCompact,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          transition: { reason: 'stop_hook_blocking' },
        }
        state = next
        continue
      }

      // ---- Token 预算检查（TOKEN_BUDGET 特性开关）----
      // 如果当前轮次 token 用量尚未达到预算，注入 nudge 消息让模型继续工作。
      // 这是 +500k auto-continue 特性的核心逻辑。
      if (feature('TOKEN_BUDGET')) {
        const decision = checkTokenBudget(
          budgetTracker!,
          toolUseContext.agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )

        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          logForDebugging(
            `Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: decision.nudgeMessage,
                isMeta: true,
              }),
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'token_budget_continuation' },
          }
          continue
        }

        if (decision.completionEvent) {
          if (decision.completionEvent.diminishingReturns) {
            logForDebugging(
              `Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`,
            )
          }
          logEvent('tengu_token_budget_completed', {
            ...decision.completionEvent,
            queryChainId: queryChainIdForAnalytics,
            queryDepth: queryTracking.depth,
          })
        }
      }

      // 所有恢复/继续检查都通过 → 正常完成
      return { reason: 'completed' }
    }

    // ===== 阶段 4: 工具执行 =====
    // needsFollowUp = true，说明模型请求了工具调用，需要执行工具并收集结果

    let shouldPreventContinuation = false  // hook 是否阻止后续继续
    let updatedToolUseContext = toolUseContext

    queryCheckpoint('query_tool_execution_start')


    if (streamingToolExecutor) {
      logEvent('tengu_streaming_tool_execution_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    } else {
      logEvent('tengu_streaming_tool_execution_not_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // 获取工具执行结果：
    // - 流式执行器：获取剩余未完成的结果（部分工具已在流式期间完成）
    // - 非流式：一次性执行所有工具
    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

    // 消费工具执行结果：yield 消息给调用方，收集 tool_result 用于下一轮
    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message

        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    queryCheckpoint('query_tool_execution_end')

    // ===== 阶段 4.1: 生成工具使用摘要（异步，不阻塞下一轮 API 调用）=====
    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId // subagents don't surface in mobile UI — skip the Haiku call
    ) {
      // Extract the last assistant text block for context
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const textBlocks = (Array.isArray(lastAssistantMessage.message?.content) ? lastAssistantMessage.message.content as Array<{ type: string; text?: string }> : []).filter(
          block => block.type === 'text',
        )
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      // Collect tool info for summary generation
      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(block => {
        // Find the corresponding tool result
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              content =>
                content.type === 'tool_result' &&
                content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlockParam =>
                  c.type === 'tool_result' && c.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      // Fire off summary generation without blocking the next API call
      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

    // ===== 中断检查点 2: 工具执行期间被中断 =====
    if (toolUseContext.abortController.signal.aborted) {
      // chicago MCP: auto-unhide + lock release when aborted mid-tool-call.
      // This is the most likely Ctrl+C path for CU (e.g. slow screenshot).
      // Main thread only — see stopHooks.ts for the subagent rationale.
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // Failures are silent — this is dogfooding cleanup, not critical path
        }
      }
      // Skip the interruption message for submit-interrupts — the queued
      // user message that follows provides sufficient context.
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: true,
        })
      }
      // Check maxTurns before returning when aborted
      const nextTurnCountOnAbort = turnCount + 1
      if (maxTurns && nextTurnCountOnAbort > maxTurns) {
        yield createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCountOnAbort,
        })
      }
      return { reason: 'aborted_tools' }
    }

    // Hook 阻止继续 → 立即终止
    if (shouldPreventContinuation) {
      return { reason: 'hook_stopped' }
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
      logEvent('tengu_post_autocompact_turn', {
        turnId:
          tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        turnCounter: tracking.turnCounter,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // ===== 阶段 5: 收集附件消息（必须在工具调用完成后执行）=====
    // 注意：API 不允许 tool_result 与普通 user 消息交错，所以附件必须在所有工具结果之后。

    // 追踪附件添加前的消息计数
    logEvent('tengu_query_before_attachments', {
      messagesForQueryCount: messagesForQuery.length,
      assistantMessagesCount: assistantMessages.length,
      toolResultsCount: toolResults.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 获取排队命令快照。这些命令会作为附件发送，让 Claude 在当前轮次中响应它们。
    //
    // Drain pending notifications. LocalShellTask completions are 'next'
    // (when MONITOR_TOOL is on) and drain without Sleep. Other task types
    // (agent/workflow/framework) still default to 'later' — the Sleep flush
    // covers those. If all task types move to 'next', this branch could go.
    //
    // Slash commands are excluded from mid-turn drain — they must go through
    // processSlashCommand after the turn ends (via useQueueProcessor), not be
    // sent to the model as text. Bash-mode commands are already excluded by
    // INLINE_NOTIFICATION_MODES in getQueuedCommandAttachments.
    //
    // Agent scoping: the queue is a process-global singleton shared by the
    // coordinator and all in-process subagents. Each loop drains only what's
    // addressed to it — main thread drains agentId===undefined, subagents
    // drain their own agentId. User prompts (mode:'prompt') still go to main
    // only; subagents never see the prompt stream.
    // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name has no aliases
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    const queuedCommandsSnapshot = getCommandsByMaxPriority(
      sleepRan ? 'later' : 'next',
    ).filter(cmd => {
      if (isSlashCommand(cmd)) return false
      if (isMainThread) return cmd.agentId === undefined
      // Subagents only drain task-notifications addressed to them — never
      // user prompts, even if someone stamps an agentId on one.
      return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
    })

    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      null,
      queuedCommandsSnapshot,
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      querySource,
    )) {
      yield attachment
      toolResults.push(attachment)
    }

    // Memory 预取消费���仅在已完成且尚未被消费时执行。
    // 未完成则跳过（零等待），下一次迭代重试 — 预取在轮次结束前有多次消费机会。
    // readFileState（跨迭代累积）过滤掉模型已 Read/Write/Edit 过的 memory
    // — including in earlier iterations, which the per-iteration
    // toolUseBlocks array would miss.
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield msg
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }


    // Inject prefetched skill discovery. collectSkillDiscoveryPrefetch emits
    // hidden_by_main_turn — true when the prefetch resolved before this point
    // (should be >98% at AKI@250ms / Haiku@573ms vs turn durations of 2-30s).
    if (skillPrefetch && pendingSkillPrefetch) {
      const skillAttachments =
        await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch)
      for (const att of skillAttachments) {
        const msg = createAttachmentMessage(att)
        yield msg
        toolResults.push(msg)
      }
    }

    // Remove only commands that were actually consumed as attachments.
    // Prompt and task-notification commands are converted to attachments above.
    const consumedCommands = queuedCommandsSnapshot.filter(
      cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
    )
    if (consumedCommands.length > 0) {
      for (const cmd of consumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(consumedCommands)
    }

    // Instrumentation: Track file change attachments after they're added
    const fileChangeAttachmentCount = count(
      toolResults,
      tr =>
        tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
    )

    logEvent('tengu_query_after_attachments', {
      totalToolResultsCount: toolResults.length,
      fileChangeAttachmentCount,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 轮次间刷新工具列表，使新连接的 MCP 服务器的工具可用
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // ===== 阶段 6: 准备下一轮迭代 =====
    // 每次有工具结果并准备递归时，轮次计数 +1
    const nextTurnCount = turnCount + 1

    // Periodic task summary for `claude ps` — fires mid-turn so a
    // long-running agent still refreshes what it's working on. Gated
    // only on !agentId so every top-level conversation (REPL, SDK, HFI,
    // remote) generates summaries; subagents/forks don't.
    if (feature('BG_SESSIONS')) {
      if (
        !toolUseContext.agentId &&
        taskSummaryModule!.shouldGenerateTaskSummary()
      ) {
        taskSummaryModule!.maybeGenerateTaskSummary({
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          forkContextMessages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...toolResults,
          ],
        })
      }
    }

    // 检查是否达到最大轮次限制 → 终止循环
    if (maxTurns && nextTurnCount > maxTurns) {
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    // ===== 状态转换: next_turn — 正常工具调用后继续下一轮 =====
    // 组装下一轮的消息数组：原消息 + assistant 响应 + 工具结果
    queryCheckpoint('query_recursive_call')
    const next: State = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,       // 新轮次重置恢复计数
      hasAttemptedReactiveCompact: false,     // 新轮次重置 reactive compact 标记
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },   // 标记为正常轮次推进
    }
    state = next
    // continue → 回到 while(true) 顶部，开始下一轮迭代
  } // while (true) — 主循环结束
}
