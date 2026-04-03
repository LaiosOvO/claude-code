# 第二章：核心抽象 -- Tool、Command、Skill

> 上一章你学会了基础原语（createSignal、Mailbox、Zod 等）。这一章我们向上一层，看这些原语如何组合成三大核心抽象：Tool、Command、Skill。

## 2.1 三者的关系

```
用户视角：
  "帮我读取 package.json"     -> Tool (Claude 自动调用)
  "/commit"                    -> Command (用户手动触发)
  "/review-pr 123"             -> Skill (可扩展的命令模板)

内部关系：
  +------------------------------------------+
  |              Skill                        |
  |  (可扩展的命令模板，加载自 .md 或代码注册)  |
  |  +-------------------------------+       |
  |  |          Command              |       |
  |  |  (用户用 / 触发的操作)         |       |
  |  |  +--------------------+      |       |
  |  |  |       Tool         |      |       |
  |  |  |  (Claude 调用的能力) |      |       |
  |  |  +--------------------+      |       |
  |  +-------------------------------+       |
  +------------------------------------------+

  Tool 包含于 Command 包含于 Skill
  （Tool 是最底层，Skill 是最高层的封装）
```

## 2.2 Tool 的完整接口

**文件**: `src/Tool.ts` (792行)

Tool 是 Claude 与外部世界交互的原子能力。ccb 定义了一个完整的 `Tool` 类型，包含 30+ 个方法/属性：

```typescript
// src/Tool.ts — 核心类型（简化展示关键部分）
export type Tool<
  Input extends AnyObject = AnyObject,
  Output = unknown,
  P extends ToolProgressData = ToolProgressData,
> = {
  readonly name: string
  aliases?: string[]                          // 重命名后的向后兼容
  searchHint?: string                         // ToolSearch 关键词匹配
  readonly inputSchema: Input                 // Zod schema
  readonly inputJSONSchema?: ToolInputJSONSchema  // MCP 工具的 JSON Schema
  maxResultSizeChars: number                  // 结果超过此大小写入磁盘

  // --- 核心方法 ---
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  description(input, options): Promise<string>

  // --- 安全属性（fail-closed 默认值）---
  isEnabled(): boolean                        // 默认 true
  isConcurrencySafe(input): boolean           // 默认 false（假设不安全）
  isReadOnly(input): boolean                  // 默认 false（假设有写操作）
  isDestructive?(input): boolean              // 默认 false

  // --- 权限 ---
  validateInput?(input, context): Promise<ValidationResult>
  checkPermissions(input, context): Promise<PermissionResult>

  // --- UI ---
  userFacingName(input?): string
  renderToolUseMessage?(...): React.ReactNode
  renderToolResultMessage?(...): React.ReactNode

  // --- 高级 ---
  interruptBehavior?(): 'cancel' | 'block'    // 用户中断时的行为
  isSearchOrReadCommand?(input): { isSearch; isRead; isList? }
  readonly shouldDefer?: boolean               // ToolSearch 延迟加载
  readonly alwaysLoad?: boolean                // 始终加载不延迟
  mcpInfo?: { serverName; toolName }           // MCP 工具的元信息
}
```

## 2.3 buildTool()：安全默认值工厂

**文件**: `src/Tool.ts` (第757-792行)

```typescript
// 安全默认值（fail-closed）
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  isConcurrencySafe: (_input?) => false,       // 默认不安全 -> 串行执行
  isReadOnly: (_input?) => false,               // 默认有写操作 -> 需要权限
  isDestructive: (_input?) => false,
  checkPermissions: (input, _ctx?) =>
    Promise.resolve({ behavior: 'allow', updatedInput: input }),
  toAutoClassifierInput: (_input?) => '',
  userFacingName: (_input?) => '',
}

export function buildTool<D extends AnyToolDef>(def: D): BuiltTool<D> {
  return {
    ...TOOL_DEFAULTS,
    userFacingName: () => def.name,
    ...def,
  } as BuiltTool<D>
}
```

**Fail-Closed 设计思想**：

- 忘了标记 `isConcurrencySafe`？默认 false -> 串行执行（安全但慢）
- 忘了标记 `isReadOnly`？默认 false -> 需要权限检查（安全但多一步确认）
- 只有**显式标记为安全**的工具才能享受优化（并行执行、跳过权限）

`ToolDef` 类型让这些方法变为可选，而 `BuiltTool<D>` 保证返回值总是完整的 `Tool`：

```typescript
type DefaultableToolKeys =
  | 'isEnabled' | 'isConcurrencySafe' | 'isReadOnly'
  | 'isDestructive' | 'checkPermissions' | 'toAutoClassifierInput'
  | 'userFacingName'

export type ToolDef<...> =
  Omit<Tool<...>, DefaultableToolKeys> &
  Partial<Pick<Tool<...>, DefaultableToolKeys>>
```

