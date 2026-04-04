/**
 * ========================================================================
 * tools.ts — 工具注册表与工具池组装
 * ========================================================================
 *
 * 本文件是 Claude Code 工具系统的注册中心，负责：
 *   1. 导入并注册所有内置工具（Bash、Read、Edit、Grep、Agent 等）
 *   2. 按 feature flag / 环境变量条件加载可选工具
 *   3. getTools() — 根据权限上下文和模式过滤，返回当前可用的内置工具
 *   4. assembleToolPool() — 合并内置工具与 MCP 工具，输出去重排序后的完整工具池
 *   5. getMergedTools() — 简单合并内置工具和 MCP 工具（用于计数和阈值计算）
 *   6. filterToolsByDenyRules() — 根据拒绝规则过滤工具
 *
 * 工具分类：
 *   【核心工具】 始终加载 — BashTool, FileReadTool, FileEditTool, FileWriteTool, AgentTool 等
 *   【搜索工具】 条件加载 — GlobTool, GrepTool（嵌入式搜索工具可用时跳过）
 *   【MCP 工具】 运行时动态注册 — 通过 assembleToolPool() 合入
 *   【功能开关工具】 按 feature flag 加载 — REPLTool, WorkflowTool, CoordinatorMode 等
 *   【环境限定工具】 按 USER_TYPE/NODE_ENV 加载 — TungstenTool, TestingPermissionTool 等
 *
 * 重要设计决策：
 *   - 导入顺序不可随意调整（ANT-ONLY import markers）
 *   - 条件加载使用 require() 而非 import，支持 dead code elimination
 *   - 延迟 require（如 getTeamCreateTool）用于打破循环依赖
 *   - 工具池按名称排序以保持 prompt cache 稳定性
 * ========================================================================
 */
// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { toolMatchesName, type Tool, type Tools } from './Tool.js'
// ========== 核心工具导入（始终加载） ==========
import { AgentTool } from './tools/AgentTool/AgentTool.js' // 子代理工具（Agent/Task 模式）
import { SkillTool } from './tools/SkillTool/SkillTool.js' // 技能工具（斜杠命令）
import { BashTool } from './tools/BashTool/BashTool.js' // Shell 命令执行
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js' // 文件编辑（精确替换）
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js' // 文件读取
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js' // 文件写入（完整覆写）
import { GlobTool } from './tools/GlobTool/GlobTool.js' // 文件名模式搜索
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool.js' // Jupyter 笔记本编辑
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js' // 网页内容获取
import { TaskStopTool } from './tools/TaskStopTool/TaskStopTool.js' // 子任务停止
import { BriefTool } from './tools/BriefTool/BriefTool.js' // 简要输出工具
// ========== 条件加载工具（按 feature flag / 环境变量决定是否加载） ==========
// 使用 require() 而非 import，配合 bun 的 dead code elimination 在打包时移除未启用的代码路径
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */

// REPL 工具 — 仅 Anthropic 内部用户（ant）可用，将 Bash/Read/Edit 等封装在 VM 中
const REPLTool =
  process.env.USER_TYPE === 'ant'
    ? require('./tools/REPLTool/REPLTool.js').REPLTool
    : null
// 后台 PR 建议工具 — 仅 ant 用户
const SuggestBackgroundPRTool =
  process.env.USER_TYPE === 'ant'
    ? require('./tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.js')
        .SuggestBackgroundPRTool
    : null
// 睡眠工具 — 主动模式或 KAIROS 模式下可用
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./tools/SleepTool/SleepTool.js').SleepTool
    : null
// 定时任务工具组（创建/删除/列出 cron 任务）
const cronTools = [
  require('./tools/ScheduleCronTool/CronCreateTool.js').CronCreateTool,
  require('./tools/ScheduleCronTool/CronDeleteTool.js').CronDeleteTool,
  require('./tools/ScheduleCronTool/CronListTool.js').CronListTool,
]
// 远程触发器工具
const RemoteTriggerTool = feature('AGENT_TRIGGERS_REMOTE')
  ? require('./tools/RemoteTriggerTool/RemoteTriggerTool.js').RemoteTriggerTool
  : null
// 监控工具
const MonitorTool = feature('MONITOR_TOOL')
  ? require('./tools/MonitorTool/MonitorTool.js').MonitorTool
  : null
// 文件发送工具 — KAIROS 模式
const SendUserFileTool = feature('KAIROS')
  ? require('./tools/SendUserFileTool/SendUserFileTool.js').SendUserFileTool
  : null
