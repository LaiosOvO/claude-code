# 阅读笔记：src/tools.ts

## 文件基本信息
- **路径**: `src/tools.ts`
- **行数**: 389 行
- **角色**: 工具注册中心，汇总所有可用工具并提供过滤、组装、合并等功能

## 核心功能

`tools.ts` 是所有工具的"注册中心"和"装配车间"。它的职责是：

1. **汇总所有内置工具**：`getAllBaseTools()` 返回当前环境下所有可能可用的工具列表
2. **按权限过滤**：`getTools()` 根据权限上下文过滤掉被禁止的工具
3. **与 MCP 工具合并**：`assembleToolPool()` 将内置工具和 MCP 工具合并为最终工具集
4. **条件加载**：通过 `feature()` gate 和环境变量决定哪些工具可用

## 关键代码解析

### 1. 工具导入——静态 vs 条件加载

```typescript
// 始终加载的核心工具
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'

// 条件加载：ant-only 工具
const REPLTool = process.env.USER_TYPE === 'ant'
  ? require('./tools/REPLTool/REPLTool.js').REPLTool
  : null

// 条件加载：feature gate 控制
const SleepTool = feature('PROACTIVE') || feature('KAIROS')
  ? require('./tools/SleepTool/SleepTool.js').SleepTool
  : null

const WebBrowserTool = feature('WEB_BROWSER_TOOL')
  ? require('./tools/WebBrowserTool/WebBrowserTool.js').WebBrowserTool
  : null
```

工具分三种加载策略：
- **静态导入**：所有用户都能使用的核心工具（Bash、Read、Edit、Glob、Grep 等）
- **环境变量条件加载**：`USER_TYPE === 'ant'` 控制的 Anthropic 内部工具
- **feature gate 条件加载**：通过 `feature()` 在构建时消除（DCE），外部构建中完全移除

### 2. getAllBaseTools()——工具注册表

```typescript
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // 当有嵌入式搜索工具时，跳过 Glob/Grep
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    // ant-only 工具
    ...(process.env.USER_TYPE === 'ant' ? [ConfigTool, TungstenTool] : []),
    // feature-gated 工具
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    ...(isTodoV2Enabled() ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    // REPL 模式
    ...(process.env.USER_TYPE === 'ant' && REPLTool ? [REPLTool] : []),
    // ToolSearch 自身
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
    // 测试工具
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []),
    // ...更多条件工具
  ]
}
```

**注意**：`hasEmbeddedSearchTools()` 检查表明 ant 内部构建可能将 `bfs`/`ugrep` 嵌入到 Bun 二进制文件中，此时就不需要独立的 Glob/Grep 工具了。

### 3. getTools()——按权限过滤

```typescript
export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // Simple 模式：只有 Bash、Read、Edit
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    if (isReplModeEnabled() && REPLTool) {
      const replSimple: Tool[] = [REPLTool]
      // coordinator 模式额外加入 TaskStopTool
      return filterToolsByDenyRules(replSimple, permissionContext)
    }
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // 正常模式：获取所有工具
  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // REPL 模式下隐藏被 REPL 包装的原始工具
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some(tool => toolMatchesName(tool, REPL_TOOL_NAME))
    if (replEnabled) {
      allowedTools = allowedTools.filter(tool => !REPL_ONLY_TOOLS.has(tool.name))
    }
  }

  // 最终过滤：isEnabled() 检查
  const isEnabled = allowedTools.map(_ => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}
```

过滤链：`getAllBaseTools()` -> `filterToolsByDenyRules()` -> REPL 过滤 -> `isEnabled()` 过滤

### 4. filterToolsByDenyRules()——权限规则过滤

```typescript
export function filterToolsByDenyRules<T extends {
  name: string
  mcpInfo?: { serverName: string; toolName: string }
}>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}
```

从工具列表中移除被"全面拒绝"（blanket deny）的工具。支持按工具名或 MCP 服务器名前缀匹配（如 `mcp__server` 会拒绝该服务器的所有工具）。

### 5. assembleToolPool()——最终工具集组装

```typescript
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // 分区排序以保持 prompt cache 稳定性
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

关键设计：
- **内置工具优先**：`uniqBy` 保留第一个出现的，所以内置工具在同名冲突时优先
- **分区排序**：内置工具和 MCP 工具各自排序后拼接，而非混合排序。这是为了 prompt cache 稳定性——API 服务端在最后一个内置工具后设置 cache breakpoint，混合排序会破坏 cache。
- **MCP 工具同样受权限过滤**：`filterToolsByDenyRules` 对 MCP 工具也生效

## 数据流

```
各工具定义文件 (BashTool.ts, FileReadTool.ts, ...)
  └─> tools.ts::getAllBaseTools()  (条件汇总)
       └─> getTools(permissionContext)  (权限过滤)
            └─> assembleToolPool(permissionContext, mcpTools)  (合并 MCP)
                 └─> 最终工具列表 → query.ts / QueryEngine.ts 使用
```

## 与其他模块的关系
- **依赖**：
  - 所有 `tools/*/` 目录下的工具定义文件
  - `Tool.ts` —— 类型定义
  - `utils/permissions/permissions.ts` —— `getDenyRuleForTool`
  - `utils/envUtils.ts` —— 环境变量检查
  - `bun:bundle` —— `feature()` 编译时条件
- **被依赖**：
  - `main.tsx` —— 调用 `getTools()` 组装工具集
  - `QueryEngine.ts` —— 使用工具列表
  - REPL 组件 —— 通过 `useMergedTools` hook 使用 `assembleToolPool`

## 设计亮点与思考

1. **三层工具加载策略**：静态导入（核心）、环境变量（内部）、feature gate（实验性）——清晰的分层控制。
2. **Prompt cache 感知的排序**：分区排序而非混合排序，避免 MCP 工具的增减破坏内置工具的 cache 前缀。这个细节直接影响 API 调用成本（12x token 差异）。
3. **REPL 模式的工具替换**：当 REPL 启用时，原始的 Bash/Read/Edit 被隐藏，由 REPL 工具统一管理——用户感知不到区别，但内部执行路径完全不同。
4. **懒加载防循环**：`getTeamCreateTool()`、`getSendMessageTool()` 使用函数式懒加载来打破循环依赖。
5. **Simple 模式**：`CLAUDE_CODE_SIMPLE=1` 只保留 Bash+Read+Edit 三个工具，大幅简化 prompt。

## 要点总结

1. **工具注册中心**：`getAllBaseTools()` 是所有工具的单一来源
2. **多层过滤**：条件加载 -> 权限过滤 -> REPL 过滤 -> isEnabled 过滤
3. **内置工具优先于 MCP**：同名冲突时内置工具胜出
4. **排序影响成本**：分区排序保护 prompt cache 的稳定性
5. **Simple 模式**：`--bare` 或 `CLAUDE_CODE_SIMPLE` 将工具集缩减到最小