## 2.4 Tool 的多文件模式

每个工具由多个文件组成，各司其职。以 BashTool 为例：

```
src/tools/BashTool/
|
+-- BashTool.tsx       <- 面向 QueryEngine：定义、验证、执行
|     buildTool({ name: 'Bash', inputSchema, call, ... })
|     实现 checkPermissions()
|     标记安全属性
|
+-- prompt.ts          <- 面向 Claude：告诉 AI 这个工具怎么用
|     返回自然语言描述
|     包含使用示例和注意事项
|     ~369行，非常详细
|
+-- UI.tsx             <- 面向用户：在终端中展示工具调用过程
|     renderToolUseMessage() -- 调用时显示什么
|     renderToolResultMessage() -- 结果显示什么
|
+-- bashPermissions.ts <- 权限逻辑（独立出来因为足够复杂）
+-- bashSecurity.ts    <- 安全检查（命令解析、危险检测）
+-- commandSemantics.ts <- 命令语义分析
+-- sedEditParser.ts   <- sed 编辑命令解析
+-- utils.ts           <- 工具函数
+-- toolName.ts        <- 常量导出
```

**为什么要分多个文件？**

| 关注点 | 受众 | 变化频率 |
|--------|------|----------|
| 执行逻辑 (BashTool.tsx) | QueryEngine | 低 |
| 模型提示 (prompt.ts) | Claude AI | 中 |
| UI 渲染 (UI.tsx) | 终端用户 | 高 |
| 权限/安全 | 权限系统 | 低 |

三者独立修改，互不影响。

## 2.5 真实工具示例：FileReadTool

```
src/tools/FileReadTool/
+-- FileReadTool.ts    <- 核心逻辑
+-- prompt.ts          <- AI 提示词
+-- UI.tsx             <- 终端 UI
+-- imageProcessor.ts  <- 图片处理
+-- limits.ts          <- 文件大小限制
```

FileReadTool 标记了 `isReadOnly: () => true` 和 `isConcurrencySafe: () => true`，这意味着：

1. 它不需要权限确认（只读操作）
2. 多个 Read 调用可以**并行执行**

## 2.6 全部 58+ 工具一览

```
核心工具（始终加载）:
  Bash, Read, Edit, Write, Glob, Grep, Agent, WebFetch, WebSearch
  NotebookEdit, TodoWrite, Brief, SkillTool, ToolSearch

任务管理:
  TaskCreate, TaskGet, TaskList, TaskUpdate, TaskStop, TaskOutput

规划模式:
  EnterPlanMode, ExitPlanModeV2, EnterWorktree, ExitWorktree

MCP 集成:
  MCPTool, ListMcpResources, ReadMcpResource, McpAuth

通知与通信:
  SendMessage, AskUserQuestion, PushNotification, ListPeers

团队协作:
  TeamCreate, TeamDelete

高级工具（feature-gated）:
  LSP, WorkflowTool, RemoteTrigger, Monitor
  ScheduleCron (CronCreate/CronDelete/CronList)
  SleepTool, SendUserFile, SubscribePR
  WebBrowser, TerminalCapture, Snip
  REPLTool, SuggestBackgroundPR, VerifyPlanExecution
  PowerShell, ReviewArtifact, OverflowTest, CtxInspect

Ant-only:
  Config, Tungsten, REPLTool
```

## 2.7 Command 的三种子类型

**文件**: `src/commands.ts`

Command 是用户通过 `/xxx` 触发的操作。它有三种子类型：

### PromptCommand（最常用）
```typescript
// 把内容发送给 Claude 处理
const commitCommand: PromptCommand = {
  type: 'prompt',
  name: 'commit',
  description: '生成 commit 信息并提交',
  isEnabled: true,
  progressMessage: 'generating commit message',
  source: 'builtin',
  async getPromptForCommand(args, context) {
    const diff = await exec('git diff --staged')
    return `请根据以下 diff 生成 commit 信息：\n${diff}`
  },
  allowedTools: ['Bash', 'Read'],
}
```

### LocalCommand（本地执行）
```typescript
// 不经过 Claude，直接在本地执行
const clearCommand: LocalCommand = {
  type: 'local',
  name: 'clear',
  description: '清除对话历史',
  load: () => ({
    async call(args, context) {
      context.clearMessages()
      return { type: 'text', text: '对话已清除' }
    }
  }),
}
```

### LocalJSXCommand（渲染 UI）
```typescript
// 渲染一个 React 组件
const helpCommand: LocalJSXCommand = {
  type: 'local-jsx',
  name: 'help',
  description: '显示帮助',
  load: () => ({
    async call(onDone, context) {
      return <HelpScreen onClose={() => onDone()} />
    }
  }),
}
```

