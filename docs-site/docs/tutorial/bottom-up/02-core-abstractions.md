# 第二章：核心抽象 — Tool、Command、Skill

> 上一章你学会了基础原语（Signal、Mailbox、Zod 等）。这一章我们向上一层，看这些原语如何组合成三大核心抽象：Tool、Command、Skill。

## 2.1 三者的关系

```
用户视角：
  "帮我读取 package.json"     → Tool (Claude 自动调用)
  "/commit"                    → Command (用户手动调用)
  "/review-pr 123"             → Skill (可扩展的命令)

内部关系：
  ┌────────────────────────────────────────┐
  │              Skill                      │
  │  (可扩展的命令模板，加载自 .md 文件)     │
  │  ┌──────────────────────────────┐      │
  │  │          Command             │      │
  │  │  (用户用 / 触发的操作)        │      │
  │  │  ┌────────────────────┐     │      │
  │  │  │       Tool         │     │      │
  │  │  │  (Claude 调用的能力) │     │      │
  │  │  └────────────────────┘     │      │
  │  └──────────────────────────────┘      │
  └────────────────────────────────────────┘

  Tool ⊂ Command ⊂ Skill
  （Tool 是最底层，Skill 是最高层的封装）
```

## 2.2 Tool 的构成

Tool 是 Claude 与外部世界交互的原子能力。从第一章的 Zod Schema 开始构建：

```typescript
// 第一步：用 Zod 定义输入参数
const inputSchema = z.strictObject({
  file_path: z.string().describe('要读取的文件路径'),
  offset: z.number().optional().describe('起始行号'),
  limit: z.number().optional().describe('读取行数'),
})

// 第二步：定义执行函数
async function call(input, context) {
  // 读取文件...
  const content = await Bun.file(input.file_path).text()
  return { type: 'text', text: content }
}

// 第三步：用 buildTool() 组装
export const FileReadTool = buildTool({
  name: 'Read',
  inputSchema,
  call,
  prompt: async () => '使用此工具读取文件内容...',
  description: async (input) => `读取 ${input.file_path}`,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
})
```

### buildTool() 做了什么？

```typescript
// buildTool 是一个「安全默认值」工厂
function buildTool(def: ToolDef): Tool {
  return {
    // 用户提供的
    name: def.name,
    inputSchema: def.inputSchema,
    call: def.call,
    prompt: def.prompt,
    description: def.description,

    // 安全默认值（如果用户没有提供）
    isEnabled: def.isEnabled ?? (() => true),
    isConcurrencySafe: def.isConcurrencySafe ?? (() => false),  // 默认不安全！
    isReadOnly: def.isReadOnly ?? (() => false),                 // 默认有写操作！
    checkPermissions: def.checkPermissions ?? (() => ({ behavior: 'allow' })),

    // UI 渲染默认值
    renderToolUseMessage: def.renderToolUseMessage ?? defaultRender,
    userFacingName: def.userFacingName ?? (() => def.name),
  }
}
```

**关键设计思想：Fail-Closed（安全优先）**

- 忘了标记 `isConcurrencySafe`？默认 false → 串行执行（安全但慢）
- 忘了标记 `isReadOnly`？默认 false → 需要权限检查（安全但多一步确认）
- 只有**显式标记为安全**的工具才能享受优化（并行执行、跳过权限）

## 2.3 Tool 的三文件模式

每个工具由三个文件组成，各司其职：

```
src/tools/BashTool/
│
├── BashTool.ts   ← 面向 QueryEngine：定义、验证、执行
│   │
│   │  定义 inputSchema
│   │  实现 call() 函数
│   │  实现 checkPermissions()
│   │  标记安全属性
│   │
├── prompt.ts     ← 面向 Claude：告诉 AI 这个工具怎么用
│   │
│   │  返回一段自然语言描述
│   │  包含使用示例
│   │  说明参数含义
│   │  说明注意事项
│   │
└── UI.tsx        ← 面向用户：在终端中展示工具调用过程
    │
    │  renderToolUseMessage() — 调用时显示什么
    │  renderToolResultMessage() — 结果显示什么
    │  可能包含语法高亮、diff 渲染等
```

**为什么要分三个文件？**

这是一个经典的**关注点分离（Separation of Concerns）**模式：

| 关注点 | 受众 | 变化频率 |
|--------|------|----------|
| 执行逻辑 | QueryEngine | 低（功能稳定后很少改） |
| 模型提示 | Claude AI | 中（优化提示词会频繁调整） |
| UI 渲染 | 终端用户 | 高（界面经常调整） |

