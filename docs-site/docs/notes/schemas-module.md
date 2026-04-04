# schemas 模块阅读笔记

## 文件列表

```
src/schemas/
├── hooks.ts   # Hook Zod Schema 定义
└── src/       # 子目录（entrypoints）
```

## 核心功能

schemas 模块将**共享的 Zod Schema 定义**从 settings/types.ts 中提取出来，打破 settings/types.ts 和 plugins/schemas.ts 之间的循环依赖。

核心 Schema：
- `BashCommandHookSchema`：Shell 命令钩子（command + if 条件 + shell 类型 + timeout）
- `IfConditionSchema`：权限规则语法的条件过滤器（如 `"Bash(git *)"` 只对 git 命令生效）
- 支持 `bash` 和 `powershell` 两种 Shell 类型

## 关键代码片段

条件过滤 Schema——权限规则语法：

```typescript
const IfConditionSchema = lazySchema(() =>
  z.string().optional().describe(
    'Permission rule syntax to filter when this hook runs (e.g., "Bash(git *)"). ' +
    'Only runs if the tool call matches the pattern.'
  )
)
```

Hook 命令 Schema 带超时和状态消息：

```typescript
const BashCommandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string(),
  if: IfConditionSchema(),
  shell: z.enum(SHELL_TYPES).optional(),
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
})
```

## 模块关系

```
schemas/hooks.ts
  ├── 被 settings/types.ts 导入（settings 配置的 Hook 字段验证）
  ├── 被 plugins/schemas.ts 导入（插件 Hook 配置验证）
  └── 导入 HOOK_EVENTS from entrypoints/agentSdkTypes.ts
```

这个三角关系之前是循环的：settings/types.ts <-> plugins/schemas.ts。提取到 schemas/ 后变成了 DAG。

## 设计亮点

1. **依赖图叶子节点**：此模块只导入类型，不引入运行时依赖，确保 mcpSkills.ts 和 loadSkillsDir.ts 都能安全依赖它
2. **lazySchema**：使用惰性初始化避免模块加载时的循环引用
3. **HookEvent 复用**：从 `agentSdkTypes.ts` 导入 `HOOK_EVENTS` 常量，Schema 与 SDK 类型保持同步
4. **describe() 文档**：每个 Schema 字段都有 `.describe()` 注释，可自动生成配置文档
5. **Shell 类型枚举**：从 `shellProvider.ts` 导入 `SHELL_TYPES`，保持 schema 与运行时行为一致