## 2.8 ccb 的 80+ 内置命令

通过 `src/commands.ts` 可以看到庞大的命令列表：

```
基础: /help, /clear, /compact, /config, /cost, /status, /version
Git:  /commit, /commit-push-pr, /diff, /branch, /pr_comments
会话: /resume, /session, /share, /copy, /export, /rename
工具: /mcp, /skills, /agents, /plugin, /reload-plugins
UI:   /color, /theme, /keybindings, /desktop, /chrome
安全: /permissions, /login, /logout, /sandbox-toggle

Feature-gated:
  /bridge, /voice, /vim, /buddy, /assistant, /peers
  /proactive, /brief, /subscribe-pr, /workflows
  /teleport, /fork, /torch, /ultraplan
  /remote-setup, /force-snip
```

## 2.9 Skill 的两种来源

### 磁盘 Skill（用户自定义）

```markdown
<!-- .claude/skills/review-pr.md -->
---
name: review-pr
description: 审查 Pull Request
allowedTools:
  - Bash
  - Read
  - Grep
---

请审查以下 Pull Request：
1. 先运行 `gh pr diff {{args}}` 查看变更
2. 阅读修改的文件
3. 给出详细的审查意见
```

**加载流程** (`src/skills/loadSkillsDir.ts`)：
```
.claude/skills/*.md  ->  loadSkillsDir()  ->  解析 frontmatter  ->  PromptCommand
```

### 内置 Skill（代码注册）

```typescript
// src/skills/bundledSkills.ts
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  // BundledSkillDefinition 包含：
  //   name, description, aliases?, whenToUse?, argumentHint?
  //   allowedTools?, model?, hooks?, context?, agent?
  //   files?: Record<string, string>  // 附带的参考文件
  //   getPromptForCommand(args, context): Promise<ContentBlockParam[]>
}
```

内置 Skill 与磁盘 Skill 的区别：

| 特性 | 磁盘 Skill | 内置 Skill |
|------|-----------|-----------|
| 定义方式 | Markdown 文件 | TypeScript 代码 |
| 发布方式 | 用户创建 | 编译到 CLI 二进制 |
| 附带文件 | 依赖磁盘路径 | `files` 字段自动解压 |
| 灵活性 | 高（直接编辑） | 低（需要重新构建） |

## 2.10 权限管线

Tool 的权限检查是一个多层管线：

```
Claude 想调用 BashTool("rm -rf /tmp/test")
    |
    v
+-- 第 1 层：输入验证 -------------------------+
|  tool.validateInput(input, context)           |
|  -> 检查输入是否符合 schema                   |
|  -> 返回 ValidationResult                    |
+--------------------+--------------------------+
                     |
                     v
+-- 第 2 层：工具自身权限检查 -------------------+
|  tool.checkPermissions(input, context)         |
|  -> BashTool: 命令白名单/黑名单              |
|  -> 危险性检测、sed 解析                      |
|  -> 返回 { behavior: 'allow'|'deny'|'ask' }  |
+--------------------+--------------------------+
                     |
                     v
+-- 第 3 层：全局权限规则 ----------------------+
|  settings.json 中的 alwaysAllow/Deny 规则     |
|  -> 模式匹配：tool name + input pattern       |
|  -> filterToolsByDenyRules()                  |
+--------------------+--------------------------+
                     |
                     v
+-- 第 4 层：权限模式 --------------------------+
|  default  -> 弹出确认对话框                   |
|  auto     -> ML 分类器自动判断                |
|  bypass   -> 直接通过（仅沙箱环境）           |
+--------------------+--------------------------+
                     |
                     v
                 执行 或 拒绝
```

## 2.11 本章总结

| 抽象 | 触发者 | 执行者 | 定义方式 | 数量 |
|------|--------|--------|----------|------|
| Tool | Claude (AI) | QueryEngine | TypeScript (buildTool) | 58+ |
| Command | 用户 (/xxx) | REPL | TypeScript (3种子类型) | 80+ |
| Skill | 用户 (/xxx) 或 AI | REPL + Claude | Markdown 或 registerBundledSkill | 可扩展 |

**关键设计原则：**

1. **安全优先** -- buildTool 默认值假设最坏情况（fail-closed）
2. **关注点分离** -- 逻辑/提示词/UI 各自独立文件
3. **可扩展性** -- Skill 让用户用 Markdown 就能扩展功能
4. **编译时门控** -- feature() 宏控制功能启停，死代码消除
5. **统一注册** -- 所有命令通过 getCommands() 汇总

下一章我们继续向上，看多个 Tool 如何组装成 **工具池**，多个 Command 如何组装成 **命令系统**。

-> [第三章：模块组装 -- 工具池、命令系统、MCP 集成](03-module-assembly.md)
