/* eslint-disable custom-rules/no-process-exit */
/**
 * ============================================================================
 * 会话初始化文件 — 一次性 setup 流程
 * ============================================================================
 *
 * 在整体架构中的位置：
 *   cli.tsx (入口分发) → main.tsx (主循环) → setup() (本文件) → 会话就绪
 *
 * 职责：
 *   在主对话循环开始前，完成所有一次性的环境准备工作。包括：
 *   1. Node.js 版本检查（≥18）
 *   2. 会话 ID 设置
 *   3. UDS（Unix Domain Socket）消息服务器启动
 *   4. 队友快照（Agent Swarms 多智能体协作）
 *   5. 终端备份恢复（iTerm2 / Terminal.app 设置被中断时自动恢复）
 *   6. 工作目录设置（setCwd）
 *   7. Hooks 配置快照捕获
 *   8. Worktree 创建（Git 工作树隔离环境）
 *   9. 后台服务注册（会话记忆、上下文折叠、版本锁定等）
 *  10. 预取（插件命令、钩子、API Key、发布说明等）
 *  11. 权限模式安全检查（bypass 模式需在沙箱内且无网络）
 *  12. 上一次会话指标上报
 *
 * 核心导出：
 *   - setup() — 唯一的导出函数，接收 cwd、权限模式、worktree 配置等参数
 *
 * 设计要点：
 *   - 函数中大量使用 void + Promise 进行"后台预取"，不阻塞主流程
 *   - --bare 模式下跳过大部分非必要工作（插件、归因、发布说明等）
 *   - worktree 模式支持 git 原生工作树和自定义 Hook（非 git VCS）
 * ============================================================================
 */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getCwd } from 'src/utils/cwd.js'
import { checkForReleaseNotes } from 'src/utils/releaseNotes.js'
import { setCwd } from 'src/utils/Shell.js'
import { initSinks } from 'src/utils/sinks.js'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
  getSessionId,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from './bootstrap/state.js'
import { getCommands } from './commands.js'
import { initSessionMemory } from './services/SessionMemory/sessionMemory.js'
import { asSessionId } from './types/ids.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { checkAndRestoreTerminalBackup } from './utils/appleTerminalBackup.js'
import { prefetchApiKeyFromApiKeyHelperIfSafe } from './utils/auth.js'
import { clearMemoryFileCaches } from './utils/claudemd.js'
import { getCurrentProjectConfig, getGlobalConfig } from './utils/config.js'
import { logForDiagnosticsNoPII } from './utils/diagLogs.js'
import { env } from './utils/env.js'
import { envDynamic } from './utils/envDynamic.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { errorMessage } from './utils/errors.js'
import { findCanonicalGitRoot, findGitRoot, getIsGit } from './utils/git.js'
import { initializeFileChangedWatcher } from './utils/hooks/fileChangedWatcher.js'
import {
  captureHooksConfigSnapshot,
  updateHooksConfigSnapshot,
} from './utils/hooks/hooksConfigSnapshot.js'
import { hasWorktreeCreateHook } from './utils/hooks.js'
import { checkAndRestoreITerm2Backup } from './utils/iTermBackup.js'
import { logError } from './utils/log.js'
import { getRecentActivity } from './utils/logoV2Utils.js'
import { lockCurrentVersion } from './utils/nativeInstaller/index.js'
import type { PermissionMode } from './utils/permissions/PermissionMode.js'
import { getPlanSlug } from './utils/plans.js'
import { saveWorktreeState } from './utils/sessionStorage.js'
import { profileCheckpoint } from './utils/startupProfiler.js'
import {
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  generateTmuxSessionName,
  worktreeBranchName,
} from './utils/worktree.js'

