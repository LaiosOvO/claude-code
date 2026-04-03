# 阅读笔记：src/setup.ts

## 文件基本信息
- **路径**: `src/setup.ts`
- **行数**: 487 行
- **角色**: 会话级别的环境准备模块，在 `main.tsx` 的 action handler 中调用，负责在 REPL 渲染前完成所有必要的初始化工作

## 核心功能

`setup.ts` 导出一个核心函数 `setup()`，它是每次 CLI 会话开始时的"布场"环节。在用户看到 REPL 界面之前，`setup()` 需要完成以下工作：

1. **环境验证**：检查 Node.js 版本、验证权限模式的安全性
2. **工作目录初始化**：设置 cwd、项目根目录，处理 worktree 创建
3. **Hook 系统初始化**：捕获 hooks 配置快照、初始化文件变更监听器
4. **终端恢复**：检测并恢复中断的 iTerm2/Terminal.app 设置
5. **后台任务启动**：插件预加载、会话记忆初始化、版本锁定等
6. **遥测与日志**：记录上一次会话的统计信息、发射 `tengu_started` 事件

## 关键代码解析

### 1. 函数签名

```typescript
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
): Promise<void>
```

参数丰富，反映了 Claude Code 支持的多种运行模式。`permissionMode` 控制权限策略，`worktreeEnabled` 和 `tmuxEnabled` 支持 git worktree + tmux 的多工作树模式。

### 2. UDS 消息服务器

```typescript
if (!isBareMode() || messagingSocketPath !== undefined) {
  if (feature('UDS_INBOX')) {
    const m = await import('./utils/udsMessaging.js')
    await m.startUdsMessaging(
      messagingSocketPath ?? m.getDefaultUdsSocketPath(),
      { isExplicit: messagingSocketPath !== undefined },
    )
  }
}
```

启动 Unix Domain Socket 消息服务器。这允许外部进程（如 hooks）通过 socket 与正在运行的 Claude Code 会话通信。`--bare` 模式下跳过（脚本化调用不需要接收注入消息），但 `--messaging-socket-path` 显式指定时仍然启用。

### 3. 终端设置恢复

```typescript
if (!getIsNonInteractiveSession()) {
  if (isAgentSwarmsEnabled()) {
    const restoredIterm2Backup = await checkAndRestoreITerm2Backup()
    if (restoredIterm2Backup.status === 'restored') {
      console.log(chalk.yellow('Detected an interrupted iTerm2 setup...'))
    }
  }
  const restoredTerminalBackup = await checkAndRestoreTerminalBackup()
  // ...
}
```

当 worktree/swarm 功能修改了终端配置（iTerm2 profile 或 Terminal.app 设置）后如果进程被中断，下次启动时会自动恢复。这是一个防御性设计——确保即使崩溃也不会留下损坏的终端配置。

### 4. Worktree 创建

```typescript
if (worktreeEnabled) {
  const hasHook = hasWorktreeCreateHook()
  const inGit = await getIsGit()
  if (!hasHook && !inGit) {
    process.stderr.write(chalk.red(`Error: Can only use --worktree in a git repository...`))
    process.exit(1)
  }

  const slug = worktreePRNumber
    ? `pr-${worktreePRNumber}`
    : (worktreeName ?? getPlanSlug())

  worktreeSession = await createWorktreeForSession(getSessionId(), slug, tmuxSessionName, ...)
  process.chdir(worktreeSession.worktreePath)
  setCwd(worktreeSession.worktreePath)
}
```

当用户使用 `--worktree` 选项时，为本次会话创建一个独立的 git worktree。支持通过 PR 号创建（`--worktree #123`）或自定义名称。创建完成后切换到 worktree 目录，这样后续所有操作都在隔离的工作树中进行。

### 5. 权限安全检查

