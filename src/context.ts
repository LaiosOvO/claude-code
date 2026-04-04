/**
 * ============================================================================
 * 系统上下文构建文件 — 为每次对话构建系统级和用户级上下文
 * ============================================================================
 *
 * 在整体架构中的位置：
 *   setup() 完成后 → 主循环每次对话开始时调用本文件的函数 → 注入系统提示词
 *
 * 职责：
 *   构建两类上下文信息，作为系统提示词的一部分注入到每次对话中：
 *   1. 系统上下文 (getSystemContext) — Git 仓库状态（分支、状态、最近提交）
 *   2. 用户上下文 (getUserContext) — CLAUDE.md 记忆文件内容 + 当前日期
 *
 * 核心导出函数：
 *   - getGitStatus()              — 获取 Git 仓库状态快照（分支、short status、最近5条提交）
 *   - getSystemContext()           — 构建系统级上下文（Git 状态 + 缓存破坏注入）
 *   - getUserContext()             — 构建用户级上下文（CLAUDE.md 内容 + 日期）
 *   - get/setSystemPromptInjection() — 系统提示词注入（用于缓存破坏调试）
 *
 * 设计要点：
 *   - 三个核心函数都使用 lodash memoize 缓存，每次对话只计算一次
 *   - setSystemPromptInjection 会清除缓存，确保注入变更立即生效
 *   - Git status 超过 2000 字符会被截断，避免 token 浪费
 *   - --bare 模式下跳过 CLAUDE.md 自动发现，但保留显式 --add-dir 指定的
 * ============================================================================
 */
import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import {
  getAdditionalDirectoriesForClaudeMd,
  setCachedClaudeMdContent,
} from './bootstrap/state.js'
import { getLocalISODate } from './constants/common.js'
import {
  filterInjectedMemoryFiles,
  getClaudeMds,
  getMemoryFiles,
} from './utils/claudemd.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { execFileNoThrow } from './utils/execFileNoThrow.js'
import { getBranch, getDefaultBranch, getIsGit, gitExe } from './utils/git.js'
import { shouldIncludeGitInstructions } from './utils/gitSettings.js'
import { logError } from './utils/log.js'

// Git status 输出的最大字符数，超出后截断（避免浪费 token 预算）
const MAX_STATUS_CHARS = 2000

// System prompt injection for cache breaking (ant-only, ephemeral debugging state)
// 系统提示词注入 — 仅内部使用，用于缓存破坏调试。修改时会清除所有 memoize 缓存。
let systemPromptInjection: string | null = null

/** 获取当前的系统提示词注入内容 */
export function getSystemPromptInjection(): string | null {
  return systemPromptInjection
}

/**
 * 设置系统提示词注入内容，并立即清除上下文缓存。
 * 设计意图：注入内容变更后，下次调用 getSystemContext/getUserContext 会重新计算，
 * 从而实现 API 提示词缓存的强制失效（cache breaking）。
 */
export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  // Clear context caches immediately when injection changes
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
}

/**
 * 获取当前 Git 仓库的状态快照。结果被 memoize 缓存，整个会话只执行一次。
 *
 * @returns 格式化的 Git 状态字符串（包含分支、主分支、用户名、short status、最近5条提交），
 *          非 Git 仓库或出错时返回 null
 *
 * 实现逻辑：
 *   1. 检查是否在 git 仓库中
 *   2. 并发执行 5 个 git 命令（分支、默认分支、status --short、log、user.name）
 *   3. status 超过 2000 字符时截断，提示用户用 BashTool 执行完整的 git status
 */
export const getGitStatus = memoize(async (): Promise<string | null> => {
  if (process.env.NODE_ENV === 'test') {
    // Avoid cycles in tests
    return null
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'git_status_started')

  const isGitStart = Date.now()
  const isGit = await getIsGit()
  logForDiagnosticsNoPII('info', 'git_is_git_check_completed', {
    duration_ms: Date.now() - isGitStart,
    is_git: isGit,
  })

  if (!isGit) {
    logForDiagnosticsNoPII('info', 'git_status_skipped_not_git', {
      duration_ms: Date.now() - startTime,
    })
    return null
  }

  try {
    // 并发执行 5 个 git 命令以最小化等待时间
    const gitCmdsStart = Date.now()
    const [branch, mainBranch, status, log, userName] = await Promise.all([
      getBranch(),           // 当前分支名
      getDefaultBranch(),    // 默认分支名（通常是 main 或 master）
      execFileNoThrow(gitExe(), ['--no-optional-locks', 'status', '--short'], {
        preserveOutputOnError: false,
      }).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(
        gitExe(),
        ['--no-optional-locks', 'log', '--oneline', '-n', '5'],
        {
          preserveOutputOnError: false,
        },
      ).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(gitExe(), ['config', 'user.name'], {
        preserveOutputOnError: false,
      }).then(({ stdout }) => stdout.trim()),
    ])

    logForDiagnosticsNoPII('info', 'git_commands_completed', {
      duration_ms: Date.now() - gitCmdsStart,
      status_length: status.length,
    })

    // 检查 status 是否超过字符限制，超出则截断并提示使用 BashTool
    const truncatedStatus =
      status.length > MAX_STATUS_CHARS
        ? status.substring(0, MAX_STATUS_CHARS) +
          '\n... (truncated because it exceeds 2k characters. If you need more information, run "git status" using BashTool)'
        : status

    logForDiagnosticsNoPII('info', 'git_status_completed', {
      duration_ms: Date.now() - startTime,
      truncated: status.length > MAX_STATUS_CHARS,
    })

    // 拼接最终的 Git 状态文本，各部分用双换行分隔
    return [
      `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.`,
      `Current branch: ${branch}`,
      `Main branch (you will usually use this for PRs): ${mainBranch}`,
      ...(userName ? [`Git user: ${userName}`] : []),
      `Status:\n${truncatedStatus || '(clean)'}`,  // 无变更时显示 (clean)
      `Recent commits:\n${log}`,
    ].join('\n\n')
  } catch (error) {
    logForDiagnosticsNoPII('error', 'git_status_failed', {
      duration_ms: Date.now() - startTime,
    })
    logError(error)
    return null
  }
})

