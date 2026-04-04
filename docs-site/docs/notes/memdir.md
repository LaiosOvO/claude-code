# memdir 模块阅读笔记

## 文件列表

```
src/memdir/
├── memdir.ts               # 核心：内存提示构建与加载
├── memoryTypes.ts          # 四类记忆分类法与提示模板
├── findRelevantMemories.ts # Sonnet 侧查询选择相关记忆
├── memoryScan.ts           # 目录扫描与 frontmatter 解析
├── memoryAge.ts            # 记忆新鲜度计算
├── memoryShapeTelemetry.ts # 记忆形状遥测（stub）
├── paths.ts                # 路径解析与安全校验
├── teamMemPaths.ts         # 团队记忆路径与 symlink 防御
└── teamMemPrompts.ts       # 团队+个人组合提示构建
```

## 核心功能

memdir 是 Claude Code 的**持久化文件记忆系统**，让 AI 在跨会话间保持对用户、项目和反馈的认知。

核心机制：
- **四类分类法**：user/feedback/project/reference，配合 frontmatter 元数据
- **MEMORY.md 索引**：每个项目一个索引文件（200 行/25KB 上限），加载到系统提示
- **Sonnet 侧查询**：`findRelevantMemories` 用轻量 Sonnet 模型从 frontmatter 描述中挑选最多 5 个相关记忆
- **团队记忆**：private/team 双目录，team 目录有 symlink 遍历防御
- **Kairos 模式**：长期会话改为 append-only 日志文件，nightly distill 到 MEMORY.md

## 关键代码片段

截断保护防止超大索引：

```typescript
export function truncateEntrypointContent(raw: string): EntrypointTruncation {
  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES
  // 先按行截断，再按字节截断（在换行处切割，不切断行）
}
```

路径安全校验（防止 symlink 逃逸）：

```typescript
async function realpathDeepestExisting(absolutePath: string): Promise<string> {
  // 逐级向上 walk，realpath 最深存在的祖先，检测 dangling symlink
}
```

## 设计亮点

1. **安全纵深防御**：`teamMemPaths.ts` 实现两轮校验——string-level 前缀检查 + realpath symlink 解析
2. **记忆新鲜度**：`memoryAge.ts` 为超过 1 天的记忆附加 staleness 警告，引导模型验证后再引用
3. **Memoized 路径**：`getAutoMemPath` 用 lodash memoize 避免渲染路径反复调用 settings 解析
4. **"不保存什么"同等重要**：明确排除可从代码推导的信息（架构、git 历史、文件结构）
5. **"推荐前先验证"**：记忆中的文件名/函数名可能已过时，提示要求模型先 grep 确认再推荐
6. **已呈现过滤**：`alreadySurfaced` 过滤已在前几轮展示过的记忆，把 5 槽预算留给新候选
7. **Cowork 扩展**：通过 `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` 环境变量注入额外记忆策略
8. **Git worktree 共享**：同一 Git 仓库的所有 worktree 共享一个记忆目录（`findCanonicalGitRoot`）
5. **"推荐前先验证"**：记忆中的文件名/函数名可能已过时，提示要求模型先 grep 确认再推荐
6. **已呈现过滤**：`alreadySurfaced` 过滤已在前几轮展示过的记忆，把 5 槽预算留给新候选
7. **Cowork 扩展**：通过 `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` 环境变量注入额外记忆策略