// 推送通知工具 — KAIROS 相关模式
const PushNotificationTool =
  feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? require('./tools/PushNotificationTool/PushNotificationTool.js')
        .PushNotificationTool
    : null
// GitHub PR 订阅工具 — KAIROS Webhook 模式
const SubscribePRTool = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('./tools/SubscribePRTool/SubscribePRTool.js').SubscribePRTool
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
// ========== 更多核心工具导入 ==========
import { TaskOutputTool } from './tools/TaskOutputTool/TaskOutputTool.js' // 子任务输出
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js' // 网络搜索
import { TodoWriteTool } from './tools/TodoWriteTool/TodoWriteTool.js' // 待办事项管理
import { ExitPlanModeV2Tool } from './tools/ExitPlanModeTool/ExitPlanModeV2Tool.js' // 退出计划模式
import { TestingPermissionTool } from './tools/testing/TestingPermissionTool.js' // 测试专用权限工具
import { GrepTool } from './tools/GrepTool/GrepTool.js' // 内容搜索（基于 ripgrep）
import { TungstenTool } from './tools/TungstenTool/TungstenTool.js' // Tungsten 内部工具
// ========== 延迟加载工具（打破循环依赖） ==========
// tools.ts -> TeamCreateTool/TeamDeleteTool -> ... -> tools.ts 存在循环引用
// 使用函数包装的 require() 延迟到首次调用时才加载
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js')
    .TeamCreateTool as typeof import('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
const getTeamDeleteTool = () =>
  require('./tools/TeamDeleteTool/TeamDeleteTool.js')
    .TeamDeleteTool as typeof import('./tools/TeamDeleteTool/TeamDeleteTool.js').TeamDeleteTool
const getSendMessageTool = () =>
  require('./tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool as typeof import('./tools/SendMessageTool/SendMessageTool.js').SendMessageTool
/* eslint-enable @typescript-eslint/no-require-imports */
// ========== 交互/辅助工具导入 ==========
import { AskUserQuestionTool } from './tools/AskUserQuestionTool/AskUserQuestionTool.js' // 向用户提问
import { LSPTool } from './tools/LSPTool/LSPTool.js' // Language Server Protocol 工具
import { ListMcpResourcesTool } from './tools/ListMcpResourcesTool/ListMcpResourcesTool.js' // 列出 MCP 资源
import { ReadMcpResourceTool } from './tools/ReadMcpResourceTool/ReadMcpResourceTool.js' // 读取 MCP 资源
import { ToolSearchTool } from './tools/ToolSearchTool/ToolSearchTool.js' // 工具搜索（延迟加载工具的入口）
import { EnterPlanModeTool } from './tools/EnterPlanModeTool/EnterPlanModeTool.js' // 进入计划模式
import { EnterWorktreeTool } from './tools/EnterWorktreeTool/EnterWorktreeTool.js' // 进入 Git 工作树
import { ExitWorktreeTool } from './tools/ExitWorktreeTool/ExitWorktreeTool.js' // 退出 Git 工作树
import { ConfigTool } from './tools/ConfigTool/ConfigTool.js' // 配置管理工具
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js' // 创建任务（Todo v2）
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js' // 获取任务
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js' // 更新任务
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js' // 列出任务
import uniqBy from 'lodash-es/uniqBy.js'
import { isToolSearchEnabledOptimistic } from './utils/toolSearch.js'
import { isTodoV2Enabled } from './utils/tasks.js'
// Dead code elimination: conditional import for CLAUDE_CODE_VERIFY_PLAN
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const VerifyPlanExecutionTool =
  process.env.CLAUDE_CODE_VERIFY_PLAN === 'true'
    ? require('./tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js')
        .VerifyPlanExecutionTool
    : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
// 导出代理工具限制常量（控制不同代理模式下可用/禁用的工具）
export {
  ALL_AGENT_DISALLOWED_TOOLS, // 所有代理类型都不允许使用的工具
  CUSTOM_AGENT_DISALLOWED_TOOLS, // 自定义代理不允许使用的工具
  ASYNC_AGENT_ALLOWED_TOOLS, // 异步代理允许使用的工具白名单
  COORDINATOR_MODE_ALLOWED_TOOLS, // 协调器模式下允许的工具
} from './constants/tools.js'
import { feature } from 'bun:bundle'
// ========== 更多条件加载工具（feature flag 控制） ==========
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const OverflowTestTool = feature('OVERFLOW_TEST_TOOL') // 溢出测试工具（调试用）
  ? require('./tools/OverflowTestTool/OverflowTestTool.js').OverflowTestTool
  : null
const CtxInspectTool = feature('CONTEXT_COLLAPSE') // 上下文检查工具
  ? require('./tools/CtxInspectTool/CtxInspectTool.js').CtxInspectTool
  : null
const TerminalCaptureTool = feature('TERMINAL_PANEL') // 终端面板截屏工具
  ? require('./tools/TerminalCaptureTool/TerminalCaptureTool.js')
      .TerminalCaptureTool
  : null
const WebBrowserTool = feature('WEB_BROWSER_TOOL') // 浏览器自动化工具
  ? require('./tools/WebBrowserTool/WebBrowserTool.js').WebBrowserTool
  : null
const coordinatorModeModule = feature('COORDINATOR_MODE') // 协调器模式（多代理编排）
  ? (require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js'))
  : null
const SnipTool = feature('HISTORY_SNIP') // 历史消息剪裁工具
  ? require('./tools/SnipTool/SnipTool.js').SnipTool
  : null
const ListPeersTool = feature('UDS_INBOX') // 列出对等代理（UDS 通信）
  ? require('./tools/ListPeersTool/ListPeersTool.js').ListPeersTool
  : null
const WorkflowTool = feature('WORKFLOW_SCRIPTS') // 工作流脚本工具
  ? (() => {
      require('./tools/WorkflowTool/bundled/index.js').initBundledWorkflows() // 初始化内置工作流
      return require('./tools/WorkflowTool/WorkflowTool.js').WorkflowTool
    })()
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
// ========== 权限与工具过滤相关导入 ==========
import type { ToolPermissionContext } from './Tool.js'
import { getDenyRuleForTool } from './utils/permissions/permissions.js' // 检查工具是否被拒绝规则匹配
import { hasEmbeddedSearchTools } from './utils/embeddedTools.js' // 检查是否有嵌入式搜索工具（bfs/ugrep）
import { isEnvTruthy } from './utils/envUtils.js' // 环境变量布尔值判断
import { isPowerShellToolEnabled } from './utils/shell/shellToolUtils.js' // PowerShell 工具是否启用
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js' // 代理集群模式是否启用
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js' // Git 工作树模式是否启用
import {
  REPL_TOOL_NAME,
  REPL_ONLY_TOOLS,
  isReplModeEnabled,
} from './tools/REPLTool/constants.js'
export { REPL_ONLY_TOOLS }
// PowerShell 工具的延迟加载（仅在 Windows 或启用了 PowerShell 支持时）
/* eslint-disable @typescript-eslint/no-require-imports */
const getPowerShellTool = () => {
  if (!isPowerShellToolEnabled()) return null
  return (
    require('./tools/PowerShellTool/PowerShellTool.js') as typeof import('./tools/PowerShellTool/PowerShellTool.js')
  ).PowerShellTool
}
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 预定义的工具预设集合
 * 可通过 --tools 命令行参数选择，目前仅有 'default' 一种预设
 */
export const TOOL_PRESETS = ['default'] as const

export type ToolPreset = (typeof TOOL_PRESETS)[number]

/** 解析工具预设名称，无效则返回 null */
export function parseToolPreset(preset: string): ToolPreset | null {
  const presetString = preset.toLowerCase()
  if (!TOOL_PRESETS.includes(presetString as ToolPreset)) {
    return null
  }
  return presetString as ToolPreset
}

/**
 * Get the list of tool names for a given preset
 * Filters out tools that are disabled via isEnabled() check
 * @param preset The preset name
 * @returns Array of tool names
 */
export function getToolsForDefaultPreset(): string[] {
  const tools = getAllBaseTools()
  const isEnabled = tools.map(tool => tool.isEnabled())
  return tools.filter((_, i) => isEnabled[i]).map(tool => tool.name)
}

/**
 * 获取当前环境下所有可能可用的内置工具（工具注册表的核心）
 *
 * 这是所有内置工具的唯一注册点（single source of truth）。
 * 根据 process.env 和 feature flag 决定哪些工具被包含。
 *
 * 注意：此列表必须与 Statsig 上的 claude_code_global_system_caching 配置保持同步，
 * 以确保 system prompt 的跨用户缓存正确性。
 *
 * 工具大致按以下顺序组织：
 *   1. 核心工具（Agent、Bash、文件操作、搜索）
 *   2. 辅助工具（计划模式、Todo、Web 相关）
 *   3. 条件加载工具（按 feature flag 逐个展开）
 *   4. MCP/ToolSearch 相关工具（放在最后）
 */
export function getAllBaseTools(): Tools {
  return [
    // ---- 核心工具 ----
    AgentTool, // 子代理/任务创建
    TaskOutputTool, // 子任务输出
    BashTool, // Shell 命令执行
    // 当 bun 内嵌了 bfs/ugrep 时（ant 原生构建），Bash 中的 find/grep 已被别名指向快速工具，
    // 此时无需单独的 Glob/Grep 工具
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool, // 退出计划模式
    FileReadTool, // 文件读取
    FileEditTool, // 文件编辑
    FileWriteTool, // 文件写入
    NotebookEditTool, // Jupyter 笔记本编辑
    WebFetchTool, // 网页获取
    TodoWriteTool, // Todo 写入
    WebSearchTool, // 网络搜索
    TaskStopTool, // 停止子任务
    AskUserQuestionTool, // 向用户提问
    SkillTool, // 技能/斜杠命令
    EnterPlanModeTool, // 进入计划模式

    // ---- Anthropic 内部工具（ant-only） ----
    ...(process.env.USER_TYPE === 'ant' ? [ConfigTool] : []),
    ...(process.env.USER_TYPE === 'ant' ? [TungstenTool] : []),
    ...(SuggestBackgroundPRTool ? [SuggestBackgroundPRTool] : []),

    // ---- Feature flag 控制的工具 ----
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    ...(isTodoV2Enabled() // Todo v2 任务管理套件
      ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool]
      : []),
    ...(OverflowTestTool ? [OverflowTestTool] : []),
    ...(CtxInspectTool ? [CtxInspectTool] : []),
    ...(TerminalCaptureTool ? [TerminalCaptureTool] : []),
    ...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    getSendMessageTool(), // 发送消息（延迟加载以打破循环依赖）
    ...(ListPeersTool ? [ListPeersTool] : []),
    ...(isAgentSwarmsEnabled() // 代理集群
      ? [getTeamCreateTool(), getTeamDeleteTool()]
      : []),
    ...(VerifyPlanExecutionTool ? [VerifyPlanExecutionTool] : []),
    ...(process.env.USER_TYPE === 'ant' && REPLTool ? [REPLTool] : []),
    ...(WorkflowTool ? [WorkflowTool] : []),
    ...(SleepTool ? [SleepTool] : []),
    ...cronTools, // 定时任务工具组
    ...(RemoteTriggerTool ? [RemoteTriggerTool] : []),
    ...(MonitorTool ? [MonitorTool] : []),
    BriefTool, // 简要输出
    ...(SendUserFileTool ? [SendUserFileTool] : []),
    ...(PushNotificationTool ? [PushNotificationTool] : []),
    ...(SubscribePRTool ? [SubscribePRTool] : []),
    ...(getPowerShellTool() ? [getPowerShellTool()] : []),
    ...(SnipTool ? [SnipTool] : []),
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []), // 仅测试环境

    // ---- MCP 与工具搜索 ----
    ListMcpResourcesTool, // 列出 MCP 资源
    ReadMcpResourceTool, // 读取 MCP 资源
    // ToolSearchTool 在工具搜索可能启用时包含（乐观检查），
    // 实际延迟加载决策在请求时（claude.ts）做出
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}

/**
 * 根据拒绝规则过滤工具
 *
 * 将被"全面拒绝"（blanket deny）的工具从列表中移除。
 * 全面拒绝指 deny 规则匹配工具名称但无 ruleContent（即不是针对特定参数的拒绝）。
 *
 * 使用与运行时权限检查（step 1a）相同的匹配器，因此：
 *   - MCP 服务器前缀规则（如 `mcp__server`）会在模型看到工具列表之前就剥离该服务器的所有工具
 *   - 不仅仅是在调用时才检查
 *
 * 这样做的好处是减少模型可见的工具数量，降低 token 消耗和误调用风险。
 */
export function filterToolsByDenyRules<
  T extends {
    name: string
    mcpInfo?: { serverName: string; toolName: string }
  },
>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}

/**
 * getTools() — 获取当前权限上下文下可用的内置工具集合
 *
 * 这是内置工具的主要获取入口。处理流程：
 *   1. 简单模式检查：CLAUDE_CODE_SIMPLE 模式下只提供 Bash/Read/Edit（或 REPL）
 *   2. 获取全部基础工具并排除特殊工具（MCP 资源工具、合成输出工具）
 *   3. 应用拒绝规则过滤
 *   4. REPL 模式处理：当 REPL 启用时隐藏被 REPL 封装的原始工具
 *   5. isEnabled() 过滤：移除当前环境下被禁用的工具
 *
 * @param permissionContext - 权限上下文，包含允许/拒绝规则
 * @returns 经过过滤的可用内置工具数组
 */
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // ---- 第一步：简单模式（--bare 或 CLAUDE_CODE_SIMPLE）----
  // 简单模式下只提供最基础的工具集：Bash + Read + Edit
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    // --bare + REPL 模式：REPL 将 Bash/Read/Edit 封装在 VM 中，
    // 因此返回 REPL 而非原始工具，与下方非 bare 路径的行为一致
    if (isReplModeEnabled() && REPLTool) {
      const replSimple: Tool[] = [REPLTool]
      // 协调器模式下额外提供 TaskStop 和 SendMessage
      if (
        feature('COORDINATOR_MODE') &&
        coordinatorModeModule?.isCoordinatorMode()
      ) {
        replSimple.push(TaskStopTool, getSendMessageTool())
      }
      return filterToolsByDenyRules(replSimple, permissionContext)
    }
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    // 协调器模式同时激活时，额外包含 AgentTool 和 TaskStopTool，
    // 协调器通过 useMergedTools 获取 Task+TaskStop，工作线程通过 filterToolsForAgent 获取 Bash/Read/Edit
    if (
      feature('COORDINATOR_MODE') &&
      coordinatorModeModule?.isCoordinatorMode()
    ) {
      simpleTools.push(AgentTool, TaskStopTool, getSendMessageTool())
    }
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // ---- 第二步：获取全部基础工具，排除特殊工具 ----
  // 特殊工具（MCP 资源列出/读取、合成输出）在 assembleToolPool 中另行处理
  const specialTools = new Set([
    ListMcpResourcesTool.name,
    ReadMcpResourceTool.name,
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])

  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))

  // ---- 第三步：应用拒绝规则过滤 ----
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // ---- 第四步：REPL 模式处理 ----
  // REPL 启用时，隐藏被 REPL 封装的原始工具（如 Bash、Read、Edit），
  // 它们仍可通过 REPL 的 VM 上下文间接访问
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(tool =>
      toolMatchesName(tool, REPL_TOOL_NAME),
    )
    if (replEnabled) {
      allowedTools = allowedTools.filter(
        tool => !REPL_ONLY_TOOLS.has(tool.name),
      )
    }
  }

  // ---- 第五步：isEnabled() 过滤 ----
  // 移除在当前环境下被禁用的工具（isEnabled 返回 false）
  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}

