# 第四章：工具系统 — Claude 的手和脚

> 工具是 Claude 与外部世界交互的唯一方式。理解工具系统，就理解了 AI Agent 的执行能力。

## 4.1 工具的概念

在 AI Agent 架构中，LLM 本身只能「思考」和「说话」。要让它真正做事（读文件、执行命令、搜索代码），需要 **工具（Tool）**。

```
Claude 的能力 = 语言理解 + 工具调用
                │              │
                ▼              ▼
           分析问题        执行操作
           理解代码        读写文件
           制定计划        运行命令
```

## 4.2 Tool 类型定义：src/Tool.ts

每个工具的完整类型定义（~800行）：

```typescript
export type Tool<Input, Output, Progress> = {
  // ===== 标识 =====
  name: string              // 工具名称（唯一标识）
  aliases?: string[]        // 别名
  searchHint?: string       // 搜索提示（ToolSearch 用）

  // ===== 核心功能 =====
  call(                     // 执行工具
    args: Input,            // 输入参数
    context: ToolContext,   // 执行上下文（cwd, 权限等）
    canUseTool: Function,   // 权限检查
    parentMessage: Message, // 触发此工具的消息
    onProgress?: Function,  // 进度回调
  ): Promise<ToolResult<Output>>

  description(input, opts): Promise<string>  // 动态描述
  inputSchema: ZodSchema                     // 输入验证（Zod schema）
  
  // ===== 安全属性 =====
  isConcurrencySafe(input): boolean  // 能否与其他工具并行？
  isReadOnly(input): boolean         // 是否只读？
  isDestructive?(input): boolean     // 是否是破坏性操作？
  checkPermissions(input, ctx):      // 权限检查
    Promise<PermissionResult>
  
  // ===== UI 渲染 =====
  renderToolUseMessage(input, opts): ReactNode    // 工具调用时显示什么
  renderToolResultMessage?(content, ...): ReactNode // 工具结果显示什么
  
  // ===== 模型提示 =====
  prompt(opts): Promise<string>  // 告诉 Claude 这个工具怎么用
  
  // ===== 元信息 =====
  isEnabled(): boolean           // 是否启用
  userFacingName(input): string  // 用户看到的名称
}
```

## 4.3 如何定义一个工具：buildTool()

```typescript
import { buildTool } from '../Tool'
import { z } from 'zod'

// 用 buildTool() 工厂函数创建工具
export const MyTool = buildTool({
  name: 'MyTool',
  
  // Zod Schema 定义输入参数
  inputSchema: z.strictObject({
    query: z.string().describe('搜索关键词'),
    maxResults: z.number().optional().describe('最大结果数'),
  }),
  
  // 工具的模型提示词
  async prompt() {
    return '使用此工具来搜索代码库中的内容...'
  },
  
  // 工具描述（动态的，可以根据输入变化）
  async description(input) {
    return `搜索: ${input.query}`
  },
  
  // 执行函数
  async call(input, context) {
    const results = await searchCode(input.query, input.maxResults)
    return {
      type: 'text',
      text: formatResults(results),
    }
  },
  
  // 安全属性
  isReadOnly() { return true },        // 只读操作
  isConcurrencySafe() { return true },  // 可以并行
  isEnabled() { return true },          // 始终启用
  
  // UI 渲染
  renderToolUseMessage(input) {
    return <Text>🔍 搜索: {input.query}</Text>
  },
})
```

**buildTool() 的默认值**（安全优先）：
| 属性 | 默认值 | 原因 |
|------|--------|------|
| `isEnabled()` | `true` | 默认启用 |
| `isConcurrencySafe()` | `false` | 假设不安全（fail-closed） |
| `isReadOnly()` | `false` | 假设有写操作 |
| `checkPermissions()` | `allow` | 默认允许 |

## 4.4 内置工具清单

### 文件操作类
| 工具 | 功能 | 只读 | 并发安全 |
|------|------|------|----------|
| FileRead | 读取文件内容 | ✅ | ✅ |
| FileEdit | 编辑文件（精确替换） | ❌ | ❌ |
| FileWrite | 创建/覆盖文件 | ❌ | ❌ |
| Glob | 按模式搜索文件名 | ✅ | ✅ |
| Grep | 搜索文件内容（ripgrep） | ✅ | ✅ |

