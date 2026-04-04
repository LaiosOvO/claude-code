#!/usr/bin/env bun
/**
 * ============================================================================
 * CLI 入口文件 — Claude Code 的总入口分发器
 * ============================================================================
 *
 * 在整体架构中的位置：
 *   用户执行 `claude` 命令 → 本文件 → 根据参数快速分发到各子系统
 *
 * 核心设计理念：
 *   "快速路径 (fast-path)" 分发 — 对常见/简单命令（如 --version）尽量
 *   零模块加载即返回；对各子命令（daemon、bridge、bg 等）按需动态 import，
 *   避免加载完整 CLI 的开销。只有当没有匹配到任何快速路径时，才加载完整的
 *   main.tsx 主循环。
 *
 * 快速路径列表（按代码顺序）：
 *   1. --version / -v / -V          → 直接打印版本号，零 import
 *   2. --dump-system-prompt         → 输出渲染后的系统提示词（仅内部构建）
 *   3. --claude-in-chrome-mcp       → 启动 Chrome 扩展的 MCP 服务器
 *   4. --chrome-native-host         → 启动 Chrome Native Messaging 宿主
 *   5. --computer-use-mcp           → 启动计算机使用的 MCP 服务器
 *   6. --daemon-worker              → 守护进程工作线程（由 supervisor 内部派生）
 *   7. remote-control / bridge      → 本地机器作为远程桥接环境
 *   8. daemon                       → 守护进程 supervisor
 *   9. ps / logs / attach / kill    → 后台会话管理
 *  10. new / list / reply           → 模板任务命令
 *  11. environment-runner           → 无头 BYOC 运行器
 *  12. self-hosted-runner           → 自托管运行器
 *  13. --tmux + --worktree          → 在 tmux 中执行 worktree 模式
 *  14. --update / --upgrade         → 重定向到 update 子命令
 *  15. --bare                       → 精简模式，提前设置环境变量
 *  16. (无匹配) → 加载完整 CLI (main.tsx)
 *
 * 文件结构：
 *   - 顶层副作用：环境变量初始化（COREPACK、NODE_OPTIONS、消融基线）
 *   - main() 异步函数：快速路径分发逻辑
 *   - 末尾 void main() 启动
 * ============================================================================
 */
import { feature } from 'bun:bundle';

