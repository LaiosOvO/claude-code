# skills 模块阅读笔记

## 文件列表

```
src/skills/
├── bundledSkills.ts      # 内置 Skill 注册与管理
├── loadSkillsDir.ts      # 从磁盘加载 .claude/skills/ ���录
├── mcpSkills.ts          # MCP 服���端 Skill 发现（stub）
├── mcpSkillBuilders.ts   # MCP Skill 构建器注册表（解循环依赖）
└── bundled/              # 内置 Skill 实现目录
    ├── batch.ts, claudeApi.ts, debug.ts, loop.ts, ...
    └── (约 20 个 Skill 实现)
```

## 核心功能

skills 模块是 Claude Code 的**斜杠命令扩展系统**，管理三类 Skill 来源：

1. **bundled**：编译到 CLI 二进制中的内置 Skill（如 /commit、/simplify、/loop）
2. **directory**：用户在 `.claude/skills/` 放置的 Markdown Skill 文件
3. **MCP**：通过 MCP 服务端动态发现的远程 Skill

核心类型 `BundledSkillDefinition` 定义 Skill 的完整契约：名称、描述、触发条件、允许的工具、提示词生成函数。

## 关键代码片段

Skill 注册——编译时绑定，运行时调用：

```typescript
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  const command: Command = {
    type: 'prompt', name: definition.name,
    source: 'bundled', loadedFrom: 'bundled',
    getPromptForCommand: definition.getPromptForCommand,
    // ...其余字段
  }
  bundledSkills.push(command)
}
```

引用文件的安全提取——O_NOFOLLOW + O_EXCL 防 symlink 攻击：

```typescript
const SAFE_WRITE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT
  | fsConstants.O_EXCL | O_NOFOLLOW
async function safeWriteFile(p: string, content: string): Promise<void> {
  const fh = await open(p, SAFE_WRITE_FLAGS, 0o600)
  try { await fh.writeFile(content, 'utf8') }
  finally { await fh.close() }
}
```

## 设计亮点

1. **懒提取**：`files` 字段的内容在首次 Skill 调用时才提取到磁盘，Promise memoize 防竞态
2. **路径遍历防御**：`resolveSkillFilePath` 拒绝包含 `..` 的相对路径
3. **循环依赖破解**：`mcpSkillBuilders.ts` 用 write-once 注册表打破 mcpSkills -> loadSkillsDir 的循环
4. **model 可选**：每个 Skill 可指定专用模型（如轻量 Skill 用 Haiku）
5. **context 模式**：Skill 可声明 `context: 'inline' | 'fork'`，inline 在当前会话执行，fork 创建子 Agent