### 系统操作类
| 工具 | 功能 | 只读 | 并发安全 |
|------|------|------|----------|
| Bash | 执行 Shell 命令 | ❌ | ❌ |
| WebFetch | 获取网页内容 | ✅ | ✅ |
| WebSearch | 搜索网络 | ✅ | ✅ |

### Agent 类
| 工具 | 功能 | 只读 | 并发安全 |
|------|------|------|----------|
| Agent | 启动子 Agent | ❌ | ❌ |
| SendMessage | 向子 Agent 发消息 | ❌ | ❌ |
| TaskCreate | 创建任务 | ❌ | ✅ |
| TaskUpdate | 更新任务 | ❌ | ✅ |

### 交互类
| 工具 | 功能 | 只读 | 并发安全 |
|------|------|------|----------|
| AskUserQuestion | 向用户提问 | ✅ | ❌ |
| Skill | 调用技能 | ❌ | ❌ |
| EnterPlanMode | 进入规划模式 | ❌ | ❌ |

## 4.5 工具池组装：src/tools.ts

```typescript
// 工具注册表的三层结构

// 第一层：所有内置工具
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    BashTool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    GlobTool,
    GrepTool,
    // ... 60+ 工具
    
    // 条件启用的工具
    ...(feature('KAIROS') ? [CronTool, RemoteTriggerTool] : []),
    ...(feature('WORKFLOW') ? [WorkflowTool] : []),
  ]
}

// 第二层：权限过滤
export function getTools(permissionContext): Tools {
  const allTools = getAllBaseTools()
  return allTools.filter(tool => {
    // 检查权限规则是否禁用了某个工具
    if (isDenied(tool.name, permissionContext)) return false
    // --simple 模式只保留基础工具
    if (simpleMode) return ['Bash', 'Read', 'Edit'].includes(tool.name)
    return true
  })
}

// 第三层：合并 MCP 工具
export function assembleToolPool(builtIn, mcpTools): Tools {
  // 内置工具放前面（prompt-cache 稳定性）
  // MCP 工具放后面
  // 同名工具去重（内置优先）
  return [...builtIn, ...mcpTools.filter(t => !builtIn.has(t.name))]
}
```

## 4.6 工具的文件结构

每个工具由 3 个文件组成：

```
src/tools/
├── BashTool/
│   ├── BashTool.ts      # 工具定义 + 执行逻辑
│   ├── prompt.ts         # 模型提示词（告诉 Claude 怎么用这个工具）
│   └── UI.tsx            # UI 渲染组件
├── FileReadTool/
│   ├── FileReadTool.ts
│   ├── prompt.ts
│   └── UI.tsx
└── ...
```

**为什么分三个文件？**
- **工具定义**：核心逻辑，面向 QueryEngine
- **提示词**：面向 Claude，描述工具用途和用法
- **UI**：面向用户，在终端中显示工具调用过程

## 4.7 权限系统

```
工具调用请求
    │
    ▼
┌─ checkPermissions() ──┐
│ 工具自己的权限判断       │
│ (如 Bash 检查危险命令)   │
└────────┬──────────────┘
         │
         ▼
┌─ 全局权限规则 ──────────┐
│ settings.json 中的规则   │
│ ├─ alwaysAllow: [...]   │  ←─ 这些工具直接通过
│ ├─ alwaysDeny: [...]    │  ←─ 这些工具直接拒绝
│ └─ alwaysAsk: [...]     │  ←─ 这些工具每次都问
└────────┬───────────────┘
         │
         ▼
┌─ 权限模式 ─────────────┐
│ default: 每次都问用户    │
│ auto: ML 分类器自动判断  │
│ bypass: 跳过所有检查     │
└────────┬───────────────┘
         │
         ▼
  allow / deny / ask(用户)
```

## 4.8 设计亮点

1. **安全优先的默认值**：不确定就标记为不安全
2. **声明式定义**：Zod schema 同时用于验证和生成描述
3. **关注点分离**：逻辑/提示词/UI 三层分离
4. **可扩展性**：MCP 协议让外部工具无缝集成
5. **并发优化**：只读工具并行执行，减少延迟

## 4.9 下一章预告

工具的调用结果需要展示给用户。下一章我们看 **终端 UI 系统** — 如何用 React 在终端中渲染交互界面。

→ [第五章：终端 UI 系统](05-terminal-ui.md)