// Bugfix for corepack auto-pinning, which adds yarnpkg to peoples' package.jsons
// 修复 corepack 自动固定版本导致 yarnpkg 被写入用户 package.json 的问题
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// Set max heap size for child processes in CCR environments (containers have 16GB)
// 在 CCR（Claude Code Remote）容器环境中限制子进程的最大堆内存为 8GB（容器总共 16GB）
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level, custom-rules/safe-env-boolean-check
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  const existing = process.env.NODE_OPTIONS || '';
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  process.env.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=8192` : '--max-old-space-size=8192';
}

// Harness-science L0 ablation baseline. Inlined here (not init.ts) because
// BashTool/AgentTool/PowerShellTool capture DISABLE_BACKGROUND_TASKS into
// module-level consts at import time — init() runs too late. feature() gate
// DCEs this entire block from external builds.
// 消融实验基线设置：当启用消融基线时，关闭所有高级功能（思考、自动压缩、
// 后台任务等），用于科学对照实验。必须在此处（而非 init.ts）设置，因为
// 多个工具模块在 import 时就会读取这些环境变量的值。
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  for (const k of [
    'CLAUDE_CODE_SIMPLE',
    'CLAUDE_CODE_DISABLE_THINKING',
    'DISABLE_INTERLEAVED_THINKING',
    'DISABLE_COMPACT',
    'DISABLE_AUTO_COMPACT',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  ]) {
    // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
    process.env[k] ??= '1';
  }
}

/**
 * Bootstrap entrypoint - checks for special flags before loading the full CLI.
 * All imports are dynamic to minimize module evaluation for fast paths.
 * Fast-path for --version has zero imports beyond this file.
 *
 * 主入口函数 — 按优先级逐一检查命令行参数，匹配到快速路径则处理后立即返回。
 * 所有 import 都是动态的（await import(...)），确保未匹配的路径不会加载多余模块。
 * 最极端的情况：--version 除了本文件外零模块加载。
 */
async function main(): Promise<void> {
  // 去掉 node 和脚本路径，只保留用户传入的参数
  const args = process.argv.slice(2);

  // Fast-path for --version/-v: zero module loading needed
  // 快速路径 #1：版本查询，完全零 import，MACRO.VERSION 在构建时内联替换
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION is inlined at build time
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;
  }

  // For all other paths, load the startup profiler
  // 非 --version 路径统一加载启动性能分析器，用于追踪各阶段耗时
  const { profileCheckpoint } = await import('../utils/startupProfiler.js');
  profileCheckpoint('cli_entry');

  // Fast-path for --dump-system-prompt: output the rendered system prompt and exit.
  // Used by prompt sensitivity evals to extract the system prompt at a specific commit.
  // Ant-only: eliminated from external builds via feature flag.
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { getMainLoopModel } = await import('../utils/model/model.js');
    const modelIdx = args.indexOf('--model');
    const model = (modelIdx !== -1 && args[modelIdx + 1]) || getMainLoopModel();
    const { getSystemPrompt } = await import('../constants/prompts.js');
    const prompt = await getSystemPrompt([], model);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(prompt.join('\n'));
    return;
  }
  // 快速路径 #3/#4/#5：Chrome 相关 MCP 服务器和原生宿主
  if (process.argv[2] === '--claude-in-chrome-mcp') {
    profileCheckpoint('cli_claude_in_chrome_mcp_path');
    const { runClaudeInChromeMcpServer } = await import('../utils/claudeInChrome/mcpServer.js');
    await runClaudeInChromeMcpServer();
    return;
  } else if (process.argv[2] === '--chrome-native-host') {
    profileCheckpoint('cli_chrome_native_host_path');
    const { runChromeNativeHost } = await import('../utils/claudeInChrome/chromeNativeHost.js');
    await runChromeNativeHost();
    return;
  } else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path');
    const { runComputerUseMcpServer } = await import('../utils/computerUse/mcpServer.js');
    await runComputerUseMcpServer();
    return;
  }

  // Fast-path for `--daemon-worker=<kind>` (internal — supervisor spawns this).
  // Must come before the daemon subcommand check: spawned per-worker, so
  // perf-sensitive. No enableConfigs(), no analytics sinks at this layer —
  // workers are lean. If a worker kind needs configs/auth (assistant will),
  // it calls them inside its run() fn.
  // 快速路径 #6：守护进程工作线程（内部使用，由 supervisor 派生）
  // 必须在 daemon 子命令检查之前，因为工作线程对性能敏感，不加载配置和分析组件
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const { runDaemonWorker } = await import('../daemon/workerRegistry.js');
    await runDaemonWorker(args[1]);
    return;
  }

  // Fast-path for `claude remote-control` (also accepts legacy `claude remote` / `claude sync` / `claude bridge`):
  // serve local machine as bridge environment.
  // feature() must stay inline for build-time dead code elimination;
  // isBridgeEnabled() checks the runtime GrowthBook gate.
  // 快速路径 #7：远程控制/桥接模式 — 将本地机器注册为远程代码执行环境
  // 支持多个别名：remote-control, rc, remote, sync, bridge
  // 启动前需依次检查：认证 → GrowthBook 开关 → 最低版本 → 组织策略
  if (
    feature('BRIDGE_MODE') &&
    (args[0] === 'remote-control' ||
      args[0] === 'rc' ||
      args[0] === 'remote' ||
      args[0] === 'sync' ||
      args[0] === 'bridge')
  ) {
    profileCheckpoint('cli_bridge_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { getBridgeDisabledReason, checkBridgeMinVersion } = await import('../bridge/bridgeEnabled.js');
    const { BRIDGE_LOGIN_ERROR } = await import('../bridge/types.js');
    const { bridgeMain } = await import('../bridge/bridgeMain.js');
    const { exitWithError } = await import('../utils/process.js');

    // Auth check must come before the GrowthBook gate check — without auth,
    // GrowthBook has no user context and would return a stale/default false.
    // getBridgeDisabledReason awaits GB init, so the returned value is fresh
    // (not the stale disk cache), but init still needs auth headers to work.
    // 认证必须先于 GrowthBook 检查：没有认证 token 时 GrowthBook 无法获取用户上下文，
    // 会返回过时的默认值 false
    const { getClaudeAIOAuthTokens } = await import('../utils/auth.js');
    if (!getClaudeAIOAuthTokens()?.accessToken) {
      exitWithError(BRIDGE_LOGIN_ERROR);
    }
    const disabledReason = await getBridgeDisabledReason();
    if (disabledReason) {
      exitWithError(`Error: ${disabledReason}`);
    }
    const versionError = checkBridgeMinVersion();
    if (versionError) {
      exitWithError(versionError);
    }

    // Bridge is a remote control feature - check policy limits
    const { waitForPolicyLimitsToLoad, isPolicyAllowed } = await import('../services/policyLimits/index.js');
    await waitForPolicyLimitsToLoad();
    if (!isPolicyAllowed('allow_remote_control')) {
      exitWithError("Error: Remote Control is disabled by your organization's policy.");
    }
    await bridgeMain(args.slice(1));
    return;
  }

  // Fast-path for `claude daemon [subcommand]`: long-running supervisor.
  // 快速路径 #8：守护进程 supervisor — 长期运行的进程管理器
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { initSinks } = await import('../utils/sinks.js');
    initSinks();
    const { daemonMain } = await import('../daemon/main.js');
    await daemonMain(args.slice(1));
    return;
  }

  // Fast-path for `claude ps|logs|attach|kill` and `--bg`/`--background`.
  // Session management against the ~/.claude/sessions/ registry. Flag
  // literals are inlined so bg.js only loads when actually dispatching.
  // 快速路径 #9：后台会话管理 — 列出/查看日志/附加/终止后台会话
  // 也处理 --bg/--background 标志，将当前命令转为后台运行
  if (
    feature('BG_SESSIONS') &&
    (args[0] === 'ps' ||
      args[0] === 'logs' ||
      args[0] === 'attach' ||
      args[0] === 'kill' ||
      args.includes('--bg') ||
      args.includes('--background'))
  ) {
    profileCheckpoint('cli_bg_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const bg = await import('../cli/bg.js');
    switch (args[0]) {
      case 'ps':        // 列出所有后台会话
        await bg.psHandler(args.slice(1));
        break;
      case 'logs':      // 查看指定会话的日志
        await bg.logsHandler(args[1]);
        break;
      case 'attach':    // 附加到一个后台会话（变为前台交互）
        await bg.attachHandler(args[1]);
        break;
      case 'kill':      // 终止指定的后台会话
        await bg.killHandler(args[1]);
        break;
      default:          // 匹配 --bg/--background 标志，将命令转为后台运行
        await bg.handleBgFlag(args);
    }
    return;
  }

  // Fast-path for template job commands.
  // 快速路径 #10：模板任务命令（new/list/reply）
  // 注意：此处使用 process.exit(0) 而非 return，因为 Ink TUI 可能留下事件循环句柄阻止自然退出
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    profileCheckpoint('cli_templates_path');
    const { templatesMain } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args);
    // process.exit (not return) — mountFleetView's Ink TUI can leave event
    // loop handles that prevent natural exit.
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0);
  }

  // Fast-path for `claude environment-runner`: headless BYOC runner.
  // feature() must stay inline for build-time dead code elimination.
  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
    profileCheckpoint('cli_environment_runner_path');
    const { environmentRunnerMain } = await import('../environment-runner/main.js');
    await environmentRunnerMain(args.slice(1));
    return;
  }

  // Fast-path for `claude self-hosted-runner`: headless self-hosted-runner
  // targeting the SelfHostedRunnerWorkerService API (register + poll; poll IS
  // heartbeat). feature() must stay inline for build-time dead code elimination.
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path');
    const { selfHostedRunnerMain } = await import('../self-hosted-runner/main.js');
    await selfHostedRunnerMain(args.slice(1));
    return;
  }

  // Fast-path for --worktree --tmux: exec into tmux before loading full CLI
  // 快速路径 #13：同时启用 --worktree 和 --tmux 时，先 exec 进 tmux 再加载完整 CLI
  // 这样可以在 tmux 会话中隔离 worktree 操作
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (
    hasTmuxFlag &&
    (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))
  ) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const { enableConfigs } = await import('../utils/config.js');
    enableConfigs();
    const { isWorktreeModeEnabled } = await import('../utils/worktreeModeEnabled.js');
    if (isWorktreeModeEnabled()) {
      const { execIntoTmuxWorktree } = await import('../utils/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        return;
      }
      // If not handled (e.g., error), fall through to normal CLI
      if (result.error) {
        const { exitWithError } = await import('../utils/process.js');
        exitWithError(result.error);
      }
    }
  }

  // Redirect common update flag mistakes to the update subcommand
  // 容错：用户可能误用 --update/--upgrade（带双横线），将其重定向到 update 子命令
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  // --bare: set SIMPLE early so gates fire during module eval / commander
  // option building (not just inside the action handler).
  // --bare 精简模式：提前设置 CLAUDE_CODE_SIMPLE 环境变量，确保在模块加载阶段
  // 各功能开关就能读取到此标志，而不是等到 action handler 中才生效
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  // No special flags detected, load and run the full CLI
  // 所有快速路径均未匹配 — 加载完整的 CLI 主循环
  // 在加载 main 模块之前，开始捕获用户的早期输入（避免输入丢失）
  const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
  startCapturingEarlyInput();
  profileCheckpoint('cli_before_main_import');
  const { main: cliMain } = await import('../main.jsx');
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
// 启动主函数，void 表示不关心返回的 Promise（fire-and-forget）
void main();