/**
 * This context is prepended to each conversation, and cached for the duration of the conversation.
 *
 * 构建系统级上下文 — 注入到每次对话的系统提示词前部，整个对话期间缓存。
 *
 * @returns 键值对对象，可能包含：
 *   - gitStatus: Git 仓库状态快照
 *   - cacheBreaker: 缓存破坏标记（仅内部调试时使用）
 *
 * 跳过 Git 状态的情况：
 *   - CCR（远程容器恢复场景，无需 Git 上下文）
 *   - 用户设置中禁用了 Git 指令
 */
export const getSystemContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'system_context_started')

    // Skip git status in CCR (unnecessary overhead on resume) or when git instructions are disabled
    const gitStatus =
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
      !shouldIncludeGitInstructions()
        ? null
        : await getGitStatus()

    // Include system prompt injection if set (for cache breaking, ant-only)
    // 缓存破坏注入：将随机字符串嵌入系统提示词，强制 API 端刷新提示词缓存
    const injection = feature('BREAK_CACHE_COMMAND')
      ? getSystemPromptInjection()
      : null

    logForDiagnosticsNoPII('info', 'system_context_completed', {
      duration_ms: Date.now() - startTime,
      has_git_status: gitStatus !== null,
      has_injection: injection !== null,
    })

    return {
      ...(gitStatus && { gitStatus }),
      ...(feature('BREAK_CACHE_COMMAND') && injection
        ? {
            cacheBreaker: `[CACHE_BREAKER: ${injection}]`,
          }
        : {}),
    }
  },
)

/**
 * This context is prepended to each conversation, and cached for the duration of the conversation.
 *
 * 构建用户级上下文 — 读取 CLAUDE.md 记忆文件并注入当前日期。
 *
 * @returns 键值对对象，可能包含：
 *   - claudeMd: 合并后的 CLAUDE.md 内容（项目级 + 用户级 + 注入的记忆文件）
 *   - currentDate: 当前日期字符串
 *
 * CLAUDE.md 禁用规则：
 *   - CLAUDE_CODE_DISABLE_CLAUDE_MDS 环境变量：强制禁用
 *   - --bare 模式且无 --add-dir：跳过自动发现，但保留显式指定的目录
 */
export const getUserContext = memoize(
  async (): Promise<{
    [k: string]: string
  }> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'user_context_started')

    // CLAUDE_CODE_DISABLE_CLAUDE_MDS: hard off, always.
    // --bare: skip auto-discovery (cwd walk), BUT honor explicit --add-dir.
    // --bare means "skip what I didn't ask for", not "ignore what I asked for".
    const shouldDisableClaudeMd =
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)
    // Await the async I/O (readFile/readdir directory walk) so the event
    // loop yields naturally at the first fs.readFile.
    // 读取所有 CLAUDE.md 记忆文件（项目目录遍历 + 用户全局），过滤注入的记忆文件后合并
    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
    // Cache for the auto-mode classifier (yoloClassifier.ts reads this
    // instead of importing claudemd.ts directly, which would create a
    // cycle through permissions/filesystem → permissions → yoloClassifier).
    // 缓存 CLAUDE.md 内容供自动模式分类器使用 — 打破循环依赖
    // （yoloClassifier.ts 不直接 import claudemd.ts，而是读取此缓存）
    setCachedClaudeMdContent(claudeMd || null)

    logForDiagnosticsNoPII('info', 'user_context_completed', {
      duration_ms: Date.now() - startTime,
      claudemd_length: claudeMd?.length ?? 0,
      claudemd_disabled: Boolean(shouldDisableClaudeMd),
    })

    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)