```typescript
if (permissionMode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
  if (process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== '1') {
    console.error(`--dangerously-skip-permissions cannot be used with root/sudo...`)
    process.exit(1)
  }

  if (process.env.USER_TYPE === 'ant' && ...) {
    const [isDocker, hasInternet] = await Promise.all([
      envDynamic.getIsDocker(),
      env.hasInternetAccess(),
    ])
    if (!isSandboxed || hasInternet) {
      console.error(`--dangerously-skip-permissions can only be used in Docker...`)
      process.exit(1)
    }
  }
}
```

`--dangerously-skip-permissions` 的安全约束：
- 不能以 root 权限使用（除非在沙箱中）
- Anthropic 内部用户必须在无网络的 Docker/Bubblewrap 容器中才能使用
- 外部用户仍可使用，但建议只在沙箱环境中使用

### 6. 上一次会话统计记录

```typescript
const projectConfig = getCurrentProjectConfig()
if (projectConfig.lastCost !== undefined && projectConfig.lastDuration !== undefined) {
  logEvent('tengu_exit', {
    last_session_cost: projectConfig.lastCost,
    last_session_api_duration: projectConfig.lastAPIDuration,
    last_session_duration: projectConfig.lastDuration,
    last_session_lines_added: projectConfig.lastLinesAdded,
    last_session_lines_removed: projectConfig.lastLinesRemoved,
    // ...
  })
}
```

因为进程退出时可能无法可靠地发送遥测事件，所以采用"下次启动时补发"的策略——在 setup 阶段读取上次保存的会话统计并发送 `tengu_exit` 事件。

## 数据流

```
main.tsx action handler
  └─> setup(cwd, permissionMode, ...)
       ├─ 检查 Node.js 版本
       ├─ 设置自定义 sessionId
       ├─ 启动 UDS 消息服务器 (feature gate)
       ├─ 捕获 teammate 模式快照
       ├─ 恢复中断的终端设置
       ├─ setCwd() / setOriginalCwd() / setProjectRoot()
       ├─ captureHooksConfigSnapshot()
       ├─ initializeFileChangedWatcher()
       ├─ 创建 worktree (如果启用)
       ├─ initSessionMemory()
       ├─ lockCurrentVersion()
       ├─ 预取 commands 和 plugin hooks
       ├─ initSinks()  (遥测)
       ├─ logEvent('tengu_started')
       ├─ prefetchApiKeyFromApiKeyHelperIfSafe()
       ├─ checkForReleaseNotes()
       ├─ 验证 --dangerously-skip-permissions 安全性
       └─ 记录上次会话统计
```

## 与其他模块的关系
- **上游**: `main.tsx` 在 action handler 中调用
- **核心依赖**:
  - `bootstrap/state.ts` —— 全局状态设置（cwd, sessionId, projectRoot）
  - `utils/config.ts` —— 读取全局/项目配置
  - `utils/worktree.ts` —— worktree 创建与管理
  - `utils/hooks/` —— hooks 系统初始化
  - `commands.ts` —— 命令预加载
  - `utils/sinks.ts` —— 遥测 sink 初始化
- **被依赖**: 仅被 `main.tsx` 直接调用

## 设计亮点与思考

1. **防御性编程**：终端配置恢复、权限安全多层检查、环境验证——每一步都考虑了异常情况。
2. **--bare 模式的精细裁剪**：不是简单的全有全无，而是逐个判断哪些初始化可以跳过。
3. **遥测的"补发"策略**：巧妙地在下次启动时发送上次的会话统计，解决了进程退出时发送不可靠的问题。
4. **worktree + tmux 的组合拳**：为每个会话创建独立的工作树和终端窗口，实现真正的并行开发。
5. **UDS 消息通道**：为进程间通信提供了标准化的 socket 接口。

## 要点总结

1. **会话级环境准备**：在 REPL 渲染前完成所有必要的环境检查和初始化
2. **安全第一**：权限绕过的多层安全约束（root 检查、容器检测、网络检测）
3. **终端状态保护**：自动恢复中断的终端配置修改
4. **worktree 隔离**：支持为每个会话创建独立的 git 工作树
5. **遥测可靠性**：通过"下次启动补发"解决退出时遥测不可靠的问题
