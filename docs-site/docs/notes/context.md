# 阅读笔记：src/context.ts

## 文件基本信息
- **路径**: `src/context.ts`
- **行数**: 260 行
- **角色**: 上下文提供模块，负责收集并缓存发送给 Claude API 的系统上下文和用户上下文

## 核心功能

`context.ts` 是 Claude Code 的"情报收集站"。每次与 Claude API 对话时，除了用户的消息和系统提示词之外，还需要附带两类上下文信息：

1. **系统上下文（System Context）**：git 状态信息（分支、最近提交、文件变更），用于让 Claude 了解当前代码仓库的状态
2. **用户上下文（User Context）**：CLAUDE.md 记忆文件的内容和当前日期，用于让 Claude 了解用户的项目规范和偏好

这两类上下文在会话开始时收集一次，之后被缓存（memoize），不再重复获取。

## 关键代码解析

### 1. getGitStatus()——Git 状态收集

```typescript
export const getGitStatus = memoize(async (): Promise<string | null> => {
  if (process.env.NODE_ENV === 'test') {
    return null  // 测试环境避免循环依赖
  }

  const isGit = await getIsGit()
  if (!isGit) return null

  const [branch, mainBranch, status, log, userName] = await Promise.all([
    getBranch(),
    getDefaultBranch(),
    execFileNoThrow(gitExe(), ['--no-optional-locks', 'status', '--short'], ...)
      .then(({ stdout }) => stdout.trim()),
    execFileNoThrow(gitExe(), ['--no-optional-locks', 'log', '--oneline', '-n', '5'], ...)
      .then(({ stdout }) => stdout.trim()),
    execFileNoThrow(gitExe(), ['config', 'user.name'], ...)
      .then(({ stdout }) => stdout.trim()),
  ])

  // 截断过长的 status 输出
  const truncatedStatus = status.length > MAX_STATUS_CHARS
    ? status.substring(0, MAX_STATUS_CHARS) + '\n... (truncated...)'
    : status

  return [
    `This is the git status at the start of the conversation...`,
    `Current branch: ${branch}`,
    `Main branch (you will usually use this for PRs): ${mainBranch}`,
    ...(userName ? [`Git user: ${userName}`] : []),
    `Status:\n${truncatedStatus || '(clean)'}`,
    `Recent commits:\n${log}`,
  ].join('\n\n')
})
```

关键设计点：
- **Promise.all 并行执行**：5 个 git 命令同时运行，而非串行
- **--no-optional-locks**：避免 git 的可选锁（在并发访问时特别重要）
- **status 截断**：2000 字符限制，防止大型仓库的 status 输出过大
- **memoize 缓存**：整个会话期间只执行一次

### 2. getSystemContext()——系统上下文

```typescript
export const getSystemContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    // 远程模式或禁用 git 时跳过
    const gitStatus =
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
      !shouldIncludeGitInstructions()
        ? null
        : await getGitStatus()

    // 系统提示注入（用于缓存破坏，ant-only）
    const injection = feature('BREAK_CACHE_COMMAND')
      ? getSystemPromptInjection()
      : null

    return {
      ...(gitStatus && { gitStatus }),
      ...(injection ? { cacheBreaker: `[CACHE_BREAKER: ${injection}]` } : {}),
    }
  },
)
```

系统上下文目前只包含两个可选字段：
- `gitStatus`：git 仓库状态
- `cacheBreaker`：缓存破坏注入（ant-only 调试功能）

### 3. getUserContext()——用户上下文

```typescript
export const getUserContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    // 禁用 CLAUDE.md 的条件
    const shouldDisableClaudeMd =
      isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
      (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)

    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))

    // 缓存 CLAUDE.md 内容供 auto-mode 分类器使用
    setCachedClaudeMdContent(claudeMd || null)

    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)
```

用户上下文包含：
- `claudeMd`：CLAUDE.md 文件内容（项目记忆/规范）
- `currentDate`：当前日期

CLAUDE.md 的加载有多个控制点：
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS`：完全禁用
- `--bare` 模式：跳过自动发现，但尊重 `--add-dir` 显式指定
- `filterInjectedMemoryFiles`：过滤掉被注入的记忆文件

### 4. 缓存破坏机制

```typescript
let systemPromptInjection: string | null = null

export function setSystemPromptInjection(value: string | null): void {
  systemPromptInjection = value
  // 修改注入值时立即清除上下文缓存
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
}
```

当系统提示注入值改变时，清除 memoize 缓存，强制下次调用重新获取上下文。这是一个调试功能——用于破坏 API 的 prompt cache 以测试不同场景。

## 数据流

```
会话开始
  ├─> getSystemContext()  [被 memoize，只执行一次]
  │    └─> getGitStatus()  [并行执行 5 个 git 命令]
  │         └─> { gitStatus: "branch, commits, status..." }
  │
  └─> getUserContext()  [被 memoize，只执行一次]
       └─> getMemoryFiles() → getClaudeMds()
            └─> { claudeMd: "项目规范...", currentDate: "Today's date is..." }

这两个上下文在 query.ts 中的使用位置：
  query() 循环体内:
    prependUserContext(messagesForQuery, userContext)   // 用户上下文作为前缀
    appendSystemContext(systemPrompt, systemContext)    // 系统上下文追加到系统提示
```

## 与其他模块的关系
- **上游调用者**:
  - `main.tsx::prefetchSystemContextIfSafe()` —— 预取系统上下文
  - `main.tsx::startDeferredPrefetches()` —— 预取用户上下文
  - `utils/queryContext.ts` —— 构建系统提示词时使用
  - `QueryEngine.ts` —— 通过 `fetchSystemPromptParts` 间接使用
- **依赖**:
  - `utils/git.ts` —— git 操作
  - `utils/claudemd.ts` —— CLAUDE.md 文件读取
  - `utils/execFileNoThrow.ts` —— 安全的子进程执行
  - `bootstrap/state.ts` —— 状态管理
  - `utils/envUtils.ts` —— 环境变量检查

## 设计亮点与思考

1. **memoize 单次执行**：上下文在会话期间不变的假设让缓存策略非常简单。如果需要更新（如缓存破坏），手动清除 cache 即可。
2. **并行 git 命令**：5 个 git 命令通过 `Promise.all` 并行执行，比串行快约 4-5 倍。
3. **安全的预取**：`prefetchSystemContextIfSafe()` 只在信任已建立时才预取 git 信息，因为 git 命令可以通过 hooks 执行任意代码。
4. **截断保护**：git status 限制在 2000 字符，防止大型仓库产生过大的上下文。
5. **--bare 的精细控制**：不是完全禁用 CLAUDE.md，而是"跳过自动发现但尊重显式指定"——体现了 `--bare` 的设计哲学"跳过你没要求的，保留你要求的"。

## 要点总结

1. **两类上下文**：系统上下文（git 状态）和用户上下文（CLAUDE.md + 日期）
2. **memoize 缓存**：每个会话只收集一次，避免重复的 IO 开销
3. **并行执行**：git 命令通过 `Promise.all` 并行运行
4. **安全预取**：只在信任建立后才执行可能触发 git hooks 的命令
5. **截断与禁用**：多层控制保证上下文大小可控