三者独立修改，互不影响。

## 2.4 Command 的构成

Command 是用户通过 `/xxx` 触发的操作。它有三种子类型：

### PromptCommand（最常用）
```typescript
// 把内容发送给 Claude 处理
const commitCommand: PromptCommand = {
  type: 'prompt',
  name: 'commit',
  description: '生成 commit 信息并提交',
  isEnabled: true,
  isHidden: false,

  // 关键：生成发送给 Claude 的 prompt
  async getPromptForCommand(args, context) {
    const diff = await exec('git diff --staged')
    return `请根据以下 diff 生成 commit 信息：\n${diff}`
  },

  // 可选：指定允许的工具（限制 Claude 的能力范围）
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

## 2.5 Skill 的构成

Skill 是最高层的封装——用 Markdown 文件定义的可扩展命令：

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
3. 检查代码质量、安全性、性能
4. 给出详细的审查意见
```

**Skill 加载流程：**
```
.claude/skills/*.md  →  loadSkillsDir()  →  解析 frontmatter  →  PromptCommand
     │
     │  用户输入 /review-pr 123
     │
     ▼
  getPromptForCommand("123")
     │  替换 {{args}} → "123"
     │  读取 markdown 正文作为 prompt
     ▼
  发送给 Claude 处理
```

## 2.6 三者如何注册到系统

```typescript
// src/commands.ts — 统一注册入口

export async function getCommands(): Promise<Command[]> {
  return [
    // 内置命令（LocalCommand / PromptCommand）
    ...builtinCommands,

    // 从磁盘加载的 Skill
    ...(await getSkills()),

    // 插件注册的命令
    ...(await getPluginCommands()),

    // 内置 Skill（代码中注册的）
    ...getBundledSkills(),
  ]
}
```

## 2.7 权限如何串联

Tool 的权限检查是一个多层管线：

```
Claude 想调用 BashTool("rm -rf /tmp/test")
    │
    ▼
┌─ 第 1 层：工具自身检查 ────────────────────┐
│  BashTool.checkPermissions(input)          │
│  → 检查命令是否在白名单/黑名单中            │
│  → 检查是否是破坏性命令                     │
│  → 返回 { behavior: 'allow' | 'deny' | 'ask' } │
└────────────┬──────────────────────────────┘
             │
             ▼
┌─ 第 2 层：全局权限规则 ────────────────────┐
│  settings.json 中的 alwaysAllow/Deny 规则   │
│  → 模式匹配：tool name + input pattern      │
└────────────┬──────────────────────────────┘
             │
             ▼
┌─ 第 3 层：权限模式 ───────────────────────┐
│  default → 弹出对话框让用户决定             │
│  auto    → ML 分类器自动判断                │
│  bypass  → 直接通过（危险！仅沙箱中）       │
└────────────┬──────────────────────────────┘
             │
             ▼
         执行 或 拒绝
```

## 2.8 从原语到抽象的组合关系

```
基础原语                核心抽象               系统功能
─────────              ─────────              ─────────
Zod Schema ──────────→ Tool.inputSchema
                       Tool.call()
AsyncGenerator ──────→ Tool 结果流式返回
                       │
Signal ──────────────→ │ 事件通知
Mailbox ─────────────→ │ 消息传递
                       │
React + Ink ─────────→ Tool.UI.tsx ──────────→ 终端显示
                       Command UI
                       │
Memoize ─────────────→ Context 缓存 ────────→ 系统提示词
                       │
                       ▼
                    QueryEngine ─────────────→ AI Agent 循环
```

## 2.9 本章总结

| 抽象 | 触发者 | 执行者 | 定义方式 |
|------|--------|--------|----------|
| Tool | Claude (AI) | QueryEngine | TypeScript (buildTool) |
| Command | 用户 (/xxx) | REPL | TypeScript (3种子类型) |
| Skill | 用户 (/xxx) | REPL + Claude | Markdown (frontmatter) |

**关键设计原则：**
1. **安全优先** — buildTool 默认值假设最坏情况
2. **关注点分离** — 逻辑/提示词/UI 三层独立
3. **可扩展性** — Skill 让用户用 Markdown 就能扩展功能
4. **统一注册** — 所有命令通过 getCommands() 汇总

下一章我们继续向上，看多个 Tool 如何组装成 **工具池**，多个 Command 如何组装成 **命令系统**。

→ [第三章：模块组装 — 工具池、命令系统、MCP 集成](03-module-assembly.md)