/**
 * 一次性会话初始化函数 — 在主对话循环开始前完成所有环境准备。
 *
 * @param cwd - 当前工作目录
 * @param permissionMode - 权限模式（正常/跳过权限/仅接受等）
 * @param allowDangerouslySkipPermissions - 是否允许跳过权限检查（需在安全环境中）
 * @param worktreeEnabled - 是否启用 Git Worktree 隔离模式
 * @param worktreeName - Worktree 自定义名称（可选）
 * @param tmuxEnabled - 是否在 tmux 中运行 worktree
 * @param customSessionId - 自定义会话 ID（用于恢复会话）
 * @param worktreePRNumber - 关联的 PR 编号（用于生成 worktree 分支名）
 * @param messagingSocketPath - UDS 消息服务器的 socket 路径（可选）
 *
 * 执行顺序概览：
 *   版本检查 → 会话ID → UDS服务 → 队友快照 → 终端恢复 → 设置cwd →
 *   Hooks快照 → Worktree创建 → 后台服务 → 预取 → 权限检查 → 上次指标上报
 */
export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void> {
  logForDiagnosticsNoPII('info', 'setup_started')

  // Check for Node.js version < 18
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
  if (!nodeVersion || parseInt(nodeVersion) < 18) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      chalk.bold.red(
        'Error: Claude Code requires Node.js version 18 or higher.',
      ),
    )
    process.exit(1)
  }

  // Set custom session ID if provided
  if (customSessionId) {
    switchSession(asSessionId(customSessionId))
  }

  // --bare / SIMPLE: skip UDS messaging server and teammate snapshot.
  // Scripted calls don't receive injected messages and don't use swarm teammates.
  // Explicit --messaging-socket-path is the escape hatch (per #23222 gate pattern).
  // --bare 模式跳过 UDS 消息和队友快照，但如果显式传入了 messagingSocketPath 则不跳过
  // 设计意图：--bare 意味着"跳过我没要求的"，不是"忽略我要求的"
  if (!isBareMode() || messagingSocketPath !== undefined) {
    // Start UDS messaging server (Mac/Linux only).
    // Enabled by default for ants — creates a socket in tmpdir if no
    // --messaging-socket-path is passed. Awaited so the server is bound
    // and $CLAUDE_CODE_MESSAGING_SOCKET is exported before any hook
    // (SessionStart in particular) can spawn and snapshot process.env.
    // 启动 Unix Domain Socket 消息服务器 — 必须 await，确保 socket 绑定且
    // 环境变量导出后，SessionStart 等钩子才能正确获取到通信地址
    if (feature('UDS_INBOX')) {
      const m = await import('./utils/udsMessaging.js')
      await m.startUdsMessaging(
        messagingSocketPath ?? m.getDefaultUdsSocketPath(),
        { isExplicit: messagingSocketPath !== undefined },
      )
    }
  }

  // Teammate snapshot — SIMPLE-only gate (no escape hatch, swarm not used in bare)
  // 多智能体协作队友快照 — 捕获当前队友模式的配置，供后续 swarm 协调使用
  if (!isBareMode() && isAgentSwarmsEnabled()) {
    const { captureTeammateModeSnapshot } = await import(
      './utils/swarm/backends/teammateModeSnapshot.js'
    )
    captureTeammateModeSnapshot()
  }

  // Terminal backup restoration — interactive only. Print mode doesn't
  // interact with terminal settings; the next interactive session will
  // detect and restore any interrupted setup.
  // 终端备份恢复 — 仅交互模式。检测 iTerm2 和 Terminal.app 的设置是否
  // 因上次异常中断而处于不一致状态，如果是则自动恢复备份。
  if (!getIsNonInteractiveSession()) {
    // iTerm2 backup check only when swarms enabled
    if (isAgentSwarmsEnabled()) {
      const restoredIterm2Backup = await checkAndRestoreITerm2Backup()
      if (restoredIterm2Backup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.yellow(
            'Detected an interrupted iTerm2 setup. Your original settings have been restored. You may need to restart iTerm2 for the changes to take effect.',
          ),
        )
      } else if (restoredIterm2Backup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            `Failed to restore iTerm2 settings. Please manually restore your original settings with: defaults import com.googlecode.iterm2 ${restoredIterm2Backup.backupPath}.`,
          ),
        )
      }
    }

    // Check and restore Terminal.app backup if setup was interrupted
    try {
      const restoredTerminalBackup = await checkAndRestoreTerminalBackup()
      if (restoredTerminalBackup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.yellow(
            'Detected an interrupted Terminal.app setup. Your original settings have been restored. You may need to restart Terminal.app for the changes to take effect.',
          ),
        )
      } else if (restoredTerminalBackup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            `Failed to restore Terminal.app settings. Please manually restore your original settings with: defaults import com.apple.Terminal ${restoredTerminalBackup.backupPath}.`,
          ),
        )
      }
    } catch (error) {
      // Log but don't crash if Terminal.app backup restoration fails
      logError(error)
    }
  }

  // IMPORTANT: setCwd() must be called before any other code that depends on the cwd
  // 关键顺序约束：setCwd() 必须在所有依赖 cwd 的代码之前调用
  setCwd(cwd)

  // Capture hooks configuration snapshot to avoid hidden hook modifications.
  // IMPORTANT: Must be called AFTER setCwd() so hooks are loaded from the correct directory
  // 捕获 hooks 配置快照 — 必须在 setCwd() 之后调用，确保从正确目录读取 hooks 配置
  // 用途：后续可以检测 hooks 配置是否被意外修改
  const hooksStart = Date.now()
  captureHooksConfigSnapshot()
  logForDiagnosticsNoPII('info', 'setup_hooks_captured', {
    duration_ms: Date.now() - hooksStart,
  })

  // Initialize FileChanged hook watcher — sync, reads hook config snapshot
  initializeFileChangedWatcher(cwd)

  // Handle worktree creation if requested
  // IMPORTANT: this must be called befiore getCommands(), otherwise /eject won't be available.
  // ============= Worktree 创建逻辑 =============
  // 必须在 getCommands() 之前调用，否则 /eject 命令不可用
  // 支持两种模式：
  //   1. Git 原生 worktree — 在 git 仓库中创建独立的工作树
  //   2. Hook 委托模式 — 通过 WorktreeCreate hook 支持非 git 版本控制系统
  if (worktreeEnabled) {
    // Mirrors bridgeMain.ts: hook-configured sessions can proceed without git
    // so createWorktreeForSession() can delegate to the hook (non-git VCS).
    const hasHook = hasWorktreeCreateHook()  // 检查是否配置了自定义 worktree 创建钩子
    const inGit = await getIsGit()           // 检查当前目录是否在 git 仓库中
    // 既不在 git 仓库中，也没有配置 hook → 无法创建 worktree，报错退出
    if (!hasHook && !inGit) {
      process.stderr.write(
        chalk.red(
          `Error: Can only use --worktree in a git repository, but ${chalk.bold(cwd)} is not a git repository. ` +
            `Configure a WorktreeCreate hook in settings.json to use --worktree with other VCS systems.\n`,
        ),
      )
      process.exit(1)
    }

    // 生成 worktree 的标识 slug：优先使用 PR 编号，其次自定义名称，最后使用计划标识
    const slug = worktreePRNumber
      ? `pr-${worktreePRNumber}`
      : (worktreeName ?? getPlanSlug())

    // Git preamble runs whenever we're in a git repo — even if a hook is
    // configured — so --tmux keeps working for git users who also have a
    // WorktreeCreate hook. Only hook-only (non-git) mode skips it.
    // Git 前置处理：即使配置了 hook，只要在 git 仓库中就执行
    // 确保 --tmux 对同时配置了 hook 的 git 用户仍然有效
    let tmuxSessionName: string | undefined
    if (inGit) {
      // Resolve to main repo root (handles being invoked from within a worktree).
      // findCanonicalGitRoot is sync/filesystem-only/memoized; the underlying
      // findGitRoot cache was already warmed by getIsGit() above, so this is ~free.
      // 解析到主仓库根目录（处理从已有 worktree 内部调用的情况）
      // findCanonicalGitRoot 是同步的、纯文件系统操作且有缓存，几乎零开销
      const mainRepoRoot = findCanonicalGitRoot(getCwd())
      if (!mainRepoRoot) {
        process.stderr.write(
          chalk.red(
            `Error: Could not determine the main git repository root.\n`,
          ),
        )
        process.exit(1)
      }

      // If we're inside a worktree, switch to the main repo for worktree creation
      // 如果当前在某个 worktree 内部，切换到主仓库以创建新的 worktree
      if (mainRepoRoot !== (findGitRoot(getCwd()) ?? getCwd())) {
        logForDiagnosticsNoPII('info', 'worktree_resolved_to_main_repo')
        process.chdir(mainRepoRoot)
        setCwd(mainRepoRoot)
      }

      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(mainRepoRoot, worktreeBranchName(slug))
        : undefined
    } else {
      // Non-git hook mode: no canonical root to resolve, so name the tmux
      // session from cwd — generateTmuxSessionName only basenames the path.
      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(getCwd(), worktreeBranchName(slug))
        : undefined
    }

    let worktreeSession: Awaited<ReturnType<typeof createWorktreeForSession>>
    try {
      worktreeSession = await createWorktreeForSession(
        getSessionId(),
        slug,
        tmuxSessionName,
        worktreePRNumber ? { prNumber: worktreePRNumber } : undefined,
      )
    } catch (error) {
      process.stderr.write(
        chalk.red(`Error creating worktree: ${errorMessage(error)}\n`),
      )
      process.exit(1)
    }

    logEvent('tengu_worktree_created', { tmux_enabled: tmuxEnabled })

    // Create tmux session for the worktree if enabled
    if (tmuxEnabled && tmuxSessionName) {
      const tmuxResult = await createTmuxSessionForWorktree(
        tmuxSessionName,
        worktreeSession.worktreePath,
      )
      if (tmuxResult.created) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.green(
            `Created tmux session: ${chalk.bold(tmuxSessionName)}\nTo attach: ${chalk.bold(`tmux attach -t ${tmuxSessionName}`)}`,
          ),
        )
      } else {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.yellow(
            `Warning: Failed to create tmux session: ${tmuxResult.error}`,
          ),
        )
      }
    }

    // 将工作目录切换到新创建的 worktree
    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    // --worktree means the worktree IS the session's project, so skills/hooks/
    // cron/etc. should resolve here. (EnterWorktreeTool mid-session does NOT
    // touch projectRoot — that's a throwaway worktree, project stays stable.)
    // 设计意图：--worktree 启动时，worktree 就是项目根目录；
    // 与会话中途 EnterWorktreeTool 创建的临时 worktree 不同，后者不改变 projectRoot
    setProjectRoot(getCwd())
    saveWorktreeState(worktreeSession)
    // Clear memory files cache since originalCwd has changed
    // 清除 CLAUDE.md 缓存和设置缓存，因为 cwd 已变更到新 worktree
    clearMemoryFileCaches()
    // Settings cache was populated in init() (via applySafeConfigEnvironmentVariables)
    // and again at captureHooksConfigSnapshot() above, both from the original dir's
    // .claude/settings.json. Re-read from the worktree and re-capture hooks.
    // 重新从 worktree 目录读取 .claude/settings.json 并重新捕获 hooks 快照
    updateHooksConfigSnapshot()
  }

  // ============= 后台服务注册 =============
  // 只注册在首次查询之前必须就绪的关键服务
  logForDiagnosticsNoPII('info', 'setup_background_jobs_starting')
  // Bundled skills/plugins are registered in main.tsx before the parallel
  // getCommands() kick — see comment there. Moved out of setup() because
  // the await points above (startUdsMessaging, ~20ms) meant getCommands()
  // raced ahead and memoized an empty bundledSkills list.
  // 注意：捆绑的 skills/plugins 在 main.tsx 中注册（而非此处），
  // 因为上面的 await 点导致 getCommands() 可能先执行并缓存空的 skill 列表
  if (!isBareMode()) {
    initSessionMemory() // 同步注册会话记忆钩子，实际的功能开关检查延迟到使用时
    if (feature('CONTEXT_COLLAPSE')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js')
      ).initContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  void lockCurrentVersion() // 锁定当前版本，防止其他进程（如自动更新）删除正在运行的版本
  logForDiagnosticsNoPII('info', 'setup_background_jobs_launched')

  // ============= 预取阶段 =============
  // 并发启动多个后台预取任务，加速首次渲染
  profileCheckpoint('setup_before_prefetch')
  logForDiagnosticsNoPII('info', 'setup_prefetch_starting')
  // When CLAUDE_CODE_SYNC_PLUGIN_INSTALL is set, skip all plugin prefetch.
  // The sync install path in print.ts calls refreshPluginState() after
  // installing, which reloads commands, hooks, and agents. Prefetching here
  // races with the install (concurrent copyPluginToVersionedCache / cachePlugin
  // on the same directories), and the hot-reload handler fires clearPluginCache()
  // mid-install when policySettings arrives.
  // 跳过插件预取的两种情况：
  // 1. 同步安装模式 — 预取会和安装过程竞争文件操作
  // 2. --bare 模式 — 插件系统不被使用，节省文件系统开销
  const skipPluginPrefetch =
    (getIsNonInteractiveSession() &&
      isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) ||
    // --bare: loadPluginHooks → loadAllPlugins is filesystem work that's
    // wasted when executeHooks early-returns under --bare anyway.
    isBareMode()
  if (!skipPluginPrefetch) {
    void getCommands(getProjectRoot())
  }
  void import('./utils/plugins/loadPluginHooks.js').then(m => {
    if (!skipPluginPrefetch) {
      void m.loadPluginHooks() // Pre-load plugin hooks (consumed by processSessionStartHooks before render)
      m.setupPluginHookHotReload() // Set up hot reload for plugin hooks when settings change
    }
  })
  // --bare: skip attribution hook install + repo classification +
  // session-file-access analytics + team memory watcher. These are background
  // bookkeeping for commit attribution + usage metrics — scripted calls don't
  // commit code, and the 49ms attribution hook stat check (measured) is pure
  // overhead. NOT an early-return: the --dangerously-skip-permissions safety
  // gate, tengu_started beacon, and apiKeyHelper prefetch below must still run.
  if (!isBareMode()) {
    if (process.env.USER_TYPE === 'ant') {
      // Prime repo classification cache for auto-undercover mode. Default is
      // undercover ON until proven internal; if this resolves to internal, clear
      // the prompt cache so the next turn picks up the OFF state.
      void import('./utils/commitAttribution.js').then(async m => {
        if (await m.isInternalModelRepo()) {
          const { clearSystemPromptSections } = await import(
            './constants/systemPromptSections.js'
          )
          clearSystemPromptSections()
        }
      })
    }
    if (feature('COMMIT_ATTRIBUTION')) {
      // Dynamic import to enable dead code elimination (module contains excluded strings).
      // Defer to next tick so the git subprocess spawn runs after first render
      // rather than during the setup() microtask window.
      setImmediate(() => {
        void import('./utils/attributionHooks.js').then(
          ({ registerAttributionHooks }) => {
            registerAttributionHooks() // Register attribution tracking hooks (ant-only feature)
          },
        )
      })
    }
    void import('./utils/sessionFileAccessHooks.js').then(m =>
      m.registerSessionFileAccessHooks(),
    ) // Register session file access analytics hooks
    if (feature('TEAMMEM')) {
      void import('./services/teamMemorySync/watcher.js').then(m =>
        m.startTeamMemoryWatcher(),
      ) // Start team memory sync watcher
    }
  }
  initSinks() // 挂载错误日志和分析 sink，并排空之前排队的事件

  // Session-success-rate denominator. Emit immediately after the analytics
  // sink is attached — before any parsing, fetching, or I/O that could throw.
  // inc-3694 (P0 CHANGELOG crash) threw at checkForReleaseNotes below; every
  // event after this point was dead. This beacon is the earliest reliable
  // "process started" signal for release health monitoring.
  // 会话成功率的分母信标 — 必须在 sink 挂载后立即发出，早于所有可能抛异常的 I/O
  // 这是最早的可靠"进程已启动"信号，用于发布健康监控
  logEvent('tengu_started', {})

  void prefetchApiKeyFromApiKeyHelperIfSafe(getIsNonInteractiveSession()) // 安全预取 API Key — 仅在信任已确认时执行
  profileCheckpoint('setup_after_prefetch')

  // Pre-fetch data for Logo v2 - await to ensure it's ready before logo renders.
  // --bare / SIMPLE: skip — release notes are interactive-UI display data,
  // and getRecentActivity() reads up to 10 session JSONL files.
  if (!isBareMode()) {
    const { hasReleaseNotes } = await checkForReleaseNotes(
      getGlobalConfig().lastReleaseNotesSeen,
    )
    if (hasReleaseNotes) {
      await getRecentActivity()
    }
  }

  // ============= 权限模式安全检查 =============
  // 跳过权限模式（--dangerously-skip-permissions）的多层安全验证：
  // 1. 不允许以 root 运行（除非在沙箱中）
  // 2. Anthropic 内部用户还需验证在 Docker/Bubblewrap 沙箱内且无网络访问
  // 3. Desktop 本地代理和 CCD 模式豁免（它们有自己的信任模型）
  if (
    permissionMode === 'bypassPermissions' ||
    allowDangerouslySkipPermissions
  ) {
    // Check if running as root/sudo on Unix-like systems
    // Allow root if in a sandbox (e.g., TPU devspaces that require root)
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== '1' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_BUBBLEWRAP)
    ) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(
        `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`,
      )
      process.exit(1)
    }

    if (
      process.env.USER_TYPE === 'ant' &&
      // Skip for Desktop's local agent mode — same trust model as CCR/BYOC
      // (trusted Anthropic-managed launcher intentionally pre-approving everything).
      // Precedent: permissionSetup.ts:861, applySettingsChange.ts:55 (PR #19116)
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent' &&
      // Same for CCD (Claude Code in Desktop) — apps#29127 passes the flag
      // unconditionally to unlock mid-session bypass switching
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop'
    ) {
      // Only await if permission mode is set to bypass
      const [isDocker, hasInternet] = await Promise.all([
        envDynamic.getIsDocker(),
        env.hasInternetAccess(),
      ])
      const isBubblewrap = envDynamic.getIsBubblewrapSandbox()
      const isSandbox = process.env.IS_SANDBOX === '1'
      const isSandboxed = isDocker || isBubblewrap || isSandbox
      if (!isSandboxed || hasInternet) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          `--dangerously-skip-permissions can only be used in Docker/sandbox containers with no internet access but got Docker: ${isDocker}, Bubblewrap: ${isBubblewrap}, IS_SANDBOX: ${isSandbox}, hasInternet: ${hasInternet}`,
        )
        process.exit(1)
      }
    }
  }

  // 测试环境提前返回 — 以下是生产环境的上一次会话指标上报
  if (process.env.NODE_ENV === 'test') {
    return
  }

  // ============= 上次会话指标上报 =============
  // 读取项目配置中保存的上次会话数据（成本、时长、token 数等），
  // 上报为 tengu_exit 事件。这些值不会被清除，因为恢复会话时还需要它们。
  const projectConfig = getCurrentProjectConfig()
  if (
    projectConfig.lastCost !== undefined &&
    projectConfig.lastDuration !== undefined
  ) {
    logEvent('tengu_exit', {
      last_session_cost: projectConfig.lastCost,
      last_session_api_duration: projectConfig.lastAPIDuration,
      last_session_tool_duration: projectConfig.lastToolDuration,
      last_session_duration: projectConfig.lastDuration,
      last_session_lines_added: projectConfig.lastLinesAdded,
      last_session_lines_removed: projectConfig.lastLinesRemoved,
      last_session_total_input_tokens: projectConfig.lastTotalInputTokens,
      last_session_total_output_tokens: projectConfig.lastTotalOutputTokens,
      last_session_total_cache_creation_input_tokens:
        projectConfig.lastTotalCacheCreationInputTokens,
      last_session_total_cache_read_input_tokens:
        projectConfig.lastTotalCacheReadInputTokens,
      last_session_fps_average: projectConfig.lastFpsAverage,
      last_session_fps_low_1_pct: projectConfig.lastFpsLow1Pct,
      last_session_id:
        projectConfig.lastSessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...projectConfig.lastSessionMetrics,
    })
    // Note: We intentionally don't clear these values after logging.
    // They're needed for cost restoration when resuming sessions.
    // The values will be overwritten when the next session exits.
  }
}