/**
 * assembleToolPool() — 组装完整的工具池（内置工具 + MCP 工具）
 *
 * 这是合并内置工具与 MCP 工具的唯一权威入口。
 * REPL.tsx（通过 useMergedTools hook）和 runAgent.ts（协调器工作线程）
 * 都使用此函数确保工具池组装的一致性。
 *
 * 组装流程：
 *   1. 通过 getTools() 获取内置工具（已经过模式过滤和权限检查）
 *   2. 对 MCP 工具应用拒绝规则过滤
 *   3. 分别对内置工具和 MCP 工具按名称排序
 *   4. 拼接两个分区（内置工具在前，MCP 工具在后）
 *   5. 通过 uniqBy 按 name 去重（内置工具优先级高于同名 MCP 工具）
 *
 * 排序策略说明：
 *   内置工具和 MCP 工具分别排序后拼接（而非混合排序），
 *   是为了保持 prompt cache 的稳定性。服务端在最后一个内置工具之后
 *   设置了全局缓存断点，混合排序会导致 MCP 工具插入到内置工具之间，
 *   在 MCP 工具增减时破坏缓存。
 */
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  // 第一步：获取经过权限过滤的内置工具
  const builtInTools = getTools(permissionContext)

  // 第二步：对 MCP 工具应用拒绝规则
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // 第三步：分区排序 + 拼接 + 去重
  // 内置工具作为连续前缀，MCP 工具紧随其后
  // uniqBy 保留插入顺序，因此同名冲突时内置工具胜出
  // 注意：不使用 Array.toSorted（Node 20+），以兼容 Node 18
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}

/**
 * getMergedTools() — 简单合并内置工具和 MCP 工具（不排序、不去重）
 *
 * 适用场景：
 *   - 工具搜索阈值计算（isToolSearchEnabled）
 *   - 包含 MCP 工具的 token 计数
 *   - 任何需要完整工具列表但不需要排序/去重的场景
 *
 * 与 assembleToolPool() 的区别：
 *   - assembleToolPool() 排序 + 去重，适合发送给 API
 *   - getMergedTools() 简单拼接，适合计数和阈值判断
 *
 * 只需要内置工具时使用 getTools()。
 */
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]
}
